import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordingCommand } from "./index.ts";

const fixture = (name: string) =>
  fileURLToPath(
    new URL(
      `../../../../keybr-recording/fixtures/keyboards/${name}.json`,
      import.meta.url,
    ),
  );

test("import-keyboards imports, reimports idempotently and exports", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keybr-cli-recording-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  const run = (...args: string[]) =>
    recordingCommand(
      () => dir,
      (line) => lines.push(line),
    )
      .exitOverride()
      .parseAsync(args, { from: "user" });

  await assert.rejects(run("export", join(dir, "none.sqlite")), /No recording/);
  await run("import-keyboards", fixture("initial"));
  await run("import-keyboards", fixture("initial"));
  await run("import-keyboards", fixture("updated"));
  assert.deepEqual(lines, [
    "Imported 3 keyboards and 4 layouts: 7 new snapshots, 0 already present.",
    "Imported 3 keyboards and 4 layouts: 0 new snapshots, 7 already present.",
    "Imported 3 keyboards and 5 layouts: 4 new snapshots, 4 already present.",
  ]);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  await assert.rejects(run("import-keyboards", broken), /Cannot read/);
  writeFileSync(broken, JSON.stringify({ format: "other" }));
  await assert.rejects(
    run("import-keyboards", broken),
    /Invalid keyboard export/,
  );

  const output = join(dir, "export.sqlite");
  await run("export", output);
  assert.ok(existsSync(output));
  const db = new DatabaseSync(output, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM snapshots").get()!.n, 11);
});
