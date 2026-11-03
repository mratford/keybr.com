import assert from "node:assert/strict";
import { Server } from "node:http";
import { test } from "node:test";
import { Application } from "@fastr/core";
import { Container } from "@fastr/invert";
import { WebSocketServer } from "ws";
import { Service } from "./service.ts";

test("recording mode binds to loopback; disabled mode preserves the default listener", (t) => {
  t.mock.property(process, "env", { ...process.env });
  const previous = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      new Set(process.listeners(signal)),
    ]),
  );
  t.after(() => {
    for (const [signal, listeners] of previous) {
      for (const listener of process.listeners(signal))
        if (!listeners.has(listener)) process.removeListener(signal, listener);
    }
  });
  for (const enabled of [true, false]) {
    process.env.DETAILED_RECORDING = String(enabled);
    const server = new Server();
    const websocket = new WebSocketServer({ noServer: true });
    const listen = t.mock.method(server, "listen", () => server);
    new Service(server, websocket).start({
      app: new Application(new Container()),
      port: 3000,
    });
    assert.deepEqual(listen.mock.calls[0].arguments, [
      3000,
      enabled ? "127.0.0.1" : undefined,
    ]);
    websocket.close();
  }
});
