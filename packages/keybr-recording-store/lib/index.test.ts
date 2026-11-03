import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  fixtureSnapshots,
  type RecordingBatch,
  type RecordingRecord,
} from "@keybr/recording";
import { RecordingConflict, RecordingStore } from "./index.ts";

const records: RecordingRecord[] = JSON.parse(
  readFileSync(
    new URL("../../keybr-recording/fixtures/v1.json", import.meta.url),
    "utf8",
  ),
).scenarios[0].expected.records;
function batch(value = records): RecordingBatch {
  return {
    schemaVersion: 1,
    snapshots: fixtureSnapshots,
    records: value,
    recovery: [],
  };
}
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "keybr-recording-"));
  const filename = join(dir, "recordings.sqlite");
  const store = new RecordingStore(filename);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, filename, store };
}

test("transactional, reordered, overlapping and lost-acknowledgement delivery survives restart", (t) => {
  const { store, filename } = setup(t);
  store.append(batch(records.slice(3).toReversed()));
  const ack = store.append(batch(records.slice(0, 6)));
  assert.equal(ack.records.length, 6);
  const second = new RecordingStore(filename);
  t.after(() => second.close());
  second.append(batch());
  second.append(batch());
  assert.equal(
    second.database.prepare("SELECT count(*) AS n FROM records").get()!.n,
    records.length,
  );
  assert.deepEqual(
    second.database
      .prepare("SELECT json FROM records ORDER BY sequence")
      .all()
      .map((r) => JSON.parse(String(r.json))),
    records,
  );
});

test("conflict rolls back all records and snapshots, with no acknowledgement", (t) => {
  const { store } = setup(t);
  store.append(batch([records[0]]));
  assert.throws(
    () => store.append(batch([records[1], { ...records[0], observedAt: -1 }])),
    RecordingConflict,
  );
  assert.equal(
    store.database.prepare("SELECT count(*) AS n FROM records").get()!.n,
    1,
  );
  const conflicting = batch([]);
  conflicting.snapshots = [
    { ...fixtureSnapshots[0], configuration: { changed: true } },
  ];
  assert.throws(() => store.append(conflicting), RecordingConflict);
  assert.throws(() => store.append({ ...batch(), schemaVersion: 2 }));
  assert.throws(() => store.append(batch(Array(129).fill(records[0]))));
  assert.throws(() =>
    store.append(
      batch([
        {
          ...records[0],
          context: {
            ...(records[0].type === "start" ? records[0].context : {}),
            text: "a".repeat(300000),
          },
        } as RecordingRecord,
      ]),
    ),
  );
});

test("immutable keyboard snapshots are required for referenced versions", (t) => {
  const { store } = setup(t);
  const start = records[0];
  assert.equal(start.type, "start");
  if (start.type !== "start") return;
  const referenced = {
    ...start,
    context: { ...start.context, board: { id: "fixture-board", version: "1" } },
  };
  assert.throws(
    () => store.append({ ...batch([referenced]), snapshots: [] }),
    /Missing keyboard/,
  );
  store.append(batch([referenced]));
  assert.equal(
    store.database.prepare("SELECT count(*) AS n FROM snapshots").get()!.n,
    2,
  );
});

test("export contains committed WAL data, configuration, recovery and version; Python can read it with writer open", (t) => {
  const { dir, filename, store } = setup(t);
  store.database.exec("PRAGMA wal_autocheckpoint=0");
  store.append({
    ...batch(),
    recovery: [
      { attemptId: records[0].attemptId, incomplete: true, interrupted: true },
    ],
  });
  const output = join(dir, "export.sqlite");
  store.export(output);
  const writer = new RecordingStore(filename);
  writer.append(
    batch([
      { ...records[0], attemptId: "00000000-0000-4000-8000-000000000099" },
    ]),
  );
  writer.close();
  const actual = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1])
print(json.dumps([c.execute('pragma user_version').fetchone()[0], c.execute('select count(*) from records').fetchone()[0], c.execute('select count(*) from snapshots').fetchone()[0], list(c.execute('select incomplete, interrupted from attempts').fetchone())]))
`,
        output,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(actual, [2, records.length, 2, [1, 1]]);
  assert.throws(() => store.export(filename), /different file/);
  assert.throws(() => store.export(output));
});

test("unsupported and unversioned database schemas are rejected", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keybr-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const version of [0, 3]) {
    const filename = join(dir, `${version}.sqlite`);
    const db = new DatabaseSync(filename);
    db.exec(`CREATE TABLE unknown (id TEXT); PRAGMA user_version=${version}`);
    db.close();
    assert.throws(
      () => new RecordingStore(filename),
      /Unsupported|Unversioned/,
    );
  }
});
