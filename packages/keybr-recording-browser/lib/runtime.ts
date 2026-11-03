import {
  type KeyboardCatalogue,
  type KeyboardLayout,
  type RecordingConfig,
  recordingConfigSchema,
  type SnapshotReference,
  snapshotReferenceSchema,
} from "@keybr/recording";
import { z } from "zod";
import { RecordingDelivery } from "./delivery.ts";
import { RecordingQueue } from "./queue.ts";
import { type RecorderOptions } from "./recorder.ts";

/** The physical keyboard and saved layout chosen for recording, remembered per browser. */
export type RecordingSelection = {
  readonly keyboard: string;
  readonly keymap: SnapshotReference | null;
};
const selectionSchema = z.strictObject({
  keyboard: z.string().min(1),
  keymap: snapshotReferenceSchema.nullable(),
});
export const selectionKey = "keybr-detailed-recording-selection";

export type RecordingState = {
  /** Present only while a valid keyboard and layout are selected. */
  options: RecorderOptions | null;
  status: string | null;
  /** Imported keyboards; null when detailed recording is not available. */
  keyboards: KeyboardCatalogue | null;
  selection: RecordingSelection | null;
};

/** A plain label: Letter layout and the saved .vil version, as typokiller names it. */
export function layoutLabel(
  keyboard: KeyboardCatalogue[number],
  layout: KeyboardLayout,
) {
  const definitions = new Set(keyboard.layouts.map((l) => l.board.version));
  return (
    `${layout.letterLayout} · ${layout.vilHash.slice(0, 8)}` +
    (definitions.size > 1
      ? ` · keyboard definition ${layout.board.version.slice(0, 8)}`
      : "")
  );
}

const sameReference = (
  a: SnapshotReference | null | undefined,
  b: SnapshotReference | null | undefined,
) => a != null && b != null && a.id === b.id && a.version === b.version;

/** Kept alive across practice navigation so queued records and late releases keep draining. */
export class RecordingRuntime {
  state: RecordingState = {
    options: null,
    status: null,
    keyboards: null,
    selection: null,
  };
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
  #config?: Extract<RecordingConfig, { enabled: true }>;
  #sink?: Pick<RecorderOptions, "onRecord" | "onError">;
  #activity = "";
  #queueStatus = "";
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
      this.#config = config;
      this.#sink = {
        onRecord: (record) => {
          // Create the browser transaction immediately; never wait for the network here.
          const incomplete = this.#failed.has(record.attemptId);
          // Imported keyboard snapshots are already stored on the server.
          void queue
            .enqueue(record, this.#owner, [], incomplete)
            .then(() => {
              // This transaction committed the incomplete notice too.
              if (incomplete) this.#failed.delete(record.attemptId);
            })
            .catch((error: unknown) => {
              this.#failed.add(record.attemptId);
              this.storageFailure(error);
              void queue
                .markIncomplete(record.attemptId)
                .then(() => this.#failed.delete(record.attemptId))
                .catch((failure: unknown) => this.storageFailure(failure));
            });
        },
        onError: (error) => this.storageFailure(error),
      };
      this.#apply(this.#remembered());
      window.addEventListener("online", this.#online);
      window.addEventListener("pagehide", this.#exit);
      document.addEventListener("visibilitychange", this.#visibility);
      this.#timer = window.setInterval(this.#online, 2000);
      await this.tick();
    } catch (error) {
      this.close();
      this.#queue = undefined;
      this.#delivery = undefined;
      this.#config = undefined;
      this.#sink = undefined;
      this.update({
        options: null,
        keyboards: null,
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

  /**
   * Choose the physical keyboard and saved layout. A new choice replaces the recorder
   * options, which ends the current Attempt ("keyboard-change") and starts fresh practice.
   */
  select(selection: RecordingSelection | null) {
    if (!this.#config) return;
    try {
      if (selection)
        window.localStorage.setItem(selectionKey, JSON.stringify(selection));
      else window.localStorage.removeItem(selectionKey);
    } catch (error) {
      this.#storageError = `Keyboard selection cannot be remembered: ${String(error)}`;
    }
    this.#apply(selection);
  }

  #remembered(): RecordingSelection | null {
    try {
      const text = window.localStorage.getItem(selectionKey);
      return text == null ? null : selectionSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** Never substitutes another configuration for an unavailable selection. */
  #apply(selection: RecordingSelection | null) {
    const config = this.#config!;
    const keyboard = config.keyboards.find((k) => k.id === selection?.keyboard);
    const layout = keyboard?.layouts.find((l) =>
      sameReference(l.keymap, selection?.keymap),
    );
    let options: RecorderOptions | null = null;
    if (keyboard && layout) {
      const current = this.state.options;
      options =
        current &&
        sameReference(current.keymap, layout.keymap) &&
        sameReference(current.board, layout.board)
          ? current
          : {
              applicationRevision: config.applicationRevision,
              board: layout.board,
              keymap: layout.keymap,
              ...this.#sink!,
            };
      this.#activity = `active on ${keyboard.name}, ${layoutLabel(keyboard, layout)}`;
    } else if (selection == null) {
      this.#activity = config.keyboards.length
        ? "inactive; choose a keyboard and layout"
        : "inactive; no keyboards imported (keybr recording import-keyboards)";
    } else if (!keyboard) {
      this.#activity = `inactive; the remembered keyboard ${JSON.stringify(selection.keyboard)} is not available, choose a keyboard and layout`;
    } else if (selection.keymap == null) {
      this.#activity = `inactive; choose a layout for ${keyboard.name}`;
    } else {
      this.#activity = `inactive; the remembered layout ${selection.keymap.id} (${selection.keymap.version.slice(0, 8)}) is not available, choose a layout`;
    }
    this.update({ options, keyboards: config.keyboards, selection });
    this.#render();
  }

  #render() {
    this.update({
      status: [
        this.#activity,
        this.#queueStatus,
        this.#storageError,
        this.#networkError,
      ]
        .filter(Boolean)
        .join("; "),
    });
  }

  storageFailure(error: unknown) {
    this.#storageError = `Browser storage failure; affected recording incomplete: ${String(error)}`;
    this.#render();
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
        await this.#queue!.markIncomplete(id);
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
      this.#queueStatus = `${status.queued} queued records; ${status.notices} queued recovery notices; ${status.incomplete} incomplete; ${status.interrupted} interrupted`;
      this.#render();
    } catch (error) {
      this.storageFailure(error);
    }
  }
}
