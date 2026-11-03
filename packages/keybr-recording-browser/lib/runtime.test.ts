import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { locks } from "node:worker_threads";
import { fixtureSnapshots, type RecordingRecord } from "@keybr/recording";
import { IDBFactory } from "fake-indexeddb";
import { RecordingQueue } from "./queue.ts";
import { RecordingRuntime } from "./runtime.ts";

const config = {
  enabled: true,
  schemaVersion: 1,
  snapshots: fixtureSnapshots,
  applicationRevision: "test",
  board: null,
  keymap: null,
};
const start = (): RecordingRecord => ({
  schemaVersion: 1,
  attemptId: crypto.randomUUID(),
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
const offline: typeof fetch = async (url) => {
  if (url === "/_/recording/config") return Response.json(config);
  throw new Error("offline");
};
function installLocks(t: { after: (fn: () => void) => void }) {
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  t.after(() => {
    if (previous) Object.defineProperty(navigator, "locks", previous);
    else Reflect.deleteProperty(navigator, "locks");
  });
}

test("disabled recording never opens browser storage or installs a sink", async () => {
  const runtime = new RecordingRuntime(
    async () => Response.json({ enabled: false }),
    async () => {
      throw new Error("Must not open storage");
    },
  );
  await runtime.start();
  assert.deepEqual(runtime.state, { options: null, status: null });
  runtime.close();
});

test("quota failure is visible, marks incomplete, and preserves earlier queued data without blocking the sink", async (t) => {
  installLocks(t);
  const queue = await RecordingQueue.open(new IDBFactory());
  const runtime = new RecordingRuntime(offline, async () => queue);
  t.after(() => runtime.close());
  await runtime.start();
  const record = start();
  assert.ok(runtime.state.options);
  assert.equal(runtime.state.options.onRecord(record), undefined);
  assert.equal((await queue.status()).queued, 1);
  const failure = t.mock.method(queue, "enqueue", async () => {
    throw new DOMException("Quota exhausted", "QuotaExceededError");
  });
  assert.equal(
    runtime.state.options.onRecord({ ...record, sequence: 1 }),
    undefined,
  );
  await setImmediate();
  await runtime.tick();
  assert.match(runtime.state.status!, /storage failure.*incomplete.*Quota/);
  assert.match(runtime.state.status!, /1 queued records/);
  assert.equal((await queue.status()).incomplete, 1);
  assert.equal((await queue.status()).queued, 1);
  failure.mock.restore();
});

test("later tabs distinguish a live owner from an interrupted Attempt without inventing lifecycle records", async (t) => {
  installLocks(t);
  const factory = new IDBFactory();
  const first = new RecordingRuntime(offline, () =>
    RecordingQueue.open(factory),
  );
  t.after(() => first.close());
  await first.start();
  first.state.options!.onRecord(start());
  const inspect = await RecordingQueue.open(factory);
  t.after(() => inspect.close());
  assert.equal((await inspect.status()).queued, 1);
  const second = new RecordingRuntime(offline, () =>
    RecordingQueue.open(factory),
  );
  t.after(() => second.close());
  await second.start();
  assert.equal((await inspect.status()).interrupted, 0);
  first.close();
  await setImmediate();
  const third = new RecordingRuntime(offline, () =>
    RecordingQueue.open(factory),
  );
  t.after(() => third.close());
  await third.start();
  assert.equal((await inspect.status()).interrupted, 1);
  assert.equal(
    (await inspect.batch()).records.some((r) => r.type === "end"),
    false,
  );
  assert.match(third.state.status!, /1 interrupted/);
});

test("initial storage failures report unavailable recording and keep practice unobserved", async (t) => {
  installLocks(t);
  const runtime = new RecordingRuntime(offline, async () => {
    throw new DOMException("Unavailable", "SecurityError");
  });
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(runtime.state.options, null);
  assert.match(
    runtime.state.status!,
    /Browser recording unavailable.*SecurityError/,
  );
});

test("offline reload uses the last enabled configuration; a disabled response clears it", async (t) => {
  installLocks(t);
  const factory = new IDBFactory();
  const first = new RecordingRuntime(offline, () =>
    RecordingQueue.open(factory),
  );
  t.after(() => first.close());
  await first.start();
  first.state.options!.onRecord(start());
  const inspect = await RecordingQueue.open(factory);
  t.after(() => inspect.close());
  await inspect.status();
  window.dispatchEvent(new window.Event("pagehide"));
  await setImmediate();
  first.close();
  await setImmediate();
  const reloaded = new RecordingRuntime(
    async () => {
      throw new Error("Server down");
    },
    () => RecordingQueue.open(factory),
  );
  t.after(() => reloaded.close());
  await reloaded.start();
  assert.ok(reloaded.state.options);
  assert.match(reloaded.state.status!, /1 queued records/);
  reloaded.state.options.onRecord(start());
  assert.equal((await inspect.status()).queued, 2);
  const disabled = new RecordingRuntime(async () =>
    Response.json({ enabled: false }),
  );
  await disabled.start();
  disabled.close();
  assert.equal(
    window.localStorage.getItem("keybr-detailed-recording-config"),
    null,
  );
});

test("configuration failure without an enabled cache stays silent", async () => {
  window.localStorage.clear();
  const runtime = new RecordingRuntime(async () => {
    throw new TypeError("Failed to fetch");
  });
  await runtime.start();
  assert.deepEqual(runtime.state, { options: null, status: null });
  runtime.close();
});
