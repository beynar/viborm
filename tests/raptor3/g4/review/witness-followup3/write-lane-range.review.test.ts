/**
 * Independent review probes (round 3) — the write lanes' SEED DOMAIN.
 *
 * The follow-up widened `tests/raptor3/g3/generation/recipe.ts` from
 * `8000 <= seed < 18000` to a named floor/ceiling pair and pointed two new
 * 25,000-ID campaigns at 75000-99999 and 100000-124999. `note.md` §14.9
 * claim 1 and §16.6 claim 2 say the two PARENTS were never executed: only the
 * first child of each lane has ever run, so nothing has ever exercised the
 * far end of either range — which is exactly where an inclusive/exclusive
 * ceiling mistake lives.
 *
 * Each cell states the invariant and FAILS when it does not hold. Nothing
 * here repairs anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  G3_GENERATED_CAMPAIGN,
  G4_WRITE_CAMPAIGN,
  G4_WRITE_TRANSPORT_CAMPAIGN,
} from "../../../../../scripts/raptor3-manifest.mjs";
import { parseRaptor3Request } from "../../../../../scripts/run-raptor3.mjs";
import { generateG3Recipe } from "../../../g3/generation/recipe";

const LANES = [
  { batchMode: "g4-write-seed-batch", campaign: G4_WRITE_CAMPAIGN },
  {
    batchMode: "g4-write-transport-seed-batch",
    campaign: G4_WRITE_TRANSPORT_CAMPAIGN,
  },
] as const;

const lastSeed = (campaign: { firstSeed: number; seedCount: number }) =>
  campaign.firstSeed + campaign.seedCount - 1;

describe("review probe (round 3): the write lanes' seed domain", () => {
  it("admits the LAST seed of every write lane, not only the first", () => {
    // The generator is the only gate that reads a seed's absolute value. A
    // ceiling written `< CEILING` instead of `<= CEILING` would refuse the
    // final child of the transport lane and nothing that has ever run would
    // have noticed.
    for (const { campaign } of LANES) {
      const last = lastSeed(campaign);
      assert.doesNotThrow(
        () => generateG3Recipe(last),
        `the generator refuses seed ${last}, the last seed of a frozen lane`
      );
      assert.equal(generateG3Recipe(last).seed, last);
    }
  });

  it("refuses the seed one past the highest frozen lane", () => {
    const beyond = Math.max(...LANES.map(({ campaign }) => lastSeed(campaign)));
    assert.throws(
      () => generateG3Recipe(beyond + 1),
      `the widened generator admits ${beyond + 1}, outside every frozen lane`
    );
    assert.throws(
      () => generateG3Recipe(G3_GENERATED_CAMPAIGN.firstSeed - 1),
      "the widened generator dropped its floor"
    );
  });

  it("keeps the receipt's contract rotation aligned with the generator's", () => {
    // `assertG3GeneratedBatchReceipt` re-derives the family from
    // `(seed - campaign.firstSeed) % 4`; the generator uses `(seed - 8000) % 4`.
    // The two agree only while every campaign's first seed is congruent to
    // G3's mod 4 — including at the far end of the range, which nothing has run.
    const families = ["C08", "C09", "C10", "C11"] as const;
    for (const { campaign } of LANES)
      for (const seed of [
        campaign.firstSeed,
        campaign.firstSeed + 27,
        lastSeed(campaign) - 3,
        lastSeed(campaign),
      ])
        assert.equal(
          generateG3Recipe(seed).contract,
          families[(seed - campaign.firstSeed) % 4],
          `the receipt would claim the wrong contract family for seed ${seed}`
        );
  });

  it("keeps the actor and fault quotas exact in every batch of every lane", () => {
    // The receipt re-derives `actors` and `fault` from `seed % 5`. A batch is
    // only a 20%/20% sample when its first seed is a multiple of five; the
    // child cost, the disk projection and the quota claims of §14.4 all rest
    // on that and were measured on one batch per lane.
    for (const { campaign } of LANES) {
      assert.equal(campaign.seedCount % campaign.batchSize, 0);
      for (const firstSeed of [
        campaign.firstSeed,
        campaign.firstSeed + campaign.batchSize,
        lastSeed(campaign) + 1 - campaign.batchSize,
      ]) {
        const seeds = Array.from(
          { length: campaign.batchSize },
          (_, offset) => firstSeed + offset
        );
        const recipes = seeds.map((seed) => generateG3Recipe(seed));
        assert.equal(
          recipes.filter((recipe) => recipe.actors === 2).length,
          campaign.batchSize / 5,
          `batch ${firstSeed} does not carry the frozen two-actor quota`
        );
        assert.equal(
          recipes.filter((recipe) => recipe.fault !== "none").length,
          campaign.batchSize / 5,
          `batch ${firstSeed} does not carry the frozen fault quota`
        );
      }
    }
  });

  it("parses every batch boundary of every lane, and only those", () => {
    for (const { batchMode, campaign } of LANES) {
      const boundaries = [
        campaign.firstSeed,
        campaign.firstSeed + campaign.batchSize,
        lastSeed(campaign) + 1 - campaign.batchSize,
      ];
      for (const firstSeed of boundaries)
        assert.equal(
          parseRaptor3Request([batchMode, String(firstSeed)]).firstSeed,
          firstSeed
        );
      assert.throws(
        () =>
          parseRaptor3Request([batchMode, String(lastSeed(campaign) + 1)]),
        /exact frozen boundary/,
        `${batchMode} admits a child one batch past its frozen range`
      );
    }
  });

  it("gives every campaign PARENT a child mode that parses at both ends", () => {
    // The class the follow-up closed is a seed-batch mode registered in the
    // runner's file map and forgotten in its count map. The other half of the
    // same class is a parent whose child mode does not exist at all: the
    // parent's loop would then throw on its first iteration, 250 children in.
    for (const { batchMode, campaign } of LANES) {
      const parent = batchMode.replace(/seed-batch$/, "seeds");
      assert.equal(parseRaptor3Request([parent]).mode, parent);
      for (
        let firstSeed = campaign.firstSeed;
        firstSeed < campaign.firstSeed + campaign.seedCount;
        firstSeed += campaign.batchSize
      )
        assert.equal(
          parseRaptor3Request([batchMode, String(firstSeed)]).firstSeed,
          firstSeed,
          `${parent} would refuse its own child at ${firstSeed}`
        );
    }
  });
});
