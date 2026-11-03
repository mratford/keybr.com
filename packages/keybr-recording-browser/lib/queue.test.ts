import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixtureSnapshots,
  type RecordingBatch,
  type RecordingRecord,
} from "@keybr/recording";
import { IDBFactory } from "fake-indexeddb";
import { RecordingDelivery } from "./delivery.ts";
import { RecordingQueue } from "./queue.ts";

const start = (id = crypto.randomUUID()): RecordingRecord => ({
  schemaVersion: 1,
  attemptId: id,
  sequence: 0,
  observedAt: 0,
  type: "start",
  context: {
    text: "abc",
    applicationRevision: "test",
    board: null,
    keymap: null,
    settings: { typing: {}, exercise: {}, layout: {} },
  },
});
const end = (record: RecordingRecord): RecordingRecord => ({
  schemaVersion: 1,
  attemptId: record.attemptId,
  sequence: 1,
  observedAt: 1,
  type: "end",
  reason: "reset",
  result: null,
  resultAccepted: null,
});
const ack = (batch: RecordingBatch) => ({
  records: batch.records.map(({ attemptId, sequence }) => ({
    attemptId,
    sequence,
  })),
  recovery: batch.recovery,
});

test("reload, failed page exit and concurrent tab acknowledgements preserve newer records", async () => {
  const factory = new IDBFactory();
  const first = await RecordingQueue.open(factory);
  const record = start();
  await first.enqueue(record, "tab-1", fixtureSnapshots);
  const inFlight = await first.batch();
  // Page exits without acknowledgement. A second connection reopens the same queue.
  const second = await RecordingQueue.open(factory);
  await second.enqueue(end(record), "tab-1", fixtureSnapshots);
  const other = start();
  await second.enqueue(other, "tab-2", fixtureSnapshots);
  await first.acknowledge(inFlight, ack(inFlight));
  await second.acknowledge(inFlight, ack(inFlight));
  assert.deepEqual(
    (await second.batch()).records.map((r) => [r.attemptId, r.sequence]).sort(),
    [
      [record.attemptId, 1],
      [other.attemptId, 0],
    ].sort(),
  );
  first.close();
  second.close();
  const reopened = await RecordingQueue.open(factory);
  assert.equal((await reopened.status()).queued, 2);
  await reopened.interrupt("tab-2");
  assert.equal((await reopened.status()).interrupted, 1);
  assert.equal(
    (await reopened.batch()).records.filter((r) => r.type === "end").length,
    1,
  );
  reopened.close();
});

test("lost acknowledgement retries exactly the committed batch, without loss or duplication", async () => {
  const queue = await RecordingQueue.open(new IDBFactory());
  await queue.enqueue(start(), "owner", fixtureSnapshots);
  const stored = new Map();
  let calls = 0;
  const delivery = new RecordingDelivery(queue, async (_url, options) => {
    const batch: RecordingBatch = JSON.parse(String(options!.body));
    for (const r of batch.records)
      stored.set(`${r.attemptId}:${r.sequence}`, r);
    if (++calls === 1) throw new Error("Acknowledgement lost");
    return Response.json(ack(batch));
  });
  await assert.rejects(delivery.flush(), /lost/);
  assert.equal((await queue.status()).queued, 1);
  await delivery.flush();
  assert.equal(stored.size, 1);
  assert.equal((await queue.status()).queued, 0);
  queue.close();
});

test("transient errors retry and terminal validation errors retain all queued data", async () => {
  for (const status of [400, 409, 413, 422, 500, 429]) {
    const queue = await RecordingQueue.open(new IDBFactory());
    await queue.enqueue(start(), "owner", fixtureSnapshots);
    let calls = 0;
    const delivery = new RecordingDelivery(queue, async () => {
      calls++;
      return new Response("rejected", { status });
    });
    await assert.rejects(delivery.flush(), new RegExp(String(status)));
    assert.equal((await queue.status()).queued, 1);
    await delivery.flush().catch(() => {});
    assert.equal(calls, status >= 500 || status === 429 ? 2 : 1);
    queue.close();
  }
});

test("bounded batches and exit payloads leave all unacknowledged records durable", async () => {
  const queue = await RecordingQueue.open(new IDBFactory());
  for (let n = 0; n < 140; n++)
    await queue.enqueue(start(), "owner", fixtureSnapshots);
  const batch = await queue.batch();
  assert.equal(batch.records.length, 128);
  const small = await queue.batch(2000);
  assert.ok(new TextEncoder().encode(JSON.stringify(small)).length <= 2000);
  assert.ok(small.records.length < 128);
  await queue.acknowledge(small, ack(small));
  assert.equal((await queue.status()).queued, 140 - small.records.length);
  queue.close();
});

