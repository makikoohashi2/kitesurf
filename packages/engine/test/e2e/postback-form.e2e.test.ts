// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Exercise legacy postback with dummy values against an in-process fixture, not a real login.
import { expect, test } from "./harness";

const fixture = "https://ks.invalid/__fixtures/";
const html = `<form id="aspnetForm" name="aspnetForm" method="post" action="${fixture}form-echo">
  <input type="hidden" name="__EVENTTARGET" value="">
  <input type="hidden" name="__EVENTARGUMENT" value="">
  <input name="container_0$UserID">
  <input type="password" name="container_0$Password">
  <button id="login" type="button" onclick="__doPostBack('container_0$Login','')">Submit fixture</button>
</form>
<script>
var theForm = document.forms['aspnetForm'];
if (!theForm) theForm = document.aspnetForm;
function __doPostBack(eventTarget, eventArgument) {
  if (!theForm.onsubmit || theForm.onsubmit() !== false) {
    theForm.__EVENTTARGET.value = eventTarget;
    theForm.__EVENTARGUMENT.value = eventArgument;
    theForm.submit();
  }
}
</script>`;

test("named form controls support postback with dummy credentials", async ({ page }) => {
  const url = new URL("policy-doc.html", fixture);
  url.searchParams.set("body", html);
  await page.goto(url.href);
  expect(
    await page.evaluate(() => {
      const form = document.forms.namedItem("aspnetForm");
      return form && Reflect.get(form, "__EVENTTARGET")?.tagName;
    }),
  ).toBe("INPUT");
  await page.type('input[name="container_0$UserID"]', "fixture-user");
  await page.type('input[name="container_0$Password"]', "not-a-real-password");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
    page.click("#login"),
  ]);
  const result = await page.evaluate(() => ({
    method: document.getElementById("method")?.textContent,
    body: document.getElementById("body")?.textContent,
  }));
  expect(result.method).toBe("POST");
  const fields = new URLSearchParams(result.body ?? "");
  expect(fields.get("__EVENTTARGET")).toBe("container_0$Login");
  expect(fields.get("__EVENTARGUMENT")).toBe("");
  expect(fields.get("container_0$UserID")).toBe("fixture-user");
  expect(fields.get("container_0$Password")).toBe("not-a-real-password");
});
