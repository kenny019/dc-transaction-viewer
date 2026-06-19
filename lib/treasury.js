// Treasury REST client — slim port of dcmanager/src/lib/dc-api.ts for the browser.
// Bearer-token auth, decimal-string money. We only read; no transfer endpoints are
// exposed here so a leaked token from this app can't move funds via a viewer bug.

export const DEFAULT_BASE = "https://api.democracycraft.net/economy";

export class TreasuryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "TreasuryError";
    this.status = status;
    this.code = code;
  }
}

/** Best-effort decode of a Treasury JWT payload. Not signature-verified — the Treasury
 *  enforces real auth. This exists purely to surface friendlier errors (wrong scope,
 *  expired token) before the first network round-trip. Returns null when the input
 *  isn't a parseable JWT. */
export function decodeToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    // base64url → base64
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Short, user-facing assessment of a pasted token. Catches the obvious mistakes:
 *  wrong scope (PERSONAL not BUSINESS) and expired tokens. */
export function validateToken(token) {
  if (!token || !token.trim()) return { ok: false, message: "Paste a token to continue." };
  const claims = decodeToken(token.trim());
  if (!claims) return { ok: false, message: "Doesn't look like a Treasury JWT." };
  if (claims.type && claims.type !== "BUSINESS") {
    return {
      ok: false,
      message: `Token scope is ${claims.type}; this viewer needs a BUSINESS token.`,
    };
  }
  if (claims.exp && claims.exp * 1000 < Date.now()) {
    return { ok: false, message: "Token has expired — generate a new one in-game." };
  }
  return { ok: true, claims };
}

async function tFetch(base, path, { token, signal } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = (body && typeof body === "object" ? body : {});
    throw new TreasuryError(
      res.status,
      err.error || "DC_API_ERROR",
      err.message || `Treasury API ${res.status}`,
    );
  }
  return body;
}

/** Public firm lookup by name → `{ firmId, displayName, defaultAccountId, ... }`. The
 *  endpoint is public, so this works without a token; we still pass one for symmetry. */
export function getPublicFirm({ base = DEFAULT_BASE, token, firmName, signal }) {
  return tFetch(base, `/api/v1/firms/${encodeURIComponent(firmName)}`, { token, signal });
}

/** Firm-wide balance (sum across all firm accounts). */
export function getFirmBalance({ base = DEFAULT_BASE, token, firmName, signal }) {
  return tFetch(base, `/api/v1/firms/${encodeURIComponent(firmName)}/balance`, {
    token,
    signal,
  });
}

/** Single-account balance — useful when the user pinpoints a specific account id. */
export function getAccountBalance({ base = DEFAULT_BASE, token, accountId, signal }) {
  return tFetch(base, `/api/v1/accounts/${accountId}/balance`, { token, signal });
}

/** One page of transactions, newest-first per Treasury convention.
 *
 *  `limit` defaults to 100 — high enough to keep an 80k-row initial sync to ~800 round
 *  trips without inviting per-page payload limits we haven't measured. */
export function getAccountTransactions({
  base = DEFAULT_BASE,
  token,
  accountId,
  page = 1,
  limit = 100,
  signal,
}) {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  return tFetch(base, `/api/v1/accounts/${accountId}/transactions?${qs.toString()}`, {
    token,
    signal,
  });
}

const SYNC_CONCURRENCY = 6;

/**
 * Sync transactions for an account, newest-first.
 *
 *  - `existingIds` is the Set of postingIds already cached. On follow-up syncs we walk
 *    page 1; if it's entirely known we're done (postings are append-only at the top, so
 *    a clean page 1 means no new activity). On a cold/full sync we fan out the remaining
 *    pages with bounded concurrency — 800 sequential round-trips would take minutes,
 *    SYNC_CONCURRENCY workers finish in tens of seconds.
 *  - Each item is validated at this boundary (`isWellFormed`) so a malformed Treasury
 *    response can never poison the cache with phantom day buckets or "undefined" keys.
 *  - `onProgress({ fetchedPages, totalPages, newCount, totalItems })` ticks after each
 *    completed page from any worker.
 */
export async function syncAccount({
  base = DEFAULT_BASE,
  token,
  accountId,
  existingIds,
  limit = 100,
  signal,
  onProgress,
}) {
  const seen = new Set(existingIds);
  const newItems = [];

  const ingestPage = (items) => {
    let added = 0;
    for (const item of items ?? []) {
      if (!isWellFormed(item)) continue;
      const id = String(item.postingId);
      if (seen.has(id)) continue;
      seen.add(id);
      newItems.push({ ...item, postingId: id, txnId: String(item.txnId) });
      added++;
    }
    return added;
  };

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const page1 = await getAccountTransactions({
    base, token, accountId, page: 1, limit, signal,
  });
  const totalPages = page1.totalPages ?? 1;
  const totalItems = page1.totalItems ?? 0;
  const page1New = ingestPage(page1.items);
  onProgress?.({ fetchedPages: 1, totalPages, newCount: newItems.length, totalItems });

  // Caught up: page 1 had zero new items AND we had cached items going in. (On a cold
  // sync existingIds is empty so page1New > 0 unless the account itself is empty.)
  if (totalPages <= 1 || (page1New === 0 && existingIds.size > 0)) {
    return { items: newItems, totalPages, totalItems };
  }

  // Fan out pages 2..totalPages with bounded concurrency. Workers share a moving index
  // into the page queue; the Set+array mutations are safe because JS is single-threaded.
  let nextPage = 2;
  let completed = 1;
  const workerCount = Math.min(SYNC_CONCURRENCY, totalPages - 1);

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = nextPage++;
      if (page > totalPages) return;
      const res = await getAccountTransactions({
        base, token, accountId, page, limit, signal,
      });
      ingestPage(res.items);
      completed++;
      onProgress?.({
        fetchedPages: completed,
        totalPages,
        newCount: newItems.length,
        totalItems,
      });
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));

  return { items: newItems, totalPages, totalItems };
}

/** Minimum item shape we trust into the cache. Anything else gets dropped at this boundary
 *  with no other layer needing to defend against null/missing fields. */
function isWellFormed(item) {
  return (
    item != null &&
    typeof item === "object" &&
    item.postingId != null &&
    item.txnId != null &&
    typeof item.amount === "string" &&
    typeof item.settledAt === "string" &&
    item.settledAt.length > 0 &&
    !Number.isNaN(new Date(item.settledAt).getTime())
  );
}
