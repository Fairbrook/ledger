import type { ButtonHTMLAttributes, ReactNode } from 'react'

// 24px stroke icons in the Lucide style, inlined so the app needs no icon dependency.
const paths = {
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  open: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  restore: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="m9 15 3-3 3 3" />
      <path d="M12 12v6" />
    </>
  ),
  cloudCheck: (
    <>
      <path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z" />
      <path d="m9 13 2 2 4-4" />
    </>
  ),
  cloudOff: (
    <>
      <path d="m2 2 20 20" />
      <path d="M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2" />
      <path d="M21.5 15.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 9.5 5.1" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  )
}

export type IconName = keyof typeof paths

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[props.name]}
    </svg>
  )
}

/** Icon-only button; `label` is both the tooltip and the accessible name. */
export function IconButton(
  props: { icon: IconName; label: string; danger?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'>
) {
  const { icon, label, danger, className, ...rest } = props
  return (
    <button type="button" {...rest} className={`icon-btn${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`} title={label} aria-label={label}>
      <Icon name={icon} />
    </button>
  )
}

/** Pill showing that a run's files live on the remote only. */
export function ArchivedPill(props: { title?: string; children?: ReactNode }) {
  return (
    <span className="badge archived" title={props.title}>
      <Icon name="archive" size={12} />
      {props.children ?? 'archived'}
    </span>
  )
}
