import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "@fastr/client";
import { start } from "@fastr/client-testlib";
import { allToRoutes } from "@fastr/controller";
import { Application } from "@fastr/core";
import { HttpError } from "@fastr/errors";
import { Container } from "@fastr/invert";
import { Router } from "@fastr/middleware-router";
import { fixtureSnapshots, type RecordingRecord } from "@keybr/recording";
import { createTestServer } from "../test/request.ts";
import { RecordingController } from "./controller.ts";

test("recording routes are independent of login, bounded, versioned, transactional and opt-in", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keybr-recording-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.property(process, "env", {
    ...process.env,
    DETAILED_RECORDING: "false",
  });
  const container = new Container();
  container.bind("dataDir").toValue(dir);
  const app = new Application(container)
    .use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        ctx.response.status = error.status;
        ctx.response.body = { error: error.message };
      }
    })
    .use(
      new Router().registerAll(allToRoutes(RecordingController)).middleware(),
    );
  const client = request.use(start(createTestServer(app.callback())));
  assert.deepEqual(
    await (await client.GET("/_/recording/config").send()).body.json(),
    { enabled: false },
  );
  assert.equal(
    (await client.POST("/_/recording/batches").send({})).status,
    404,
  );
  assert.equal(existsSync(join(dir, "recordings.sqlite")), false);
  process.env.DETAILED_RECORDING = "true";
  const configResponse = await client.GET("/_/recording/config").send();
  assert.equal(configResponse.headers.get("Cache-Control"), "no-store");
  const config = await configResponse.body.json<{
    enabled: boolean;
    schemaVersion: number;
  }>();
  assert.equal(config.enabled, true);
  assert.equal(config.schemaVersion, 1);
  const record: RecordingRecord = {
    schemaVersion: 1,
    attemptId: crypto.randomUUID(),
    sequence: 0,
    observedAt: 0,
    type: "start",
    context: {
      text: "abc",
      applicationRevision: "test",
      board: null,
      keymap: null,
      settings: { typing: {}, exercise: {}, layout: {} },
    },
  };
  const batch = {
    schemaVersion: 1,
    records: [record],
    recovery: [],
    snapshots: fixtureSnapshots,
  };
  const posted = await client.POST("/_/recording/batches").send(batch);
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.body.json(), {
    records: [{ attemptId: record.attemptId, sequence: 0 }],
    recovery: [],
  });
  assert.equal(
    (await client.POST("/_/recording/batches").send(batch)).status,
    200,
  );
  assert.equal(
    (
      await client
        .POST("/_/recording/batches")
        .send({ ...batch, records: [{ ...record, observedAt: 99 }] })
    ).status,
    409,
  );
  for (const invalid of [
    {},
    { ...batch, schemaVersion: 2 },
    { ...batch, records: [{ ...record, attemptId: "invalid" }] },
    { ...batch, records: Array(129).fill(record) },
  ]) {
    assert.equal(
      (await client.POST("/_/recording/batches").send(invalid)).status,
      400,
    );
  }
  assert.equal(
    (
      await client
        .POST("/_/recording/batches")
        .send({ padding: "a".repeat(300000) })
    ).status,
    413,
  );
  assert.equal(
    (
      await client
        .POST("/_/recording/batches")
        .header("Content-Type", "application/json")
        .send("{broken")
    ).status,
    400,
  );
});
