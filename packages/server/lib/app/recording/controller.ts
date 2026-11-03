import { join } from "node:path";
import { body, controller, http } from "@fastr/controller";
import { Context } from "@fastr/core";
import { BadRequestError, HttpError, NotFoundError } from "@fastr/errors";
import { inject, injectable } from "@fastr/invert";
import { Env } from "@keybr/config";
import { maxBatchBytes, schemaVersion } from "@keybr/recording";
import {
  RecordingConflict,
  RecordingStore,
  RecordingValidationError,
} from "@keybr/recording-store";

@injectable({ singleton: true })
@controller()
export class RecordingController {
  #store?: RecordingStore;
  constructor(@inject("dataDir") readonly dataDir: string) {}

  @http.GET("/_/recording/config")
  config(ctx: Context) {
    const enabled = Env.getBoolean("DETAILED_RECORDING", false);
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.body = enabled
      ? {
          enabled,
          schemaVersion,
          applicationRevision: Env.getString("APPLICATION_REVISION", "local"),
          // Imported with `keybr recording import-keyboards`; snapshots stay on the server.
          keyboards: this.#open().keyboards(),
        }
      : { enabled: false };
  }

  #open() {
    return (this.#store ??= new RecordingStore(
      join(this.dataDir, "recordings.sqlite"),
    ));
  }

  @http.POST("/_/recording/batches")
  append(
    ctx: Context,
    @body.json(null, { maxLength: maxBatchBytes }) value: unknown,
  ) {
    if (!Env.getBoolean("DETAILED_RECORDING", false)) throw new NotFoundError();
    const store = this.#open();
    try {
      ctx.response.body = store.append(value);
      ctx.response.headers.set("Cache-Control", "no-store");
    } catch (error) {
      if (error instanceof RecordingConflict)
        throw new HttpError(409, error.message);
      if (
        error instanceof RecordingValidationError ||
        error instanceof RangeError ||
        (error instanceof Error && error.name === "ZodError")
      )
        throw new BadRequestError(error.message);
      throw error;
    }
  }
}
