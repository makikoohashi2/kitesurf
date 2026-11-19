// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const RESPONSE_HEADER_NAMES = [
  "server",
  "via",
  "request-id",
  "x-request-id",
  "x-correlation-id",
  "cf-ray",
  "x-amzn-requestid",
  "x-amz-request-id",
  "x-amz-cf-id",
  "x-ms-request-id",
];

const MAX_HEADER_VALUE_CHARS = 256;

// NetworkEventTracker uses lower-case keys for records made from response Headers.
export type DiagnosticHeaderSource = Headers | Readonly<Record<string, string>>;

export function selectDiagnosticResponseHeaders(
  headers: DiagnosticHeaderSource,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_NAMES) {
    const value = headers instanceof Headers ? headers.get(name) : headers[name];
    // Keep each identifier intact. The fixed allowlist also bounds the entry count.
    if (typeof value === "string" && value.length > 0 && value.length <= MAX_HEADER_VALUE_CHARS)
      selected[name] = value;
  }
  return selected;
}
