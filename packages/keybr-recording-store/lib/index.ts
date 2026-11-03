import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  batchSchema,
  canonicalJson,
  type KeyboardCatalogue,
  keyboardExportSchema,
  maxBatchBytes,
  type RecordingBatch,
} from "@keybr/recording";

/**
 * The layout of the recording database, stored in `PRAGMA user_version`. Records
 * carry their own contract version (`schemaVersion`). Version 2 adds imported
 * keyboard provenance; version 1 databases are migrated explicitly.
 */
export const databaseVersion = 2;

const migrations: Record<number, string> = {
  0: `
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO metadata VALUES ('schemaVersion', '1');
    CREATE TABLE snapshots(kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id,version)) STRICT;
    CREATE TABLE attempts(id TEXT PRIMARY KEY, context TEXT, incomplete INTEGER NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE records(attempt_id TEXT NOT NULL REFERENCES attempts(id), sequence INTEGER NOT NULL, observed_at REAL NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(attempt_id,sequence)) STRICT;
    CREATE INDEX records_time ON records(observed_at);
    CREATE INDEX records_type ON records(attempt_id,type);
    PRAGMA user_version=1;
  `,
  1: `
    INSERT INTO metadata VALUES ('databaseVersion', '2');
    CREATE TABLE keyboard_sources(
      seq INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE(kind,id,version,source),
      FOREIGN KEY(kind,id,version) REFERENCES snapshots(kind,id,version)
    ) STRICT;
    PRAGMA user_version=2;
  `,
};

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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
      let version = Number(
        db.prepare("PRAGMA user_version").get()!.user_version,
      );
      if (
        !Number.isInteger(version) ||
        version < 0 ||
        version > databaseVersion
      )
        throw new Error(`Unsupported recording schema version ${version}`);
      if (
        version === 0 &&
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()
      )
        throw new Error("Unversioned recording database");
      for (; version < databaseVersion; version++) db.exec(migrations[version]);
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
      for (const snapshot of batch.snapshots) this.#putSnapshot(snapshot);
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

  /** Insert an immutable snapshot, or confirm an identical one. Returns true when new. */
  #putSnapshot(snapshot: RecordingBatch["snapshots"][number]) {
    const { kind, id, version } = snapshot;
    const json = canonicalJson(snapshot);
    const existing = this.database
      .prepare("SELECT json FROM snapshots WHERE kind=? AND id=? AND version=?")
      .get(kind, id, version);
    if (existing && existing.json !== json)
      throw new RecordingConflict("Conflicting keyboard snapshot");
    this.database
      .prepare("INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?)")
      .run(kind, id, version, json);
    return !existing;
  }

  /**
   * Import a keyboard export in one transaction. Snapshots are identified by content:
   * a Board version is the sha256 of its vial.json text, and a Keymap version is the
   * sha256 of its canonical configuration, which freezes the .vil text, the Board
   * version, the Letter layout and the layer names. Changed content therefore adds
   * snapshots and never rewrites earlier ones; identical content adds nothing.
   * Source identifiers are kept separately, in keyboard_sources.
   */
  importKeyboards(value: unknown, importedAt = new Date().toISOString()) {
    const parsed = keyboardExportSchema.safeParse(value);
    if (!parsed.success)
      throw new RecordingValidationError(
        `Invalid keyboard export: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "export"}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    const data = parsed.data;
    const application = data.source.application;
    const plan: {
      snapshot: RecordingBatch["snapshots"][number];
      source: object;
    }[] = [];
    for (const board of data.boards) {
      const boardRef = { id: board.name, version: sha256(board.vial) };
      plan.push({
        snapshot: {
          kind: "board",
          ...boardRef,
          configuration: {
            name: board.name,
            vial: board.vial,
            vialHash: boardRef.version,
          },
        },
        source: { application, boardId: board.sourceId, name: board.name },
      });
      for (const keymap of board.keymaps) {
        const vilHash = sha256(keymap.vil);
        if (vilHash !== keymap.sourceHash)
          throw new RecordingValidationError(
            `Board ${JSON.stringify(board.name)}: .vil text does not match its sourceHash ${keymap.sourceHash}`,
          );
        const configuration = {
          board: boardRef,
          letterLayout: keymap.letterLayout,
          layers: keymap.layers,
          vil: keymap.vil,
          vilHash,
        };
        plan.push({
          snapshot: {
            kind: "keymap",
            id: `${board.name}/${keymap.letterLayout}`,
            version: sha256(canonicalJson(configuration)),
            configuration,
          },
          source: {
            application,
            boardId: board.sourceId,
            sourceHash: keymap.sourceHash,
          },
        });
      }
    }
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      let added = 0;
      for (const { snapshot, source } of plan) {
        if (this.#putSnapshot(snapshot)) added++;
        db.prepare(
          "INSERT OR IGNORE INTO keyboard_sources(kind,id,version,source,imported_at) VALUES (?,?,?,?,?)",
        ).run(
          snapshot.kind,
          snapshot.id,
          snapshot.version,
          canonicalJson(source),
          importedAt,
        );
      }
      db.exec("COMMIT");
      return {
        boards: data.boards.length,
        keymaps: plan.length - data.boards.length,
        added,
        unchanged: plan.length - added,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Imported keyboards by name, each with its layouts in newest-first import order. */
  keyboards(): KeyboardCatalogue {
    const rows = this.database
      .prepare(
        `SELECT s.id, s.version, s.json, min(k.seq) AS first
         FROM snapshots s JOIN keyboard_sources k
           ON k.kind = s.kind AND k.id = s.id AND k.version = s.version
         WHERE s.kind = 'keymap'
         GROUP BY s.id, s.version
         ORDER BY first DESC`,
      )
      .all();
    const boards = new Map<string, KeyboardCatalogue[number]>();
    for (const row of rows) {
      const { configuration } = JSON.parse(String(row.json));
      const board = configuration.board as { id: string; version: string };
      let entry = boards.get(board.id);
      if (!entry)
        boards.set(
          board.id,
          (entry = { id: board.id, name: board.id, layouts: [] }),
        );
      entry.layouts.push({
        board,
        keymap: { id: String(row.id), version: String(row.version) },
        letterLayout: configuration.letterLayout,
        layers: configuration.layers,
        vilHash: configuration.vilHash,
      });
    }
    return [...boards.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
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
