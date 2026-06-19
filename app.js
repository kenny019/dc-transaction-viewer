// Main controller. Owns the in-memory transaction list, the filter+pagination state, the
// sync orchestration, and the DOM wiring. Kept in one file because the surface is small
// enough that splitting per-concern would just add import noise — every responsibility
// boundary is enforced by a separate module in ./lib/.

import {
  decodeToken,
  getAccountBalance,
  getFirmBalance,
  getPublicFirm,
  syncAccount,
  validateToken,
  TreasuryError,
  DEFAULT_BASE,
} from "./lib/treasury.js";
import {
  getMeta,
  loadAllTransactions,
  nukeDatabase,
  putTransactions,
  setMeta,
} from "./lib/store.js";
import { classify, direction, groupItems, groupTitle } from "./lib/grouping.js";
import { buildExportCsv, DEFAULT_MAPPING } from "./lib/export.js";
import { downloadCsv } from "./lib/csv.js";
import { dcAmountToCents, formatDollars } from "./lib/money.js";
import { formatDate, formatDateTime, formatTime, formatTimeRange } from "./lib/time.js";

// ─── Persisted UI state (token + account selection + mapping) ───────────────
// Token sits in localStorage by design — see README's Privacy section. The cache itself
// lives in IndexedDB.
const LS = {
  token: "dctv:token",
  account: "dctv:account",
  firm: "dctv:firm",
  mapping: "dctv:mapping",
  pageSize: "dctv:pageSize",
};

