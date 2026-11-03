import { existsSync } from "node:fs";
import { join } from "node:path";
import { Container } from "@fastr/invert";
import { ConfigModule, Env } from "@keybr/config";
import { RecordingStore } from "@keybr/recording-store";
import { Command, CommanderError } from "commander";
import Knex from "knex";
import { PremiumCommand } from "./command/premium/index.ts";
import { StatsCommand } from "./command/stats/index.ts";
import { UserInfoCommand } from "./command/user-info/index.ts";

Env.probeFilesSync();
const container = new Container();
container.load(new ConfigModule());
const knex = container.get(Knex);
const program = new Command("keybr")
  .addCommand(container.get(UserInfoCommand).command())
  .addCommand(container.get(PremiumCommand).command())
  .addCommand(container.get(StatsCommand).command())
  .addCommand(
    new Command("recording").addCommand(
      new Command("export")
        .argument("<file>")
        .description("Export a consistent recording SQLite snapshot.")
        .action((file: string) => {
          const filename = join(
            container.get<string>("dataDir"),
            "recordings.sqlite",
          );
          if (!existsSync(filename))
            throw new Error("No recording database exists yet");
          const store = new RecordingStore(filename);
          try {
            store.export(file);
          } finally {
            store.close();
          }
        }),
    ),
  );
program
  .parseAsync()
  .then(() => {
    knex.destroy();
  })
  .catch((err) => {
    if (err instanceof CommanderError) {
      program.error(err.message, err);
    } else {
      throw err;
    }
  });
