// Money helpers — ported from dcmanager/src/lib/money.ts so the export CSV cents
// match exactly. The Treasury API speaks decimal STRINGS to avoid IEEE-754 corruption;
// internally we use integer cents (Number is fine — JS safe-integer range covers
// 9 quadrillion cents).

/** Parse a DC decimal-string amount ("12.34", "0.05", "100", "-25.50") into integer cents. */
export function dcAmountToCents(amount) {
  const trimmed = String(amount).trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid money string: ${amount}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = unsigned.split(".");
  const fracCents = Number((frac + "00").slice(0, 2));
  const cents = Number(whole) * 100 + fracCents;
  return negative ? -cents : cents;
}

/** Format integer cents back to a DC-style decimal string ("1234.56"). Used for CSV. */
export function centsToDcAmount(cents) {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/** Human display: 123456 → "$1,234.56". Negative renders with a leading "-$". */
export function formatDollars(cents) {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const remainder = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${remainder}`;
}
