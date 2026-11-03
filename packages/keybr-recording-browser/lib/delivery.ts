import { type RecordingBatch } from "@keybr/recording";
import { type RecordingQueue } from "./queue.ts";

export class RecordingDelivery {
  #sending = false;
  #terminal = false;
  #exitBatch?: RecordingBatch;

  async prepareExit() {
    this.#exitBatch = await this.queue.batch(48000);
  }

  constructor(
    readonly queue: RecordingQueue,
    readonly request: typeof fetch = fetch,
  ) {}

  /** Safe for concurrent tabs: only exact, committed server acknowledgements remove records. */
  async flush(exiting = false) {
    if (exiting) {
      const batch = this.#exitBatch;
      if (
        this.#terminal ||
        !batch ||
        (!batch.records.length && !batch.recovery.length)
      )
        return;
      // Start fetch before yielding: pagehide cannot depend on IndexedDB completing.
      await this.request("/_/recording/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        keepalive: true,
      });
      // Exit delivery is best effort; normal delivery verifies and applies acknowledgements.
      return;
    }
    if (this.#sending || this.#terminal) return;
    this.#sending = true;
    try {
      await this.prepareExit();
      const batch = await this.queue.batch();
      if (!batch.records.length && !batch.recovery.length) return;
      const response = await this.request("/_/recording/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        keepalive: exiting,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        // Retain terminal failures for inspection/recovery; do not spin on invalid data.
        this.#terminal =
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 429].includes(response.status);
        throw new Error(
          `Recording server returned ${response.status}; queued data retained`,
        );
      }
      const ack = (await response.json()) as {
        records: { attemptId: string; sequence: number }[];
        recovery: RecordingBatch["recovery"];
      };
      await this.queue.acknowledge(batch, ack);
      await this.prepareExit();
      return true;
    } finally {
      this.#sending = false;
    }
  }
}
