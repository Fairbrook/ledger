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

## Local API

While the app is open it serves a JSON API on `http://127.0.0.1:4317/api`, so scripts can record runs as they
finish. To use it without the app, run `npm run api` (same database, same port). The window refreshes by itself
when data changes through the API or the MCP server.

```bash
# Register an experiment with its first runs in one call (status becomes "running")
curl -X POST localhost:4317/api/experiments -H 'Content-Type: application/json' -d '{
  "name": "PID tuning", "subject": "Altitude controller", "objective": "< 5% overshoot",
  "runs": [{ "params": { "Kp": 1.2 }, "outcome": "success",
             "results": [{ "label": "overshoot", "value": 3.8, "unit": "%" }],
             "files": ["/home/me/logs/run1.csv"] }]
}'

# Log the next run, then close the experiment
curl -X POST localhost:4317/api/experiments/1/runs -H 'Content-Type: application/json' \
  -d '{ "params": { "Kp": 1.4 }, "results": [{ "label": "overshoot", "value": 2.1, "unit": "%" }] }'
curl -X PATCH localhost:4317/api/experiments/1 -H 'Content-Type: application/json' \
  -d '{ "status": "concluded", "conclusions": "Kp = 1.2 is the best trade-off" }'
```

| Method | Path | |
| --- | --- | --- |
| GET | `/api/experiments?q=&status=` | list, optionally filtered |
| POST | `/api/experiments` | create; optional `runs: [...]` (all or nothing) |
| GET / PATCH / DELETE | `/api/experiments/:id` | full detail (runs, results, files) / update given fields / delete |
| GET | `/api/experiments/:id/compare` (`.csv`) | comparison table as JSON or CSV |
| GET | `/api/experiments/:id/analysis` | outcome counts, per-metric stats, parameter effects |
| GET / POST | `/api/experiments/:id/runs` | list / log the next run (`params`, `results`, `files`, …) |
| GET / PATCH / DELETE | `/api/runs/:id` | run detail / update given fields (`mergeParams` keeps other params) / delete |
| POST | `/api/runs/:id/results` | add results (`[...]` or `{ "results": [...] }`) |
| PATCH / DELETE | `/api/results/:id` | update / delete one result |
| POST | `/api/runs/:id/files` | copy files in: `{ "paths": ["/abs/path"] }` |
| DELETE | `/api/files/:id` | delete an attached file |

Run fields default sensibly: `date` is now, `outcome` is `pending`. `params` may be `{ "Kp": 1.2 }` or
`[{ "key": "Kp", "value": "1.2" }]`. Errors come back as `{ "error": "…" }` with 400, 404 or 405.

The API only listens on the loopback interface and rejects requests with an `Origin` header or a non-local `Host`, so
web pages in your browser can't reach it. Set `LEDGER_API_TOKEN` to also require `Authorization: Bearer <token>`.
`LEDGER_API_PORT` changes the port and `LEDGER_API=0` turns the API off in the app.

## Claude Code (MCP)

`src/cli/mcp.ts` is an MCP server over stdio that opens the same database as the app (the app doesn't need to be
running). The repo's `.mcp.json` registers it, so starting Claude Code in this folder offers it; approve the
`ledger` server when asked. To use it from any folder:

```bash
claude mcp add --scope user ledger -- node --disable-warning=ExperimentalWarning \
  --import "$PWD/node_modules/tsx/dist/loader.mjs" "$PWD/src/cli/mcp.ts"
```

Tools: `list_experiments`, `get_experiment`, `get_run`, `compare_runs`, `analyze_experiment`, `read_run_file`
(contents of an attached log or CSV), `register_experiment`, `update_experiment`, `log_run`, `update_run`,
`add_results`, `update_result`, `attach_files`, and `delete_experiment` / `delete_run` / `delete_result` /
`delete_file`. Then ask things like *"register a new experiment for the hallway SLAM runs in ~/logs"*, *"mark run 3
of PID tuning as a failure and note the oscillation"* or *"which parameter has the biggest effect on overshoot?"*.

Set `LEDGER_DATA_DIR` in the server's `env` if the app uses a non-default data folder.

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
  service.ts       partial updates, one-call registration and analysis for the API and MCP server
  http.ts          local HTTP API
  mcp.ts           MCP tools
  paths.ts         data folder resolution (shared by the app and the CLIs)
  index.ts         window + IPC handlers (file dialogs run here, never in the renderer), starts the API
src/cli/         headless entry points: api.ts (npm run api) and mcp.ts (stdio MCP server)
src/preload/     context-isolated bridge exposing window.ledger
src/shared/      types shared by main and renderer (LedgerApi)
src/renderer/    React UI
test/            node:test suites for the data layer, API and MCP server
```
