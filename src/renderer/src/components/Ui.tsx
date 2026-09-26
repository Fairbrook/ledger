import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { cleanError } from '../api'
import Modal from './Modal'

type ToastKind = 'ok' | 'error'
interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
}
interface UiContext {
  toast(text: string, kind?: ToastKind): void
  /** Show an error toast for a failed action. */
  fail(e: unknown): void
  confirm(opts: ConfirmOptions): Promise<boolean>
}

const Ctx = createContext<UiContext | null>(null)

export const useUi = () => {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useUi outside <UiProvider>')
  return ctx
}

/** Toast notifications and confirmation dialogs, available anywhere through useUi(). */
export function UiProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: ToastKind }[]>([])
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const nextId = useRef(0)

  const toast = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 2500)
  }, [])
  const fail = useCallback((e: unknown) => toast(cleanError(e), 'error'), [toast])
  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    []
  )
  const value = useMemo(() => ({ toast, fail, confirm }), [toast, fail, confirm])
  const close = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  return (
    <Ctx.Provider value={value}>
      {props.children}
      {pending && (
        <Modal title={pending.title} onClose={() => close(false)}>
          <div className="confirm-message">{pending.message}</div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close(false)}>
              Cancel
            </button>
            <button className="btn primary danger-fill" autoFocus onClick={() => close(true)}>
              {pending.confirmLabel ?? 'Delete'}
            </button>
          </div>
        </Modal>
      )}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
