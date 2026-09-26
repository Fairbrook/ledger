import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have run,
 * so append new entries — never edit one that has shipped.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE experiments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
    subject     TEXT NOT NULL DEFAULT '',
    objective   TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    conclusions TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'planning'
                CHECK (status IN ('planning', 'running', 'concluded', 'archived')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    date          TEXT NOT NULL,
    notes         TEXT NOT NULL DEFAULT '',
    outcome       TEXT NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending', 'success', 'partial', 'failure', 'inconclusive')),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (experiment_id, seq)
  );

  CREATE TABLE run_params (
    run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, key)
  );

  CREATE TABLE results (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    label  TEXT NOT NULL CHECK (length(trim(label)) > 0),
    value  REAL NOT NULL,
    unit   TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX results_run ON results(run_id);

  CREATE TABLE files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    size_bytes  INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX files_run ON files(run_id);
  `
]

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

/** Run `fn` inside a transaction; rolls back if it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
