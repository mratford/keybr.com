import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { locks } from "node:worker_threads";
import { type KeyboardCatalogue, type RecordingRecord } from "@keybr/recording";
import { IDBFactory } from "fake-indexeddb";
import { RecordingDelivery } from "./delivery.ts";
import { RecordingQueue } from "./queue.ts";
import { RecordingRuntime, selectionKey } from "./runtime.ts";

const layout = (letterLayout: string, vil: string, definition = "d1") => ({
  board: { id: "Sweep", version: definition.repeat(32) },
  keymap: {
    id: `Sweep/${letterLayout}`,
    version: `${vil}${definition}`.repeat(16),
  },
  letterLayout,
  layers: [],
  vilHash: vil.repeat(32),
});
const keyboards: KeyboardCatalogue = [
  {
    id: "Sweep",
    name: "Sweep",
    layouts: [layout("free-range", "a1"), layout("QWERTY", "b2")],
  },
  { id: "Q4", name: "Q4", layouts: [layout("QWERTY", "c3")] },
];
const config = {
  enabled: true,
  schemaVersion: 1,
  applicationRevision: "test",
  keyboards,
};
const freeRange = { keyboard: "Sweep", keymap: keyboards[0].layouts[0].keymap };
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
/** Web Locks for enabled runtimes, and a remembered valid keyboard selection. */
function installLocks(t: { after: (fn: () => void) => void }) {
  window.localStorage.setItem(selectionKey, JSON.stringify(freeRange));
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
  assert.deepEqual(runtime.state, {
    options: null,
    activity: null,
    status: null,
    keyboards: null,
    selection: null,
  });
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
  assert.deepEqual(runtime.state, {
    options: null,
    activity: null,
    status: null,
    keyboards: null,
    selection: null,
  });
  runtime.close();
});

test("committed incomplete end clears failed retries before acknowledgement prunes the attempt", async (t) => {
  installLocks(t);
  const queue = await RecordingQueue.open(new IDBFactory());
  const runtime = new RecordingRuntime(offline, async () => queue);
  t.after(() => runtime.close());
  await runtime.start();
  const record = start();
  runtime.state.options!.onRecord(record);
  await queue.status();
  const owner = (await queue.owners())[0];
  const enqueue = t.mock.method(queue, "enqueue", async () => {
    throw new Error("quota");
  });
  const mark = t.mock.method(queue, "markIncomplete", async () => {
    throw new Error("quota");
  });
  runtime.state.options!.onRecord({ ...record, sequence: 1 });
  await setImmediate();
  enqueue.mock.restore();
  runtime.state.options!.onRecord({
    schemaVersion: 1,
    attemptId: record.attemptId,
    sequence: 2,
    observedAt: 2,
    type: "end",
    reason: "reset",
    result: null,
    resultAccepted: null,
  });
  const batch = await queue.batch();
  await setImmediate();
  await queue.acknowledge(batch, {
    records: batch.records.map(({ attemptId, sequence }) => ({
      attemptId,
      sequence,
    })),
    recovery: batch.recovery,
  });
  mark.mock.restore();
  const retry = t.mock.method(queue, "markIncomplete");
  await runtime.tick();
  assert.equal(retry.mock.callCount(), 0);
  assert.deepEqual(await queue.owners(), []);
  await queue.interrupt(owner);
  assert.deepEqual(await queue.status(), {
    queued: 0,
    notices: 0,
    incomplete: 0,
    interrupted: 0,
  });
});

