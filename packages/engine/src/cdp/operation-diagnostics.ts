// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type Protocol from "devtools-protocol";
import type { BeforeClickSnapshot } from "@kitesurf/jsrpc-types/query-dom";
import {
  selectDiagnosticResponseHeaders,
  type DiagnosticHeaderSource,
} from "./diagnostic-response-headers.ts";

const DEFAULT_DURATION_MS = 5_000;
const MAX_DURATION_MS = 30_000;
const MAX_WAIT_MS = 2_000;
const REPORT_RETENTION_MS = 60_000;
const MAX_RECORDS = 100;
const MAX_PUBLIC_VALUES = 16;
const MAX_PUBLIC_VALUE_LENGTH = 256;

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);
const EXCEPTIONS = new Set([
  "Error",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
]);

type PageSnapshot = Protocol.Kitesurf.OperationPageSnapshot;
type Request = Protocol.Kitesurf.OperationRequest;
type Options = { durationMs?: unknown; publicTitles?: unknown; publicUrls?: unknown };

function limit(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function approvedValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_PUBLIC_VALUES)
    .filter(
      (entry: unknown): entry is string =>
        typeof entry === "string" && entry.length <= MAX_PUBLIC_VALUE_LENGTH,
    );
}

function summarizeUrl(raw: string, approved: ReadonlySet<string>): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const path = url.origin + url.pathname;
      return approved.has(path) ? path : url.origin;
    }
    return url.protocol === "about:" && url.pathname === "blank" ? "about:blank" : url.protocol;
  } catch {
    return "(unparseable-url)";
  }
}

function recordResponse(request: Request, status: number, headers?: DiagnosticHeaderSource): void {
  request.status = status;
  if (!headers || request.responseHeaders !== undefined) return;
  const selected = selectDiagnosticResponseHeaders(headers);
  if (Object.keys(selected).length > 0) request.responseHeaders = selected;
}

interface Capture {
  frameId: string;
  owner: string | undefined;
  start: PageSnapshot;
  startedAt: number;
  deadline: number;
  deadlineTimer: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  snapshot: () => Promise<PageSnapshot>;
  publicUrls: ReadonlySet<string>;
  requests: Request[];
  currentRequests: Map<string, Request>;
  exceptions: Protocol.Kitesurf.OperationException[];
  completedClicks: number;
  beforeClicks: BeforeClickSnapshot[];
  completedDocumentNavigations: number;
  lastReadyRequestId?: string;
  postStartObserved: boolean;
  droppedRecords: number;
  stopped?: Promise<Protocol.Kitesurf.StopOperationDiagnosticsResponse>;
  sealedAt?: number;
  sealed?: Promise<PageSnapshot>;
}

export class OperationDiagnostics {
  private capture: Capture | undefined;

  watches(frameId: string): boolean {
    const capture = this.capture;
    return (
      capture?.frameId === frameId &&
      capture.sealedAt === undefined &&
      Date.now() <= capture.deadline
    );
  }

  deadlineFor(frameId: string): number {
    return this.watches(frameId) ? (this.capture?.deadline ?? 0) : 0;
  }

  get observedFrameId(): string | undefined {
    return this.capture?.frameId;
  }

  async start(
    frameId: string,
    owner: string | undefined,
    options: Options | undefined,
    readPage: (publicTitles: string[], exceptionDeadline: number) => Promise<PageSnapshot>,
    stillExclusive: () => boolean,
  ): Promise<Protocol.Kitesurf.StartOperationDiagnosticsResponse> {
    if (this.capture) throw new Error("An operation observation already exists on this connection");
    const publicUrls = new Set(approvedValues(options?.publicUrls));
    const publicTitles = approvedValues(options?.publicTitles);
    const durationMs = limit(options?.durationMs, DEFAULT_DURATION_MS, 1, MAX_DURATION_MS);
    const read = async (exceptionDeadline: number) => {
      const page = await readPage(publicTitles, exceptionDeadline);
      return { ...page, url: summarizeUrl(page.url, publicUrls) };
    };
    const start = await read(Date.now() + durationMs + 250);
    if (this.capture) throw new Error("An operation observation already exists on this connection");
    if (!stillExclusive())
      throw new Error("Operation observation requires a single session on the page");
    const startedAt = Date.now();
    const capture: Capture = {
      frameId,
      owner,
      start,
      startedAt,
      deadline: startedAt + durationMs,
      snapshot: () => read(0),
      publicUrls,
      deadlineTimer: setTimeout(() => {
        if (this.capture === capture) void this.seal(capture);
      }, durationMs),
      requests: [],
      currentRequests: new Map(),
      exceptions: [],
      completedClicks: 0,
      beforeClicks: [],
      completedDocumentNavigations: 0,
      postStartObserved: false,
      droppedRecords: 0,
    };
    this.capture = capture;
    return { start, startedAt, durationMs, maxRecords: MAX_RECORDS };
  }

  stop(
    frameId: string,
    owner: string | undefined,
    waitMs: unknown,
    flush: () => Promise<void>,
  ): Promise<Protocol.Kitesurf.StopOperationDiagnosticsResponse> {
    const capture = this.capture;
    if (!capture || capture.frameId !== frameId || capture.owner !== owner) {
      throw new Error("No operation observation for this page session");
    }
    capture.stopped ??= this.finish(capture, waitMs, flush);
    return capture.stopped;
  }

