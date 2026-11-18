// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type Protocol from "devtools-protocol";
import { expect, test } from "./harness";

const origin = "https://ks.invalid";
const finalUrl = origin + "/diagnostics/document";
const redirectUrl = origin + "/diagnostics/redirect";
const queryAndFragment = "?token=fixture-secret#fixture-fragment";

test.for([
  { redirect: false, status: 200 },
  { redirect: false, status: 403 },
  { redirect: true, status: 200 },
  { redirect: true, status: 403 },
])(
  "navigation diagnostics report redirect=$redirect and HTTP $status",
  { timeout: 60_000 },
  async ({ redirect, status }, { cdpSession: cdp }) => {
    await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] });
    const respond = async ({ requestId, request }: Protocol.Fetch.RequestPausedEvent) => {
      if (new URL(request.url).pathname === "/diagnostics/redirect") {
        await cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 302,
          responseHeaders: [{ name: "Location", value: finalUrl + queryAndFragment }],
        });
        return;
      }
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: status,
        responseHeaders: [
          { name: "Content-Type", value: "text/html" },
          { name: "Set-Cookie", value: "session=fixture-cookie" },
          { name: "WWW-Authenticate", value: 'Basic realm="fixture-auth"' },
          { name: "Server", value: "fixture-server" },
          ...(status === 403
            ? [
                { name: "Via", value: "1.1 fixture-proxy" },
                { name: "X-Request-ID", value: "fixture-response-id" },
              ]
            : []),
        ],
        body: btoa("<!doctype html><title>Navigation fixture</title>"),
      });
    };
    const responses: Promise<void>[] = [];
    cdp.on("Fetch.requestPaused", (event) => responses.push(respond(event)));
    const requestedUrl = redirect ? redirectUrl : finalUrl;
    const result = await cdp.send("Page.navigate", {
      url: requestedUrl + queryAndFragment,
      kitesurfDiagnostics: true,
    });
    await Promise.all(responses);

    expect(result.errorText).toBeUndefined();
    expect(result.kitesurfDiagnostics).toEqual({
      requestedUrl,
      finalUrl,
      redirects: redirect
        ? [
            {
              url: redirectUrl,
              destinationUrl: finalUrl,
              status: 302,
              headersReceivedMs: expect.any(Number),
            },
          ]
        : [],
      status,
      responseHeaders:
        status === 403
          ? {
              server: "fixture-server",
              via: "1.1 fixture-proxy",
              "x-request-id": "fixture-response-id",
            }
          : { server: "fixture-server" },
      headersReceivedMs: expect.any(Number),
      navigationCompleted: true,
      httpSuccess: status === 200,
    });
    const diagnostics = result.kitesurfDiagnostics!;
    expect(diagnostics.headersReceivedMs).toBeGreaterThanOrEqual(
      diagnostics.redirects[0]?.headersReceivedMs ?? 0,
    );
  },
);

test("navigation diagnostics have no HTTP result when the request fails", async ({
  cdpSession: cdp,
}) => {
  await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] });
  cdp.once("Fetch.requestPaused", ({ requestId }) => {
    void cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
  });
  const result = await cdp.send("Page.navigate", {
    url: finalUrl + queryAndFragment,
    kitesurfDiagnostics: true,
  });
  expect(result.errorText).toBe("net::ERR_CONNECTION_REFUSED");
  expect(result.kitesurfDiagnostics).toEqual({
    requestedUrl: finalUrl,
    finalUrl: null,
    redirects: [],
    status: null,
    responseHeaders: {},
    headersReceivedMs: null,
    navigationCompleted: false,
    httpSuccess: null,
  });
}, 60_000);
