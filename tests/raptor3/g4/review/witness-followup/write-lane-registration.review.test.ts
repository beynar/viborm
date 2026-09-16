/**
 * Independent review probes — the G4 write-envelope lanes' registration.
 *
 * Each cell states the invariant the follow-up claims and FAILS when the
 * invariant does not hold on the current source. Nothing here repairs
 * anything.
 *
 * Claim under test (note.md §14.4): the two write lanes are "data-only"
 * constants that reuse G3's generator, runner and receipt assertion, so "a
 * campaign constant cannot widen what qualifies" and the children are the
 * frozen 100-seed batches the projection and the child cost were measured on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import {
  assertG3GeneratedBatchReceipt,
  G4_WRITE_CAMPAIGN,
  G4_WRITE_TRANSPORT_CAMPAIGN,
} from "../../../../../scripts/raptor3-manifest.mjs";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const AMBIENT_COUNT = "VIBORM_RAPTOR3_GENERATED_SEED_COUNT";

describe("review probe: the G4 write lanes' registration", () => {
  it("does not let an inherited seed count shrink a write child", () => {
    for (const child of [
      "tests/raptor3/g4/generation/write-campaign.test.ts",
      "tests/raptor3/g4/generation/write-transport-campaign.test.ts",
    ])
      assert.equal(
        read(child).includes(AMBIENT_COUNT),
        false,
        `${child} takes its seed count from the ambient environment`
      );
  });

  it("sanitises the seed-count variable in the runner, as it does the subject", () => {
    const runner = read("scripts/run-raptor3.mjs");
    assert.ok(
      runner.includes("delete environment.VIBORM_RAPTOR3_G4_SUBJECT"),
      "the subject leak repair is missing"
    );
    assert.ok(
      runner.includes(`delete environment.${AMBIENT_COUNT}`),
      `the runner forwards an inherited ${AMBIENT_COUNT} to every child`
    );
  });

  it("refuses a child that holds fewer seeds than the frozen batch", () => {
    // The G4 read child was hardened after review to hold the frozen batch
    // ("never an ambient count"). The write receipt assertion is the only
    // other thing that could catch a shrunken child; this builds the receipt
    // a truthful 1-seed run would produce — the recipe facts the assertion
    // re-derives from the seed are all correct — and shows it qualifies.
    const identity = { production: "p", harness: "h", runtime: { node: "v" } };
    const seed = G4_WRITE_CAMPAIGN.firstSeed;
    const shrunk = {
      formatVersion: 1,
      qualifying: true,
      status: "complete",
      identity,
      firstSeed: seed,
      seedCount: 1,
      profiles: G4_WRITE_CAMPAIGN.profiles,
      completed: G4_WRITE_CAMPAIGN.profiles.map((profile: string) => ({
        seed,
        profile,
        contract: ["C08", "C09", "C10", "C11"][
          (seed - G4_WRITE_CAMPAIGN.firstSeed) % 4
        ],
        actors: seed % 5 === 0 ? 2 : 1,
        actorOverlap: seed % 5 === 0,
        faults: seed % 5 === 1 ? 1 : 0,
        operations: 3,
        completions: 1,
      })),
      replays:
        G4_WRITE_CAMPAIGN.profiles.length * G4_WRITE_CAMPAIGN.replayCount,
      skipped: 0,
    };
    assert.throws(
      () =>
        assertG3GeneratedBatchReceipt(
          shrunk,
          seed,
          G4_WRITE_CAMPAIGN,
          identity
        ),
      /seed/,
      "a 1-seed child of a 100-seed frozen batch still qualifies"
    );
  });

  it("pins the child cell count of every registered seed-batch mode", () => {
    // Every other `*-seed-batch` mode appears twice in the runner: once in the
    // files map and once in the expected-counts map. A mode missing from the
    // counts map runs with no cell-count assertion at all.
    const runner = read("scripts/run-raptor3.mjs");
    const modes = [
      "g1-seed-batch",
      "g2-seed-batch",
      "g3-seed-batch",
      "g3p06-seed-batch",
      "g4-seed-batch",
      "g4-transport-seed-batch",
      "g4-write-seed-batch",
      "g4-write-transport-seed-batch",
    ];
    for (const mode of modes) {
      const occurrences = runner.split(`"${mode}": `).length - 1;
      assert.equal(
        occurrences,
        2,
        `${mode} is registered in ${occurrences} of the runner's two maps`
      );
    }
  });

  it("keeps the write ranges disjoint from every other frozen campaign", () => {
    // Control cell: this one is expected to PASS. The claimed disjointness is
    // real for every campaign constant the manifest declares, not only for the
    // three the author's self-test compares against.
    const manifest = read("scripts/raptor3-manifest.mjs");
    const ranges: [number, number][] = [];
    const pattern = /firstSeed: ([\d_]+),\s*\n\s*seedCount: ([\d_]+),/g;
    for (const match of manifest.matchAll(pattern))
      ranges.push([
        Number(match[1]!.replaceAll("_", "")),
        Number(match[2]!.replaceAll("_", "")),
      ]);
    assert.ok(ranges.length >= 8, "no campaign ranges were found");
    for (const lane of [G4_WRITE_CAMPAIGN, G4_WRITE_TRANSPORT_CAMPAIGN])
      for (const [first, count] of ranges) {
        if (first === lane.firstSeed && count === lane.seedCount) continue;
        assert.ok(
          lane.firstSeed + lane.seedCount <= first ||
            first + count <= lane.firstSeed,
          `write lane ${lane.firstSeed} overlaps ${first}-${first + count - 1}`
        );
      }
  });
});
