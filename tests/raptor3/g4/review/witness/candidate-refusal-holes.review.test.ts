/**
 * Review probe. Claim under attack: witness note §2 records
 * "Q-W05 scalar membership vs list containment" as a witnessed row, and the
 * unit's method states that every refusal is compared on BOTH engines
 * (`expectRefusal` in `witness-world.ts`).
 *
 * `read-filters.test.ts` "Q-W05 keeps scalar membership and list containment
 * distinct" ends with a refusal that is observed on the shipped client only —
 * `observeFailure(() => world.shipped.specimen.findMany({ where: { count: { has: 7 } } }))`
 * — and never puts the same request to the candidate. This probe puts it to the
 * candidate and records what the candidate actually does, so the review can say
 * whether the omission hides a defect.
 */
import assert from "node:assert/strict";
import { DbNull } from "@schema";
import { afterEach, beforeEach, describe, it } from "vitest";
import { codecWorldSchema, SPECIMENS } from "../../codec-schema";
import {
  createWitnessWorld,
  observeFailure,
  type WitnessWorld,
} from "../../witness-world";

describe("review probe: refusals witnessed on one engine only", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(codecWorldSchema());
    for (const specimen of SPECIMENS) {
      await world.shipped.specimen?.create?.({
        data: { ...specimen, document: specimen.document ?? DbNull },
      });
    }
    world.reset();
  });

  afterEach(async () => {
    await world?.close();
  });

  it("records the candidate identity for `has` applied to a scalar column", async () => {
    const args = { where: { count: { has: 7 } } };
    const shipped = await observeFailure(() =>
      Promise.resolve(world.shipped.specimen?.findMany?.(args))
    );
    assert.equal(shipped.name, "ValidationError", shipped.message);
    const candidate = await observeFailure(() =>
      world.candidate.execute("specimen", "findMany", args)
    );
    // Result: the candidate happens to agree today, so the one-engine
    // observation hides no live defect — but nothing in the witness estate
    // would notice if it stopped agreeing.
    assert.equal(
      candidate.constructorName,
      shipped.constructorName,
      `the candidate refusal identity is ${candidate.constructorName} ` +
        `(${candidate.message}) where the shipped engine raises ` +
        `${shipped.constructorName} — the witness never compares them`
    );
    assert.match(candidate.message, /Unknown key: has/);
  });
});
