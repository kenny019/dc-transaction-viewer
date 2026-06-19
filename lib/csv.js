// RFC4180 CSV builder — same shape as dcmanager/src/lib/csv.ts so the export round-trips
// cleanly through DCManager's importer.

const BOM = "﻿"; // Excel prefers a UTF-8 BOM so leading sigils don't garble.

function escapeField(value) {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build a CSV string. Headers are an array of strings; rows are arrays of cells. */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(","));
  }
  return BOM + lines.join("\r\n");
}

/** Trigger a download in the browser. */
export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the click has time to spawn the download in older browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
