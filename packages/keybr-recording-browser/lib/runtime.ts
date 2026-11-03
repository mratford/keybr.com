import { recordingConfigSchema } from "@keybr/recording";
import { RecordingDelivery } from "./delivery.ts";
import { RecordingQueue } from "./queue.ts";
import { type RecorderOptions } from "./recorder.ts";

export type RecordingState = {
  options: RecorderOptions | null;
  status: string | null;
};

/** Kept alive across practice navigation so queued records and late releases keep draining. */
export class RecordingRuntime {
  state: RecordingState = { options: null, status: null };
  readonly listeners = new Set<(state: RecordingState) => void>();
  #started = false;
  #queue?: RecordingQueue;
  #delivery?: RecordingDelivery;
  #storageError = "";
  #networkError = "";
  readonly #failed = new Set<string>();
  #owner = "";
  #release?: () => void;
  #timer?: number;
  #retry?: number;
  #ticking = false;
  readonly #online = () => {
    void this.tick();
  };
  readonly #exit = () => {
    void this.#delivery?.flush(true).catch(() => {});
  };

  readonly #visibility = () => {
    if (document.visibilityState !== "hidden") return;
    void this.#delivery
      ?.prepareExit()
      .then(() => this.#delivery?.flush(true))
      .catch(() => {});
  };

  constructor(
    readonly request: typeof fetch = fetch,
    readonly openQueue = () => RecordingQueue.open(),
  ) {}

  close() {
    window.clearInterval(this.#timer);
    window.clearTimeout(this.#retry);
    window.removeEventListener("online", this.#online);
    window.removeEventListener("pagehide", this.#exit);
    document.removeEventListener("visibilitychange", this.#visibility);
    this.#release?.();
    this.#queue?.close();
  }

  update(state: Partial<RecordingState>) {
    this.state = { ...this.state, ...state };
    for (const listener of this.listeners) listener(this.state);
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    let available = false;
    try {
      const config = await this.configuration();
      if (!config.enabled) {
        this.update({ status: null });
        return;
      }
      available = true;
      this.#owner ||= crypto.randomUUID();
      this.update({ status: "Starting" });
      if (!navigator.locks || !globalThis.indexedDB)
        throw new Error("Recording requires IndexedDB and Web Locks");
      // Acquire ownership before exposing the sink. The lock survives React unmounts.
      await new Promise<void>((resolve, reject) => {
        void navigator.locks
          .request(`keybr-recording:${this.#owner}`, async () => {
            resolve();
            await new Promise<void>((release) => {
              this.#release = release;
            });
          })
          .catch(reject);
      });
      const queue = (this.#queue = await this.openQueue());
      this.#delivery = new RecordingDelivery(queue, this.request);
      for (const owner of await queue.owners()) {
        if (owner === this.#owner) continue;
        await navigator.locks.request(
          `keybr-recording:${owner}`,
          { ifAvailable: true },
          async (lock) => {
            if (lock) await queue.interrupt(owner);
          },
        );
      }
      this.update({
        options: {
          applicationRevision: config.applicationRevision,
          board: config.board,
          keymap: config.keymap,
          onRecord: (record) => {
            // Create the browser transaction immediately; never wait for the network here.
            const incomplete = this.#failed.has(record.attemptId);
            void queue
              .enqueue(record, this.#owner, config.snapshots, incomplete)
              .then(() => {
                // This transaction committed the incomplete notice too.
                if (incomplete) this.#failed.delete(record.attemptId);
              })
              .catch((error: unknown) => {
                this.#failed.add(record.attemptId);
                this.storageFailure(error);
                void queue
                  .markIncomplete(record.attemptId, this.#owner)
                  .then(() => this.#failed.delete(record.attemptId))
                  .catch((failure: unknown) => this.storageFailure(failure));
              });
          },
          onError: (error) => this.storageFailure(error),
        },
      });
      window.addEventListener("online", this.#online);
      window.addEventListener("pagehide", this.#exit);
      document.addEventListener("visibilitychange", this.#visibility);
      this.#timer = window.setInterval(this.#online, 2000);
      await this.tick();
    } catch (error) {
      this.close();
      this.#queue = undefined;
      this.#delivery = undefined;
      this.update({
        status: available
          ? `Browser recording unavailable: ${String(error)}`
          : null,
      });
      this.#started = false;
      this.#retry = window.setTimeout(() => {
        void this.start();
      }, 10000);
    }
  }

  private async configuration() {
    const key = "keybr-detailed-recording-config";
    const cached = (error: unknown) => {
      try {
        const config = recordingConfigSchema.parse(
          JSON.parse(window.localStorage.getItem(key) ?? "null"),
        );
        if (config.enabled) {
          this.#networkError =
            "Server unavailable; using last enabled recording configuration";
          return config;
        }
      } catch {
        /* No usable cache: leave recording unavailable until configuration can be read. */
      }
      throw error;
    };
    let response: Response;
    try {
      response = await this.request("/_/recording/config", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      return cached(error);
    }
    if (response.status >= 500 || [408, 429].includes(response.status))
      return cached(new Error(`Recording availability: ${response.status}`));
    if (!response.ok)
      throw new Error(`Recording availability: ${response.status}`);
    const config = recordingConfigSchema.parse(await response.json());
    try {
      if (config.enabled)
        window.localStorage.setItem(key, JSON.stringify(config));
      else window.localStorage.removeItem(key);
    } catch (error) {
      this.#storageError = `Configuration cache unavailable; offline reload cannot resume recording: ${String(error)}`;
    }
    return config;
  }

  storageFailure(error: unknown) {
    this.#storageError = `Browser storage failure; affected recording incomplete: ${String(error)}`;
    this.update({ status: this.#storageError });
  }

  async tick() {
    if (this.#ticking || !this.#queue) return;
    this.#ticking = true;
    try {
      await this.deliver();
    } finally {
      this.#ticking = false;
    }
  }

  private async deliver() {
    try {
      // Retry incomplete markers if a quota failure prevented the first write.
      for (const id of this.#failed) {
        await this.#queue!.markIncomplete(id, this.#owner);
        this.#failed.delete(id);
      }
    } catch (error) {
      this.storageFailure(error);
    }
    try {
      if (await this.#delivery?.flush()) this.#networkError = "";
    } catch (error) {
      this.#networkError = String(error);
    }
    try {
      const status = await this.#queue!.status();
      this.update({
        status: `${status.queued} queued records; ${status.notices} queued recovery notices; ${status.incomplete} incomplete; ${status.interrupted} interrupted${this.#storageError ? "; " + this.#storageError : ""}${this.#networkError ? "; " + this.#networkError : ""}`,
      });
    } catch (error) {
      this.storageFailure(error);
    }
  }
}
