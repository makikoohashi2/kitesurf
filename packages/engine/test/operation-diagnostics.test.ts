// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test, vi } from "vitest";
import { NetworkEventTracker } from "../src/cdp/network-events";

test("operation observation bounds records and retains failures without raw error text", async () => {
  vi.useFakeTimers();
  const tracker = new NetworkEventTracker(() => {}, "test-connection");
  const observation = tracker.operationDiagnostics;
  const frameId = "target-frame";
  try {
    const start = await observation.start(
      frameId,
      "owner",
      { durationMs: 50 },
      async () => ({
        url: "https://user:private@example.test/secret?key=private#fragment",
        title: null,
        formCount: 0,
      }),
      () => true,
    );
    const request = (url: string, method: string) =>
      tracker.beginRequest({
        url,
        method,
        type: "Fetch",
        headers: { Authorization: "fixture-secret" },
        initiator: { type: "script" },
        loaderId: "loader",
        frameId,
      });
    tracker.failRequest(request("https://example.test/fail", "GET"), "Error with fixture-secret");
    tracker.failRequest(request("https://example.test/timeout", "GET"), "net::ERR_TIMED_OUT");
    const pending = request("https://example.test/headers-only", "GET");
    observation.headers(
      pending,
      403,
      new Headers({
        "X-Request-ID": "test-response-id",
        "Set-Cookie": "fixture-secret",
      }),
    );
    const beforeClick = {
      documentId: "test-document",
      timestamp: start.startedAt,
      x: 40,
      y: 25,
      hit: "none" as const,
      hitTarget: null,
      dispatchTarget: null,
    };
    observation.captureClick(frameId, "owner")?.(true, beforeClick);
    for (let index = 4; index < start.maxRecords; index++) {
      request("https://example.test/pending", "GET");
    }
    request("https://example.test/post", "POST");
    observation.exception(frameId, start.startedAt, "arbitrary fixture-secret");
    observation.captureClick(frameId, "owner")?.(true, beforeClick);
    await vi.advanceTimersByTimeAsync(start.durationMs + 1);
    request("https://example.test/late", "POST");
    const result = await observation.stop(frameId, "owner", 500_000, async () => {});
    expect(result.startedAt + 50).toBe(result.endedAt);
    expect(result.requests).toHaveLength(start.maxRecords - 1);
    expect(result.beforeClicks).toEqual([beforeClick]);
    expect(result.completedClicks).toBe(2);
    expect(result.requests.slice(0, 2).map((entry) => entry.state)).toEqual(["failed", "timedOut"]);
    expect(result.requests[2]).toEqual({
      type: "Fetch",
      method: "GET",
      url: "https://example.test",
      status: 403,
      state: "pending",
      responseHeaders: { "x-request-id": "test-response-id" },
    });
    expect(result.start.url).toBe("https://example.test");
    expect(result.droppedRecords).toBe(3);
    expect(result.postStartObserved).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|private|fragment/);
  } finally {
    tracker.dispose();
    vi.useRealTimers();
  }
});
