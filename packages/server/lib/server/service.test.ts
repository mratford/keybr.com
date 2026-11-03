import assert from "node:assert/strict";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
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
    if (enabled) {
      for (const host of [
        "attacker.example:3000",
        "localhost:4000",
        undefined,
      ]) {
        const req = new IncomingMessage(new Socket());
        req.headers.host = host;
        const res = new ServerResponse(req);
        const end = t.mock.method(res, "end", () => res);
        server.emit("request", req, res);
        assert.equal(res.statusCode, 403);
        assert.equal(end.mock.callCount(), 1);
      }
    }
    websocket.close();
  }
});
