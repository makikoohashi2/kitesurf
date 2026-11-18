// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Compare headers received by the fixture with the identity exposed to page code.
import type { Page } from "@cloudflare/puppeteer";
import { DEFAULT_USER_AGENT } from "@kitesurf/dom-shim/user-agent";
import { expect, test } from "./harness";

const ECHO = "https://ks.invalid/__fixtures/echo-headers.html";

async function identities(page: Page) {
  await page.waitForFunction(() => {
    const headers = Reflect.get(globalThis, "__ks_fetch_headers");
    return typeof headers === "object" && headers !== null;
  });
  return page.evaluate(() => {
    const doc = Reflect.get(globalThis, "__ks_doc_headers") as Record<string, string>;
    const sub = Reflect.get(globalThis, "__ks_fetch_headers") as Record<string, string>;
    return {
      document: doc["user-agent"],
      subrequest: sub["user-agent"],
      navigator: navigator.userAgent,
    };
  });
}

test("default identity agrees across discovery, document, fetch, and navigator", async ({
  page,
  cdpSession,
}) => {
  const version = await cdpSession.send("Browser.getVersion");
  expect(version.userAgent).toBe(DEFAULT_USER_AGENT);
  await page.goto(ECHO);
  expect(await identities(page)).toEqual({
    document: DEFAULT_USER_AGENT,
    subrequest: DEFAULT_USER_AGENT,
    navigator: DEFAULT_USER_AGENT,
  });
});

test("an explicit identity survives navigation and resetting restores one default", async ({
  page,
  cdpSession,
}) => {
  for (const method of [
    "Network.setUserAgentOverride",
    "Emulation.setUserAgentOverride",
  ] as const) {
    const custom = `KitesurfConsistencyTest/${method}`;
    await cdpSession.send(method, { userAgent: custom });
    await page.goto(ECHO);
    expect(await identities(page)).toEqual({
      document: custom,
      subrequest: custom,
      navigator: custom,
    });
  }
  await cdpSession.send("Network.setUserAgentOverride", { userAgent: "" });
  await page.goto(ECHO);
  expect(await identities(page)).toEqual({
    document: DEFAULT_USER_AGENT,
    subrequest: DEFAULT_USER_AGENT,
    navigator: DEFAULT_USER_AGENT,
  });
});