// Safe localStorage accessors: in Safari with "Block All Cookies" and some webview
// embeds, plain access throws SecurityError. Reads silently return null; writes are
// surfaced once via toast so the user knows persistence is off but the session works.
function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeReadJson(key) {
  try {
    const raw = safeRead(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
let storageWarned = false;
function safeWrite(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    if (!storageWarned) {
      storageWarned = true;
      console.warn("localStorage write failed:", err);
      toast("Browser storage is disabled — settings won't persist this session.", "error");
    }
  }
}

const state = {
  token: safeRead(LS.token) ?? "",
  accountId: safeRead(LS.account) ?? "",
  firmName: safeRead(LS.firm) ?? "",
  pageSize: clampPageSize(Number(safeRead(LS.pageSize))),
  mapping: { ...DEFAULT_MAPPING, ...safeReadJson(LS.mapping) },
  items: [],          // newest-first; the source of truth for the visible view
  itemsById: new Map(),
  filtered: [],       // items after filters applied
  display: [],        // grouped+single rows (the actual rendered rows)
  expanded: new Set(),
  page: 1,
  filters: {
    search: "",
    fromDay: "",
    toDay: "",
    plugin: "",
    direction: "",
  },
  syncing: false,
  syncAbort: null,
  totalItems: null,
  firmDisplayName: null,
  balance: null,
};

/** Clamp persisted pageSize to a sane positive integer; localStorage can hold "0",
 *  "-1", "NaN" or "Infinity" from manual tampering or a previous bug. */
function clampPageSize(n) {
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(500, Math.floor(n));
}

function persist() {
  safeWrite(LS.token, state.token || null);
  safeWrite(LS.account, state.accountId || null);
  safeWrite(LS.firm, state.firmName || null);
  safeWrite(LS.mapping, JSON.stringify(state.mapping));
  safeWrite(LS.pageSize, String(state.pageSize));
}

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {};

function cacheDom() {
  const ids = [
    "connect-view", "connect-form", "connect-token", "connect-firm", "connect-account",
    "connect-submit", "connect-clear", "token-hint",
    "ledger-view", "ledger-firm-name", "ledger-firm-meta",
    "stat-cached", "stat-total", "stat-balance",
    "sync-btn", "sync-status",
    "export-btn", "export-settings-btn",
    "filter-search", "filter-from", "filter-to", "filter-plugin", "filter-direction",
    "filter-clear", "row-count",
    "ledger-table", "ledger-body",
    "page-first", "page-prev", "page-next", "page-last", "page-info", "page-size",
    "settings-btn", "settings-dialog", "settings-disconnect", "settings-info",
    "mapping-dialog", "map-chestshop-in", "map-chestshop-out",
    "map-other-in", "map-other-out", "map-skip-sweeps", "mapping-reset",
    "toast-host",
  ];
  for (const id of ids) els[id] = $(id);
}

// ─── Toasts ─────────────────────────────────────────────────────────────────
function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  els["toast-host"].appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 200ms";
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

// ─── View routing ───────────────────────────────────────────────────────────
function showConnectView() {
  els["connect-view"].classList.remove("hidden");
  els["ledger-view"].classList.add("hidden");
  if (state.token) els["connect-token"].value = state.token;
  if (state.firmName) els["connect-firm"].value = state.firmName;
  if (state.accountId) els["connect-account"].value = state.accountId;
  updateTokenHint();
}

function showLedgerView() {
  els["connect-view"].classList.add("hidden");
  els["ledger-view"].classList.remove("hidden");
  els["ledger-firm-name"].textContent =
    state.firmDisplayName ?? (state.firmName || `Account ${state.accountId}`);
  els["ledger-firm-meta"].textContent =
    `Account ${state.accountId}${state.firmName ? ` · ${state.firmName}` : ""}`;
  els["page-size"].value = String(state.pageSize);
}

function updateTokenHint() {
  const t = els["connect-token"].value.trim();
  if (!t) {
    els["token-hint"].textContent = "";
    return;
  }
  const check = validateToken(t);
  if (!check.ok) {
    els["token-hint"].textContent = check.message;
    els["token-hint"].style.color = "var(--destructive)";
    return;
  }
  const c = check.claims;
  const exp = c.exp ? ` · expires ${formatDateTime(new Date(c.exp * 1000).toISOString())}` : "";
  els["token-hint"].textContent = `Looks like a BUSINESS token (firm #${c.firm ?? "?"})${exp}`;
  els["token-hint"].style.color = "var(--muted-foreground)";
}

// ─── Connect flow ───────────────────────────────────────────────────────────
async function onConnect(ev) {
  ev.preventDefault();
  const token = els["connect-token"].value.trim();
  const firmName = els["connect-firm"].value.trim();
  let accountIdInput = els["connect-account"].value.trim();

  const check = validateToken(token);
  if (!check.ok) {
    toast(check.message, "error");
    return;
  }
  if (!firmName && !accountIdInput) {
    toast("Enter a firm name or an account id.", "error");
    return;
  }

  els["connect-submit"].disabled = true;
  els["connect-submit"].textContent = "Looking up…";

  try {
    let firm = null;
    if (firmName) {
      firm = await getPublicFirm({ base: DEFAULT_BASE, token, firmName });
      if (firm.archived) {
        toast(`${firm.displayName} is archived in the Treasury.`, "error");
        return;
      }
      if (!accountIdInput) {
        // The Treasury doesn't always return a defaultAccountId — guard against the
        // null/undefined case so we never persist the literal string "null" as the
        // account id and trap the user in a 404 loop on every reload.
        if (firm.defaultAccountId == null) {
          toast(
            `${firm.displayName} has no default account in the Treasury — enter an account id manually.`,
            "error",
          );
          return;
        }
        accountIdInput = String(firm.defaultAccountId);
      }
    }

    // Final guard: even with a manually-entered id, an empty/whitespace string would
    // hit the same trap.
    if (!accountIdInput || !/^\d+$/.test(String(accountIdInput).trim())) {
      toast("Account id must be a positive integer.", "error");
      return;
    }

    state.token = token;
    state.firmName = firmName;
    state.accountId = String(accountIdInput).trim();
    state.firmDisplayName = firm?.displayName ?? null;
    persist();

    showLedgerView();
    await loadCacheAndRender();
    await refreshBalances();
    await runSync();
  } catch (err) {
    console.error(err);
    toast(humanizeError(err), "error");
  } finally {
    els["connect-submit"].disabled = false;
    els["connect-submit"].innerHTML = '<span class="btn__label">Connect</span>';
  }
}

function humanizeError(err) {
  if (err instanceof TreasuryError) {
    if (err.status === 401) return "Treasury rejected the token (401). Generate a new one.";
    if (err.status === 403) return "Token isn't authorized for this resource (403).";
    if (err.status === 404) return "Resource not found (404). Check the firm name / account id.";
    return `Treasury error ${err.status}: ${err.message}`;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "Cancelled.";
  // Browser fetch failures (CORS, DNS, network) surface as a TypeError with no
  // useful message. The Treasury API doesn't send CORS headers today, so a browser
  // fetch from any non-allowlisted origin is rejected at preflight — by far the most
  // common failure mode for this viewer.
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return "Browser blocked the request — the Treasury API doesn't send CORS headers, so a direct browser fetch is refused. See the README.";
  }
  return err?.message ?? "Unexpected error.";
}

/** Newest-first comparator: by settledAt descending, then postingId descending.
 *  Uses raw `<` / `>` instead of localeCompare — Intl.Collator allocates per call and is
 *  ~10× slower on 80k items. ISO-8601 timestamps sort correctly with primitive
 *  comparison; for postingIds we compare by length first so the longer (=bigger) numeric
 *  string wins regardless of width, then lexically for same-width strings. */
function bySettledDesc(a, b) {
  if (a.settledAt !== b.settledAt) return a.settledAt < b.settledAt ? 1 : -1;
  if (a.postingId.length !== b.postingId.length) {
    return a.postingId.length < b.postingId.length ? 1 : -1;
  }
  if (a.postingId === b.postingId) return 0;
  return a.postingId < b.postingId ? 1 : -1;
}

// ─── Cache load ─────────────────────────────────────────────────────────────
async function loadCacheAndRender() {
  if (!state.accountId) return;
  const stored = await loadAllTransactions(state.accountId);
  stored.sort(bySettledDesc);
  state.items = stored;
  state.itemsById = new Map(stored.map((it) => [it.postingId, it]));
  const meta = await getMeta(state.accountId);
  state.totalItems = meta?.totalItems ?? null;
  refreshPluginFilterOptions();
  applyFiltersAndRender();
  updateStats();
}

// ─── Sync ───────────────────────────────────────────────────────────────────
async function runSync() {
  if (state.syncing) {
    toast("Sync already in progress.", "error");
    return;
  }
  if (!state.token || !state.accountId) return;
  state.syncing = true;
  const abort = new AbortController();
  state.syncAbort = abort;
  setSyncStatus("progress", { fetchedPages: 0, totalPages: 0, newCount: 0 });

  try {
    const { items, totalPages, totalItems } = await syncAccount({
      base: DEFAULT_BASE,
      token: state.token,
      accountId: state.accountId,
      existingIds: new Set(state.itemsById.keys()),
      signal: abort.signal,
      // syncAccount already puts totalItems in the payload — don't reach for the
      // outer destructured binding (it's in the TDZ during the page walk).
      onProgress: (p) => setSyncStatus("progress", p),
    });

    if (items.length > 0) {
      await putTransactions(state.accountId, items);
      // Merge new items into the in-memory list while preserving sort order. Cheap
      // approach: append + re-sort. Even 80k items sort in <50 ms.
      for (const it of items) {
        if (!state.itemsById.has(it.postingId)) {
          state.itemsById.set(it.postingId, it);
          state.items.push(it);
        }
      }
      state.items.sort(bySettledDesc);
    }

    state.totalItems = totalItems;
    await setMeta(state.accountId, {
      lastSyncAt: new Date().toISOString(),
      totalItems,
      totalPages,
    });
    refreshPluginFilterOptions();
    applyFiltersAndRender();
    updateStats();
    setSyncStatus("done", { newCount: items.length });
    if (items.length > 0) toast(`Synced ${items.length} new transaction${items.length === 1 ? "" : "s"}.`, "success");
    else toast("Up to date.", "success");
  } catch (err) {
    if (err?.name === "AbortError") {
      setSyncStatus("idle");
    } else {
      console.error(err);
      setSyncStatus("idle");
      toast(humanizeError(err), "error");
    }
  } finally {
    state.syncing = false;
    state.syncAbort = null;
  }
}

function setSyncStatus(kind, payload = {}) {
  const el = els["sync-status"];
  if (kind === "idle") {
    el.textContent = "";
    return;
  }
  if (kind === "done") {
    el.textContent = `Up to date (+${payload.newCount ?? 0})`;
    setTimeout(() => {
      if (el.textContent.startsWith("Up to date")) el.textContent = "";
    }, 4000);
    return;
  }
  // progress
  const { fetchedPages, totalPages, newCount, totalItems } = payload;
  const pct = totalPages > 0 ? Math.min(100, Math.round((fetchedPages / totalPages) * 100)) : 0;
  el.innerHTML = `<span class="progress"><span>Page ${fetchedPages}/${totalPages || "?"} · +${newCount}${totalItems ? ` of ${totalItems.toLocaleString()}` : ""}</span><span class="progress__bar"><span class="progress__fill" style="width:${pct}%"></span></span></span>`;
}

async function refreshBalances() {
  if (!state.token || !state.accountId) return;
  try {
    const balance = await getAccountBalance({
      base: DEFAULT_BASE,
      token: state.token,
      accountId: state.accountId,
    });
    state.balance = balance?.balance ?? null;
  } catch (err) {
    // Balance is informational; if it fails (e.g. permissions) we don't block the view.
    console.warn("Balance fetch failed:", err);
    state.balance = null;
  }
  if (state.firmName) {
    try {
      const firmBalance = await getFirmBalance({
        base: DEFAULT_BASE,
        token: state.token,
        firmName: state.firmName,
      });
      state.firmDisplayName = firmBalance?.displayName ?? state.firmDisplayName;
    } catch (err) {
      console.warn("Firm balance fetch failed:", err);
    }
  }
  els["ledger-firm-name"].textContent =
    state.firmDisplayName ?? (state.firmName || `Account ${state.accountId}`);
  updateStats();
}

function updateStats() {
  els["stat-cached"].textContent = state.items.length.toLocaleString();
  els["stat-total"].textContent =
    state.totalItems != null ? state.totalItems.toLocaleString() : "—";
  els["stat-balance"].textContent =
    state.balance != null ? formatDollars(dcAmountToCents(state.balance)) : "—";
}

// ─── Filters ────────────────────────────────────────────────────────────────
/** Rebuild the plugin filter dropdown from the current item set. Replaces options
 *  rather than appending so a previous account's plugin names don't leak into a new
 *  account's filter, and resets the selection to "All" when the saved value isn't
 *  in the new option set. */
function refreshPluginFilterOptions() {
  const select = els["filter-plugin"];
  const present = new Set();
  for (const item of state.items) present.add(classify(item));
  const sorted = [...present].sort();
  const previous = select.value;
  select.replaceChildren();
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All";
  select.appendChild(allOpt);
  for (const p of sorted) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }
  if (previous && present.has(previous)) {
    select.value = previous;
  } else {
    select.value = "";
    state.filters.plugin = "";
  }
}

function readFilters() {
  state.filters.search = els["filter-search"].value.trim().toLowerCase();
  state.filters.fromDay = els["filter-from"].value;
  state.filters.toDay = els["filter-to"].value;
  state.filters.plugin = els["filter-plugin"].value;
  state.filters.direction = els["filter-direction"].value;
}

function applyFiltersAndRender() {
  readFilters();
  const f = state.filters;
  // Date filters: skip the bound entirely when the parsed timestamp is NaN. Without
  // the guard, every comparison against NaN is false, so a malformed input silently
  // disables the filter while the field still shows the bad value.
  const fromRaw = f.fromDay ? Date.parse(`${f.fromDay}T00:00:00Z`) : NaN;
  const toRaw = f.toDay ? Date.parse(`${f.toDay}T00:00:00Z`) : NaN;
  const fromTs = Number.isFinite(fromRaw) ? fromRaw : null;
  // Inclusive end-of-day: add 24h - 1ms so a "to" of 2026-01-05 keeps that day's items.
  const toTs = Number.isFinite(toRaw) ? toRaw + 86_400_000 - 1 : null;
  state.filtered = state.items.filter((item) => {
    if (f.plugin && classify(item) !== f.plugin) return false;
    if (f.direction && direction(item) !== f.direction) return false;
    const ts = Date.parse(item.settledAt);
    if (fromTs != null && (Number.isNaN(ts) || ts < fromTs)) return false;
    if (toTs != null && (Number.isNaN(ts) || ts > toTs)) return false;
    if (f.search) {
      const haystack = [
        item.memo,
        item.message,
        item.initiatorName,
        item.initiatorUuid,
        item.pluginSystem,
        item.postingId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(f.search)) return false;
    }
    return true;
  });

  state.display = groupItems(state.filtered);
  // Prune expanded-group keys that no longer exist in the display set so a stale key
  // can't pre-expand an unrelated future group with a matching plugin|dir|day signature.
  if (state.expanded.size > 0) {
    const live = new Set();
    for (const r of state.display) if (r.kind === "group") live.add(r.key);
    for (const k of state.expanded) if (!live.has(k)) state.expanded.delete(k);
  }
  // Keep the user on the same page where possible.
  const totalPages = Math.max(1, Math.ceil(state.display.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  renderTable();
  renderPager();
  renderRowCount();
}

function renderRowCount() {
  const n = state.filtered.length;
  const total = state.items.length;
  if (total === 0) {
    els["row-count"].textContent = "No transactions cached.";
    return;
  }
  const filtered = n === total ? `${n.toLocaleString()} transactions` : `${n.toLocaleString()} of ${total.toLocaleString()} transactions`;
  const folds = state.display.length;
  const groupCount = state.display.filter((r) => r.kind === "group").length;
  els["row-count"].textContent =
    groupCount > 0
      ? `${filtered} · ${folds.toLocaleString()} rows (${groupCount} folded)`
      : `${filtered} · ${folds.toLocaleString()} rows`;
}

// ─── Table render ───────────────────────────────────────────────────────────
function renderTable() {
  const body = els["ledger-body"];
  body.replaceChildren();
  if (state.display.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="empty muted">No transactions match the current filters.</td>`;
    body.appendChild(tr);
    return;
  }
  const start = (state.page - 1) * state.pageSize;
  const end = Math.min(state.display.length, start + state.pageSize);
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const row = state.display[i];
    if (row.kind === "single") {
      fragment.appendChild(buildSingleRow(row.item));
    } else {
      const expanded = state.expanded.has(row.key);
      fragment.appendChild(buildGroupRow(row, expanded));
      if (expanded) {
        // Cap inline expansion at 500: any single fold with more items than that is a
        // pathological day and rendering thousands of <tr>s inline locks up the tab —
        // the export keeps the full set so this is just a display cap.
        const visible = Math.min(row.items.length, 500);
        for (let j = 0; j < visible; j++) {
          fragment.appendChild(buildSingleRow(row.items[j], { child: true }));
        }
        if (row.items.length > visible) {
          const note = document.createElement("tr");
          note.className = "fold-child";
          note.innerHTML = `<td colspan="5" class="empty muted">Showing first ${visible.toLocaleString()} of ${row.items.length.toLocaleString()} — export the CSV for the full list.</td>`;
          fragment.appendChild(note);
        }
      }
    }
  }
  body.appendChild(fragment);
}

function buildSingleRow(item, { child = false } = {}) {
  const tr = document.createElement("tr");
  if (child) tr.classList.add("fold-child");
  const cents = dcAmountToCents(item.amount);
  const plugin = classify(item);
  const pluginClass =
    plugin === "ChestShop"
      ? "plugin-tag plugin-tag--chestshop"
      : plugin === "Sweep"
      ? "plugin-tag plugin-tag--sweep"
      : "plugin-tag";

  const memo = item.memo ?? "—";
  const message = item.message ? `<div class="memo-cell__sub">${escapeHtml(item.message)}</div>` : "";
  const postingId = `<div class="memo-cell__sub">#${escapeHtml(item.postingId)}</div>`;
  const initiator = item.initiatorName
    ? escapeHtml(item.initiatorName)
    : item.initiatorUuid
    ? `<span class="mono" title="${escapeHtml(item.initiatorUuid)}">${escapeHtml(item.initiatorUuid.slice(0, 8))}…</span>`
    : "—";

  tr.innerHTML = `
    <td class="col-date mono">${escapeHtml(formatDateTime(item.settledAt))}</td>
    <td class="col-memo">
      <div class="memo-cell">
        <span class="memo-cell__main">${escapeHtml(memo)}</span>
        ${message}
        ${postingId}
      </div>
    </td>
    <td class="col-plugin"><span class="${pluginClass}">${escapeHtml(plugin)}</span></td>
    <td class="col-initiator">${initiator}</td>
    <td class="col-amount amount ${cents >= 0 ? "amount--in" : "amount--out"}">${formatDollars(cents)}</td>
  `;
  return tr;
}

function buildGroupRow(group, expanded) {
  const tr = document.createElement("tr");
  tr.classList.add("fold-row");
  if (expanded) tr.classList.add("expanded");
  const caret = expanded ? "▾" : "▸";
  const pluginClass =
    group.plugin === "ChestShop"
      ? "plugin-tag plugin-tag--chestshop"
      : group.plugin === "Sweep"
      ? "plugin-tag plugin-tag--sweep"
      : "plugin-tag";
  const range = formatTimeRange(group.startIso, group.endIso);
  tr.innerHTML = `
    <td class="col-date mono">${escapeHtml(formatDate(group.startIso))}</td>
    <td class="col-memo">
      <div class="memo-cell">
        <span class="memo-cell__main"><span class="fold-row__caret">${caret}</span>${escapeHtml(groupTitle(group))}</span>
        <span class="memo-cell__sub">${escapeHtml(range)}</span>
      </div>
    </td>
    <td class="col-plugin"><span class="${pluginClass}">${escapeHtml(group.plugin)}</span></td>
    <td class="col-initiator muted">—</td>
    <td class="col-amount amount ${group.totalCents >= 0 ? "amount--in" : "amount--out"}">${formatDollars(group.totalCents)}</td>
  `;
  tr.addEventListener("click", () => toggleGroup(group));
  return tr;
}

function toggleGroup(group) {
  if (state.expanded.has(group.key)) state.expanded.delete(group.key);
  else state.expanded.add(group.key);
  renderTable();
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Pager ──────────────────────────────────────────────────────────────────
function renderPager() {
  const totalPages = Math.max(1, Math.ceil(state.display.length / state.pageSize));
  els["page-info"].textContent = `Page ${state.page} / ${totalPages}`;
  els["page-first"].disabled = state.page <= 1;
  els["page-prev"].disabled = state.page <= 1;
  els["page-next"].disabled = state.page >= totalPages;
  els["page-last"].disabled = state.page >= totalPages;
}

// ─── Export ─────────────────────────────────────────────────────────────────
/** Strip filesystem/URL-significant characters from a string so it can't poison the
 *  download filename. A firmName like "Smith/Jones LLC" would otherwise let Chrome
 *  truncate the download to "Jones LLC-…csv" and Safari refuse it outright. */
function sanitizeFilenamePart(s) {
  return String(s ?? "")
    .replace(/[/\\:?*<>|"\x00-\x1f]/g, "_")
    .trim()
    .replace(/\s+/g, "_") || "untitled";
}

function onExport() {
  if (state.filtered.length === 0) {
    toast("Nothing to export with the current filters.", "error");
    return;
  }
  const { csv, stats } = buildExportCsv(state.filtered, state.mapping);
  const safeName = sanitizeFilenamePart(state.firmName || `account-${state.accountId}`);
  const filename = `dcmanager-import-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`;
  downloadCsv(csv, filename);
  toast(
    `Exported ${stats.entryCount.toLocaleString()} entries (${stats.chestshopBuckets} ChestShop days, ${stats.singleEntries} singles${stats.skippedSweeps ? `, ${stats.skippedSweeps} sweeps skipped` : ""}${stats.skippedMalformed ? `, ${stats.skippedMalformed} malformed dropped` : ""}).`,
    "success",
  );
}

// ─── Mapping dialog ─────────────────────────────────────────────────────────
function openMapping() {
  els["map-chestshop-in"].value = state.mapping.chestshopInCode;
  els["map-chestshop-out"].value = state.mapping.chestshopOutCode;
  els["map-other-in"].value = state.mapping.otherInCode;
  els["map-other-out"].value = state.mapping.otherOutCode;
  els["map-skip-sweeps"].checked = state.mapping.skipSweeps;
  els["mapping-dialog"].showModal();
}

function saveMapping() {
  state.mapping = {
    ...DEFAULT_MAPPING,
    chestshopInCode: els["map-chestshop-in"].value.trim() || DEFAULT_MAPPING.chestshopInCode,
    chestshopOutCode: els["map-chestshop-out"].value.trim() || DEFAULT_MAPPING.chestshopOutCode,
    otherInCode: els["map-other-in"].value.trim() || DEFAULT_MAPPING.otherInCode,
    otherOutCode: els["map-other-out"].value.trim() || DEFAULT_MAPPING.otherOutCode,
    skipSweeps: els["map-skip-sweeps"].checked,
  };
  persist();
}

// ─── Settings dialog ────────────────────────────────────────────────────────
function openSettings() {
  const total = state.items.length.toLocaleString();
  els["settings-info"].textContent = state.token
    ? `Cached ${total} transactions for account ${state.accountId}.`
    : "Not connected.";
  els["settings-dialog"].showModal();
}

async function fullDisconnect() {
  state.syncAbort?.abort();
  // Wait for any in-flight sync to unwind before tearing down IDB. Without this, a
  // setMeta running after the abort would re-open the database (we just nulled
  // dbPromise) and write a meta record for the cleared account into the fresh DB.
  while (state.syncing) await new Promise((r) => setTimeout(r, 30));
  await nukeDatabase();
  state.items = [];
  state.itemsById = new Map();
  state.expanded = new Set();
  state.filters = { search: "", fromDay: "", toDay: "", plugin: "", direction: "" };
  state.page = 1;
  state.token = "";
  state.accountId = "";
  state.firmName = "";
  state.firmDisplayName = null;
  state.balance = null;
  state.totalItems = null;
  persist();
  els["settings-dialog"].close();
  showConnectView();
  toast("Disconnected and cleared all local data.", "success");
}

// ─── Wiring ─────────────────────────────────────────────────────────────────
function wire() {
  els["connect-form"].addEventListener("submit", onConnect);
  els["connect-clear"].addEventListener("click", () => {
    els["connect-token"].value = "";
    els["connect-firm"].value = "";
    els["connect-account"].value = "";
    updateTokenHint();
  });
  els["connect-token"].addEventListener("input", updateTokenHint);

  els["sync-btn"].addEventListener("click", () => runSync());
  els["export-btn"].addEventListener("click", onExport);
  els["export-settings-btn"].addEventListener("click", openMapping);
  els["settings-btn"].addEventListener("click", openSettings);

  els["filter-search"].addEventListener("input", debounce(applyFiltersAndRender, 180));
  els["filter-from"].addEventListener("change", applyFiltersAndRender);
  els["filter-to"].addEventListener("change", applyFiltersAndRender);
  els["filter-plugin"].addEventListener("change", applyFiltersAndRender);
  els["filter-direction"].addEventListener("change", applyFiltersAndRender);
  els["filter-clear"].addEventListener("click", () => {
    els["filter-search"].value = "";
    els["filter-from"].value = "";
    els["filter-to"].value = "";
    els["filter-plugin"].value = "";
    els["filter-direction"].value = "";
    applyFiltersAndRender();
  });
  els["page-first"].addEventListener("click", () => goPage(1));
  els["page-prev"].addEventListener("click", () => goPage(state.page - 1));
  els["page-next"].addEventListener("click", () => goPage(state.page + 1));
  els["page-last"].addEventListener("click", () =>
    goPage(Math.ceil(state.display.length / state.pageSize) || 1),
  );
  els["page-size"].addEventListener("change", () => {
    state.pageSize = Number(els["page-size"].value) || 50;
    state.page = 1;
    persist();
    renderTable();
    renderPager();
  });

  els["settings-disconnect"].addEventListener("click", () => void fullDisconnect());

  // Save only on explicit Save (button has value="save"); Escape and backdrop click
  // both close with returnValue="" and must NOT persist half-edited values.
  els["mapping-dialog"].addEventListener("close", () => {
    if (els["mapping-dialog"].returnValue === "save") saveMapping();
  });
  els["mapping-reset"].addEventListener("click", () => {
    els["map-chestshop-in"].value = DEFAULT_MAPPING.chestshopInCode;
    els["map-chestshop-out"].value = DEFAULT_MAPPING.chestshopOutCode;
    els["map-other-in"].value = DEFAULT_MAPPING.otherInCode;
    els["map-other-out"].value = DEFAULT_MAPPING.otherOutCode;
    els["map-skip-sweeps"].checked = DEFAULT_MAPPING.skipSweeps;
  });
}

function goPage(n) {
  const totalPages = Math.max(1, Math.ceil(state.display.length / state.pageSize));
  state.page = Math.max(1, Math.min(totalPages, n));
  renderTable();
  renderPager();
  document.querySelector(".table-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  cacheDom();
  wire();

  if (state.token && state.accountId) {
    // Validate the stored token cheaply; if it's obviously expired, fall back to connect.
    const check = validateToken(state.token);
    if (!check.ok) {
      toast(`Saved token is unusable (${check.message}). Re-enter to continue.`, "error");
      showConnectView();
      return;
    }
    showLedgerView();
    await loadCacheAndRender();
    void refreshBalances();
  } else {
    showConnectView();
  }
}

boot().catch((err) => {
  console.error(err);
  toast(`Failed to start: ${err.message}`, "error");
});
