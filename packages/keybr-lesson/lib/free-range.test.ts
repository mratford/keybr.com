import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keyboardProps, Language, Layout, loadKeyboard } from "@keybr/keyboard";
import { makePhoneticModel, TransitionTable } from "@keybr/phonetic-model";
import { LCG } from "@keybr/rand";
import { makeKeyStatsMap, ResultFaker } from "@keybr/result";
import { Settings } from "@keybr/settings";
import { deepEqual, equal, isTrue } from "rich-assert";
import { fakeKeyStatsMap } from "./fakes.ts";
import { GuidedLesson } from "./guided.ts";
import { lessonProps } from "./settings.ts";

// The real English phonetic model and word list, as practice loads them.
const model = makePhoneticModel(
  Language.EN,
  TransitionTable.load(
    readFileSync(
      new URL(
        "../../keybr-phonetic-model/assets/model-en.data",
        import.meta.url,
      ),
    ),
  ),
);
const words: string[] = JSON.parse(
  readFileSync(
    new URL(
      "../../keybr-content-words/lib/data/words-en.json",
      import.meta.url,
    ),
    "utf-8",
  ),
);

const settings = new Settings()
  .set(keyboardProps.layout, Layout.EN_FREE_RANGE)
  .set(lessonProps.capitals, 1)
  .set(lessonProps.punctuators, 1);
const keyboard = loadKeyboard(Layout.EN_FREE_RANGE);
const typeable = new Set(keyboard.getCodePoints());

function check(text: string) {
  isTrue(text.length > 100);
  for (const char of text) {
    isTrue(typeable.has(char.codePointAt(0)!), `Cannot type ${char}`);
  }
}

test("guided lessons teach every English letter on free-range", () => {
  const lesson = new GuidedLesson(settings, keyboard, model, words);
  equal(
    lesson.letters.map(String).sort().join(""),
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  );
});

test("guided lessons generate typeable free-range exercises", () => {
  const lesson = new GuidedLesson(settings, keyboard, model, words);
  const rng = LCG(1);

  // A new learner starts with the most frequent letters.
  const first = lesson.update(makeKeyStatsMap(lesson.letters, []));
  equal(first.findIncludedKeys().length, 6);
  check(String(lesson.generate(first, rng)));

  // A learner who knows every letter practises the whole alphabet.
  const all = lesson.update(
    fakeKeyStatsMap(
      settings,
      lesson.letters.map((letter) => [letter, 1, 1]),
    ),
  );
  equal(all.findIncludedKeys().length, 26);
  check(String(lesson.generate(all, rng)));
});

test("guided lessons use only free-range results", () => {
  const lesson = new GuidedLesson(settings, keyboard, model, words);
  const qwerty = new ResultFaker({ layout: Layout.EN_US }).nextResult();
  const freeRange = new ResultFaker({
    layout: Layout.EN_FREE_RANGE,
  }).nextResult();
  deepEqual(lesson.filter([qwerty, freeRange]), [freeRange]);
});