test("typing and normal flush do not prepare exit batches; hidden events coalesce", async (t) => {
  installLocks(t);
  const queue = await RecordingQueue.open(new IDBFactory());
  let keepalives = 0;
  const runtime = new RecordingRuntime(
    async (url, options) => {
      if (url === "/_/recording/config") return Response.json(config);
      if (options?.keepalive) {
        keepalives++;
        const batch = JSON.parse(String(options.body));
        return Response.json({
          records: batch.records.map(
            ({ attemptId, sequence }: RecordingRecord) => ({
              attemptId,
              sequence,
            }),
          ),
          recovery: batch.recovery,
        });
      }
      throw new Error("offline");
    },
    async () => queue,
  );
  t.after(() => runtime.close());
  await runtime.start();
  const batch = t.mock.method(queue, "batch");
  runtime.state.options!.onRecord(start());
  await queue.status();
  await setImmediate();
  assert.equal(batch.mock.callCount(), 0);
  await runtime.tick();
  assert.equal(batch.mock.callCount(), 1);
  assert.deepEqual(batch.mock.calls[0].arguments, []);
  t.mock.getter(document, "visibilityState", () => "hidden");
  document.dispatchEvent(new window.Event("visibilitychange"));
  document.dispatchEvent(new window.Event("visibilitychange"));
  // A queue read acts as a barrier after the hidden handler's read transaction.
  await queue.status();
  await setImmediate();
  assert.equal(batch.mock.callCount(), 2);
  assert.deepEqual(batch.mock.calls[1].arguments, [48000]);
  assert.equal(keepalives, 1);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(keepalives, 1);
});

test("same-turn failed keystroke and committed end cannot resurrect a pruned attempt", async (t) => {
  installLocks(t);
  const queue = await RecordingQueue.open(new IDBFactory());
  const runtime = new RecordingRuntime(offline, async () => queue);
  t.after(() => runtime.close());
  await runtime.start();
  const record = start();
  runtime.state.options!.onRecord(record);
  await queue.status();
  const owner = (await queue.owners())[0];
  const enqueue = queue.enqueue.bind(queue);
  const writes = t.mock.method(
    queue,
    "enqueue",
    (...args: Parameters<RecordingQueue["enqueue"]>) => {
      if (args[0].sequence === 1) return Promise.reject(new Error("quota"));
      return enqueue(...args);
    },
  );
  const marker = t.mock.method(queue, "markIncomplete", async () => {
    throw new Error("quota");
  });
  // Both calls capture incomplete=false before either promise settles.
  runtime.state.options!.onRecord({ ...record, sequence: 1 });
  runtime.state.options!.onRecord({
    schemaVersion: 1,
    attemptId: record.attemptId,
    sequence: 2,
    observedAt: 2,
    type: "end",
    reason: "reset",
    result: null,
    resultAccepted: null,
  });
  const batch = await queue.batch();
  await setImmediate();
  assert.deepEqual(
    writes.mock.calls.map((call) => call.arguments[3]),
    [false, false],
  );
  assert.equal(marker.mock.callCount(), 1);
  assert.deepEqual(
    batch.records.map((record) => record.type),
    ["start", "end"],
  );
  assert.equal(batch.recovery.length, 0);
  await queue.acknowledge(batch, {
    records: batch.records.map(({ attemptId, sequence }) => ({
      attemptId,
      sequence,
    })),
    recovery: batch.recovery,
  });
  marker.mock.restore();
  await runtime.tick();
  assert.deepEqual(await queue.owners(), []);
  await queue.interrupt(owner);
  assert.deepEqual(await queue.status(), {
    queued: 0,
    notices: 1,
    incomplete: 1,
    interrupted: 0,
  });
  assert.deepEqual((await queue.batch()).recovery, [
    {
      attemptId: record.attemptId,
      incomplete: true,
      interrupted: false,
    },
  ]);
});

