// Build a DCManager-compatible journal import CSV from raw Treasury postings.
//
// DCManager's importer (see dcmanager/src/lib/journal-import.ts) expects:
//   Entry,Date,Memo,Account Code,Debit,Credit,Line Memo
//
// Where:
//   - rows are grouped by Entry id (same id = same entry, must balance)
//   - Date is YYYY-MM-DD
//   - each line is EITHER a debit OR a credit, not both
//   - the wallet (account 1050 "Cash Held In-Game") sits on every entry's cash leg
//
// Categorization defaults (user-overridable in the Mapping dialog) mirror the chart of
// accounts seeded by dcmanager/supabase/schema.sql:
//   1050  Cash Held In-Game           (always one leg)
//   4000  Sales Revenue               (ChestShop in)
//   6400  Materials & Supplies        (ChestShop out)
//   4950  Uncategorized Income        (other in)
//   6900  Uncategorized Expense       (other out)
//
// ChestShop legs are batched per UTC day so a year of sales is ~365 entries instead of
// 80k lines — which keeps each import under DCManager's IMPORT_MAX_LINES = 2000 ceiling.

import { dcAmountToCents } from "./money.js";
import { utcDayKey } from "./time.js";
import { classify } from "./grouping.js";
import { toCsv } from "./csv.js";

export const EXPORT_HEADER = [
  "Entry",
  "Date",
  "Memo",
  "Account Code",
  "Debit",
  "Credit",
  "Line Memo",
];

export const DEFAULT_MAPPING = Object.freeze({
  cashCode: "1050",
  chestshopInCode: "4000",
  chestshopOutCode: "6400",
  otherInCode: "4950",
  otherOutCode: "6900",
  skipSweeps: true,
});

/** Format integer cents as a CSV amount: "1234.56", "0.07", "". Negative amounts never
 *  appear — debits and credits go in their own columns. */
function fmt(cents) {
  if (cents <= 0) return "";
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

/** Plan one balanced entry: cash leg on 1050 plus the offset category leg. */
function entryLines({ entryId, date, memo, cashCode, otherCode, cents, lineMemo = "" }) {
  // Positive cents → money into the account → DR cash / CR category (income/liability).
  // Negative cents → money out → CR cash / DR category (expense/asset).
  const debitCash = cents > 0;
  const abs = Math.abs(cents);
  return [
    [entryId, date, memo, cashCode, debitCash ? fmt(abs) : "", debitCash ? "" : fmt(abs), lineMemo],
    [entryId, date, memo, otherCode, debitCash ? "" : fmt(abs), debitCash ? fmt(abs) : "", lineMemo],
  ];
}

/**
 *  Build the CSV. Returns `{ csv, stats }` so the caller can show "exported N entries from
 *  M postings" before triggering the download.
 *
 *  ChestShop postings are bucketed by `(direction, UTC day)` and summed into one entry
 *  per bucket — the count + total feed the entry memo so the user can spot anomalies
 *  ("ChestShop sales × 1,243 — $9,210.50") in DCManager's journal afterwards.
 *
 *  Non-ChestShop postings emit one entry per posting, with the original memo + the
 *  initiator name in Line Memo for traceability.
 */
export function buildExportCsv(items, mapping = DEFAULT_MAPPING) {
  const cfg = { ...DEFAULT_MAPPING, ...mapping };
  // Process oldest→newest so DCManager's journal shows them chronologically. Raw
  // comparison is fine for ISO timestamps and ~10× faster than localeCompare on the
  // 80k-item path.
  const sorted = [...items].sort((a, b) =>
    a.settledAt < b.settledAt ? -1 : a.settledAt > b.settledAt ? 1 : 0,
  );

  const csBuckets = new Map(); // key: `${dir}|${day}` → { dir, day, cents, count, sampleMemo }
  const singleEntries = []; // { date, memo, cashCode, otherCode, cents, lineMemo }
  let skippedSweeps = 0;

  let skippedMalformed = 0;
  for (const item of sorted) {
    const day = utcDayKey(item.settledAt);
    if (day == null) {
      skippedMalformed++;
      continue;
    }
    const cents = dcAmountToCents(item.amount);
    if (cents === 0) continue;
    const plugin = classify(item);

    if (cfg.skipSweeps && plugin === "Sweep") {
      skippedSweeps++;
      continue;
    }

    if (plugin === "ChestShop") {
      const dir = cents > 0 ? "in" : "out";
      const key = `${dir}|${day}`;
      const bucket = csBuckets.get(key) ?? { dir, day, cents: 0, count: 0 };
      bucket.cents += cents;
      bucket.count += 1;
      csBuckets.set(key, bucket);
      continue;
    }

    const cashCode = cfg.cashCode;
    const otherCode = cents > 0 ? cfg.otherInCode : cfg.otherOutCode;
    const memo = item.memo?.trim() || (cents > 0 ? "Incoming transfer" : "Outgoing transfer");
    const lineMemo = [item.initiatorName, item.initiatorUuid].filter(Boolean).join(" · ");
    singleEntries.push({ date: day, memo, cashCode, otherCode, cents, lineMemo });
  }

  const rows = [];
  let entryNo = 0;

  // Chestshop buckets first so a glance at the import shows the daily sales totals.
  const sortedBuckets = [...csBuckets.values()].sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
  });

  for (const bucket of sortedBuckets) {
    entryNo++;
    const memo =
      bucket.dir === "in"
        ? `ChestShop sales × ${bucket.count}`
        : `ChestShop outflows × ${bucket.count}`;
    const otherCode = bucket.dir === "in" ? cfg.chestshopInCode : cfg.chestshopOutCode;
    rows.push(
      ...entryLines({
        entryId: String(entryNo),
        date: bucket.day,
        memo,
        cashCode: cfg.cashCode,
        otherCode,
        cents: bucket.cents,
        lineMemo: "Batched from Treasury postings",
      }),
    );
  }

  for (const e of singleEntries) {
    entryNo++;
    rows.push(
      ...entryLines({
        entryId: String(entryNo),
        date: e.date,
        memo: e.memo,
        cashCode: e.cashCode,
        otherCode: e.otherCode,
        cents: e.cents,
        lineMemo: e.lineMemo,
      }),
    );
  }

  const csv = toCsv(EXPORT_HEADER, rows);
  return {
    csv,
    stats: {
      entryCount: entryNo,
      lineCount: rows.length,
      chestshopBuckets: sortedBuckets.length,
      singleEntries: singleEntries.length,
      skippedSweeps,
      skippedMalformed,
      processed: items.length,
    },
  };
}
