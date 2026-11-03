import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { type KeyboardExport, keyboardExportSchema } from "./keyboards.ts";

async function fixture(name: string): Promise<KeyboardExport> {
  return JSON.parse(
    await readFile(
      new URL(`../fixtures/keyboards/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

test("shared keyboard export fixtures are valid and representative", async () => {
  const initial = keyboardExportSchema.parse(await fixture("initial"));
  const updated = keyboardExportSchema.parse(await fixture("updated"));
  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  for (const exported of [initial, updated])
    for (const board of exported.boards)
      for (const keymap of board.keymaps)
        assert.equal(keymap.sourceHash, sha256(keymap.vil));

  // Multiple Boards and Letter layouts.
  assert.ok(initial.boards.length >= 3);
  const letterLayouts = new Set(
    initial.boards.flatMap((b) => b.keymaps.map((k) => k.letterLayout)),
  );
  assert.ok(letterLayouts.has("QWERTY") && letterLayouts.has("free-range"));
  // Multiple saved versions of one Letter layout on one Board.
  const sweep = updated.boards.find((b) => b.name === "Sweep")!;
  assert.equal(
    sweep.keymaps.filter((k) => k.letterLayout === "free-range").length,
    2,
  );
  // Identical .vil content associated with a changed physical keyboard definition.
  const before = initial.boards.find((b) => b.name === "Sweep")!;
  assert.notEqual(sha256(before.vial), sha256(sweep.vial));
  assert.ok(
    before.keymaps.every((k) =>
      sweep.keymaps.some((later) => later.sourceHash === k.sourceHash),
    ),
  );
  // Changed layer metadata for an unchanged .vil.
  assert.notDeepEqual(before.keymaps[0].layers, sweep.keymaps[0].layers);
  assert.equal(before.keymaps[0].sourceHash, sweep.keymaps[0].sourceHash);
});

test("the export contract rejects unknown fields, duplicates and malformed files", async () => {
  const valid = await fixture("initial");
  for (const invalid of [
    { ...valid, settings: { apiKey: "secret" } },
    { ...valid, formatVersion: 2 },
    { ...valid, boards: [] },
    { ...valid, boards: [valid.boards[0], valid.boards[0]] },
    {
      ...valid,
      boards: [
        {
          ...valid.boards[0],
          keymaps: [{ ...valid.boards[0].keymaps[0], vil: "[]" }],
        },
      ],
    },
    {
      ...valid,
      boards: [
        {
          ...valid.boards[0],
          keymaps: [{ ...valid.boards[0].keymaps[0], sourceHash: "abc" }],
        },
      ],
    },
  ])
    assert.equal(keyboardExportSchema.safeParse(invalid).success, false);
});
