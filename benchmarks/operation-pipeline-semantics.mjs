/** Deterministic semantic evidence computed outside timed benchmark stages. */

import { createHash } from "node:crypto";

function canonicalize(value) {
  if (value === undefined) return ["undefined"];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["bytes", ...value];
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function semanticDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function assertSemanticDigest(label, canonicalValue, comparedValue) {
  const canonical = semanticDigest(canonicalValue);
  const compared = semanticDigest(comparedValue);
  if (canonical !== compared) {
    throw new Error(
      `${label} semantic digest mismatch: ${canonical} vs ${compared}`
    );
  }
  return canonical;
}

export function freezeRawResult(raw) {
  const rows = raw.rows.map((row) => Object.freeze(row));
  return Object.freeze({
    rows: Object.freeze(rows),
    rowCount: raw.rowCount,
    ...(raw.insertId === undefined ? {} : { insertId: raw.insertId }),
  });
}

export function freezeRawResults(results) {
  return Object.freeze(results.map(freezeRawResult));
}