test("storage abort preserves existing queue; incomplete/interrupted notices survive reload and exact ack", async () => {
  const factory = new IDBFactory();
  const queue = await RecordingQueue.open(factory);
  const record = start();
  await queue.enqueue(record, "owner", fixtureSnapshots);
  await assert.rejects(queue.enqueue(record, "owner", fixtureSnapshots));
  assert.equal((await queue.status()).queued, 1);
  await queue.markIncomplete(record.attemptId, "owner");
  const inFlight = await queue.batch();
  await queue.interrupt("owner");
  await queue.acknowledge(inFlight, ack(inFlight));
  const remaining = await queue.batch();
  assert.ok(remaining.recovery.some((r) => r.incomplete && r.interrupted));
  assert.equal(remaining.records.length, 0);
  queue.close();
  const reopened = await RecordingQueue.open(factory);
  assert.equal((await reopened.status()).incomplete, 1);
  assert.equal((await reopened.status()).interrupted, 1);
  assert.equal((await reopened.batch()).recovery.length, 1);
  reopened.close();
});

test("snapshots are immutable and unsupported browser schemas are rejected", async () => {
  const factory = new IDBFactory();
  const queue = await RecordingQueue.open(factory);
  await queue.enqueue(start(), "owner", fixtureSnapshots);
  await assert.rejects(
    queue.enqueue(start(), "owner", [
      { ...fixtureSnapshots[0], configuration: "changed" },
    ]),
  );
  assert.equal((await queue.status()).queued, 1);
  queue.close();
  await new Promise<void>((resolve) => {
    const request = factory.open("future", 2);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
  await assert.rejects(RecordingQueue.open(factory, "future"), /Unsupported/);
});

test("acknowledgements cannot remove identities outside the request", async () => {
  const queue = await RecordingQueue.open(new IDBFactory());
  await queue.enqueue(start(), "owner", fixtureSnapshots);
  const batch = await queue.batch();
  await assert.rejects(
    queue.acknowledge(batch, {
      records: [{ attemptId: crypto.randomUUID(), sequence: 0 }],
      recovery: [],
    }),
    /Invalid/,
  );
  assert.equal((await queue.status()).queued, 1);
  queue.close();
});

test("batches include only referenced snapshots and stop at sixteen versions", async () => {
  const queue = await RecordingQueue.open(new IDBFactory());
  for (let n = 0; n < 20; n++) {
    const snapshot = { ...fixtureSnapshots[0], version: String(n) };
    const record = start();
    if (record.type !== "start") throw new Error("Expected start");
    record.context.board = { id: snapshot.id, version: snapshot.version };
    await queue.enqueue(record, "owner", [snapshot]);
  }
  const batch = await queue.batch();
  assert.equal(batch.snapshots.length, 16);
  assert.equal(batch.records.length, 16);
  await queue.acknowledge(batch, ack(batch));
  const next = await queue.batch();
  assert.equal(next.snapshots.length, 4);
  assert.equal(next.records.length, 4);
  queue.close();
});

test("acknowledgement prunes finished attempts and pending recovery counts", async () => {
  const queue = await RecordingQueue.open(new IDBFactory());
  const record = start();
  await queue.enqueue(record, "owner", []);
  await queue.enqueue(end(record), "owner", []);
  await queue.markIncomplete(record.attemptId, "owner");
  const batch = await queue.batch();
  await queue.acknowledge(batch, ack(batch));
  assert.deepEqual(await queue.status(), {
    queued: 0,
    notices: 0,
    incomplete: 0,
    interrupted: 0,
  });
  const request = queue.database
    .transaction("attempts")
    .objectStore("attempts")
    .count();
  assert.equal(
    await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    }),
    0,
  );
  queue.close();
});

test("page exit starts keepalive synchronously while normal delivery is in flight", async () => {
  const queue = await RecordingQueue.open(new IDBFactory());
  await queue.enqueue(start(), "owner", []);
  let calls = 0;
  let finish!: (response: Response) => void;
  const delivery = new RecordingDelivery(queue, (_url, options) => {
    calls++;
    if (options?.keepalive) return Promise.resolve(new Response());
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await delivery.prepareExit();
  const sending = delivery.flush();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const exit = delivery.flush(true);
  assert.equal(calls, 2);
  await exit;
  const batch = await queue.batch();
  finish(Response.json(ack(batch)));
  await sending;
  queue.close();
});

test("acknowledgement cleanup uses bounded counts without scanning the backlog", async (t) => {
  const queue = await RecordingQueue.open(new IDBFactory());
  t.after(() => queue.close());
  const record = start();
  await queue.enqueue(record, "owner", [], true);
  await queue.enqueue(end(record), "owner", []);
  const batch = await queue.batch();
  for (let n = 0; n < 300; n++) await queue.enqueue(start(), "other", []);
  const store = queue.database.transaction("records").objectStore("records");
  const prototype = Object.getPrototypeOf(store);
  const cursors = t.mock.method(prototype, "openCursor", () => {
    throw new Error("Acknowledgement must not scan the queue");
  });
  const counts = t.mock.method(prototype, "count");
  await queue.acknowledge(batch, ack(batch));
  assert.equal(cursors.mock.callCount(), 0);
  assert.equal(counts.mock.callCount(), 5);
  counts.mock.restore();
  cursors.mock.restore();
  assert.equal((await queue.status()).queued, 300);
  assert.equal((await queue.status()).notices, 0);
});
