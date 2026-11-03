import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deepEqual, equal, includes, isFalse, isTrue } from "rich-assert";
import { Geometry } from "./geometry.ts";
import { KeyModifier } from "./keymodifier.ts";
import { Language } from "./language.ts";
import { Layout } from "./layout.ts";
import { loadKeyboard } from "./load.ts";

// The 30 main keys of the matrix geometry, row by row, left to right.
// prettier-ignore
const mainKeys = [
  ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"],
  ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"],
];

// typokiller's name for these letters (LETTER_LAYOUTS in keymap.py).
const canonical = "xpdgvklio'untsm,rea_zwbcfjhy.q";

/**
 * Reads typokiller's Sweep free-range .vil and vial.json from the keyboard
 * export fixture, the same files as typokiller's own test fixtures.
 */
function readSweep() {
  const url = new URL(
    "../../keybr-recording/fixtures/keyboards/initial.json",
    import.meta.url,
  );
  const { boards } = JSON.parse(readFileSync(url, "utf-8"));
  const sweep = boards.find((board: any) => board.name === "Sweep");
  const keymap = sweep.keymaps.find(
    (keymap: any) => keymap.letterLayout === "free-range",
  );
  return { vial: JSON.parse(sweep.vial), vil: JSON.parse(keymap.vil) };
}

// The characters of the QMK basic keycodes used on the base layer, without
// and with Shift, as typokiller's keymap.py gives them.
const basic: Record<string, string> = {
  KC_QUOT: "'\"",
  KC_COMM: ",<",
  KC_DOT: ".>",
  KC_UNDS: "_",
  KC_MINS: "-_",
  KC_SPC: " ",
};
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
  basic[`KC_${c}`] = c.toLowerCase() + c;
}

/** The keycode a key sends when tapped: `LSFT_T(KC_C)` and `LT(1,KC_C)` give `KC_C`. */
function tapped(keycode: string): string {
  return keycode.split("(").at(-1)!.replace(")", "").split(",").at(-1)!.trim();
}

/** The x position of each matrix key "row,col" in a vial.json, as typokiller's key_x. */
function keyX(vial: any): Map<string, number> {
  const xs = new Map<string, number>();
  for (const row of vial.layouts.keymap) {
    let x = 0;
    for (const item of row) {
      if (typeof item === "object") {
        x += item.x ?? 0;
      } else {
        xs.set(item.split("\n")[0], x);
        x += 1;
      }
    }
  }
  return xs;
}

/**
 * The base-layer characters of the Sweep's 30 main keys, row by row in x
 * order, each without and with Shift. A key override triggered by Shift
 * replaces the shifted character, as typokiller's shift_overrides.
 */
function sweepMainKeys(): string[][] {
  const { vial, vil } = readSweep();
  const base: (string | number)[][] = vil.layout[0];
  const overrides = new Map<string, string>();
  for (const ko of vil.key_override) {
    if (ko.options & 0x80 && ko.trigger_mods & 0x22) {
      overrides.set(ko.trigger, basic[ko.replacement][0]);
    }
  }
  const xs = keyX(vial);
  const rows: string[][] = [[], [], []];
  for (const [rc] of [...xs].sort((a, b) => a[1] - b[1])) {
    const [r, c] = rc.split(",").map(Number);
    // Rows 0-2 are the left half and rows 4-6 the right half.
    if (r % 4 < 3) {
      const keycode = tapped(String(base[r][c]));
      const chars = basic[keycode];
      const shifted = overrides.get(keycode) ?? chars[1];
      rows[r % 4].push(chars[0] + shifted);
    }
  }
  return rows;
}

test("register free-range with stable identifiers", () => {
  const layout = Layout.EN_FREE_RANGE;
  equal(layout.id, "en-free-range");
  equal(layout.xid, 0xfe);
  equal(layout.family, "free-range");
  equal(layout.language, Language.EN);
  deepEqual([...layout.geometries], [Geometry.MATRIX]);
  equal(Layout.ALL.get("en-free-range"), layout);
  equal(Layout.ALL.xget(0xfe), layout);
  includes(Layout.selectableLayouts(Language.EN), layout);
});

test("free-range is not emulated by keybr", () => {
  // The keyboard firmware already sends the remapped characters.
  isFalse(Layout.EN_FREE_RANGE.emulate);
});

test("layout identifiers are unique", () => {
  const ids = Layout.ALL.map((layout) => layout.id);
  const xids = Layout.ALL.map((layout) => layout.xid);
  equal(new Set(ids).size, ids.length);
  equal(new Set(xids).size, xids.length);
});

test("free-range characters agree with the Sweep free-range keymap", () => {
  const keyboard = loadKeyboard(Layout.EN_FREE_RANGE);
  equal(keyboard.geometry, Geometry.MATRIX);

  const registered = mainKeys.map((row) =>
    row.map((id) => {
      const characters = keyboard.getCharacters(id)!;
      return String.fromCodePoint(
        characters.getCodePoint(KeyModifier.None)!,
        characters.getCodePoint(KeyModifier.Shift)!,
      );
    }),
  );

  deepEqual(registered, sweepMainKeys());
  equal(
    registered
      .flat()
      .map((chars) => chars[0])
      .join(""),
    canonical,
  );

  // Shift types capitals, `"`, `<`, `>`, and `-` through the key override.
  deepEqual(
    registered
      .flat()
      .map((chars) => chars[1])
      .join(""),
    `XPDGVKLIO"UNTSM<REA-ZWBCFJHY>Q`,
  );
});

test("free-range has the space on the right thumb and nothing else", () => {
  const keyboard = loadKeyboard(Layout.EN_FREE_RANGE);
  equal(
    keyboard
      .getCharacters("ThumbClusterRight1")
      ?.getCodePoint(KeyModifier.None),
    0x0020,
  );
  deepEqual(
    String.fromCodePoint(...keyboard.getCodePoints())
      .split("")
      .sort()
      .join(""),
    ` "',-.<>ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz`,
  );
});

test("free-range types the space with a key that the matrix draws", () => {
  // The next-key pointer is drawn only on keys with a shape.
  const keyboard = loadKeyboard(Layout.EN_FREE_RANGE);
  const combo = keyboard.getCombo(0x0020);
  equal(combo?.id, "ThumbClusterRight1");
  isTrue(keyboard.getShape("ThumbClusterRight1") != null);
  equal(keyboard.getCharacters("Space"), null);
});
