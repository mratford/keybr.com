import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  batchSchema,
  canonicalJson,
  maxBatchBytes,
  schemaVersion,
} from "@keybr/recording";

export class RecordingValidationError extends Error {}

export class RecordingConflict extends Error {}

/** A dedicated database, never the account database or binary result files. */
export class RecordingStore {
  readonly database: DatabaseSync;
  constructor(readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    const db = (this.database = new DatabaseSync(filename, { timeout: 5000 }));
    try {
      db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
      );
      const version = db.prepare("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== schemaVersion)
        throw new Error(`Unsupported recording schema version ${version}`);
      if (version === 0) {
        if (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()
        )
          throw new Error("Unversioned recording database");
        db.exec(`
          CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          INSERT INTO metadata VALUES ('schemaVersion', '1');
          CREATE TABLE snapshots(kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id,version)) STRICT;
          CREATE TABLE attempts(id TEXT PRIMARY KEY, context TEXT, incomplete INTEGER NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0) STRICT;
          CREATE TABLE records(attempt_id TEXT NOT NULL REFERENCES attempts(id), sequence INTEGER NOT NULL, observed_at REAL NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(attempt_id,sequence)) STRICT;
          CREATE INDEX records_time ON records(observed_at);
          CREATE INDEX records_type ON records(attempt_id,type);
          PRAGMA user_version=1;
        `);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  append(value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > maxBatchBytes)
      throw new RangeError("Recording batch exceeds byte limit");
    const batch = batchSchema.parse(value);
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const snapshot of batch.snapshots) {
        const { kind, id, version } = snapshot;
        const json = canonicalJson(snapshot);
        const existing = db
          .prepare(
            "SELECT json FROM snapshots WHERE kind=? AND id=? AND version=?",
          )
          .get(kind, id, version);
        if (existing && existing.json !== json)
          throw new RecordingConflict("Conflicting keyboard snapshot");
        db.prepare("INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?)").run(
          kind,
          id,
          version,
          json,
        );
      }
      for (const record of batch.records) {
        if ((record.type === "start") !== (record.sequence === 0))
          throw new RecordingValidationError(
            "Attempt start must have sequence zero",
          );
        const json = canonicalJson(record);
        const existing = db
          .prepare("SELECT json FROM records WHERE attempt_id=? AND sequence=?")
          .get(record.attemptId, record.sequence);
        if (existing && existing.json !== json)
          throw new RecordingConflict("Conflicting record identity");
        db.prepare("INSERT OR IGNORE INTO attempts(id) VALUES (?)").run(
          record.attemptId,
        );
        if (record.type === "start") {
          for (const kind of ["board", "keymap"] as const) {
            const ref = record.context[kind];
            if (
              ref &&
              !db
                .prepare(
                  "SELECT 1 FROM snapshots WHERE kind=? AND id=? AND version=?",
                )
                .get(kind, ref.id, ref.version)
            )
              throw new RecordingValidationError("Missing keyboard snapshot");
          }
          db.prepare("UPDATE attempts SET context=? WHERE id=?").run(
            canonicalJson(record.context),
            record.attemptId,
          );
        }
        db.prepare("INSERT OR IGNORE INTO records VALUES (?,?,?,?,?,?)").run(
          record.attemptId,
          record.sequence,
          record.observedAt,
          record.type,
          record.schemaVersion,
          json,
        );
      }
      for (const status of batch.recovery) {
        db.prepare(
          "INSERT INTO attempts(id,incomplete,interrupted) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET incomplete=max(incomplete,excluded.incomplete), interrupted=max(interrupted,excluded.interrupted)",
        ).run(
          status.attemptId,
          Number(status.incomplete),
          Number(status.interrupted),
        );
      }
      db.exec("COMMIT");
      return {
        records: batch.records.map(({ attemptId, sequence }) => ({
          attemptId,
          sequence,
        })),
        recovery: batch.recovery,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** VACUUM INTO reads a consistent SQLite snapshot, including committed WAL pages. */
  export(filename: string) {
    if (resolve(filename) === resolve(this.filename))
      throw new Error("Export must use a different file");
    this.database.prepare("VACUUM INTO ?").run(resolve(filename));
  }
  close() {
    this.database.close();
  }
}
