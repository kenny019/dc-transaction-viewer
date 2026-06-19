// Daily folding for the ledger view. ChestShop firms can post 200+ postings/day; rendered
// straight, the page is unscannable. This collapses consecutive same-shape postings on the
// same UTC day into one summary row, mirroring dcmanager's journal-grouping behaviour
// (which only sees aggregated entries; we work at the raw posting level).
//
// Shape signature: `pluginSystem | direction`. Memo isn't part of the key so 200 ChestShop
// memos still fold into one row. `dcm-sweep:` is a special-case bucket since its
// pluginSystem is null but its memo prefix uniquely identifies it.

import { dcAmountToCents } from "./money.js";
import { utcDayKey } from "./time.js";

const FOLD_THRESHOLD = 2; // a "group" of one collapses back to a single row

/** Bucket label used in fold keys + plugin tags. */
export function classify(item) {
  if (item.memo?.startsWith("dcm-sweep:")) return "Sweep";
  return item.pluginSystem || "Manual";
}

/** "in" for credits to this account, "out" for debits. */
export function direction(item) {
  return dcAmountToCents(item.amount) >= 0 ? "in" : "out";
}

const FOLDABLE = new Set(["ChestShop", "Sweep"]);

/** Group an already-sorted (newest-first) item list into display rows.
 *
 *  Output rows are either:
 *    - `{ kind: "single", item }`
 *    - `{ kind: "group", key, items, totalCents, plugin, direction, day, startIso, endIso }`
 *
 *  ChestShop and sweep runs on the same UTC day collapse into a group; everything else
 *  stays as singles. The user can click a group row to expand it inline.
 */
export function groupItems(items) {
  const rows = [];
  let current = null;
  for (const item of items) {
    const day = utcDayKey(item.settledAt);
    // Skip items with unparseable settledAt — would otherwise create phantom day buckets.
    // Treasury syncs validate this at the boundary; this guard only fires on items left
    // in IDB from a pre-validation build of the viewer.
    if (day == null) continue;
    const plugin = classify(item);
    const cents = dcAmountToCents(item.amount);
    const dir = cents >= 0 ? "in" : "out";
    const key = `${plugin}|${dir}|${day}`;

    if (FOLDABLE.has(plugin) && current && current.key === key) {
      current.items.push(item);
      current.totalCents += cents;
      // Items arrive newest-first, so the first item is `endIso` and the latest is
      // `startIso`. Track both so the summary range stays accurate when more arrive.
      current.startIso = item.settledAt; // oldest so far
      continue;
    }
    // Close out the previous run.
    if (current) {
      rows.push(finalizeGroup(current));
      current = null;
    }
    if (FOLDABLE.has(plugin)) {
      current = {
        key,
        plugin,
        direction: dir,
        day,
        startIso: item.settledAt, // oldest
        endIso: item.settledAt,   // newest (first item in newest-first stream)
        items: [item],
        totalCents: cents,
      };
    } else {
      rows.push({ kind: "single", item });
    }
  }
  if (current) rows.push(finalizeGroup(current));
  return rows;
}

function finalizeGroup(group) {
  if (group.items.length < FOLD_THRESHOLD) {
    return { kind: "single", item: group.items[0] };
  }
  return {
    kind: "group",
    key: group.key,
    items: group.items,
    totalCents: group.totalCents,
    plugin: group.plugin,
    direction: group.direction,
    day: group.day,
    startIso: group.startIso,
    endIso: group.endIso,
  };
}

/** Human title for a fold row. */
export function groupTitle(group) {
  const label =
    group.plugin === "Sweep"
      ? "Sweep transfers"
      : group.plugin === "ChestShop"
      ? group.direction === "in"
        ? "ChestShop sales"
        : "ChestShop outflows"
      : `${group.plugin} activity`;
  return `${label} (${group.items.length})`;
}
