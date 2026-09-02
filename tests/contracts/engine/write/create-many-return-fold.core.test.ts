import type { AnyDriver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { ManyAndReturnOperation } from "@src/query-engine/write-engine/ManyAndReturnOperation";
import type { OperationStep } from "@src/query-engine/write-engine/OperationFragment";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * PHASE 7.2 — the plan SHAPE of the multi-row `INSERT … RETURNING` fold
 * (query-performance-plan, Decision 7.2).
 *
 * The live traffic is measured on every driver leg by
 * `tests/drivers/create-many-return-fold-behavior.ts`. What is pinned HERE is
 * the compiled fragment, which needs no database: how many write steps the
 * operation allocates, that the returning arm's fragment output is the ordered
 * SOURCE LIST (one entry per statement, concatenating in input order), and that
 * a non-returning driver still plans the interleaved INSERT/refetch pair per
 * input row.
 */

const foldRow = s
  .model({
    id: s.int().id(),
    label: s.string(),
  })
  .map("p72_plan_rows");

const foldAutoRow = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
  })
  .map("p72_plan_auto_rows");

const schema = { foldRow, foldAutoRow };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function sqlOf(step: OperationStep): string {
  if (!("statement" in step)) throw new Error("expected a statement step");
  return step.statement.strings.join("");
}

function compiledCreateManyReturn(
  driver: AnyDriver,
  model: (typeof schema)[keyof typeof schema],
  args: Record<string, unknown>
) {
  const engine = engineFor(driver);
  const operation = new ManyAndReturnOperation(
    engine,
    model,
    "createManyAndReturn",
    args
  );
  // `createManyAndReturn` plans nothing on either capability — its fragment is
  // built statically in the constructor — so `compile({})` is the whole plan.
  return { planning: operation.planning().steps, ...operation.compile({}) };
}

describe("the createMany RETURNING fold — deterministic plan shape", () => {
  test("a returning driver writes FOUR input rows with ONE write step", () => {
    const compiled = compiledCreateManyReturn(
      new PlanningDriver("postgresql"),
      foldRow,
      {
        data: [
          { id: 40, label: "first" },
          { id: 10, label: "second" },
          { id: 30, label: "third" },
          { id: 20, label: "fourth" },
        ],
        select: { id: true, label: true },
      }
    );

    expect(compiled.planning).toEqual([]);
    // ONE write step for four input rows — the fold's whole deliverable.
    expect(compiled.steps.map((step) => step.kind)).toEqual(["write"]);
    const statement = sqlOf(compiled.steps[0]!);
    expect(statement).toContain("INSERT");
    expect(statement).toContain("RETURNING");
    // Four VALUES groups ride ONE statement, so the statement carries every
    // input row's bound values.
    expect(statement.split("), (").length - 1).toBe(3);

    // The output is the ordered source list — here a list of ONE, because one
    // statement answers for the whole input. `resolveOutputList` concatenates
    // its sources' rows, so the operation's rows are this statement's rows, in
    // the order it returned them.
    const output = compiled.outputs.result as unknown as {
      step: string;
      output: string;
    }[];
    expect(output).toEqual([
      {
        kind: expect.anything(),
        step: compiled.steps[0]!.id,
        output: "result",
      },
    ]);
  });

  test("two contiguous shape runs are two write steps, in input-run order", () => {
    const compiled = compiledCreateManyReturn(
      new PlanningDriver("postgresql"),
      foldAutoRow,
      {
        data: [
          { id: 300, label: "explicit-high" },
          { id: 200, label: "explicit-low" },
          { label: "generated-first" },
          { label: "generated-second" },
        ],
        select: { id: true, label: true },
      }
    );

    expect(compiled.planning).toEqual([]);
    expect(compiled.steps.map((step) => step.kind)).toEqual(["write", "write"]);
    const output = compiled.outputs.result as unknown as { step: string }[];
    // The source list is in STATEMENT order, and the statements are in input-run
    // order — that is what makes the concatenation the input order. Reversing
    // either would silently reorder the answer.
    expect(output.map((entry) => entry.step)).toEqual(
      compiled.steps.map((step) => step.id)
    );
  });

  test("a NON-RETURNING driver keeps one INSERT and one refetch per input row", () => {
    // The planning-only MySQL driver is transaction-capable and non-returning.
    // Accidental provider dispatch fails. Byte-for-byte the documented path —
    // the refetch reads the created identity back, so it needs one INSERT to
    // address and nothing here folds.
    const compiled = compiledCreateManyReturn(
      new PlanningDriver("mysql"),
      foldRow,
      {
        data: [
          { id: 40, label: "first" },
          { id: 10, label: "second" },
          { id: 30, label: "third" },
        ],
        select: { id: true, label: true },
      }
    );

    expect(compiled.steps.map((step) => step.kind)).toEqual([
      "write",
      "read",
      "write",
      "read",
      "write",
      "read",
    ]);
    for (const step of compiled.steps) {
      expect(sqlOf(step)).not.toContain("RETURNING");
    }
    expect(sqlOf(compiled.steps[0]!)).toContain("INSERT");
    expect(sqlOf(compiled.steps[1]!)).toContain("SELECT");
    // One source per input row, each the row's own refetch.
    expect(compiled.outputs.result).toHaveLength(3);
  });
});
