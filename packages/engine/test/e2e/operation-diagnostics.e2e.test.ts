// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { openCdpWireSession } from "./cdp-wire";
import { engine, expect, test } from "./harness";

const fixture = "https://ks.invalid/__fixtures/";
const pageUrl = fixture + "policy-doc.html";
const resultUrl = fixture + "operation-result.html";
const fetchUrl = fixture + "echo-headers.json";
const slowUrl = fixture + "slow-document.html";
const secret = "operation-dummy-secret";
const publicUrls = [pageUrl, resultUrl, fetchUrl, slowUrl];

async function connect() {
  const { ws, next } = await openCdpWireSession(engine);
  let id = 0;
  async function send<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params?: ProtocolMapping.Commands[M]["paramsType"][0],
    sessionId?: string,
  ): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    const requestId = ++id;
    ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    const reply = (await next()) as { id: number; result?: unknown; error?: { message: string } };
    expect(reply.id).toBe(requestId);
    if (reply.error) throw new Error(reply.error.message);
    return reply.result as ProtocolMapping.Commands[M]["returnType"];
  }
  return { send, close: () => ws.close() };
}

type Connection = Awaited<ReturnType<typeof connect>>;
type PageSend = Connection["send"];

async function attach(connection: Connection, markup: string) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  const send: PageSend = (method, params) => connection.send(method, params, sessionId);
  const url = new URL(pageUrl);
  url.searchParams.set(
    "body",
    "<style>button { position: absolute; left: 10px; top: 10px; width: 120px; height: 38px; }</style>" +
      markup,
  );
  url.hash = secret;
  const nav = await send("Page.navigate", { url: url.href });
  expect(nav.errorText).toBeUndefined();
  return { send, targetId, sessionId };
}

async function click(send: PageSend) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    x: 30,
    y: 25,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    x: 30,
    y: 25,
    clickCount: 1,
  });
}

async function observe(send: PageSend, durationMs = 3_000) {
  return send("Kitesurf.startOperationDiagnostics", {
    durationMs,
    publicUrls,
    publicTitles: ["policy-doc", "operation-result"],
  });
}

test("reports a dispatched click and a classified exception without a POST", async () => {
  const connection = await connect();
  try {
    const { send } = await attach(
      connection,
      `
      <form><button type="button" onclick="fail()">Click</button></form>
      <script>function fail() {
        document.title = '${secret}-title';
        throw new TypeError('${secret}-exception');
      }</script>`,
    );
    const start = await observe(send, 1_500);
    expect(start.start).toEqual({ url: pageUrl, title: "policy-doc", formCount: 1 });
    await click(send);
    const result = await send("Kitesurf.stopOperationDiagnostics", { waitMs: 100_000 });
    expect(result.endedAt).toBeLessThanOrEqual(start.startedAt + start.durationMs);
    expect(result.completedClicks).toBe(1);
    expect(result.completedDocumentNavigations).toBe(0);
    expect(result.requests).toEqual([]);
    expect(result.postStartObserved).toBe(false);
    expect(result.exceptions).toEqual([{ kind: "TypeError", timestamp: expect.any(Number) }]);
    expect(result.end).toEqual({ url: pageUrl, title: null, formCount: 1 });
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally {
    connection.close();
  }
}, 60_000);

test.for([200, 403])(
  "retains POST status %i through document navigation",
  { timeout: 60_000 },
  async (status) => {
    const connection = await connect();
    try {
      const { send } = await attach(
        connection,
        `
      <form method="post" action="/__fixtures/operation-result.html?status=${status}&token=${secret}#private">
        <input name="user" value="${secret}-user">
        <input type="password" name="password" value="${secret}-password">
        <button type="submit">Submit fixture</button>
      </form>`,
      );
      await observe(send);
      await click(send);
      const result = await send("Kitesurf.stopOperationDiagnostics", { waitMs: 500 });
      expect(result.completedClicks).toBe(1);
      expect(result.completedDocumentNavigations).toBe(1);
      expect(result.requests).toEqual([
        { type: "Document", method: "POST", url: resultUrl, status, state: "completed" },
      ]);
      expect(result.postStartObserved).toBe(true);
      expect(result.start.formCount).toBe(1);
      expect(result.end).toEqual({ url: resultUrl, title: "operation-result", formCount: 0 });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      connection.close();
    }
  },
);

test("reports a fetch without claiming document navigation or leaking headers", async () => {
  const connection = await connect();
  try {
    const { send } = await attach(
      connection,
      `
      <button onclick="run()">Click</button>
      <script>function run() {
        document.cookie = 'test=${secret}-cookie';
        fetch('/__fixtures/echo-headers.json?token=${secret}#private',
          {headers:{Authorization:'Bearer ${secret}-credential'}});
      }</script>`,
    );
    await observe(send);
    await click(send);
    const result = await send("Kitesurf.stopOperationDiagnostics", { waitMs: 400 });
    expect(result.requests).toEqual([
      { type: "Fetch", method: "GET", url: fetchUrl, status: 200, state: "responseReceived" },
    ]);
    expect(result.completedDocumentNavigations).toBe(0);
    expect(result.postStartObserved).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally {
    connection.close();
  }
}, 60_000);

test("returns without waiting for the network and excludes other pages and connections", async () => {
  const connection = await connect();
  const separate = await connect();
  try {
    const observed = await attach(
      connection,
      `<button onclick="fetch('/__fixtures/slow-document.html?ms=3000')">Wait</button>`,
    );
    const hidden = await attach(
      connection,
      `<button onclick="fetch('/__fixtures/echo-headers.json')">Send</button>`,
    );
    const remote = await attach(
      separate,
      `<button onclick="throw new TypeError('${secret}')">Error</button>`,
    );
    await observe(observed.send, 2_500);
    await expect(hidden.send("Kitesurf.stopOperationDiagnostics")).rejects.toThrow(
      /No operation observation/,
    );
    await expect(remote.send("Kitesurf.stopOperationDiagnostics")).rejects.toThrow(
      /No operation observation/,
    );
    await observe(remote.send);
    await click(observed.send);
    await click(hidden.send);
    await click(remote.send);
    const remoteReport = await remote.send("Kitesurf.stopOperationDiagnostics", { waitMs: 100 });
    expect(remoteReport.exceptions).toEqual([{ kind: "TypeError", timestamp: expect.any(Number) }]);
    expect(remoteReport.requests).toEqual([]);
    const result = await observed.send("Kitesurf.stopOperationDiagnostics", { waitMs: 100 });
    expect(result.requests).toEqual([
      { type: "Fetch", method: "GET", url: slowUrl, status: null, state: "pending" },
    ]);
    expect(result.exceptions).toEqual([]);
    expect(result.completedClicks).toBe(1);
    expect(result.laterActivity).toBe("unverified");
    await observe(observed.send);
    await connection.send("Target.attachToTarget", { targetId: observed.targetId, flatten: true });
    await expect(observed.send("Kitesurf.stopOperationDiagnostics")).rejects.toThrow(
      /No operation observation/,
    );
  } finally {
    connection.close();
    separate.close();
  }
}, 60_000);
