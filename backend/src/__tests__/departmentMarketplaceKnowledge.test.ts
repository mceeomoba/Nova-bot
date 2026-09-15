// next-phase.md Phase 9e-iii (architecture-agent.md §4h's closing
// paragraph): tests for the decision logic behind
// writeMarketplaceKnowledgeForMarketingDepartment() in departments.ts
// — a Marketing department's own `create_department` call gains a
// `department_knowledge` write (category `department_strategy`)
// stating the shared marketplace's URL and this Agent's own storefront
// path, without ever handing Marketing a Cloudflare/Mailcow
// credential.
//
// NOTE on what this file can and can't exercise in this environment:
// same no-network-for-`npm install` constraint every prior backend/src
// phase (2i(a)…2i(e), 3a…3g-iii, 9a…9d) has already flagged and worked
// around. departments.ts imports `./db.js`, which pulls in
// better-sqlite3 at module load — not installed here — so it can't be
// imported and run against a live DB. What CAN be tested without a
// live DB is the decision logic itself (role → department-type gating
// via normalizeDepartmentType(), the exact content string built from a
// marketplace URL + agent slug, and the no-slug skip path), since none
// of it touches a table read/write beyond the single INSERT
// recordDepartmentKnowledge() itself already owns and already has its
// own coverage for (toolRegistry.test.ts's own convention). This file
// inlines the gating/content logic, kept byte-for-byte in sync with
// departments.ts's own implementation (see the comment above each).
// Before deploying, re-run this same set of cases against a real
// create_department() call over a live sqlite3 DB (`npm install &&
// npx tsc && node dist/__tests__/departmentMarketplaceKnowledge.test.js`)
// to confirm the inlined copy hasn't drifted from the real function.

import { test } from "node:test";
import assert from "node:assert/strict";

type DepartmentType = "software" | "marketing" | "finance" | "security" | "server" | "domain";

// Mirrors toolRegistry.ts's DEPARTMENT_TYPE_ALIASES / normalizeDepartmentType()
// exactly — a literal copy, not an import, per this file's own header
// (same convention toolRegistry.test.ts already established for this
// exact function).
const DEPARTMENT_TYPE_ALIASES: Record<DepartmentType, string[]> = {
  software: ["engineering", "eng", "dev", "development", "frontend", "backend"],
  marketing: ["growth", "marcomm"],
  finance: ["accounting", "fin"],
  security: ["infosec", "sec"],
  server: ["infra", "infrastructure", "devops", "ops", "sysadmin"],
  domain: ["dns", "domains", "webmaster"],
};
const CANONICAL_DEPARTMENT_TYPES: DepartmentType[] = [
  "software",
  "marketing",
  "finance",
  "security",
  "server",
  "domain",
];

function normalizeDepartmentType(role: string | null | undefined): DepartmentType | null {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if ((CANONICAL_DEPARTMENT_TYPES as string[]).includes(normalized)) {
    return normalized as DepartmentType;
  }
  for (const type of CANONICAL_DEPARTMENT_TYPES) {
    if (DEPARTMENT_TYPE_ALIASES[type].includes(normalized)) return type;
  }
  return null;
}

// Mirrors domains.ts's MARKETPLACE_SUBDOMAIN_SLUG (= PLATFORM_RESERVED_SLUG)
// and config.ts's domainApex default.
const MARKETPLACE_SUBDOMAIN_SLUG = "marketplace";
const DOMAIN_APEX = "novamail.store";

// Mirrors departments.ts's writeMarketplaceKnowledgeForMarketingDepartment()
// gating + content-construction logic — the parts that don't require a
// live DB. Returns `null` when the write is skipped (no slug), else
// the exact `{ category, content }` recordDepartmentKnowledge() would
// be called with.
function resolveMarketplaceKnowledgeWrite(
  role: string,
  agentSlug: string | null | undefined,
): { category: "department_strategy"; content: string } | null {
  if (normalizeDepartmentType(role) !== "marketing") return null;
  if (!agentSlug) return null;
  const marketplaceUrl = `https://${MARKETPLACE_SUBDOMAIN_SLUG}.${DOMAIN_APEX}`;
  const storefrontPath = `/${agentSlug}`;
  return {
    category: "department_strategy",
    content: `our marketplace listings live at ${marketplaceUrl}, your storefront path is ${storefrontPath}`,
  };
}

test("marketing role (canonical) triggers a write", () => {
  const result = resolveMarketplaceKnowledgeWrite("marketing", "spacex");
  assert.ok(result);
  assert.equal(result!.category, "department_strategy");
  assert.equal(
    result!.content,
    "our marketplace listings live at https://marketplace.novamail.store, your storefront path is /spacex",
  );
});

test("marketing role aliases (growth, marcomm) trigger a write, case-insensitive and trimmed", () => {
  for (const role of ["growth", "MARCOMM", "  Marketing  ", "Growth"]) {
    const result = resolveMarketplaceKnowledgeWrite(role, "acme-co");
    assert.ok(result, `expected a write for role "${role}"`);
    assert.match(result!.content, /storefront path is \/acme-co$/);
  }
});

test("non-marketing canonical roles never trigger a write", () => {
  for (const role of ["software", "finance", "security", "server", "domain"]) {
    assert.equal(resolveMarketplaceKnowledgeWrite(role, "some-slug"), null);
  }
});

test("non-marketing aliases never trigger a write", () => {
  for (const role of ["engineering", "devops", "infosec", "dns"]) {
    assert.equal(resolveMarketplaceKnowledgeWrite(role, "some-slug"), null);
  }
});

test("unrecognized role never triggers a write (fail closed, same as assignTools())", () => {
  assert.equal(resolveMarketplaceKnowledgeWrite("totally-unknown-role", "some-slug"), null);
});

test("empty/whitespace role never triggers a write", () => {
  assert.equal(resolveMarketplaceKnowledgeWrite("", "some-slug"), null);
  assert.equal(resolveMarketplaceKnowledgeWrite("   ", "some-slug"), null);
});

test("marketing role with no agent slug skips the write rather than producing a broken storefront path", () => {
  assert.equal(resolveMarketplaceKnowledgeWrite("marketing", null), null);
  assert.equal(resolveMarketplaceKnowledgeWrite("marketing", undefined), null);
  assert.equal(resolveMarketplaceKnowledgeWrite("marketing", ""), null);
});

test("content wording matches architecture-agent.md §4h verbatim, for a range of slugs", () => {
  for (const slug of ["a", "spacex-blog", "very-long-agent-slug-name-24"]) {
    const result = resolveMarketplaceKnowledgeWrite("marketing", slug);
    assert.ok(result);
    assert.equal(
      result!.content,
      `our marketplace listings live at https://marketplace.novamail.store, your storefront path is /${slug}`,
    );
  }
});

test("storefront path is always the Agent's own slug, never the department's id or name", () => {
  // The function signature itself only ever takes an agentSlug, never a
  // departmentId/departmentName — this test documents that contract
  // rather than re-deriving it, since resolveMarketplaceKnowledgeWrite()
  // (and the real writeMarketplaceKnowledgeForMarketingDepartment())
  // has no department-name parameter to accidentally use instead.
  const result = resolveMarketplaceKnowledgeWrite("marketing", "the-agents-own-slug");
  assert.match(result!.content, /\/the-agents-own-slug$/);
});
