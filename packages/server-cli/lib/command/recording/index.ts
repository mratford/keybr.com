import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordingStore } from "@keybr/recording-store";
import { Command } from "commander";

/** `keybr recording …`: personal detailed-recording maintenance. */
export function recordingCommand(
  dataDir: () => string,
  log: (line: string) => void = console.log,
) {
  const filename = () => join(dataDir(), "recordings.sqlite");
  return new Command("recording")
    .description("Manage the detailed recording database.")
    .addCommand(
      new Command("export")
        .argument("<file>")
        .description("Export a consistent recording SQLite snapshot.")
        .action((file: string) => {
          if (!existsSync(filename()))
            throw new Error("No recording database exists yet");
          const store = new RecordingStore(filename());
          try {
            store.export(file);
          } finally {
            store.close();
          }
        }),
    )
    .addCommand(
      new Command("import-keyboards")
        .argument("<file>")
        .description(
          "Import a keyboard configuration export (from typokiller) in one transaction.",
        )
        .action((file: string) => {
          let value: unknown;
          try {
            value = JSON.parse(readFileSync(file, "utf8"));
          } catch (error) {
            throw new Error(`Cannot read keyboard export ${file}: ${error}`);
          }
          const store = new RecordingStore(filename());
          try {
            const { boards, keymaps, added, unchanged } =
              store.importKeyboards(value);
            log(
              `Imported ${boards} keyboards and ${keymaps} layouts: ` +
                `${added} new snapshots, ${unchanged} already present.`,
            );
          } finally {
            store.close();
          }
        }),
    );
}