  private async finish(capture: Capture, waitMs: unknown, flush: () => Promise<void>) {
    const wait = Math.min(limit(waitMs, 0, 0, MAX_WAIT_MS), capture.deadline - Date.now());
    if (wait > 0 && capture.sealedAt === undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    if (this.capture !== capture) throw new Error("Operation observation is no longer available");
    const end = await this.seal(capture);
    // Retain exception timestamps from the last drain if they fall inside the window.
    await flush();
    if (this.capture !== capture) throw new Error("Operation observation is no longer available");
    this.dispose();
    return {
      start: capture.start,
      end,
      startedAt: capture.startedAt,
      endedAt: capture.sealedAt ?? capture.deadline,
      requests: capture.requests,
      exceptions: capture.exceptions,
      completedClicks: capture.completedClicks,
      beforeClicks: capture.beforeClicks,
      completedDocumentNavigations: capture.completedDocumentNavigations,
      postStartObserved: capture.postStartObserved,
      droppedRecords: capture.droppedRecords,
      laterActivity: "unverified" as const,
    };
  }

  private seal(capture: Capture): Promise<PageSnapshot> {
    if (capture.sealed) return capture.sealed;
    capture.sealedAt = Math.min(capture.deadline, Date.now());
    clearTimeout(capture.deadlineTimer);
    capture.expiryTimer = setTimeout(() => {
      if (this.capture === capture) this.dispose();
    }, REPORT_RETENTION_MS);
    capture.sealed = capture.snapshot();
    return capture.sealed;
  }

  discardTarget(frameId: string): void {
    if (this.capture?.frameId === frameId) this.dispose();
  }

  discardForOtherSession(frameId: string, sessionId: string | undefined): void {
    if (this.capture?.frameId === frameId && this.capture.owner !== sessionId) this.dispose();
  }

  forgetSession(sessionId: string): void {
    if (this.capture?.owner === sessionId) this.dispose();
  }

  dispose(): void {
    const capture = this.capture;
    if (!capture) return;
    clearTimeout(capture.deadlineTimer);
    clearTimeout(capture.expiryTimer);
    this.capture = undefined;
  }

  begin(requestId: string, frameId: string, method: string, url: string, type: string): void {
    const capture = this.capture;
    if (!capture || !this.watches(frameId)) return;
    const safeMethod = METHODS.has(method) ? method : "Other";
    capture.postStartObserved ||= safeMethod === "POST";
    if (!this.hasRoom(capture)) return;
    const request: Request = {
      type: type === "Document" || type === "Fetch" || type === "XHR" ? type : "Other",
      method: safeMethod,
      url: summarizeUrl(url, capture.publicUrls),
      status: null,
      state: "pending",
    };
    capture.requests.push(request);
    capture.currentRequests.set(requestId, request);
  }

  redirect(
    requestId: string,
    frameId: string,
    method: string,
    url: string,
    type: string,
    status: number,
    headers: DiagnosticHeaderSource,
  ): void {
    const capture = this.capture;
    const request = this.openRequest(requestId);
    if (!capture || !request) return;
    request.redirectedTo = summarizeUrl(url, capture.publicUrls);
    this.complete(requestId, { status, headers });
    capture.currentRequests.delete(requestId);
    this.begin(requestId, frameId, method, url, type);
  }

  headers(requestId: string, status: number, headers?: DiagnosticHeaderSource): void {
    const request = this.openRequest(requestId);
    if (request) recordResponse(request, status, headers);
  }

  complete(
    requestId: string,
    response: {
      status: number;
      headers?: DiagnosticHeaderSource;
      errorText?: string;
      bodyCompletionUnverified?: boolean;
    },
  ): void {
    const request = this.openRequest(requestId);
    if (!request) return;
    recordResponse(request, response.status, response.headers);
    request.state =
      response.errorText !== undefined
        ? "failed"
        : response.bodyCompletionUnverified
          ? "responseReceived"
          : "completed";
  }

  fail(requestId: string, timedOut: boolean): void {
    const request = this.openRequest(requestId);
    if (request) request.state = timedOut ? "timedOut" : "failed";
  }

  captureClick(frameId: string, owner: string | undefined) {
    const capture = this.capture;
    if (!capture || capture.owner !== owner || !this.watches(frameId)) return;
    return (dispatched: boolean, beforeClick?: BeforeClickSnapshot): void => {
      if (this.capture !== capture || !this.watches(frameId)) return;
      if (dispatched) capture.completedClicks++;
      if (beforeClick && this.hasRoom(capture)) capture.beforeClicks.push(beforeClick);
    };
  }

  documentReady(frameId: string, requestId: string): void {
    const capture = this.capture;
    if (
      !capture ||
      !this.watches(frameId) ||
      capture.lastReadyRequestId === requestId ||
      capture.currentRequests.get(requestId)?.type !== "Document"
    )
      return;
    capture.lastReadyRequestId = requestId;
    capture.completedDocumentNavigations++;
  }

  exception(frameId: string, timestamp: number, className: string): void {
    const capture = this.capture;
    if (!capture || capture.frameId !== frameId || !Number.isFinite(timestamp)) return;
    if (timestamp < capture.startedAt || timestamp > (capture.sealedAt ?? capture.deadline)) return;
    if (!this.hasRoom(capture)) return;
    capture.exceptions.push({ timestamp, kind: EXCEPTIONS.has(className) ? className : "Other" });
  }

  private openRequest(requestId: string): Request | undefined {
    const capture = this.capture;
    if (!capture || !this.watches(capture.frameId)) return;
    const request = capture.currentRequests.get(requestId);
    return request?.state === "pending" ? request : undefined;
  }

  private hasRoom(capture: Capture): boolean {
    if (
      capture.requests.length + capture.exceptions.length + capture.beforeClicks.length <
      MAX_RECORDS
    )
      return true;
    capture.droppedRecords++;
    return false;
  }
}
