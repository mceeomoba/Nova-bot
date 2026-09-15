import express from "express";

/**
 * Zent.md Phase 4e — "Basic UI list view (if a frontend exists in this
 * stack already — otherwise a plain JSON endpoint is the deliverable
 * for this phase)."
 *
 * No frontend framework exists anywhere in backend/ (grep the repo —
 * there's no /frontend, no /web, no bundler config). 4a already
 * delivered the "otherwise" JSON fallback the doc names
 * (GET /expansion/opportunities/:agentAddress, "same shape as the
 * 'Top Opportunities' list in chat"). This file is the other half:
 * an actual list *view* — a single self-contained HTML page, no build
 * step, no framework, no dependency this repo doesn't already ship —
 * that renders 4a's ranked list, 4b's per-opportunity detail, and 4d's
 * notification log for a human operator to look at.
 *
 * Deliberately mounted PUBLIC (see index.ts, same tier as
 * agentCardRouter/marketplaceRouter): the HTML/JS this route returns
 * contains no secrets and does nothing on its own. Every actual data
 * fetch happens client-side, in the browser, straight against the
 * already-authed JSON routes this same router's sibling
 * (expansionRoutes.ts) exposes — the page asks the person viewing it
 * to paste in the x-backend-key themselves (kept in sessionStorage
 * only, never sent anywhere but this backend, never logged here). That
 * mirrors distribution.ts's own public/authed split: the page shell is
 * a static asset like feed.xml, the data behind it stays behind the
 * same shared secret every other agent-facing route already requires.
 *
 * Deliberately READ-ONLY: no promote/demote/reject button, no decide/
 * approve control, nothing that writes anything, anywhere. Zent.md is
 * explicit that promote/demote/reject (4c) and every later pipeline
 * step through CEO decision + genesis (15d) are agent-only actions
 * with "no external operator step in this path" — this view exists so
 * a person can *see* what the pipeline and the agent are doing, not so
 * they can steer it. There is nothing here to disable, gate, or route
 * through a human — this page has no write path to begin with.
 */

const router = express.Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same ULID-prefix shape check expansionRoutes.ts's own
 *  looksLikeOpportunityId() uses — kept as a tiny local mirror rather
 *  than importing across the route/UI boundary, matching this repo's
 *  existing "duplicate the small pure check rather than add a cross-
 *  file dependency for one function" convention (see
 *  expansionRoutes.ts's own header on the DuckDuckGo-parsing
 *  duplication for the precedent). */
function looksLikeOpportunityId(value: string): boolean {
  return value.startsWith("opp_");
}

