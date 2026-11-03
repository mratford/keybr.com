import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { keyboardProps, loadKeyboard } from "@keybr/keyboard";
import { CustomTextLesson } from "@keybr/lesson";
import { FakePhoneticModel } from "@keybr/phonetic-model";
import { type RecordingRecord } from "@keybr/recording";
import { type Scenario } from "@keybr/recording-browser/lib/testing.ts";
import { type Result } from "@keybr/result";
import { Settings } from "@keybr/settings";
import { emulateLayout } from "@keybr/textinput-events";
import { InputHandler } from "@keybr/textinput-events/lib/inputhandler.ts";
import { fakeEvent } from "@keybr/textinput-events/lib/testing.ts";
import { LessonState } from "./lesson-state.ts";
import { Progress } from "./progress.ts";

const { scenarios } = JSON.parse(
  await readFile(
    new URL("../../../../keybr-recording/fixtures/v1.json", import.meta.url),
    "utf8",
  ),
) as {
  scenarios: (Scenario & {
    expected: { records: RecordingRecord[]; results: unknown[] };
  })[];
};

// Exercise the production result constructor independently of replayScenario.
for (const scenario of scenarios.filter(
  ({ expected, actions }) =>
    expected.results.length > 0 &&
    !actions.some((action) => action.type === "exercise"),
)) {
  test(`reference results match practice: ${scenario.name}`, (t) => {
    t.mock.method(Date, "now", () => 1700000000000);
    const settings = new Settings(scenario.settings);
    const keyboard = loadKeyboard(settings.get(keyboardProps.layout));
    class FixedLesson extends CustomTextLesson {
      override generate() {
        return scenario.text;
      }
    }
    const results: Result[] = [];
    const state = new LessonState(
      new Progress(
        settings,
        new FixedLesson(settings, keyboard, new FakePhoneticModel()),
      ),
      (result) => results.push(result),
    );
    const handler = new InputHandler();
    handler.setCallbacks(
      emulateLayout(settings, keyboard, {
        onKeyDown() {},
        onKeyUp() {},
        onInput: (event) => state.onInput(event),
      }),
    );
    for (const action of scenario.actions) {
      switch (action.type) {
        case "keydown":
        case "keyup":
          handler.handleKeyboard(fakeEvent(action));
          break;
        case "input":
          handler.handleInput(fakeEvent(action));
          break;
        case "compositionstart":
        case "compositionupdate":
        case "compositionend":
          handler.handleComposition(fakeEvent(action));
          break;
        default:
          assert.fail(`Unexpected action: ${action.type}`);
      }
    }
    assert.equal(results.length, 1, "practice completes the fixture text");
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          results.map((result) => ({
            result: result.toJSON(),
            accepted: result.validate(),
            score: result.score,
            accuracy: result.accuracy,
          })),
        ),
      ),
      scenario.expected.results,
    );
    const end = scenario.expected.records.find(
      (record) => record.type === "end",
    );
    assert.ok(end, "fixture contains a completed end record");
    assert.deepEqual(JSON.parse(JSON.stringify(results[0])), end.result);
  });
}
