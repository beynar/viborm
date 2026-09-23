/**
 * Review probe. Two evidence claims of the unit.
 *
 * 1. Note §1 (decision table) and §7: `archiveG3GeneratedCorpus` gained an
 *    optional `replayCommand` "so both lanes keep one compress/verify/rename/
 *    receipt mechanism", with the falsifier "the G4 archive receipt carries its
 *    own working command". The probe reads the two retained G4 archive receipts.
 *
 * 2. Note §1 (decision table) and §3: `expectRead` states the hand value once
 *    and checks the SHIPPED engine against it BEFORE the candidate, so a
 *    candidate defect can never be masked by a re-baselined expectation. The
 *    probe breaks a hand value and requires the shipped assertion to fire.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "../../read-schema";
import { createWitnessWorld, expectRead, type WitnessWorld } from "../../witness-world";

const WITNESS = "docs/architecture/raptor3-evidence/g4/witness/receipts";

describe("review probe: retained G4 corpus archive receipts", () => {
  it("the SQLite lane's receipt states a replay command for a different corpus format", () => {
    const sqlite = JSON.parse(
      readFileSync(
        `${WITNESS}/g4-seed-batch-20000-shipped/generated-corpus.archive.json`,
        "utf8"
      )
    );
    const transport = JSON.parse(
      readFileSync(
        `${WITNESS}/g4-transport-seed-batch-50000-shipped/generated-corpus.archive.json`,
        "utf8"
      )
    );
    // The transport lane received the new parameter...
    assert.match(
      transport.replayCommand,
      /run-raptor3\.mjs g4-transport-seed-batch 50000/
    );
    // ...and the SQLite lane kept the G0/G3 default, which routes a G4 read
    // corpus into tests/raptor3/gate.test.ts. Re-running it fails with a
    // ZodError; see witness-review-receipts/archive-replay-command-fails.log.
    assert.match(
      sqlite.replayCommand,
      /run-raptor3\.mjs replay "\$g3_corpus_restore_dir\/generated-corpus\.json"/,
      "the SQLite archive receipt was regenerated after the parameter landed"
    );
  });
});

describe("review probe: the differential oracle fires before the candidate", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(relationWorldSchema(), {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  it("a wrong hand value fails as a disputed row, not as a candidate defect", async () => {
    await assert.rejects(
      () =>
        expectRead(
          world,
          "author",
          "findUnique",
          {
            where: { tenant_handle: { tenant: "acme", handle: "ada" } },
            select: { name: true },
          },
          { name: "Not Ada" }
        ),
      /Disputed row: the shipped engine disagrees with the hand-computed value/
    );
  });
});