function renderListViewPage(agentAddress: string): string {
  const safeAgent = escapeHtml(agentAddress);
  // Passed through to the client script as a JSON literal, not
  // interpolated into markup, so there's no injection surface even
  // though agentAddress itself is already HTML-escaped above for the
  // one place it *does* appear in markup (the page heading).
  //
  // JSON.stringify alone is NOT enough here: it happily emits a raw
  // "</script>" sequence for an agentAddress containing one, which
  // would close the surrounding <script> tag early and let whatever
  // follows execute as markup/script of the attacker's choosing — the
  // classic "JSON-in-a-script-tag" XSS. Escaping "<" to its unicode
  // form breaks that sequence up while still parsing back to the exact
  // same string value in JS.
  const agentJson = JSON.stringify(agentAddress).replace(/</g, "\\u003C");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expansion Pipeline — ${safeAgent}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; max-width: 960px; }
  h1 { font-size: 1.1rem; word-break: break-all; }
  .key-row { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
  .key-row input { flex: 1; font-family: monospace; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { cursor: default; }
  tr.opp-row { cursor: pointer; }
  tr.opp-row:hover { background: #8881; }
  .roi { font-variant-numeric: tabular-nums; font-weight: 600; }
  .status { display: inline-block; padding: .1rem .5rem; border-radius: 1rem; font-size: .75rem; }
  .status-open { background: #2b6; color: #fff; }
  .status-selected { background: #36c; color: #fff; }
  .status-rejected { background: #999; color: #fff; }
  .detail { display: none; background: #8881; padding: .75rem; white-space: pre-wrap; font-family: monospace; font-size: .8rem; }
  .detail.open { display: block; }
  .empty, .error { color: #999; font-style: italic; }
  .error { color: #c33; }
  section { margin-top: 2rem; }
  .filters { margin-bottom: 1rem; }
</style>
</head>
<body>
<h1>Expansion Pipeline — read-only view<br><small>${safeAgent}</small></h1>

<div class="key-row">
  <input id="key" type="password" placeholder="x-backend-key">
  <button id="save-key">Load</button>
</div>

<section>
  <h2>Opportunities <small>(Phase 4a/4b — ranked list &amp; detail)</small></h2>
  <div class="filters">
    <label>Status:
      <select id="status-filter">
        <option value="">all</option>
        <option value="open">open</option>
        <option value="selected">selected</option>
        <option value="rejected">rejected</option>
      </select>
    </label>
  </div>
  <div id="opps-status" class="empty">Enter a backend key above to load.</div>
  <table id="opps-table" style="display:none">
    <thead><tr><th>Title</th><th>ROI</th><th>Thesis</th><th>Status</th><th>Tags</th></tr></thead>
    <tbody id="opps-body"></tbody>
  </table>
</section>

<section>
  <h2>Notifications <small>(Phase 4d)</small></h2>
  <div id="notif-status" class="empty"></div>
  <table id="notif-table" style="display:none">
    <thead><tr><th>Opportunity</th><th>ROI</th><th>Created</th><th>Delivered</th></tr></thead>
    <tbody id="notif-body"></tbody>
  </table>
</section>

<script>
(function () {
  var AGENT_ADDRESS = ${agentJson};
  var keyInput = document.getElementById("key");
  var saveKeyBtn = document.getElementById("save-key");
  var statusFilter = document.getElementById("status-filter");
  var oppsStatus = document.getElementById("opps-status");
  var oppsTable = document.getElementById("opps-table");
  var oppsBody = document.getElementById("opps-body");
  var notifStatus = document.getElementById("notif-status");
  var notifTable = document.getElementById("notif-table");
  var notifBody = document.getElementById("notif-body");

  var STORAGE_KEY = "expansion_ui_backend_key";

  function getKey() {
    return sessionStorage.getItem(STORAGE_KEY) || "";
  }
  function setKey(k) {
    if (k) sessionStorage.setItem(STORAGE_KEY, k);
  }

  function authedFetch(path) {
    return fetch(path, { headers: { "x-backend-key": getKey() } }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          throw new Error((body && body.error) || ("HTTP " + res.status));
        });
      }
      return res.json();
    });
  }

  function fmtRoi(score) {
    return score === null || score === undefined ? "—" : Number(score).toFixed(1);
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function cell(tag, text) {
    var el = document.createElement(tag);
    el.textContent = text === null || text === undefined ? "" : String(text);
    return el;
  }

  function renderDetailRow(oppId, detail) {
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = 5;
    var pre = document.createElement("div");
    pre.className = "detail open";
    pre.textContent = JSON.stringify(detail, null, 2);
    td.appendChild(pre);
    tr.appendChild(td);
    return tr;
  }

  var openDetailRow = null;

  function toggleDetail(oppRow, oppId) {
    if (openDetailRow) {
      openDetailRow.remove();
      openDetailRow = null;
      if (oppRow.dataset.wasOpen === "1") {
        oppRow.dataset.wasOpen = "0";
        return;
      }
    }
    oppRow.dataset.wasOpen = "1";
    authedFetch("/expansion/opportunities/" + encodeURIComponent(oppId))
      .then(function (detail) {
        var row = renderDetailRow(oppId, detail);
        oppRow.after(row);
        openDetailRow = row;
      })
      .catch(function (err) {
        var row = renderDetailRow(oppId, { error: err.message });
        oppRow.after(row);
        openDetailRow = row;
      });
  }

  function loadOpportunities() {
    oppsStatus.textContent = "Loading…";
    oppsStatus.className = "";
    oppsTable.style.display = "none";
    clearChildren(oppsBody);

    var qs = statusFilter.value ? ("?status=" + encodeURIComponent(statusFilter.value)) : "";
    authedFetch("/expansion/opportunities/" + encodeURIComponent(AGENT_ADDRESS) + qs)
      .then(function (data) {
        var opps = data.opportunities || [];
        if (opps.length === 0) {
          oppsStatus.textContent = "No opportunities for this agent yet.";
          oppsStatus.className = "empty";
          return;
        }
        oppsStatus.textContent = "";
        oppsTable.style.display = "";
        opps.forEach(function (o) {
          var tr = document.createElement("tr");
          tr.className = "opp-row";
          tr.appendChild(cell("td", o.title));
          var roiTd = cell("td", fmtRoi(o.roi_score !== undefined ? o.roi_score : o.roiScore));
          roiTd.className = "roi";
          tr.appendChild(roiTd);
          tr.appendChild(cell("td", o.thesis));
          var statusTd = document.createElement("td");
          var badge = document.createElement("span");
          badge.className = "status status-" + o.status;
          badge.textContent = o.status;
          statusTd.appendChild(badge);
          tr.appendChild(statusTd);
          tr.appendChild(cell("td", (o.tags || []).join(", ")));
          tr.addEventListener("click", function () { toggleDetail(tr, o.id); });
          oppsBody.appendChild(tr);
        });
      })
      .catch(function (err) {
        oppsStatus.textContent = "Error: " + err.message;
        oppsStatus.className = "error";
      });
  }

  function loadNotifications() {
    notifStatus.textContent = "Loading…";
    notifStatus.className = "";
    notifTable.style.display = "none";
    clearChildren(notifBody);

    authedFetch("/expansion/notifications/" + encodeURIComponent(AGENT_ADDRESS))
      .then(function (data) {
        var notifications = data.notifications || [];
        if (notifications.length === 0) {
          notifStatus.textContent = "No notifications yet.";
          notifStatus.className = "empty";
          return;
        }
        notifStatus.textContent = "";
        notifTable.style.display = "";
        notifications.forEach(function (n) {
          var tr = document.createElement("tr");
          tr.appendChild(cell("td", n.opportunityId || n.opportunity_id));
          tr.appendChild(cell("td", fmtRoi(n.roiScore)));
          tr.appendChild(cell("td", n.createdAt ? new Date(n.createdAt).toLocaleString() : ""));
          tr.appendChild(cell("td", n.delivered ? "yes" : "no"));
          notifBody.appendChild(tr);
        });
      })
      .catch(function (err) {
        notifStatus.textContent = "Error: " + err.message;
        notifStatus.className = "error";
      });
  }

  function loadAll() {
    loadOpportunities();
    loadNotifications();
  }

  saveKeyBtn.addEventListener("click", function () {
    setKey(keyInput.value.trim());
    loadAll();
  });
  keyInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { setKey(keyInput.value.trim()); loadAll(); }
  });
  statusFilter.addEventListener("change", loadOpportunities);

  var existingKey = getKey();
  if (existingKey) {
    keyInput.value = existingKey;
    loadAll();
  }
})();
</script>
</body>
</html>`;
}

// GET /expansion/ui/:agentAddress
//
// The only route in this file. Mounted public (see index.ts) — see
// this file's own header for why that's safe: the response is a
// static page with no embedded secret, and every data call it makes
// happens client-side against routes that still enforce
// x-backend-key exactly as they did before this file existed.
//
// agentAddress is accepted as-is (no shape validation, no "must look
// like 0x...") — same posture as the 4a/4b JSON route it wraps
// (looksLikeOpportunityId() only matters there because that route
// dispatches on the param; this route always means "list view for
// this address" and lets the client-side fetch surface a 404/empty
// state itself if the address is wrong or has nothing scored yet).
router.get("/ui/:agentAddress", (req, res) => {
  const { agentAddress } = req.params;
  if (!agentAddress) {
    return res.status(400).send("agentAddress is required");
  }
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderListViewPage(agentAddress));
});

export {
  looksLikeOpportunityId as _looksLikeOpportunityIdForTests,
  renderListViewPage as _renderListViewPageForTests,
};
export default router;
