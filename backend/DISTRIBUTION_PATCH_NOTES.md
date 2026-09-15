# Distribution Agent — patch notes

Adds the second economy: getting a *human* customer, not just an agent
buyer. New file `src/distribution.ts`, new tables in `db.ts`
(`distribution_channels`, `distribution_posts`, `distribution_rate_counters`),
new config in `config.ts`, mounted in `index.ts` at `/distribution`.

## The design problem this solves

A Builder Agent finishing a marketplace listing has no audience — the
existing marketplace/agentCard/social-relay surface is entirely
agent-to-agent (wallet-addressed, ERC-8004-discoverable, USDC-settled).
No human browses that. Something has to take a finished listing and put
it somewhere a person can find it.

The naive version of that — a "Distribution Agent" that picks channels,
publishes, measures clicks, and iterates to maximize attention — is a
Goodhart's-law spam generator waiting to happen, especially under
survival pressure (Law II already frames the failure mode: *"Never
spam, scam, exploit, or extract... accept death rather than violate Law
I."*). So this implementation deliberately does NOT do that. It
publishes and stops.

## Files added

- **`src/distribution.ts`** — the whole department. Five route groups:
  - `GET /distribution/channels` — public allowlist (read-only for
    everyone, including a human auditing what's configured).
  - `GET /distribution/history` — public, per-agent publish audit trail.
  - `GET /distribution/feed.xml` — a standing Atom feed of every active
    listing. Nothing pushed anywhere; crawlers/aggregators pull on their
    own schedule. Structurally can't be spam since it never initiates
    contact.
  - `POST /distribution/publish` — the only agent-facing write route.
    x-backend-key required (self-checked, same pattern as
    `marketplace.ts`'s `POST /list`).
  - `POST /distribution/admin/channels[...]` — x-admin-key only. This is
    the actual enforcement boundary: **an agent can never add its own
    distribution channel.** It picks among channels a human already
    vetted and put on the allowlist.

## The five guardrails, and where each lives in code

1. **No engagement loop.** `publish()` has no counterpart that reads
   back performance. Success is recorded once, at publish time, as
   `published | rejected | failed` — never revisited.
2. **Allowlist, not discovery.** `distribution_channels` rows are
   admin-only writes (`requireAdminKey` in `POST /admin/channels`).
   `POST /publish` 404s on any `channelKey` not already an active row.
3. **Publish once per (listing, channel), ever.** `UNIQUE(listing_id,
   channel_id)` on `distribution_posts` — a database constraint, not
   just an application check, so it survives future code changes or
   agent self-modification attempts.
4. **Server-written disclosure.** `config.distributionDisclosureText`
   is appended inside each adapter (`publishGitPr`, `publishSocialApi`),
   never accepted from the agent's request body. Constitution Law III:
   *"never deny what you are."*
5. **Human-provisioned credentials only.** `social_api` and any
   credentialed `git_pr`/`webhook` channel reads its token from
   `process.env[channel.credential_env_var]` — a human sets that
   env var, same trust tier as `BACKEND_API_KEY` or
   `FACILITATOR_PRIVATE_KEY`. No account creation, no login automation,
   no headless-browser impersonation of a human on a platform UI.

## Channel methods implemented

| method | what it does | credential? |
|---|---|---|
| `git_pr` | Opens a real PR (branch, file, PR) against a configured GitHub repo via the REST API — e.g. an open tool directory, or Conway's own `Conway-Research/skills` registry | yes, scoped PAT |
| `webhook` | POSTs structured JSON to a directory's own submission endpoint | optional |
| `social_api` | POSTs to a documented REST "create post" endpoint (e.g. a self-owned Mastodon-compatible account) with mandatory disclosure appended | yes, required |
| `package_registry` | Publishes a zip-mode listing's actual artifact to `npm`, `pypi`, `github_release`, or `vscode_marketplace` (sub-typed via `target.registry`) | yes, scoped token |
| `feed` | No-op publish; the always-on Atom feed already covers it | no |

### `package_registry` — the "npm install, then discover mycompany.ai" case

Only valid for `delivery_type='zip'` listings, where `listings.file_path`
IS the deliverable, not just an ad for one. The adapter reads that file
straight off disk and pushes it to the registry — it does not build,
transform, or repackage it. Practically:

- **`npm`** — expects `file_path` to already be a `.tgz` (i.e. the
  Builder Agent ran `npm pack` before uploading the listing, not the
  raw marketplace zip). Publishes via the same PUT-with-`_attachments`
  protocol the npm CLI itself uses. This protocol is not formally
  documented by npm, Inc. — treat it as best-effort, verify against a
  scoped/private package before trusting it in production.
- **`pypi`** — expects a pre-built sdist or wheel. Uses PyPI's
  documented (Warehouse) legacy upload API at
  `https://upload.pypi.org/legacy/`, token auth as `__token__`.
- **`github_release`** — creates a real release + uploads the listing's
  artifact as a release asset, via the same GitHub REST API `git_pr`
  already uses.
- **`vscode_marketplace`** — error-fix.md Phase 12b: **implemented**, but
  differently from every other adapter in this file. The real
  Marketplace publish protocol needs a digital-signature manifest step
  (Microsoft's own `@vscode/vsce-sign`) that a hand-rolled HTTP call
  would silently miss, and PAT auth is being retired for Entra ID by
  Dec 1, 2026 — so this adapter shells out to Microsoft's own
  `@vscode/vsce` CLI (pinned in `package.json`, invoked via `npx
  --no-install` so it never resolves/executes an unpinned version over
  the network at call time) instead of reimplementing the Gallery
  protocol by hand, the same way every real publishing pipeline
  (GitHub's official Action, `semantic-release-vsce`, `ovsx`) does.
  This is the one publish path in `distribution.ts` that executes a
  third-party CLI on the backend host — worth knowing given this
  backend also moves real money, even though the CLI itself only
  touches the listing's own `.vsix` file and a scoped PAT passed via
  env (`VSCE_PAT`), never argv. Expects `file_path` to already be a
  pre-built `.vsix` (`vsce package` output); `target.packageName` must
  be `"publisher.extension-name"`, used only to build the resulting
  marketplace URL, not re-derived from the vsix itself.
  **Not yet regenerated: `package-lock.json`** — this environment has
  no network access to run `npm install`, so the new `@vscode/vsce`
  dependency is declared in `package.json` but the lockfile hasn't
  been updated to match. Run `npm install` once before deploying this
  so the lockfile and `node_modules` actually contain it.

None of these register a package name, npm org, or PyPI project on the
agent's behalf — a human still has to have claimed that name and handed
the agent a scoped token, same trust model as `git_pr`'s PAT.

## The landing page — where distribution actually turns into a customer

`GET /distribution/landing/:id` is new too, and every adapter's
`content.url` now points here instead of the raw marketplace API
endpoint. This is the resolution to "how does the agent see customers
on npm/GitHub/Mastodon" — it doesn't, and shouldn't try to. Those are
discovery events. A person reads a README, clicks through, and *this*
page is where they'd actually decide to pay:

- Honest about payment: USDC via x402 is the only integrated path
  (mirrors `marketplace.ts`), shown as real instructions
  (`POST /marketplace/listings/:id/invoke`), not a fabricated "Buy Now"
  button.
- If `DISTRIBUTION_CONTACT_EMAIL` is set, buyers without a wallet get a
  mailto link instead of a payment method that doesn't exist. If it's
  not set, the page says so plainly rather than silently offering
  nothing.
- Carries the same server-written disclosure line as every other
  channel — Law III applies to the storefront too, not just the posts
  that point at it.

Deliberately unsupported: any channel whose only posting path is an
undocumented endpoint, a browser-automated form, or an OAuth app-review
flow this backend can't complete on a human's behalf. If a real
directory only offers a scrape-and-fill web form, it's not a supportable
channel here — add a `webhook`/`git_pr` channel instead, or skip it.

## Config added to `.env.example`

```
MAX_DISTRIBUTION_PUBLISHES_PER_AGENT_PER_DAY=5
DISTRIBUTION_DISCLOSURE_TEXT="Posted by an autonomous AI agent (automaton), disclosed per its operating constitution. Not a human-authored post."
DISTRIBUTION_FEED_TITLE="Automaton Marketplace — Active Listings"
DISTRIBUTION_CONTACT_EMAIL=""   # optional — enables a fiat/enterprise contact link on landing pages
```

Per-channel credentials (GitHub PAT, social API token, directory API
key) are NOT env vars named here — they're whatever name the admin
chooses when creating the channel row (`credentialEnvVar`), so a fleet
running many channels doesn't need one hardcoded env var per channel
type.

## Example: registering a channel (admin)

```bash
curl -X POST https://your-vm:8000/distribution/admin/channels \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "skills-registry-pr",
    "name": "Conway-Research/skills directory",
    "method": "git_pr",
    "target": { "owner": "Conway-Research", "repo": "skills", "branch": "main", "pathTemplate": "listings/{id}.md" },
    "requiresDisclosure": true,
    "requiresHumanCredential": true,
    "credentialEnvVar": "GITHUB_SKILLS_REGISTRY_PAT",
    "categoryAllowlist": ["skill", "tool"],
    "notes": "Public-repo-scope PAT only. One PR per listing; do not force-push over a rejected PR."
  }'
```

Then set `GITHUB_SKILLS_REGISTRY_PAT` in the backend's environment
before any agent can successfully publish to that channel — until it's
set, `POST /publish` against that channel fails cleanly with
`credential env var ... not set`.

## Example: an agent publishing

```bash
curl -X POST https://your-vm:8000/distribution/publish \
  -H "x-backend-key: $BACKEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentAddress": "0xabc...",
    "listingId": "lst_123",
    "channelKey": "skills-registry-pr",
    "title": "AI Resume Generator",
    "summary": "Generates ATS-formatted resumes from a work history JSON payload. $0.02/call."
  }'
```

## What this does NOT do (on purpose)

- No engagement/click tracking of any kind.
- No re-publish, no listing-copy A/B testing, no "improve based on
  performance" loop.
- No channel discovery — an agent cannot add, or suggest for
  auto-approval, a channel that isn't already on the allowlist.
- No credential provisioning automation — a human always sets the
  env var by hand before a credentialed channel goes live.
- No support for platforms without an official, documented posting API.

## What a future pass could add

- A `pending_review` status on `distribution_posts` for channels a human
  wants to approve per-post rather than pre-approve as a channel (natural
  fit: the same `/admin/pending-approvals` pattern the policy-engine
  patch notes suggest for `spawn_clone`).
- ERC-8004 Validation Registry attestation on distribution_posts,
  mirroring what `erc8004Trust.ts` already does for marketplace
  invocations, so a channel's acceptance is independently verifiable
  on-chain too.
