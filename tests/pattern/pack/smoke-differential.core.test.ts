/**
 * The first compile-level differential (pattern-engine-ideal-state.md §12.1,
 * §13.5 M1): the K4 smoke payload, hand-written as a Pattern, scheduled and
 * packed, against today's engine's dump — step by step, on both substrates.
 *
 * Every difference is classified (order / byte / guard-shape / untaken-arm
 * read) and printed before the assertion, so a red run reports the four
 * numbers the slice owes rather than a wall of JSON.
 */
import { StepIds } from "@src/query-engine/pattern/ids";
import { pack } from "@src/query-engine/pattern/pack";
import { schedule } from "@src/query-engine/pattern/schedule";
import {
  dumpOperation,
  engineFor,
  oracleFor,
  planningDriver,
  type Substrate,
  synthesizeKnown,
} from "@tests/pattern/harness/dump";
import { models, schema, smokeArgs } from "@tests/pattern/schedule/schema";
import { describe, expect, test } from "vitest";
import {
  diffSteps,
  dumpProgram,
  dumpStep,
  type StepDifference,
} from "./program-dump";
import { smokePattern } from "./smoke-pattern";

function report(differences: readonly StepDifference[]): string {
  const counts = new Map<string, number>();
  for (const difference of differences) {
    counts.set(difference.kind, (counts.get(difference.kind) ?? 0) + 1);
  }
  const summary = [
    "order mismatch",
    "byte special case",
    "guard-shape special case",
    "untaken-arm read difference",
  ]
    .map((kind) => `${kind}: ${counts.get(kind) ?? 0}`)
    .join(", ");
  const lines = differences.map(
    (d) => `  [${d.phase} #${d.position} ${d.id}] ${d.kind}: ${d.detail}`
  );
  return [summary, ...lines].join("\n");
}

function packSmoke(substrate: Substrate) {
  const driver = planningDriver("postgresql", substrate);
  const engine = engineFor(models, driver);
  const pattern = smokePattern();
  const scheduled = schedule(pattern, {
    bindsGeneratedKey: "returning",
    supportsTransactions: substrate === "transaction",
  });
  // Pass one: the match phase (no known yet) — what the executor would run
  // first. Pass two: the writes, with the match rows the harness synthesizes.
  const planned = pack(scheduled, engine, new StepIds());
  const known = synthesizeKnown(
    oracleFor(models, "postgresql", substrate),
    { steps: planned.fragments.flatMap((fragment) => fragment.matches.flat()) },
    "found"
  );
  const program = pack(scheduled, engine, new StepIds(), known);
  return { driver, engine, scheduled, program, planned, known };
}

describe("compile-level differential: K4 smoke payload", () => {
  test.each([
    "transaction",
    "batch",
  ] as const)("post.update with author connect and tags connect on %s", (substrate) => {
    const oracle = dumpOperation(
      models,
      schema.post,
      "post",
      "update",
      smokeArgs,
      "postgresql",
      substrate,
      "found"
    );
    expect(oracle.error).toBeUndefined();
    const { driver, program } = packSmoke(substrate);
    const mine = dumpProgram(driver, program);
    const differences = [
      ...diffSteps("planning", oracle.planning, mine.planning),
      ...diffSteps("final", oracle.final, mine.final),
    ];
    // eslint-disable-next-line no-console
    console.log(
      `${substrate}: planning ${oracle.planning.length}/${mine.planning.length}, final ${oracle.final.length}/${mine.final.length}\n${report(differences)}`
    );
    expect(differences).toEqual([]);
    expect(mine.outputs).toEqual(oracle.outputs);
  });

  test.each([
    "transaction",
    "batch",
  ] as const)("a missing connect target is refused with today's error on %s", (substrate) => {
    const oracle = dumpOperation(
      models,
      schema.post,
      "post",
      "update",
      smokeArgs,
      "postgresql",
      substrate,
      "missing"
    );
    const driver = planningDriver("postgresql", substrate);
    const engine = engineFor(models, driver);
    const scheduled = schedule(smokePattern(), {
      bindsGeneratedKey: "returning",
      supportsTransactions: substrate === "transaction",
    });
    const planned = pack(scheduled, engine, new StepIds());
    const known = synthesizeKnown(
      oracleFor(models, "postgresql", substrate),
      { steps: planned.fragments.flatMap((f) => f.matches.flat()) },
      "missing"
    );
    let caught: { name?: string; message?: string; code?: unknown } | undefined;
    try {
      pack(scheduled, engine, new StepIds(), known);
    } catch (error) {
      caught = error as typeof caught;
    }
    expect(caught).toBeDefined();
    expect({
      name: caught?.name,
      message: caught?.message,
      code: caught?.code,
    }).toEqual(oracle.error);
  });

  test.each([
    "transaction",
    "batch",
  ] as const)("Fragment.pack re-packs the taken arm to the same steps as the two-pass on %s", (substrate) => {
    const { driver, program, planned, known } = packSmoke(substrate);
    const fragment = planned.fragments[0]!;
    expect(fragment.pack).toBeDefined();
    const repacked = fragment.pack!(known);
    const expected = program.fragments[0]!;
    const dumpAll = (steps: readonly (typeof expected.writes)[number][]) =>
      steps.map((step, index) => dumpStep(driver, step, index));
    expect(dumpAll(repacked.writes)).toEqual(dumpAll(expected.writes));
    expect(
      repacked.premises.map((p) => [
        p.premise,
        p.match.id,
        p.guard?.id,
        p.failure,
      ])
    ).toEqual(
      expected.premises.map((p) => [
        p.premise,
        p.match.id,
        p.guard?.id,
        p.failure,
      ])
    );
  });

  test("the schedule states one premise per decision match, bound to its guard on batch", () => {
    const { program: batch } = packSmoke("batch");
    const { program: transaction } = packSmoke("transaction");
    const premises = batch.fragments[0]!.premises;
    expect(
      premises.map((p) => [p.premise.kind, p.match.id, p.guard?.id])
    ).toEqual([
      ["exists", "post.locate", "post.guard.exists"],
      ["exists", "user.find", "user.guard.exists"],
      ["exists", "tag.find", "tag.guard.exists"],
      ["exists", "tag.find#1", "tag.guard.exists#1"],
    ]);
    expect(
      transaction.fragments[0]!.premises.every((p) => p.guard === undefined)
    ).toBe(true);
    expect(batch.fragments[0]!.boundary).toEqual({ kind: "end" });
  });
});
