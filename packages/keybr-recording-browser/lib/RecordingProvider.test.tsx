import assert from "node:assert/strict";
import { test } from "node:test";
import { type KeyboardCatalogue } from "@keybr/recording";
import { fireEvent, render } from "@testing-library/react";
import { createIntl, IntlProvider } from "react-intl";
import {
  layoutLabel,
  RecordingActivityText,
  RecordingSelector,
} from "./RecordingProvider.tsx";
import { type RecordingSelection, type RecordingState } from "./runtime.ts";

const ref = (id: string, version: string) => ({ id, version });
const keyboards: KeyboardCatalogue = [
  {
    id: "Sweep",
    name: "Sweep",
    layouts: [
      {
        board: ref("Sweep", "b".repeat(64)),
        keymap: ref("Sweep/free-range", "1".repeat(64)),
        letterLayout: "free-range",
        layers: [],
        vilHash: "f".repeat(64),
      },
      {
        board: ref("Sweep", "a".repeat(64)),
        keymap: ref("Sweep/free-range", "2".repeat(64)),
        letterLayout: "free-range",
        layers: [],
        vilHash: "f".repeat(64),
      },
    ],
  },
  { id: "Q4", name: "Q4", layouts: [] },
];

function setup(selection: RecordingSelection | null) {
  const selected: (RecordingSelection | null)[] = [];
  const state: RecordingState = {
    options: null,
    activity: null,
    status: null,
    keyboards,
    selection,
  };
  const view = render(
    <IntlProvider locale="en">
      <RecordingSelector state={state} onSelect={(s) => selected.push(s)} />
    </IntlProvider>,
  );
  const [keyboard, layout] = view.container.querySelectorAll("select");
  return { view, keyboard, layout, selected };
}

test("keyboard and layout are chosen separately, and layouts name their definitions", (t) => {
  const page = setup({
    keyboard: "Sweep",
    keymap: keyboards[0].layouts[1].keymap,
  });
  t.after(() => page.view.unmount());
  assert.ok(page.view.getByLabelText("Keyboard"));
  assert.ok(page.view.getByLabelText("Layout"));
  assert.equal(page.keyboard.value, "Sweep");
  // Identical .vil content under two keyboard definitions remains distinguishable.
  assert.deepEqual(
    [...page.layout.options].map((o) => o.text),
    [
      "Choose…",
      "free-range · ffffffff · keyboard definition bbbbbbbb",
      "free-range · ffffffff · keyboard definition aaaaaaaa",
    ],
  );
  assert.equal(page.layout.selectedIndex, 2);
  fireEvent.change(page.layout, {
    target: { value: page.layout.options[1].value },
  });
  fireEvent.change(page.keyboard, { target: { value: "Q4" } });
  fireEvent.change(page.keyboard, { target: { value: "" } });
  assert.deepEqual(page.selected, [
    { keyboard: "Sweep", keymap: keyboards[0].layouts[0].keymap },
    { keyboard: "Q4", keymap: null },
    null,
  ]);
});

test("an unavailable remembered layout is shown as unselected, not replaced", (t) => {
  const page = setup({
    keyboard: "Sweep",
    keymap: ref("Sweep/free-range", "gone"),
  });
  t.after(() => page.view.unmount());
  assert.equal(page.keyboard.value, "Sweep");
  assert.equal(page.layout.value, "");
  assert.deepEqual(page.selected, []);
  const missing = setup({ keyboard: "Sofle", keymap: null });
  t.after(() => missing.view.unmount());
  assert.equal(missing.keyboard.value, "");
  assert.equal(missing.layout.disabled, true);
});

test("layouts that differ only in layer names have different labels", () => {
  const intl = createIntl({ locale: "en" });
  const qwerty = (version: string, layers: string[]) => ({
    board: ref("Sweep", "b".repeat(64)),
    keymap: ref("Sweep/QWERTY", version.repeat(64)),
    letterLayout: "QWERTY",
    layers,
    vilHash: "3a7e9c85".repeat(8),
  });
  const keyboard = {
    id: "Sweep",
    name: "Sweep",
    layouts: [
      qwerty("1", ["Main", "Sym"]),
      qwerty("2", ["Base", "Sym"]),
      qwerty("3", []),
      { ...qwerty("4", []), vilHash: "e".repeat(64) },
    ],
  };
  assert.deepEqual(
    keyboard.layouts.map((l) => layoutLabel(intl, keyboard, l)),
    [
      "QWERTY · 3a7e9c85 · layers Main, Sym",
      "QWERTY · 3a7e9c85 · layers Base, Sym",
      "QWERTY · 3a7e9c85 · no layer names",
      "QWERTY · eeeeeeee",
    ],
  );
  // Layer names that format the same still give different labels.
  const same = {
    ...keyboard,
    layouts: [qwerty("1", ["A, B"]), qwerty("2", ["A", "B"])],
  };
  assert.deepEqual(
    same.layouts.map((l) => layoutLabel(intl, same, l)),
    [
      "QWERTY · 3a7e9c85 · layers A, B · version 11111111",
      "QWERTY · 3a7e9c85 · layers A, B · version 22222222",
    ],
  );
});

test("recording guidance is translated", (t) => {
  const view = render(
    <IntlProvider
      locale="de"
      messages={{
        "recording.chooseLayout": "inaktiv; Layout für {keyboard} wählen",
        "recording.layoutDefinition": "Tastaturdefinition {version}",
        "recording.active": "aktiv auf {keyboard}, {layout}",
      }}
    >
      <p>
        <RecordingActivityText type="choose-layout" keyboard="Sweep" />
      </p>
      <p>
        <RecordingActivityText
          type="active"
          keyboard={keyboards[0]}
          layout={keyboards[0].layouts[0]}
        />
      </p>
    </IntlProvider>,
  );
  t.after(() => view.unmount());
  assert.deepEqual(
    [...view.container.querySelectorAll("p")].map((p) => p.textContent),
    [
      "inaktiv; Layout für Sweep wählen",
      "aktiv auf Sweep, free-range · ffffffff · Tastaturdefinition bbbbbbbb",
    ],
  );
});
