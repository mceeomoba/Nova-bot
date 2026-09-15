// Zent.md Phase 4e — "Basic UI list view ... otherwise a plain JSON
// endpoint is the deliverable for this phase."
//
// No live express server in this test (same "no live better-sqlite3 /
// no live express server in this environment" reason every other
// backend/src test file in this repo carries — see
// expansionOpportunitiesList.test.ts's own header). This just imports
// the pure page-rendering function directly and asserts on its output
// string, the same way a template-rendering unit test would.
//
// What this locks in:
//   - the agentAddress is escaped into the heading (no HTML injection
//     via an attacker-controlled address string)
//   - the client script only ever calls the existing, already-authed
//     4a/4b/4d JSON routes — never a route this phase invented that
//     could itself become a write path
//   - the page has NO write affordance anywhere: no promote/demote/
//     reject/decide/approve control of any kind. Zent.md is explicit
//     that those stay agent-only with "no external operator step in
//     this path" (4c) all the way through CEO decision + genesis
//     (15d) — this view is observability, not control, and this test
//     is what keeps a future edit from quietly adding a button that
//     would contradict that.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { _renderListViewPageForTests as renderListViewPage } from "../expansionUiRoutes.js";

describe("expansionUiRoutes: Phase 4e list view", () => {
  test("escapes an agentAddress containing HTML-special characters", () => {
    const html = renderListViewPage('0xABC"><script>alert(1)</script>');
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  test("passes the raw agentAddress to client JS only as a JSON string literal", () => {
    const html = renderListViewPage("0xDEF");
    assert.ok(html.includes('var AGENT_ADDRESS = "0xDEF";'));
  });

  test("only calls the pre-existing 4a/4b/4d JSON routes", () => {
    const html = renderListViewPage("0xDEF");
    assert.ok(html.includes('"/expansion/opportunities/" + encodeURIComponent(AGENT_ADDRESS)'));
    assert.ok(html.includes('"/expansion/opportunities/" + encodeURIComponent(oppId)'));
    assert.ok(html.includes('"/expansion/notifications/" + encodeURIComponent(AGENT_ADDRESS)'));
  });

  test("never fetches with a method other than the default GET", () => {
    const html = renderListViewPage("0xDEF");
    assert.ok(!/method\s*:\s*["']POST["']/i.test(html));
    assert.ok(!/method\s*:\s*["']PUT["']/i.test(html));
    assert.ok(!/method\s*:\s*["']PATCH["']/i.test(html));
    assert.ok(!/method\s*:\s*["']DELETE["']/i.test(html));
  });

  test("has no write/decision affordance of any kind", () => {
    const html = renderListViewPage("0xDEF").toLowerCase();
    for (const forbidden of [
      "promote",
      "demote",
      "reject(",
      '"reject"',
      "decide_expansion",
      "/decide",
      "approve",
      "genesis_company",
    ]) {
      assert.ok(!html.includes(forbidden), `list view must not contain "${forbidden}"`);
    }
  });

  test("backend key is read from sessionStorage, never hardcoded or query-stringed", () => {
    const html = renderListViewPage("0xDEF");
    assert.ok(html.includes("sessionStorage.getItem(STORAGE_KEY)"));
    assert.ok(!/x-backend-key["']?\s*[:=]\s*["'][^"']+["']/i.test(html));
  });

  test("is a self-contained document with no external script/style dependency", () => {
    const html = renderListViewPage("0xDEF");
    assert.ok(!/<script[^>]+src=/i.test(html));
    assert.ok(!/<link[^>]+href=/i.test(html));
  });
});