test("recording waits for a keyboard and layout selection; ordinary practice is unobserved", async (t) => {
  installLocks(t);
  window.localStorage.removeItem(selectionKey);
  const queue = await RecordingQueue.open(new IDBFactory());
  const runtime = new RecordingRuntime(offline, async () => queue);
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(runtime.state.options, null);
  assert.deepEqual(runtime.state.keyboards, keyboards);
  assert.deepEqual(runtime.state.activity, { type: "choose-keyboard" });

  runtime.select({ keyboard: "Sweep", keymap: null });
  assert.equal(runtime.state.options, null);
  assert.deepEqual(runtime.state.activity, {
    type: "choose-layout",
    keyboard: "Sweep",
  });

  runtime.select(freeRange);
  const options = runtime.state.options!;
  assert.deepEqual(
    [options.board, options.keymap, options.applicationRevision],
    [keyboards[0].layouts[0].board, freeRange.keymap, "test"],
  );
  assert.deepEqual(runtime.state.activity, {
    type: "active",
    keyboard: keyboards[0],
    layout: keyboards[0].layouts[0],
  });
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(selectionKey)!),
    freeRange,
  );
  // Reselecting the same context keeps the recorder, so practice is not reset.
  runtime.select({ ...freeRange });
  assert.equal(runtime.state.options, options);
  runtime.select(null);
  assert.equal(runtime.state.options, null);
  assert.equal(window.localStorage.getItem(selectionKey), null);
});

test("a remembered selection survives reload, including offline reloads", async (t) => {
  installLocks(t);
  const factory = new IDBFactory();
  const qwerty = { keyboard: "Sweep", keymap: keyboards[0].layouts[1].keymap };
  const first = new RecordingRuntime(offline, () =>
    RecordingQueue.open(factory),
  );
  t.after(() => first.close());
  await first.start();
  first.select(qwerty);
  first.close();
  for (const request of [
    offline,
    async () => {
      throw new Error("Server down");
    },
  ]) {
    const reloaded = new RecordingRuntime(request, () =>
      RecordingQueue.open(factory),
    );
    t.after(() => reloaded.close());
    await reloaded.start();
    assert.deepEqual(reloaded.state.selection, qwerty);
    assert.deepEqual(reloaded.state.options?.keymap, qwerty.keymap);
    reloaded.close();
  }
});

test("an unavailable remembered selection is visible and never replaced by another configuration", async (t) => {
  installLocks(t);
  for (const [remembered, activity] of [
    // A layout version no longer offered, although Q4 has exactly one other layout.
    [
      { keyboard: "Q4", keymap: { id: "Q4/QWERTY", version: "gone" } },
      {
        type: "layout-unavailable",
        keymap: { id: "Q4/QWERTY", version: "gone" },
      },
    ],
    // A keyboard no longer offered.
    [
      { keyboard: "Sofle", keymap: { id: "Sofle/free-range", version: "x" } },
      { type: "keyboard-unavailable", keyboard: "Sofle" },
    ],
  ] as const) {
    window.localStorage.setItem(selectionKey, JSON.stringify(remembered));
    const runtime = new RecordingRuntime(offline, () =>
      RecordingQueue.open(new IDBFactory()),
    );
    t.after(() => runtime.close());
    await runtime.start();
    assert.equal(runtime.state.options, null);
    assert.deepEqual(runtime.state.selection, remembered);
    assert.deepEqual(runtime.state.activity, activity);
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem(selectionKey)!),
      remembered,
    );
    runtime.close();
  }
});

test("default requests call fetch as browsers require, not as a method", async (t) => {
  window.localStorage.removeItem(selectionKey);
  // Browsers reject fetch called with any receiver other than the global object.
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", function (this: unknown, url: string) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError(
        "Failed to execute 'fetch' on 'Window': Illegal invocation",
      );
    calls.push(url);
    return Promise.resolve(Response.json({ enabled: false }));
  });
  const runtime = new RecordingRuntime();
  await runtime.start();
  runtime.close();
  assert.deepEqual(calls, ["/_/recording/config"]);
  const queue = await RecordingQueue.open(new IDBFactory());
  t.after(() => queue.close());
  await queue.enqueue(start(), "owner", []);
  await assert.rejects(
    new RecordingDelivery(queue).flush(),
    /Invalid recording acknowledgement/,
  );
  assert.deepEqual(calls, ["/_/recording/config", "/_/recording/batches"]);
});
