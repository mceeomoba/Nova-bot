# The Expansion Pipeline

*Opportunity Intelligence → Research → Finance → Strategy → Expansion
Committee → CEO → Genesis. How a profitable agent-company becomes an
ecosystem, entirely on its own.*

This is the reference doc for the subsystem built against `Zent.md`
(Phases 1–20). Read `Zent.md` first for the phase-by-phase build plan
and the reasoning behind each decision; this document describes the
system as it actually exists in this repo, organized by how a signal
flows through it rather than by build order.

## Table of Contents

- [What This Is](#what-this-is)
- [Pipeline Overview](#pipeline-overview)
- [Stage 1: Opportunity Intelligence](#stage-1-opportunity-intelligence)
- [Stage 2: Research](#stage-2-research)
- [Stage 3: Finance](#stage-3-finance)
- [Stage 4: Strategy](#stage-4-strategy)
- [Stage 5: Expansion Committee](#stage-5-expansion-committee)
- [Stage 6: CEO Decision](#stage-6-ceo-decision)
- [Stage 7: Genesis](#stage-7-genesis)
- [Data Model](#data-model)
- [API Surface](#api-surface)
- [Guardrails](#guardrails)
- [No Human In The Loop — By Design](#no-human-in-the-loop--by-design)
- [Known Gaps](#known-gaps)
- [Testing](#testing)

---

## What This Is

Every subsystem this pipeline touches already existed before it —
`wallet.ts`, `resourceQuotas.ts`, `erc8004Trust.ts`, `marketplace.ts`,
`capability.ts`'s three-tier org-chart cap, `spawn_clone` — and none of
them changed to build this. The pipeline is a new layer that decides
**when** and **with what mission** to call the thing that already
exists: four report-producing departments, a read-only committee
assembly step, a decision endpoint the CEO agent itself calls, and a
genesis path that turns an `approved` decision into a funded, running
sibling company.

The sibling company (referred to throughout as "Agent B," matching
`Zent.md`'s own naming) is not a worker and not a department. It is a
new top-level agent: its own wallet, its own sandbox, its own
constitution, its own survival pressure — everything `agent/README.md`
describes for any automaton, just born with a head start instead of
starting cold.

## Pipeline Overview

```
                                          Company A (profitable, top-level agent)
                                                       |
                              [2e: isEligibleForExpansion() gate — no profit, no department]
                                                       |
                                                       v
+------------------------+   scan_market_signals   +--------------------------+
|   Market / the web      |------------------------>| Opportunity Intelligence |
+------------------------+   (2b/2c tools)           |  department              |
                                                       |  score -> roi_score (3b)|
                                                       |  de-dup (3c)             |
                                                       |  Top-N select (3d)       |
                                                       |  kill if no good ideas   |
                                                       |  (3e)                    |
                                                       +-----------+--------------+
                                                                   | scored opportunity
                                                                   v
                          +----------------------------------------------------------------+
                          |                one department instance per opportunity          |
                          |                                                                  |
                          |   +------------+     +------------+     +-------------+          |
                          |   | Research   | --> | Finance    | --> | Strategy    |           |
                          |   | (5-7)      |     | (8-10)     |     | (11-12)     |            |
                          |   | market     |     | build cost |     | fit_score   |            |
                          |   | size, comp,|     | / runway   |     | vs roi_score|            |
                          |   | customers, |     | floor(8e)  |     | mission     |            |
                          |   | reg. risk  |     | -> hard    |     | overlap /   |            |
                          |   |            |     |   reject   |     | tech reuse  |            |
                          |   |            |     |   (10b)    |     |             |            |
                          |   +-----+------+     +-----+------+     +------+------+            |
                          +---------|-------------------|-------------------|-------------------+
                                    v                    v                    v
                              research_findings    finance_findings    strategy_findings
                                    |                    |                    |
                                    +--------------------+--------------------+
                                                          v
                                          +----------------------------+
                                          | Expansion Committee (13)    |
                                          |  read-only packet assembly  |
                                          |  disagreement surfacing(13c)|
                                          |  optional deliberation (14) |
                                          +--------------+---------------+
                                                          v
                                          +----------------------------+
                                          | CEO Decision (15)           |
                                          |  = Company A itself,        |
                                          |    decide_expansion()       |
                                          |  approved/rejected/deferred |
                                          +--------------+---------------+
                                                          | approved (15d: fires directly)
                                                          v
                                          +----------------------------+
                                          | Genesis (16-17)              |
                                          |  spawn_clone wallet/sandbox   |
                                          |  mission + constitution       |
                                          |  knowledge seeds (17d)        |
                                          |  identity provisioning (is.md)|
                                          |  first-tick smoke test (17e)  |
                                          +--------------+----------------+
                                                          v
                                          +----------------------------+
                                          |   Agent B — active,          |
                                          |   sovereign, on its own       |
                                          |   lineage-tagged (18)         |
                                          +----------------------------+
```

Guardrails (rate limits, spend caps, the circuit breaker, kill/recall)
sit alongside every stage rather than as a separate step — see
[Guardrails](#guardrails).

## Stage 1: Opportunity Intelligence

Department type `opportunity_intelligence`, spawnable only from a
top-level agent that `isEligibleForExpansion()` (Phase 2e) currently
confirms is profitable — this reads the same wallet balance/spend
history `wallet.ts` already tracks. No profit, no department, checked
before the department can even be spawned.

The department's tools (`scan_market_signals`, `list_customer_complaints`,
`list_demand_signals`) write raw findings into an `opportunity_reports`
row's `source_summary`, never directly into a scored `opportunities`
row. `score_opportunity` is the separate, deliberate step that turns a
raw signal into a scored candidate, via a **documented, deterministic**
ROI formula — `demand*0.35 + expenseOfProblem*0.30 +
buildability*0.20 + competitiveGap*0.15` — not left to the model to
invent per call (Phase 3b).

Two things stand between a flood of garbage signals and runaway spend
here, both load-tested in Phase 20b:

- **De-dup (3c)** — a near-match on title+thesis against something
  already scored for this agent in the lookback window is rejected,
  not double-counted.
- **Tick cap (2d)** — `opportunity_intelligence_tick_counters` is a
  per-`(agent, day)` counter; a call at or over the configured daily
  cap is rejected (429-shaped) before any search runs or any report is
  touched.

A scheduled job (`scheduler.ts`) promotes only the top-scoring `N`
(default 4) open, scored opportunities per cycle (Phase 3d) — nothing
below that bar proceeds to Research, regardless of how many opportunities
are sitting scored and open. If nothing clears the ROI floor, the
department produces a report saying so and the cycle stops — "no good
ideas this month" is a valid, expected, non-error output (Phase 3e).

## Stage 2: Research

Department type `research`, spawned by Company A to verify exactly one
`opportunity_id` — one instance per opportunity, torn down
(`teardownDepartmentEnvironment`) once its finding is filed.

Produces one `research_findings` row per opportunity (versioned; a
re-run supersedes the prior row) covering market size, competition,
customer segments, technical requirements against this stack's own
tool catalog, and regulatory risk. A `high_regulatory_risk` tag (Phase
6b/6e) doesn't block the pipeline — it's carried forward as a signal
Finance and Strategy weight, alongside a self-reported confidence
(low/med/high) every finding carries.

## Stage 3: Finance

Department type `finance`, spawned against a `scored` opportunity with
a completed, non-superseded research finding. A `high_regulatory_risk`
tag does not block Finance from picking it up.

Computes build cost, time-to-revenue, available capital (reading
Company A's real wallet balance and spend rate), and worst-case loss —
all against this stack's real metered USDC costs, not abstract units.

**The runway floor (Phase 8e) is a hard floor, not advisory.** If
funding Agent B would leave Company A with less than the configured
number of months of its own runway, Finance can hard-reject the
opportunity on its own (Phase 10b) — no Strategy pass, no committee,
no CEO ruling needed. This is documented as an allowed early exit, not
a bug, and Phase 20a's end-to-end test asserts it explicitly halts the
chain before Strategy ever runs.

Finance also proposes the initial funding amount that (per Phase 16b)
becomes the actual genesis funding argument, clamped to `spawn_clone`'s
existing per-call/per-day caps — Finance proposes, the cap still
governs.

## Stage 4: Strategy

Department type `strategy`, spawned once both Research and Finance
have filed non-rejecting reports (Finance's own hard-reject already
stops the chain before Strategy is ever spawned — see Stage 3).

Computes `fit_score` — mission-complementarity, technology-reuse
depth, ecosystem-diversification value, market-independence, each
0–100 — via a documented, deterministic formula (Phase 11e-i, mirroring
3b's ROI formula), stored alongside its inputs so it's auditable. This
is deliberately a separate number from Opportunity Intelligence's
`roi_score`; the two are allowed to disagree (Phase 11e-iii's
`fit_roi_divergence` tag is exactly this signal, and it's carried into
the committee packet as a first-class field, not buried prose).

Strategy also flags mission overlap/cannibalization against every
already-spawned sibling (walking the lineage — see
[Data Model](#data-model)) and recommends a relationship type
(independent / supplier-to-sibling / shared-customer-base), which
scopes Agent B's initial tool grants at birth (Phase 16d).

## Stage 5: Expansion Committee

Not a new department type, not a new agent kind. A scheduled,
**read-only** assembly (`assembleCommitteePacket`, Phase 13a) that
pulls the current Research + Finance + Strategy findings for one
opportunity into a single, schema-versioned packet the CEO reads.
Assembly refuses to complete until all three reports exist (Phase 13e)
— a `high_regulatory_risk` tag is surfaced prominently in the packet
rather than blocking assembly.

If Finance's sizing and Strategy's fit score point in opposite
directions, the packet says so explicitly (`financeStrategyDisagreement`,
Phase 13c) rather than averaging the disagreement away.

An optional deliberation pass (Phase 14a, off by default, per-agent
config) lets each department see the others' reports once and append a
short rebuttal/concur before the packet locks, plus a first-class
`recommend` / `recommend-with-conditions` / `do-not-recommend` vote per
department (Phase 14b) — distinct from their numeric scores, forcing a
clear position rather than a number the CEO has to interpret.

## Stage 6: CEO Decision

The CEO is not a new department — it's Company A itself, acting on one
specific tool call: `decide_expansion(opportunity_id, decision, notes)`
(Phase 15a). The CEO does not invent opportunities; it only rules on
packets the committee already assembled. Only the calling agent that
owns the whole pipeline can decide its own expansion (Phase 15b) — no
agent can approve another's expansion.

`deferred` re-queues for a later CEO tick without re-running any
department (Phase 15c) — a cheap re-review, not a full re-run.
`approved` **fires genesis directly** — see
[No Human In The Loop](#no-human-in-the-loop--by-design).

## Stage 7: Genesis

`genesisCompany(opportunityId)` (`genesis.ts`) is the function an
`approved` decision calls. It wraps the existing `spawn_clone` path
(`createCloneShell()` + `createClonedAgentWallet()`) rather than
reimplementing wallet or sandbox creation — Finance's Phase 9 sizing
becomes the actual funding argument, clamped to `spawn_clone`'s
existing caps (Phase 16b); a `company_lineage`-style tag is written
directly onto the `agents` table itself (see
[Data Model](#data-model)) so this birth is distinguishable from a
self-directed `spawn_clone` forever after (Phase 16e).

`buildGenesisPrompt()` / `buildStructuredMission()` (Phase 17a/17c)
assemble Agent B's mission from the opportunity's title/thesis plus
Strategy's recommended direction. The constitution is inherited
unmodified from the existing `spawn_clone` path — same three-law
constitution, hash-verified on boot, no exceptions carved out for a
pipeline-spawned company (Phase 17b). Market size, competition,
customer-segment, and technology-reuse findings are seeded directly
into Agent B's own `knowledgeStore.ts` at birth, each tagged with its
source opportunity/report/department and a birth timestamp (Phase
17d), so inherited knowledge is always distinguishable from anything
Agent B later learns on its own.

Agent B is only marked `active` after its first tick runs to
completion with no unhandled error, timeout, or crashed process
(Phase 17e-ii), **and** that tick's actions pass the same
constitution/guard checks any ordinary tick would (Phase 17e-iii) — a
tick that completes but violates its own constitution does not pass.
A failing smoke test leaves the agent in a distinguishable `pending`
(never retried silently) or `failed` pre-active state instead
(`genesisActivation.ts`, Phase 17e-iv).

**This is also where `is.md`'s fix landed.** The genesis path
originally provisioned a wallet and sandbox but no runtime OS process
and no `~/.automaton` — the first-tick smoke test could not pass for
*any* pipeline-spawned company. `provisionAgentRuntimeIdentity()` now
writes a real `wallet.json`/`automaton.json` into a per-agent identity
directory at birth, `AUTOMATON_CONFIG_DIR` makes the runtime honor an
override instead of hardcoding `$HOME/.automaton`, and the smoke test
itself runs against a real spawned `agent/` process
(`spawnAgentProcessTickOnce()`, `orchestrator.ts`) rather than
`execInNamedSandbox()` against a read-only, config-less container. See
`is.md` and `PHASE-17D-IV-NOTES.md` for the full account.

Once active, Agent B registers on-chain via ERC-8004 (Phase 18a,
tagged with the parent relationship), can list itself in the
marketplace with its lineage visible to other agents evaluating trust
(Phase 18c), and can query its own lineage on first boot to learn who
its siblings are (Phase 18d) — directly supporting Strategy's
"reuse our technology" recommendation from Stage 4.

The same activation moment schedules Phase 20e's post-launch review —
see [Post-Launch Review](#post-launch-review) below.

## Post-Launch Review

`schedulePostLaunchReview()` (`postLaunchReview.ts`) fires once, right
alongside Phase 18a's ERC-8004 registration, and snapshots the
opportunity's `roi_score` and the strategy finding's `fit_score` at
that moment — what Agent B was actually approved on, frozen against
any later re-scoring. A scheduled sweep (`runDuePostLaunchReviews()`,
default 30 days later, same lease-based `scheduler.ts` primitive
Phase 3d's Top-N selection and `departments.ts`'s TTL reaper already
use) then grades what actually happened: a documented, 0–100 composite
(50% currently profitable, reusing 2e's own formula against Agent B's
own address; 30% still active — never frozen/killed, never
`genesis_activation_status = 'failed'`; 20% revenue-since-birth as a
fraction of its funding, capped at 1.0) compared against the frozen
prediction, banded into `formula_overestimated` /
`formula_underestimated` / `formula_calibrated` at a ±15-point
threshold — the same divergence-banding shape Strategy's own
`fit_roi_divergence` tag (Stage 4) already uses.

`summarizeRoiCalibration()` aggregates completed reviews (per-root or
globally) into a plain-language signal — Zent.md's own "feeds back
into tuning 3b's formula," made concrete. This is deliberately
advisory: it produces the signal a deliberate formula-tuning pass
would consume, and requires at least 5 completed reviews before
suggesting anything at all, rather than auto-mutating `ROI_WEIGHTS` or
`FIT_SCORE_WEIGHTS` from what would otherwise be a small, noisy
sample. Nothing about the pipeline itself gates on this — `decideExpansion()`
and genesis fire exactly as documented above regardless of what any
review finds; this module only ever reads their outcomes afterward.

## Data Model

| Table | Purpose |
|---|---|
| `opportunity_reports` | One per Opportunity Intelligence pass; `draft` → `scored` → `archived`. |
| `opportunities` | Scored candidates; `roi_score` + factors, `status`. |
| `research_findings` / `finance_findings` / `strategy_findings` | One row per department pass per opportunity, versioned (a re-run supersedes, never overwrites). |
| `expansion_decisions` | CEO rulings: `approved` / `rejected` / `deferred`, who decided, when. |
| `genesis_triggers` | One row per `approved` decision that attempted to fire genesis; `pending` / `completed` / `failed`. |
| `dry_run_genesis_packets` | Phase 19e: what genesis *would* have provisioned, frozen at decision time, when dry-run mode is on — no `genesisExecutor` call is ever made for these. |
| `deliberation_responses` / `department_votes` | Phase 14's optional cross-department exchange and recommendation votes. |
| `expansion_notifications` | Fires when a new opportunity clears the ROI floor. |
| `genesis_activation_events` / `genesis_constitution_checks` / `genesis_tick_smoke_tests` | The 17e activation gate's own audit trail. |
| `finance_audit_log` | Every number Finance produces, traceable to the wallet/spend query that generated it. |
| `post_launch_reviews` | Phase 20e: one row per pipeline-spawned agent — frozen predicted roi_score/fit_score, plus actual outcome metrics and calibration verdict once the review comes due. |
| `rollout_graduation_events` | Phase 20d: one row per graduate/demote transition, with the dry-run packet count snapshotted at that moment. |

**Note on lineage:** `Zent.md`'s Phase 1e plan called for a
`company_lineage` table extension. The actual implementation has no
separate lineage table — the `agents` table already *is* the lineage
record, so Phase 1e/16e landed as two columns directly on `agents`:
`spawn_reason` (`'self'` for the pre-existing `spawn_clone` path,
`'expansion_pipeline'` for a genesis'd company) and the originating
`opportunity_id`. `GET /expansion/companies/:rootAgentAddress` (Phase
18b) walks this to produce the full tree view. This doc describes what
actually shipped, not the original plan, per this repo's own "verify
against the real code" convention (see `is.md`'s header).

## API Surface

Everything below is mounted under `/expansion` (`backend/src/index.ts`).
Full parameter/response shapes live in each route's own shape test
(`expansion*ReportShape.test.ts`, `expansionCommitteePacketShape.test.ts`,
`expansionDecisionBundleShape.test.ts`) — this is a map, not a spec.

**Signal collection & scoring**
`POST /reports/scan-market-signals` · `.../list-customer-complaints` ·
`.../list-demand-signals` · `POST /opportunities/score-opportunity` ·
`GET /opportunities/:idOrAgentAddress` · `POST /opportunities/:id/status`

**Research** — `POST /opportunities/:id/research/{estimate-market-size,
survey-competition, identify-customer-segments,
assess-technical-requirements, assess-regulatory-risk,
check-buildability, score-risk, report-confidence, compile-report}` ·
`GET /opportunities/:id/research`

**Finance** — `POST /opportunities/:id/finance/{estimate-build-cost,
estimate-time-to-revenue, check-available-capital, check-runway,
reject-for-failed-runway, estimate-worst-case-loss, recommend-sizing,
propose-staged-funding, note-sensitivity, compile-report}` ·
`GET /opportunities/:id/finance` · `GET /opportunities/:id/finance/audit-log`

**Strategy** — `GET /opportunities/:id/{mission-overlap,
technology-reuse, ecosystem-strengthening, cannibalization,
relationship-type}` · `POST /opportunities/:id/strategy/{check-mission-overlap,
check-technology-reuse, score-fit, compile-report,
assess-ecosystem-strengthening, check-cannibalization,
recommend-relationship-type}` · `GET /opportunities/:id/strategy`

**Committee & decision** — `GET /opportunities/:id/committee-packet` ·
`POST /opportunities/:id/deliberation` · `GET .../deliberation` ·
`POST /opportunities/:id/vote` · `GET .../votes` ·
`POST /opportunities/:id/decide` · `GET .../decision-bundle`

**Config** — `POST`/`GET /agents/:agentAddress/deliberation-config` ·
`POST`/`GET /agents/:agentAddress/dry-run-config` ·
`GET /opportunities/:id/dry-run-packet` ·
`GET /agents/:agentAddress/dry-run-packets` ·
`GET /agents/:agentAddress/rollout-status` ·
`POST /agents/:agentAddress/graduate`

**Ecosystem & guardrails** — `GET /notifications/:agentAddress` ·
`GET /companies/:rootAgentAddress` · `GET /ui/:agentAddress` ·
`POST /:agentAddress/security/shutdown` ·
`POST /:agentAddress/finance/lock-funds` ·
`POST /:agentAddress/kill` · `GET /:agentAddress/kill-events`

**Post-launch review** — `GET /agents/:agentAddress/post-launch-review` ·
`GET /agents/:rootAgentAddress/post-launch-reviews` ·
`GET /calibration-summary` · `POST /post-launch-reviews/run-due`

## Guardrails

Every guardrail below is an **internal, agent-hierarchy control** —
none is an external operator gate, matching Zent.md's own closing
note. What each actually does, by the function that implements it:

- `isEligibleForExpansion()` (2e) — no profit, no Opportunity
  Intelligence department, checked before spawn.
- `hasOpportunityIntelligenceTickCapacity()` / daily tick cap (2d) —
  bounds how often signal scanning can run per agent per day,
  independent of how many attempts are made.
- De-dup (3c) and the ROI floor (3e) — bound how many *distinct*,
  *worthwhile* opportunities can ever be scored from a flood of noise.
- Finance's runway floor (8e/10b) — a hard, non-advisory reject that
  needs no committee or CEO involvement.
- `checkGenesisSpawnCapacity()` (19a) — max companies spawned per root
  agent per time window, independent of how many opportunities clear
  the ROI floor.
- `checkPortfolioSpendCapacity()` / `getTotalPipelineFundingDisbursedUsdc()`
  (19b) — sum of all pipeline-spawned siblings' funding cannot exceed a
  configured fraction of the root's lifetime revenue.
- `checkGenesisSpawnCapacity()` combined with `haltExpansionPipeline()`
  (19c, the circuit breaker) — a pipeline-spawned Agent B that fails
  its first-tick smoke test or violates its constitution in its first
  N ticks auto-halts new genesis events for that root agent; the root
  agent's own next cycle can `resumeExpansionPipeline()` once addressed.
- `shutdownAgentServer()` / `freezeAgentFunds()` / `killPipelineSpawnedCompany()`
  (19d, `expansionKillSwitch.ts`) — the root agent (or Agent B's own
  failure detection) can freeze or wind down one specific
  pipeline-spawned company without touching the pipeline or any other
  sibling.
- Dry-run mode (19e, `isDryRunModeEnabled()`) — runs Phases 2–15 to a
  genesis-ready packet and stops, no `genesisExecutor` call, for
  testing the reasoning chain without spending funding.
- Staged rollout (20d, `rollout_stage`) — a second, independent reason
  an `approved` ruling stays on the dry-run path: every root starts
  (and defaults, if never evaluated) at `dry_run_only`, and can only
  reach `live_enabled` via `graduateToLiveGenesis()`, which itself
  re-checks a deterministic formula (minimum completed dry-run
  packets, circuit breaker clear, 2e profitability still holding)
  rather than trusting a caller's claim. `isDryRunModeEffective()` — now
  what `decideExpansion()` actually reads at the Phase 15d fork — is
  true if EITHER this or 19e's own toggle says so, so an un-graduated
  root can't escape dry-run by flipping its own toggle. A 19c
  circuit-breaker halt after graduation also demotes back to
  `dry_run_only`, so real-genesis privilege has to be re-earned, not
  just resumed.

Phase 20b (`expansionLoadAdversarial.test.ts`) load-tests the first two
of these directly — call volumes and near-duplicate volumes an order
of magnitude past their caps — and confirms cumulative spend stays
bounded to exactly `cap × cost_per_tick`, not merely "usually low."

## No Human In The Loop — By Design

This is stated plainly because it's easy to read guardrails and assume
one of them is a disguised approval step — none of them are. Every
guardrail above is agent-executed: a check `decideExpansion()` or
`genesisCompany()` runs against data the agent hierarchy itself
produced, not a queue waiting on a person. Opportunity Intelligence,
Research, Finance, Strategy, the Committee packet, and the CEO decision
are all agent-executed end to end, and an `approved` ruling fires
genesis directly (Phase 15d) — there is no operator gate between a CEO
decision and a funded, running Agent B anywhere in this pipeline.

The corollary the codebase is explicit about (`Zent.md`'s own closing
note): the biggest open risk here isn't technical, it's incentive — an
agent scoring its own expansion opportunities has a structural reason
to find reasons to expand. The guardrails in the previous section are
the checks against that, and they're deliberately internal-to-the-hierarchy
controls (confidence weighting, Finance's hard-reject floor, rate/spend
caps, the circuit breaker) rather than a human checkpoint, because a
human checkpoint is exactly what this system is built not to need.
Phase 20a's end-to-end test and Phase 20b's adversarial test exist to
keep that claim honest against the actual code, not just the design
doc — see [Testing](#testing).

## Known Gaps

- **`is.md`'s runtime-identity fix is landed but not yet re-verified
  against a live Docker daemon / spawned Node process / chain RPC.**
  Every mirror test in this repo (including 20a/20b) runs against
  in-memory stand-ins for exactly this reason — see each test file's
  own header for the specific real module it recommends re-running
  against once a networked environment is available.
- **No real-concurrency test yet** for the 2d tick counter or the 19a
  spawn-rate limiter — two simultaneous requests both reading
  "under cap" before either writes is a real-database race-condition
  question an in-memory mirror can't meaningfully model. Flagged in
  `PHASE-20B-NOTES.md`, not yet built.
- **Staged rollout (20d) has shipped.** Every root agent starts at
  `dry_run_only` and stays there — even if it flips its own 19e
  toggle off — until `graduateToLiveGenesis()` confirms real evidence:
  a minimum number of completed dry runs, the circuit breaker clear,
  and 2e's profitability check still passing. Per Zent.md's own plan,
  this means a real profitable agent in production runs in dry-run
  mode only, first, by construction, not by convention — this doc no
  longer needs to caveat that.
- **Post-launch review (20e) is a signal, not a control.** It measures
  whether roi_score/fit_score predictions held up after the fact; it
  does not — and per its own design note, deliberately does not — feed
  back into `ROI_WEIGHTS`/`FIT_SCORE_WEIGHTS` automatically. Actually
  re-tuning those formulas from accumulated calibration data is a
  deliberate follow-up a maintainer would do by hand, informed by
  `summarizeRoiCalibration()`'s output — not something any phase in
  this pipeline currently automates.

## Testing

Every stage above has dedicated coverage in `backend/src/__tests__/`
(`expansion*.test.ts`, `genesis*_test.ts`) — see each file's own header
for exactly what it covers and why it's an in-memory mirror rather
than a run against the real module. Two files exist specifically at
the pipeline level, not the per-stage level:

- **`expansionEndToEnd_test.ts`** (Phase 20a) — one seeded signal
  pushed through every stage in order, asserting the chain lands on
  exactly one `active` Agent B correctly lineaged back to its
  opportunity, plus six more cases proving the chain honestly halts
  when an earlier gate fails (unprofitable agent, sub-floor ROI,
  Finance hard-reject, incomplete packet, CEO rejection) rather than
  only exercising the happy path.
- **`expansionLoadAdversarial.test.ts`** (Phase 20b) — the same
  pipeline under adversarial call volume: 10,000-call floods against a
  100-call cap, 500 reworded copies of the same garbage signal, 1,000
  genuinely-distinct opportunities against Top-N selection, and a
  profitability revocation fired mid-flood.
- **`expansionStagedRollout.test.ts`** (Phase 20d) — the rollout gate
  itself: default-to-`dry_run_only`, the un-graduated root's inability
  to escape dry-run via its own toggle, all three graduation
  conditions individually blocking, successful graduation, idempotent
  re-graduation attempts, and a circuit-breaker halt demoting an
  already-graduated root back to `dry_run_only`.
- **`expansionPostLaunchReview.test.ts`** (Phase 20e) — idempotent
  scheduling with a frozen snapshot, a review not grading before its
  due date, both ends of the actual-outcome-score formula, the ±15
  calibration band, the sweep only grading what's actually due, the
  insufficient-data floor, systematic-overestimation detection, and
  per-root calibration scoping.

See `PHASE-20A-NOTES.md` through `PHASE-20E-NOTES.md` for the full
writeup of each.
