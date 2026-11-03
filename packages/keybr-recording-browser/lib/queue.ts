import {
  canonicalJson,
  maxBatchBytes,
  type RecordingBatch,
  type RecordingRecord,
  schemaVersion,
} from "@keybr/recording";

type Attempt = {
  id: string;
  owner: string;
  ended: boolean;
  incomplete: boolean;
  interrupted: boolean;
};
type Notice = RecordingBatch["recovery"][number];

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Recording transaction aborted"));
    tx.onerror = () => {
      /* onabort reports the transaction outcome. */
    };
  });
}

/** Every mutation is transactional across tabs; an acknowledgement deletes exact identities. */
export class RecordingQueue {
  private constructor(readonly database: IDBDatabase) {}

  static async open(factory = indexedDB, name = "keybr-detailed-recording") {
    const request = factory.open(name);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        request.transaction!.abort();
        return;
      }
      const db = request.result;
      db.createObjectStore("records", { keyPath: ["attemptId", "sequence"] });
      db.createObjectStore("attempts", { keyPath: "id" });
      db.createObjectStore("notices");
      db.createObjectStore("snapshots", { keyPath: ["kind", "id", "version"] });
    };
    const db = await result(request);
    if (db.version !== 1) {
      db.close();
      throw new Error(`Unsupported browser recording schema ${db.version}`);
    }
    db.onversionchange = () => db.close();
    return new RecordingQueue(db);
  }

  async enqueue(
    record: RecordingRecord,
    owner: string,
    snapshots: RecordingBatch["snapshots"],
    incomplete = false,
  ) {
    const tx = this.database.transaction(
      ["records", "attempts", "notices", "snapshots"],
      "readwrite",
    );
    const done = committed(tx);
    const attempts = tx.objectStore("attempts");
    const request = attempts.get(record.attemptId);
    request.onsuccess = () => {
      const attempt: Attempt = request.result ?? {
        id: record.attemptId,
        owner,
        ended: false,
        incomplete: false,
        interrupted: false,
      };
      attempt.ended ||= record.type === "end";
      attempt.incomplete ||= incomplete;
      attempts.put(attempt);
      if (attempt.incomplete) this.notice(tx, attempt);
    };
    tx.objectStore("records").add(record);
    for (const snapshot of snapshots) {
      const store = tx.objectStore("snapshots");
      const existing = store.get([
        snapshot.kind,
        snapshot.id,
        snapshot.version,
      ]);
      existing.onsuccess = () => {
        if (
          existing.result &&
          canonicalJson(existing.result) !== canonicalJson(snapshot)
        )
          tx.abort();
        else if (!existing.result) store.add(snapshot);
      };
    }
    await done;
  }

  async markIncomplete(id: string) {
    const tx = this.database.transaction(["attempts", "notices"], "readwrite");
    const done = committed(tx);
    const store = tx.objectStore("attempts");
    const request = store.get(id);
    request.onsuccess = () => {
      const attempt: Attempt | undefined = request.result;
      if (attempt) {
        attempt.incomplete = true;
        store.put(attempt);
      }
      // A failed write may refer to an already pruned or never persisted attempt.
      // Preserve its recovery notice without inventing an unended attempt.
      this.notice(tx, {
        id,
        incomplete: true,
        interrupted: attempt?.interrupted ?? false,
      });
    };
    await done;
  }

  private notice(
    tx: IDBTransaction,
    attempt: Pick<Attempt, "id" | "incomplete" | "interrupted">,
  ) {
    const value: Notice = {
      attemptId: attempt.id,
      incomplete: attempt.incomplete,
      interrupted: attempt.interrupted,
    };
    tx.objectStore("notices").put(value, canonicalJson(value));
  }

  async owners(): Promise<string[]> {
    const tx = this.database.transaction("attempts");
    const attempts = await result<Attempt[]>(
      tx.objectStore("attempts").getAll(),
    );
    return [
      ...new Set(
        attempts.filter((a) => !a.ended && !a.interrupted).map((a) => a.owner),
      ),
    ];
  }

  /** Caller holds the former owner's exclusive Web Lock, proving it is no longer active. */
  async interrupt(owner: string) {
    const tx = this.database.transaction(["attempts", "notices"], "readwrite");
    const done = committed(tx);
    const request = tx.objectStore("attempts").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const attempt: Attempt = cursor.value;
      if (attempt.owner === owner && !attempt.ended && !attempt.interrupted) {
        attempt.interrupted = true;
        cursor.update(attempt);
        this.notice(tx, attempt);
      }
      cursor.continue();
    };
    await done;
  }

  async batch(byteLimit = maxBatchBytes): Promise<RecordingBatch> {
    const tx = this.database.transaction(["records", "notices", "snapshots"]);
    const [records, recovery, snapshots] = await Promise.all([
      result<RecordingRecord[]>(
        tx.objectStore("records").getAll(undefined, 128),
      ),
      result<Notice[]>(tx.objectStore("notices").getAll(undefined, 128)),
      result<RecordingBatch["snapshots"]>(tx.objectStore("snapshots").getAll()),
    ]);
    const batch: RecordingBatch = {
      schemaVersion,
      snapshots: [],
      records: [],
      recovery: [],
    };
    const encoder = new TextEncoder();
    const bytes = (value: unknown) =>
      encoder.encode(JSON.stringify(value)).length;
    let size = bytes(batch);
    for (const notice of recovery) {
      const extra = bytes(notice) + Number(batch.recovery.length > 0);
      if (size + extra > byteLimit) break;
      batch.recovery.push(notice);
      size += extra;
    }
    for (const record of records) {
      const needed = snapshots.filter(
        (snapshot) =>
          record.type === "start" &&
          record.context[snapshot.kind]?.id === snapshot.id &&
          record.context[snapshot.kind]?.version === snapshot.version &&
          !batch.snapshots.includes(snapshot),
      );
      const extra =
        bytes(record) +
        Number(batch.records.length > 0) +
        needed.reduce(
          (sum, snapshot, index) =>
            sum + bytes(snapshot) + Number(batch.snapshots.length + index > 0),
          0,
        );
      if (
        size + extra > byteLimit ||
        batch.snapshots.length + needed.length > 16
      ) {
        if (
          !batch.records.length &&
          !batch.recovery.length &&
          byteLimit === maxBatchBytes
        )
          throw new Error(
            "Recording record exceeds transport limit; retained in browser",
          );
        break;
      }
      batch.records.push(record);
      batch.snapshots.push(...needed);
      size += extra;
    }
    return batch;
  }

  async acknowledge(
    batch: RecordingBatch,
    ack: {
      records: { attemptId: string; sequence: number }[];
      recovery: Notice[];
    },
  ) {
    // Never trust an acknowledgement for an identity outside this exact request.
    const records = new Set(
      batch.records.map((r) => canonicalJson([r.attemptId, r.sequence])),
    );
    const notices = new Set(batch.recovery.map(canonicalJson));
    if (
      !Array.isArray(ack.records) ||
      !Array.isArray(ack.recovery) ||
      ack.records.length !== batch.records.length ||
      ack.recovery.length !== batch.recovery.length ||
      new Set(ack.records.map((r) => canonicalJson([r.attemptId, r.sequence])))
        .size !== records.size ||
      new Set(ack.recovery.map(canonicalJson)).size !== notices.size ||
      ack.records.some(
        (r) => !records.has(canonicalJson([r.attemptId, r.sequence])),
      ) ||
      ack.recovery.some((r) => !notices.has(canonicalJson(r)))
    )
      throw new Error("Invalid recording acknowledgement");
    const tx = this.database.transaction(
      ["records", "notices", "attempts"],
      "readwrite",
    );
    const done = committed(tx);
    for (const record of ack.records)
      tx.objectStore("records").delete([record.attemptId, record.sequence]);
    for (const notice of ack.recovery)
      tx.objectStore("notices").delete(canonicalJson(notice));
    // Only these attempts can have become empty after the exact deletions above.
    const affected = new Set(
      [...ack.records, ...ack.recovery].map(({ attemptId }) => attemptId),
    );
    for (const id of affected) {
      const request = tx.objectStore("attempts").get(id);
      request.onsuccess = () => {
        const attempt: Attempt | undefined = request.result;
        if (!attempt || (!attempt.ended && !attempt.interrupted)) return;
        const records = tx
          .objectStore("records")
          .count(IDBKeyRange.bound([id], [id, Infinity]));
        // Notice keys are canonical JSON of these three fields. Check the four
        // possible identities directly, preserving the existing browser schema.
        const notices = [];
        for (const incomplete of [false, true]) {
          for (const interrupted of [false, true]) {
            notices.push(
              tx.objectStore("notices").count(
                canonicalJson({
                  attemptId: id,
                  incomplete,
                  interrupted,
                }),
              ),
            );
          }
        }
        let remaining = notices.length + 1;
        let pending = 0;
        for (const count of [records, ...notices]) {
          count.onsuccess = () => {
            pending += count.result;
            if (--remaining === 0 && pending === 0)
              tx.objectStore("attempts").delete(id);
          };
        }
      };
    }
    await done;
  }

  async status() {
    const tx = this.database.transaction(["records", "notices"]);
    const [queued, pending] = await Promise.all([
      result(tx.objectStore("records").count()),
      result<Notice[]>(tx.objectStore("notices").getAll()),
    ]);
    return {
      queued,
      notices: pending.length,
      incomplete: new Set(
        pending.filter((a) => a.incomplete).map((a) => a.attemptId),
      ).size,
      interrupted: new Set(
        pending.filter((a) => a.interrupted).map((a) => a.attemptId),
      ).size,
    };
  }
  close() {
    this.database.close();
  }
}
