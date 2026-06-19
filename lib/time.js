// UTC-day bookkeeping. We deliberately use the browser's Intl/Date — no dayjs to keep the
// page dependency-free — and pin every grouping operation to UTC so a Pacific user and a
// CET user produce identical fold groups and identical export rows.

const PAD = (n) => String(n).padStart(2, "0");

/** Strict UTC day key as "YYYY-MM-DD" for a non-empty ISO timestamp. Returns null when the
 *  input is null/undefined/empty or fails to parse — callers must treat null as "drop this
 *  item", NOT bucket it into a phantom day. new Date(undefined) is Invalid Date and
 *  new Date(null) silently coerces to the epoch, so an explicit guard is required. */
export function utcDayKey(iso) {
  if (iso == null || iso === "") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${PAD(d.getUTCMonth() + 1)}-${PAD(d.getUTCDate())}`;
}

/** Human-readable absolute date (local). Returns "—" on bad input rather than throwing or
 *  rendering "Invalid Date" in the UI. */
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatDate(iso) {
  const d = parseIso(iso);
  return d ? DATE_FMT.format(d) : "—";
}

const DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateTime(iso) {
  const d = parseIso(iso);
  return d ? DATETIME_FMT.format(d) : "—";
}

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

export function formatTime(iso) {
  const d = parseIso(iso);
  return d ? TIME_FMT.format(d) : "—";
}

/** "Jun 9, 2026 · 9:00 AM – 5:42 PM", collapsing the range when start==end. */
export function formatTimeRange(startIso, endIso) {
  const date = formatDate(startIso);
  const start = formatTime(startIso);
  const end = formatTime(endIso);
  if (start === end) return `${date} · ${start}`;
  return `${date} · ${start} – ${end}`;
}

function parseIso(iso) {
  if (iso == null || iso === "") return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
