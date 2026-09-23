// Round-4 self-audit: the two properties the round-3 reviewer's probe
// (tests/raptor3/g4/review/witness-followup3/evidence-identity.review.test.ts)
// asserts over a round's receipt set, applied to THIS round's receipts.
// The probe itself points at `receipts/followup-verify/`, whose numbers are
// historical and cannot be re-taken; this is the same arithmetic on the set
// that replaces them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
const REPAIR = resolve(HERE, "../repair");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const identityOf = (receipt) =>
  receipt.identity ??
  (receipt.production !== undefined && receipt.harness !== undefined
    ? { production: receipt.production, harness: receipt.harness }
    : undefined);

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (entry.endsWith(".json")) found.push(path);
  }
  return found;
}

const runReceipts = walk(HERE).filter((path) =>
  /\/(attempt|verified)\.json$/.test(path)
);
const before = identityOf(readJson(join(HERE, "identity-before.json")));
const after = identityOf(readJson(join(HERE, "identity-after.json")));
const priorRound = identityOf(
  readJson(join(REPAIR, "identity-after-repair.json"))
);

const rows = runReceipts.map((path) => ({
  receipt: path.slice(HERE.length + 1),
  ...identityOf(readJson(path)),
}));

const audit = {
  capturedAt: new Date().toISOString(),
  runReceipts: rows.length,
  opening: before,
  closing: after,
  priorRoundClosing: priorRound,
  everyReceiptCarriesAnIdentity: rows.every(
    (row) => row.production !== undefined && row.harness !== undefined
  ),
  everyReceiptAtTheClosingProduction: rows.every(
    (row) => row.production === after.production
  ),
  productionsSeen: [...new Set(rows.map((row) => row.production))],
  harnessesSeen: [...new Set(rows.map((row) => row.harness))],
  measuredAtADifferentProductionThanThePriorRound: rows.every(
    (row) => row.production !== priorRound.production
  ),
  rows,
};
process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
