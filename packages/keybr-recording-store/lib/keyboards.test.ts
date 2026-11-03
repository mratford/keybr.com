import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type KeyboardExport, type RecordingRecord } from "@keybr/recording";
import {
  databaseVersion,
  RecordingStore,
  RecordingValidationError,
} from "./index.ts";

function fixture(name: "initial" | "updated"): KeyboardExport {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../keybr-recording/fixtures/keyboards/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "keybr-keyboards-"));
  const filename = join(dir, "recordings.sqlite");
  const store = new RecordingStore(filename);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, filename, store };
}

function count(store: RecordingStore, table: string) {
  return Number(
    store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
  );
}

function snapshots(store: RecordingStore) {
  return store.database
    .prepare("SELECT kind, id, version, json FROM snapshots ORDER BY rowid")
    .all()
    .map((row) => ({ ...row }));
}

function start(
  layout: { board: { id: string; version: string }; keymap: object },
  attemptId = crypto.randomUUID(),
): RecordingRecord {
  return {
    schemaVersion: 1,
    attemptId,
    sequence: 0,
    observedAt: 0,
    type: "start",
    context: {
      text: "abc",
      applicationRevision: "test",
      board: layout.board,
      keymap: layout.keymap as { id: string; version: string },
      settings: { typing: {}, exercise: {}, layout: {} },
    },
  };
}

test("import is idempotent and lists Boards with their Letter layouts", (t) => {
  const { store } = setup(t);
  assert.deepEqual(store.importKeyboards(fixture("initial")), {
    boards: 3,
    keymaps: 4,
    added: 7,
    unchanged: 0,
  });
  const before = {
    snapshots: snapshots(store),
    sources: count(store, "keyboard_sources"),
  };
  assert.deepEqual(store.importKeyboards(fixture("initial")), {
    boards: 3,
    keymaps: 4,
    added: 0,
    unchanged: 7,
  });
  assert.deepEqual(snapshots(store), before.snapshots);
  assert.equal(count(store, "keyboard_sources"), before.sources);

  const catalogue = store.keyboards();
  assert.deepEqual(
    catalogue.map((board) => [
      board.name,
      board.layouts.map((layout) => [layout.letterLayout, layout.layers]),
    ]),
    [
      ["Q4", [["QWERTY", ["Base", "Fn"]]]],
      ["Sofle", [["free-range", []]]],
      [
        "Sweep",
        [
          ["free-range", []],
          ["QWERTY", ["Base", "Sym", "Nav", "Stack", "Num"]],
        ],
      ],
    ],
  );
  const sweep = catalogue.find((board) => board.id === "Sweep")!;
  for (const layout of sweep.layouts) {
    assert.equal(layout.board.id, "Sweep");
    assert.equal(layout.keymap.id, `Sweep/${layout.letterLayout}`);
    assert.match(layout.keymap.version, /^[0-9a-f]{64}$/);
  }
  // Source identifiers are kept for traceability, apart from content identity.
  assert.deepEqual(
    store.database
      .prepare(
        "SELECT source FROM keyboard_sources WHERE kind='board' AND id='Sweep'",
      )
      .all()
      .map((row) => JSON.parse(String(row.source))),
    [{ application: "typokiller", boardId: 1, name: "Sweep" }],
  );
});

test("later Board, .vil and layer changes add snapshots and preserve earlier Attempt references", (t) => {
  const { store } = setup(t);
  store.importKeyboards(fixture("initial"));
  const initial = store.keyboards();
  const earlier = snapshots(store);
  const oldQwerty = initial
    .find((board) => board.id === "Sweep")!
    .layouts.find((layout) => layout.letterLayout === "QWERTY")!;
  store.append({
    schemaVersion: 1,
    snapshots: [],
    records: [start(oldQwerty)],
    recovery: [],
  });

  assert.deepEqual(store.importKeyboards(fixture("updated")), {
    boards: 3,
    keymaps: 5,
    added: 4, // Sweep definition, QWERTY (new board + layers) and both free-range versions
    unchanged: 4, // Sofle and Q4 boards and keymaps
  });
  // Every earlier snapshot is unchanged and still present.
  assert.deepEqual(snapshots(store).slice(0, earlier.length), earlier);
  const sweep = store.keyboards().find((board) => board.id === "Sweep")!;
  assert.equal(sweep.layouts.length, 5);
  const boardVersions = new Set(sweep.layouts.map((l) => l.board.version));
  assert.equal(boardVersions.size, 2);
  // Identical .vil content under two physical keyboard definitions: two snapshots.
  const freeRange = initial
    .find((board) => board.id === "Sweep")!
    .layouts.find((layout) => layout.letterLayout === "free-range")!;
  const sameVil = sweep.layouts.filter((l) => l.vilHash === freeRange.vilHash);
  assert.equal(sameVil.length, 2);
  assert.notEqual(sameVil[0].board.version, sameVil[1].board.version);
  assert.notEqual(sameVil[0].keymap.version, sameVil[1].keymap.version);
  // Newest import first: the updated definitions lead.
  assert.notEqual(sweep.layouts[0].board.version, oldQwerty.board.version);

  // The Attempt still refers to the original QWERTY snapshot, and new Attempts can too.
  const context = JSON.parse(
    String(
      store.database.prepare("SELECT context FROM attempts").get()!.context,
    ),
  );
  assert.deepEqual(context.keymap, oldQwerty.keymap);
  const frozen = JSON.parse(
    String(
      store.database
        .prepare(
          "SELECT json FROM snapshots WHERE kind='keymap' AND id=? AND version=?",
        )
        .get(oldQwerty.keymap.id, oldQwerty.keymap.version)!.json,
    ),
  );
  assert.deepEqual(frozen.configuration.layers, [
    "Base",
    "Sym",
    "Nav",
    "Stack",
    "Num",
  ]);
  assert.equal(frozen.configuration.board.version, oldQwerty.board.version);
  store.append({
    schemaVersion: 1,
    snapshots: [],
    records: [start(oldQwerty)],
    recovery: [],
  });
});

