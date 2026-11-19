// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { openCdpWireSession } from "./cdp-wire";
import { engine, expect, test } from "./harness";

const fixture = "https://ks.invalid/__fixtures/";
const pageUrl = fixture + "policy-doc.html";
const resultUrl = fixture + "operation-result.html";
const redirectUrl = fixture + "operation-redirect.html";
const responseHeaders = {
  server: "fixture-server",
  via: "1.1 fixture-proxy",
  "x-request-id": "fixture-final-id",
};
const fetchUrl = fixture + "echo-headers.json";
const slowUrl = fixture + "slow-document.html";
const secret = "operation-dummy-secret";
const publicUrls = [pageUrl, resultUrl, redirectUrl, fetchUrl, slowUrl];

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

test.for([
  { status: 200, redirect: false },
  { status: 403, redirect: false },
  { status: 403, redirect: true },
])(
  "retains response identifiers through document navigation (HTTP $status, redirect=$redirect)",
  { timeout: 60_000 },
  async ({ status, redirect }) => {
    const connection = await connect();
    try {
      const action = redirect ? redirectUrl : resultUrl;
      const { send } = await attach(
        connection,
        `
      <form method="post" action="${action}?status=${status}&token=${secret}#private">
        <input name="user" value="${secret}-user">
        <input type="password" name="password" value="${secret}-password">
        <button type="submit">Submit fixture</button>
      </form>`,
      );
      const original = await send("Kitesurf.inspectInteractionTarget", { x: 30, y: 25 });
      await observe(send);
      await click(send);
      const result = await send("Kitesurf.stopOperationDiagnostics", { waitMs: 500 });
      expect(original.hitTarget?.tagName).toBe("BUTTON");
      expect(result.beforeClicks).toEqual([
        expect.objectContaining({
          documentId: original.documentId,
          x: 30,
          y: 25,
          hitTarget: expect.objectContaining({ backendNodeId: original.hitTarget?.backendNodeId }),
        }),
      ]);
      const after = await send("Kitesurf.inspectInteractionTarget", {
        x: 30,
        y: 25,
        backendNodeId: original.hitTarget!.backendNodeId,
        documentId: original.documentId!,
      });
      expect(after.documentId).not.toBe(original.documentId);
      expect(after.requestedHit).toBe("stale");
      expect(after.requestedTarget).toBeNull();
      expect(result.completedClicks).toBe(1);
      expect(result.completedDocumentNavigations).toBe(1);
      expect(result.requests).toEqual([
        ...(redirect
          ? [
              {
                type: "Document",
                method: "POST",
                url: redirectUrl,
                status: 302,
                state: "completed",
                redirectedTo: resultUrl,
                responseHeaders: {
                  server: "fixture-redirect-server",
                  "x-request-id": "fixture-redirect-id",
                },
              },
            ]
          : []),
        {
          type: "Document",
          method: redirect ? "GET" : "POST",
          url: resultUrl,
          status,
          state: "completed",
          responseHeaders,
        },
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
    const homeHit = await observed.send("Kitesurf.inspectInteractionTarget", { x: 30, y: 25 });
    const foreignHit = await remote.send("Kitesurf.inspectInteractionTarget", {
      x: 30,
      y: 25,
      backendNodeId: homeHit.hitTarget!.backendNodeId,
      documentId: homeHit.documentId!,
    });
    expect(foreignHit.documentId).not.toBe(homeHit.documentId);
    expect(foreignHit.requestedHit).toBe("stale");
    expect(foreignHit.requestedTarget).toBeNull();
    await click(observed.send);
    await click(hidden.send);
    await click(remote.send);
    const remoteReport = await remote.send("Kitesurf.stopOperationDiagnostics", { waitMs: 100 });
    expect(remoteReport.exceptions).toEqual([{ kind: "TypeError", timestamp: expect.any(Number) }]);
    expect(remoteReport.requests).toEqual([]);
    expect(remoteReport.beforeClicks).toHaveLength(1);
    const result = await observed.send("Kitesurf.stopOperationDiagnostics", { waitMs: 100 });
    expect(result.requests).toEqual([
      { type: "Fetch", method: "GET", url: slowUrl, status: null, state: "pending" },
    ]);
    expect(result.exceptions).toEqual([]);
    expect(result.completedClicks).toBe(1);
    expect(result.beforeClicks).toHaveLength(1);
    expect(result.beforeClicks[0]?.documentId).not.toBe(remoteReport.beforeClicks[0]?.documentId);
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

async function backendIdFor(send: PageSend, selector: string): Promise<number> {
  const { root } = await send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await send("DOM.describeNode", { nodeId });
  expect(node.backendNodeId).toBeGreaterThan(0);
  return node.backendNodeId;
}

test("inspects the shared hit test, including transparent overlays and pointer-events", async () => {
  const connection = await connect();
  try {
    const { send } = await attach(
      connection,
      `
      <style>
        #plain span { position: absolute; inset: 5px; display: block }
        #covered { left: 150px } #under { left: 290px }
        .cover { position: absolute; top: 10px; width: 120px; height: 38px;
          opacity: 0; z-index: 2; background: black }
      </style>
      <button id="plain"><span>Nested</span></button>
      <button id="covered">Covered</button><div class="cover" style="left:150px"></div>
      <button id="under">Behind</button>
      <div id="ignored" class="cover" style="left:290px; pointer-events:none"></div>
    `,
    );
    const plain = await send("Kitesurf.inspectInteractionTarget", { x: 30, y: 25 });
    expect(plain.hit).toBe("hit");
    expect(plain.hitTarget).toMatchObject({ tagName: "SPAN", overlapsViewport: true });
    expect(plain.documentId).toEqual(expect.any(String));
    const target = async (selector: string, x: number) =>
      send("Kitesurf.inspectInteractionTarget", {
        x,
        y: 25,
        backendNodeId: await backendIdFor(send, selector),
        documentId: plain.documentId!,
      });
    const plainId = await backendIdFor(send, "#plain");
    const { model } = await send("DOM.getBoxModel", { backendNodeId: plainId });
    expect(await target("#plain", 30)).toMatchObject({
      requestedHit: "descendant",
      requestedTarget: {
        tagName: "BUTTON",
        disabled: false,
        overlapsViewport: true,
        rect: { x: 10, y: 10, width: model.width, height: model.height },
      },
    });
    expect(await target("#covered", 165)).toMatchObject({
      requestedHit: "other",
      hitTarget: { tagName: "DIV" },
      requestedTarget: { tagName: "BUTTON" },
    });
    expect(await target("#ignored", 310)).toMatchObject({
      requestedHit: "other",
      hitTarget: { tagName: "BUTTON" },
      requestedTarget: { pointerEvents: "none", overlapsViewport: true },
    });
    expect(await target("#under", 310)).toMatchObject({ requestedHit: "self" });
  } finally {
    connection.close();
  }
}, 60_000);

test("reports layout, visibility, and HTML form disabled state separately", async () => {
  const connection = await connect();
  try {
    const { send } = await attach(
      connection,
      `
      <button id="hidden-display" style="display:none">No layout</button>
      <button id="hidden-visibility" style="visibility:hidden; left:150px">Hidden</button>
      <button id="offscreen" style="left:2200px">Outside</button>
      <button id="disabled" disabled>Disabled</button>
      <fieldset disabled><legend><input id="legend"></legend><input id="inherited"></fieldset>
    `,
    );
    const { documentId } = await send("Kitesurf.inspectInteractionTarget", { x: 30, y: 25 });
    const read = async (selector: string, x = 30) =>
      send("Kitesurf.inspectInteractionTarget", {
        x,
        y: 25,
        backendNodeId: await backendIdFor(send, selector),
        documentId: documentId!,
      });
    expect((await read("#hidden-display")).requestedTarget?.display).toBe("none");
    expect((await read("#hidden-visibility", 165)).requestedTarget?.visibility).toBe("hidden");
    expect((await read("#offscreen")).requestedTarget?.overlapsViewport).toBe(false);
    expect((await read("#disabled")).requestedTarget?.disabled).toBe(true);
    expect((await read("#inherited")).requestedTarget?.disabled).toBe(true);
    expect((await read("#legend")).requestedTarget?.disabled).toBe(false);
  } finally {
    connection.close();
  }
}, 60_000);

test("inspection has no input side effects and click diagnostics preserve the pre-dispatch node", async () => {
  const connection = await connect();
  try {
    const { send } = await attach(
      connection,
      `
      <input id="focus" value="${secret}">
      <form method="post" action="/__fixtures/operation-result.html">
        <button id="${secret}" name="${secret}" aria-label="${secret}"
          onclick="this.remove(); return false">${secret}</button>
      </form>
      <div style="height:2000px"></div>
    `,
    );
    await send("Runtime.evaluate", {
      expression: "document.getElementById('focus').focus(); scrollTo(0, 5)",
    });
    const readState = () =>
      send("Runtime.evaluate", {
        expression: "[document.activeElement.id, scrollX, scrollY]",
        returnByValue: true,
      });
    const original = await readState();
    await observe(send);
    const hit = await send("Kitesurf.inspectInteractionTarget", { x: 30, y: 25 });
    expect(hit.hitTarget?.tagName).toBe("BUTTON");
    expect(JSON.stringify(hit)).not.toContain(secret);
    expect((await readState()).result.value).toEqual(original.result.value);
    const inspection = await send("Kitesurf.stopOperationDiagnostics");
    expect(inspection.beforeClicks).toEqual([]);
    expect(inspection.requests).toEqual([]);
    expect(inspection.completedClicks).toBe(0);

    await observe(send);
    await click(send);
    const after = await send("Kitesurf.inspectInteractionTarget", { x: 30, y: 25 });
    const operation = await send("Kitesurf.stopOperationDiagnostics");
    expect(after.documentId).toBe(hit.documentId);
    expect(after.hitTarget?.backendNodeId).not.toBe(hit.hitTarget?.backendNodeId);
    expect(operation.beforeClicks).toEqual([
      expect.objectContaining({
        documentId: hit.documentId,
        x: 30,
        y: 25,
        hit: "hit",
        hitTarget: { backendNodeId: hit.hitTarget?.backendNodeId, tagName: "BUTTON" },
        dispatchTarget: { backendNodeId: hit.hitTarget?.backendNodeId, tagName: "BUTTON" },
      }),
    ]);
    expect(operation.requests).toEqual([]);
    expect(JSON.stringify(operation)).not.toContain(secret);
  } finally {
    connection.close();
  }
}, 60_000);
