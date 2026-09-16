/**
 * Independent review probes (round 4) — the repair round's own receipt set.
 *
 * The round-3 review's must-fix 1 was that `note.md` §16 closed at an identity
 * none of its rows were measured at. The repair answers it twice: the §16 prose
 * is corrected, and the whole accepted claim set is re-measured in §17.4. These
 * cells apply the two properties the round-3 probe asserts over a round's
 * receipt set to THIS round's receipts, recomputing them from the files rather
 * than reading the round's own `identity-audit.json` conclusions.
 *
 * A failing cell here is a finding, not a request to re-run anything.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WITNESS = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/witness/receipts"
);
const REPAIR2 = join(WITNESS, "repair2");
const REPAIR = join(WITNESS, "repair");

interface Identity {
  readonly production: string;
  readonly harness: string;
}
interface Receipt {
  readonly identity?: Identity;
  readonly production?: string;
  readonly harness?: string;
}

const readJson = (path: string): Receipt =>
  JSON.parse(readFileSync(path, "utf8")) as Receipt;

const identityOf = (receipt: Receipt): Identity | undefined =>
  receipt.identity ??
  (receipt.production !== undefined && receipt.harness !== undefined
    ? { production: receipt.production, harness: receipt.harness }
    : undefined);

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (entry.endsWith(".json")) found.push(path);
  }
  return found;
}

const runReceipts = (): string[] =>
  walk(REPAIR2).filter((path) => /\/(attempt|verified)\.json$/.test(path));

describe("review probe (round 4): the repair round's identity", () => {
  it("writes run receipts and gives every one of them an identity", () => {
    const receipts = runReceipts();
    assert.ok(receipts.length > 0, "the repair round wrote no run receipts");
    for (const path of receipts)
      assert.ok(
        identityOf(readJson(path)),
        `${path} records no executed-source identity`
      );
  });

  it("took every run at the production identity it closes at", () => {
    const after = identityOf(readJson(join(REPAIR2, "identity-after.json")));
    assert.ok(after, "the repair round recorded no closing identity");
    for (const path of runReceipts()) {
      const identity = identityOf(readJson(path));
      assert.equal(
        identity?.production,
        after.production,
        `${path} was measured at production ${identity?.production.slice(0, 8)}…, the round closed at ${after.production.slice(0, 8)}…`
      );
    }
  });

  it("opens and closes at the same production identity", () => {
    const before = identityOf(readJson(join(REPAIR2, "identity-before.json")));
    const after = identityOf(readJson(join(REPAIR2, "identity-after.json")));
    assert.ok(before && after, "a bracket is missing");
    assert.equal(before.production, after.production);
  });

  it("measured a production identity the earlier repair round never covered", () => {
    const prior = identityOf(
      readJson(join(REPAIR, "identity-after-repair.json"))
    );
    assert.ok(prior, "the earlier repair round recorded no closing identity");
    const productions = new Set(
      runReceipts()
        .map((path) => identityOf(readJson(path))?.production)
        .filter((value): value is string => value !== undefined)
    );
    assert.equal(productions.size, 1, "more than one production was measured");
    assert.deepEqual(
      [...productions].filter((production) => production === prior.production),
      [],
      `the repair round ran at the earlier round's production ${prior.production.slice(0, 8)}…`
    );
  });

  it("states in its audit only what the receipts themselves say", () => {
    // `identity-audit.json` is the round's own arithmetic. Recompute it here:
    // an audit that asserted rather than computed would disagree.
    interface Audit {
      readonly runReceipts: number;
      readonly everyReceiptAtTheClosingProduction: boolean;
      readonly measuredAtADifferentProductionThanThePriorRound: boolean;
      readonly productionsSeen: readonly string[];
    }
    const audit = JSON.parse(
      readFileSync(join(REPAIR2, "identity-audit.json"), "utf8")
    ) as Audit;
    const receipts = runReceipts();
    const after = identityOf(readJson(join(REPAIR2, "identity-after.json")));
    assert.ok(after);
    assert.equal(audit.runReceipts, receipts.length);
    assert.equal(
      audit.everyReceiptAtTheClosingProduction,
      receipts.every(
        (path) => identityOf(readJson(path))?.production === after.production
      )
    );
    assert.deepEqual(
      [...audit.productionsSeen].sort(),
      [
        ...new Set(
          receipts
            .map((path) => identityOf(readJson(path))?.production)
            .filter((value): value is string => value !== undefined)
        ),
      ].sort()
    );
  });
});