test("invalid exports fail without partial changes", (t) => {
  const { store } = setup(t);
  store.importKeyboards(fixture("initial"));
  const before = {
    snapshots: snapshots(store),
    sources: count(store, "keyboard_sources"),
  };
  const corrupt = fixture("updated");
  // The last Board is checked after earlier Boards would already be new snapshots.
  corrupt.boards[2].keymaps[0].vil += " ";
  const invalid: unknown[] = [
    corrupt,
    { ...fixture("updated"), formatVersion: 2 },
    { ...fixture("updated"), environment: { secret: "x" } },
    {
      ...fixture("updated"),
      boards: [fixture("updated").boards[0], fixture("updated").boards[0]],
    },
    {
      ...fixture("updated"),
      boards: [{ ...fixture("updated").boards[0], vial: "not json" }],
    },
    {},
  ];
  for (const value of invalid) {
    assert.throws(() => store.importKeyboards(value), RecordingValidationError);
    assert.deepEqual(snapshots(store), before.snapshots);
    assert.equal(count(store, "keyboard_sources"), before.sources);
  }
  // A storage failure part-way through also rolls back.
  const failing = new RecordingStore(store.filename);
  t.after(() => failing.close());
  failing.database.exec(
    "CREATE TEMP TRIGGER fail BEFORE INSERT ON keyboard_sources WHEN NEW.id = 'Q4' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  assert.throws(() => failing.importKeyboards(fixture("updated")), /disk full/);
  assert.deepEqual(snapshots(store), before.snapshots);
  assert.equal(count(store, "keyboard_sources"), before.sources);
});

test("version 1 databases migrate explicitly and keep their records", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keybr-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "recordings.sqlite");
  const v1 = new DatabaseSync(filename);
  v1.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO metadata VALUES ('schemaVersion', '1');
    CREATE TABLE snapshots(kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id,version)) STRICT;
    CREATE TABLE attempts(id TEXT PRIMARY KEY, context TEXT, incomplete INTEGER NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE records(attempt_id TEXT NOT NULL REFERENCES attempts(id), sequence INTEGER NOT NULL, observed_at REAL NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(attempt_id,sequence)) STRICT;
    CREATE INDEX records_time ON records(observed_at);
    CREATE INDEX records_type ON records(attempt_id,type);
    INSERT INTO attempts(id) VALUES ('00000000-0000-4000-8000-000000000001');
    PRAGMA user_version=1;
  `);
  v1.close();
  const store = new RecordingStore(filename);
  t.after(() => store.close());
  assert.equal(
    store.database.prepare("PRAGMA user_version").get()!.user_version,
    databaseVersion,
  );
  assert.equal(count(store, "attempts"), 1);
  store.importKeyboards(fixture("initial"));
  assert.equal(store.keyboards().length, 3);
});

test("exports include keyboard snapshots and provenance readable from Python", (t) => {
  const { dir, store } = setup(t);
  store.importKeyboards(fixture("initial"));
  const output = join(dir, "export.sqlite");
  store.export(output);
  const result = JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import json, sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = c.execute("select json from snapshots where kind='keymap' and id='Sweep/QWERTY'").fetchone()
config = json.loads(row[0])["configuration"]
vil = json.loads(config["vil"])
print(json.dumps({
  "version": c.execute("pragma user_version").fetchone()[0],
  "sources": c.execute("select count(*) from keyboard_sources").fetchone()[0],
  "uid": str(vil["uid"]),
  "layers": config["layers"],
}))
`,
        output,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(result, {
    version: databaseVersion,
    sources: 7,
    // Exact 64-bit value, beyond JavaScript's safe integer range.
    uid: String(
      /"uid": (\d+)/.exec(fixture("initial").boards[0].keymaps[0].vil)![1],
    ),
    layers: ["Base", "Sym", "Nav", "Stack", "Num"],
  });
});
