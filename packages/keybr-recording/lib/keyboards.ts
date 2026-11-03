import { z } from "zod";

/**
 * Keyboard configuration exported by typokiller for import into the recording
 * database. Configuration only: no typing history, secrets or environment settings.
 * `vial` and `vil` are the exact saved file texts. Keep them as strings: a .vil
 * `uid` can exceed JavaScript's safe integer range, and content hashes are taken
 * over the UTF-8 bytes of the text.
 */
export const keyboardExportFormat = "keybr-keyboard-export";
export const keyboardExportVersion = 1;

const sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a sha256 hex digest");
const jsonObjectText = z.string().refine((text) => {
  try {
    const value: unknown = JSON.parse(text);
    return value != null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}, "Expected the text of a JSON object");

export const keyboardExportSchema = z
  .strictObject({
    format: z.literal(keyboardExportFormat),
    formatVersion: z.literal(keyboardExportVersion),
    exportedAt: z.iso.datetime({ offset: true }),
    source: z.strictObject({ application: z.string().min(1) }),
    boards: z
      .array(
        z.strictObject({
          /** The Board's identifier in the source database, kept for traceability. */
          sourceId: z.union([z.int(), z.string().min(1)]),
          /** The Board's unique name; it identifies the physical keyboard. */
          name: z.string().min(1).max(200),
          /** The Board's current vial.json text. */
          vial: jsonObjectText,
          /** Saved Keymap versions, oldest first. */
          keymaps: z
            .array(
              z.strictObject({
                /** The source's identifier: sha256 of the .vil text. */
                sourceHash: sha256,
                vil: jsonObjectText,
                /** The computed Letter layout, such as "QWERTY" or "free-range". */
                letterLayout: z.string().min(1).max(200),
                /** Layer display names, base layer first; empty when unavailable. */
                layers: z.array(z.string().max(200)).max(32),
              }),
            )
            .min(1)
            .max(256),
        }),
      )
      .min(1)
      .max(64),
  })
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const [index, board] of value.boards.entries()) {
      if (names.has(board.name))
        ctx.addIssue({
          code: "custom",
          path: ["boards", index, "name"],
          message: `Duplicate Board name ${JSON.stringify(board.name)}`,
        });
      const id = JSON.stringify(board.sourceId);
      if (ids.has(id))
        ctx.addIssue({
          code: "custom",
          path: ["boards", index, "sourceId"],
          message: `Duplicate Board sourceId ${id}`,
        });
      names.add(board.name);
      ids.add(id);
      const hashes = new Set<string>();
      for (const [n, keymap] of board.keymaps.entries()) {
        if (hashes.has(keymap.sourceHash))
          ctx.addIssue({
            code: "custom",
            path: ["boards", index, "keymaps", n, "sourceHash"],
            message: "Duplicate saved .vil version on one Board",
          });
        hashes.add(keymap.sourceHash);
      }
    }
  });
export type KeyboardExport = z.infer<typeof keyboardExportSchema>;

export const snapshotReferenceSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
});
export type SnapshotReference = z.infer<typeof snapshotReferenceSchema>;

/** One selectable saved Keymap version, frozen together with its Board definition. */
export const keyboardLayoutSchema = z.strictObject({
  board: snapshotReferenceSchema,
  keymap: snapshotReferenceSchema,
  letterLayout: z.string().min(1),
  layers: z.array(z.string()),
  vilHash: z.string().min(1),
});
export type KeyboardLayout = z.infer<typeof keyboardLayoutSchema>;

/** Imported physical keyboards, each with its layouts newest first. */
export const keyboardCatalogueSchema = z.array(
  z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    layouts: z.array(keyboardLayoutSchema),
  }),
);
export type KeyboardCatalogue = z.infer<typeof keyboardCatalogueSchema>;
