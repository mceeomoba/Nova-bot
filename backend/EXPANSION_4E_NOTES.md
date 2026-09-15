# Zent.md Phase 4e — Opportunity Intelligence: Reporting Interface (UI list view)

Deliverable per Zent.md: *"Basic UI list view (if a frontend exists in
this stack already — otherwise a plain JSON endpoint is the deliverable
for this phase)."*

There's no frontend framework anywhere in this repo (`backend/` is a
plain Express API; `agent/` is the runtime, not a UI). Phase 4a already
shipped the "otherwise" JSON fallback (`GET
/expansion/opportunities/:agentAddress`). This phase adds the other
half named in the doc: an actual list *view*.

## What shipped

- **`backend/src/expansionUiRoutes.ts`** — `GET /expansion/ui/:agentAddress`,
  a single self-contained HTML page (inline CSS/JS, zero build step, zero
  new dependency) that renders:
  - the ranked opportunity list (4a), with a status filter (open /
    selected / rejected / all)
  - per-opportunity detail (4b) on click — source summary, scoring
    factors, de-dup history, shown inline
  - the notification log (4d) — opportunity, ROI, created-at, delivered

- Mounted in `index.ts` at the same public tier as `agentCardRouter` /
  `marketplaceRouter` / `distributionRouter` — the page itself carries
  no secret and performs no write. The person viewing it pastes their
  own `x-backend-key` into the page (kept in `sessionStorage` only);
  every actual data call happens client-side, straight against the
  existing authed `/expansion/opportunities/*` and
  `/expansion/notifications/*` routes, unchanged.

- **`backend/src/__tests__/expansionUiListView.test.ts`** — shape tests
  against the pure render function (no live server, same convention as
  every other `expansion*.test.ts` in this repo): HTML-escaping of the
  address, JSON-in-`<script>`-tag XSS safety, no external
  script/style dependency, and — the one this phase cares about most —
  **no write affordance of any kind**.

## Read-only, deliberately

Zent.md is explicit, both in Phase 4c ("no external operator step in
this path") and in its closing notes ("There is no human-in-the-loop
step anywhere in this pipeline... an `approved` decision fires genesis
directly"): promote/demote/reject, the CEO's `decide_expansion` call,
and genesis are all agent-only actions. This view has no button, form,
or code path that calls any of those — it's a window onto what the
pipeline and the agent are doing, not a control surface. The shape
test above (`has no write/decision affordance of any kind`) exists
specifically so a later edit can't quietly add one without a test
failing first.

## Not in scope for 4e

- Editing/annotating opportunities from the UI — out of scope by the
  read-only framing above.
- Auth beyond "paste the existing backend key" — this reuses the same
  single shared-secret trust model every other route in this backend
  already uses (see `wallet.ts`'s own header: self-hosted per
  operator, one key, no multi-tenant concern).
- Research/Finance/Strategy report views, the committee packet, or the
  CEO decision UI — those belong to their own phases (7c, 10a, 12e,
  13d) and aren't built yet.
