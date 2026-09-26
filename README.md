# ledger

A desktop experiment log built with Electron. An **experiment** studies one system, setup, controller or algorithm
through an ordered series of **runs**. For each run you record what was tested, what you observed and the numbers
it produced, and attach its output files. You can then compare every run in one table.

Based on the *experiments database* challenge (`covenant-tec/challenges` → `experiments-database/`), using the same
app scaffold as [betaxiv](https://github.com/Fairbrook/betaxiv): electron-vite, React, TypeScript and
electron-builder.

## Flow

1. **Create an experiment.** Give it a name, the system under test, the objective or hypothesis, the setup/method,
   and a status (planning → running → concluded → archived).
2. **Log runs in order.** Runs are numbered #1, #2, … within the experiment. Each run has:
   - **What was tested**: parameter/value pairs (`Kp = 1.2`, `dataset = hallway_02`, `firmware = v1.4`).
   - **Outcome**: pending, success, partial, failure or inconclusive.
   - **Observations**: free-text qualitative notes.
   - **Results**: numeric metrics with a unit (`overshoot 3.8 %`). Add them one at a time, or paste several lines of
     `label, value, unit` at once. Metric names from earlier runs are suggested, so the same metric lines up across
     runs.
   - **Files**: logs, CSVs, plots and recordings, picked with the native file dialog.
   **Repeat #n** starts a new run with the same parameters as the selected one, so you only change what differs.
3. **Compare.** One row per run, with every parameter and metric as a column. The highest and lowest value of each
   metric is marked. **Export CSV** saves the table.
4. **Conclude.** The *Setup & conclusions* tab keeps the qualitative write-up next to the data.

Deleting a run or an experiment also deletes its results, file records and stored files. You confirm first.

## Where data lives

Everything is stored in the app's user-data folder. `LEDGER_DATA_DIR` overrides the folder and `LEDGER_FILES_DIR`
overrides only the file storage.

```
data/
  ledger.db                              SQLite database (experiments, runs, run_params, results, files)
  experiment_files/
    <experimentId>/<runId>/<file name>   copies of attached files (out.csv, out_1.csv, … on name clashes)
```

Attached files are **copied**, never moved. The database stores their paths relative to `experiment_files/`, so the
whole data folder can be moved or backed up as one unit.

SQLite comes from Node's built-in `node:sqlite`, so there is no native module to rebuild for Electron. Foreign keys
are enforced (`ON DELETE CASCADE`), and multi-row writes (batch results, multi-file attach) run in a transaction.
Schema changes go in `src/main/db.ts` as new, append-only migrations tracked with `PRAGMA user_version`.

## Development

```bash
npm install
npm run dev        # start the app with hot reload
npm test           # data-layer tests (CRUD, cascades, file storage, comparison, CSV)
npm run typecheck
npm run dist       # package an installer for the current OS (electron-builder)
npm run dist:linux # build dist/ledger-<version>.AppImage
```

Requires Node 22.5+ (for `node:sqlite` in the tests; Electron ships its own Node).

If `npm run dev` fails with `Error: Electron uninstall`, the Electron binary was never downloaded. `npm install`
repairs this automatically through `scripts/ensure-electron.mjs`. You can also run
`node node_modules/electron/install.js` directly. Behind a proxy, set `ELECTRON_MIRROR` or `HTTPS_PROXY` first.

## Installing on Linux (AppImage)

```bash
npm run dist:linux       # builds dist/ledger-<version>.AppImage
npm run install:linux    # copies it to ~/.local/share/ledger and adds an app-launcher entry
sh scripts/install-appimage.sh --uninstall   # removes it (your data is kept)
```

The AppImage uses electron-builder's new AppImage toolset (static type2-runtime), so it doesn't need `libfuse2`.

## Project layout

```
src/main/        Electron main process
  db.ts            SQLite connection, migrations, transaction helper
  ledger.ts        experiments / runs / results / files, validation, managed file storage, comparison
  csv.ts           comparison table → CSV
  index.ts         window + IPC handlers (file dialogs run here, never in the renderer)
src/preload/     context-isolated bridge exposing window.ledger
src/shared/      types shared by main and renderer (LedgerApi)
src/renderer/    React UI
test/            node:test suites for the data layer
```
