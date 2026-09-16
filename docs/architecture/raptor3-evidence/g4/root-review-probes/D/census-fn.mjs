// Read-only extraction of scripts/query-engine-structure.mjs's own
// `countTokenLines`. The function text is sliced verbatim from the script on
// disk (never modified) and its sha256 is asserted against the G3 census
// receipt's `accounting.censusFunctionSha256`, so the method is provably the
// same one G3 used.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const CENSUS = resolve(ROOT, "scripts/query-engine-structure.mjs");
const G3_COST = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/support/source-cost.json"
);

const censusSource = readFileSync(CENSUS, "utf8");
const start = censusSource.indexOf("function countTokenLines");
const end = censusSource.indexOf("\nfunction getRuntimeModule");
if (start < 0 || end < 0) throw new Error("countTokenLines not found");
const fnText = censusSource.slice(start, end).trim();
export const censusFunctionSha256 = createHash("sha256")
  .update(fnText)
  .digest("hex");

const expected = JSON.parse(readFileSync(G3_COST, "utf8")).accounting
  .censusFunctionSha256;
if (censusFunctionSha256 !== expected) {
  throw new Error(
    `census function drifted: ${censusFunctionSha256} != ${expected}`
  );
}

// eslint-disable-next-line no-new-func
const factory = new Function(
  "ts",
  `${fnText}\nreturn countTokenLines;`
);
export const countTokenLines = factory(ts);
export const censusScriptPath = CENSUS;
