import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { OperationStep } from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { fragmentAtom } from "@tests/fixtures/routed-fragment-atom";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/** The SQL text of a statement step (guard steps carry no statement). */
function sqlOf(step: OperationStep): string {
  if (!("statement" in step)) throw new Error("expected a statement step");
  return step.statement.strings.join("");
}

/**
 * The STATEMENT ORDER of `deleteMany` + `select` on a driver without RETURNING,
 * pinned without a database.
 *
 * On a returning driver the whole operation is one `DELETE … RETURNING`. Without
 * RETURNING the rows have to be read BEFORE they are deleted — after the DELETE
 * there is nothing left to read — so the compiled fragment must be
 * `[read, write]`, and its result must come from that read. A future refactor
 * that reuses the `updateMany` shape (write-then-read, which is correct there
 * because the rows still exist) would silently return `[]` for every delete on
 * MySQL; this test fails instead. The behavioral proof runs on the Docker MySQL
 * leg via the shared driver suite — this is the cheap structural tripwire that
 * does not need it.
 *
 * The planning-only MySQL driver is transaction-capable and non-returning, so
 * the ATOM §7 batch-only refusal does not pre-empt the plan. Any accidental
 * provider dispatch fails.
 */
const gadget = s
  .model({
    id: s.string().id(),
    code: s.string().unique(),
    name: s.string(),
  })
  .map("nonreturning_delete_gadgets");

const schema = { gadget };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

function engine(): QueryEngine {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(
    new PlanningDriver("mysql"),
    createModelRegistry(schema, schemas)
  );
}

describe("deleteMany with select on a non-returning driver", () => {
  test("plans a locked PK capture, then reads BEFORE it deletes", () => {
    const operation = fragmentAtom(
      constructRoutedOperation(engine(), schema.gadget, "deleteMany", {
        where: { name: "Alpha" },
        select: { id: true, name: true },
      }),
      "deleteMany"
    );

    // Planning: exactly one read that locks the target primary keys.
    const planning = operation.planning();
    expect(planning.steps).toHaveLength(1);
    const capture = planning.steps[0]!;
    expect(capture.kind).toBe("read");
    expect(sqlOf(capture)).toContain("FOR UPDATE");

    // Compile against a capture of two rows: read first, delete second.
    const compiled = operation.compile({
      [planningKey(capture.id, "rows")]: [{ id: "g1" }, { id: "g2" }],
    });
    expect(compiled.steps.map((step) => step.kind)).toEqual(["read", "write"]);
    expect(compiled.outputs.result).toMatchObject({
      step: compiled.steps[0]!.id,
      output: "result",
    });
    expect(sqlOf(compiled.steps[1]!)).toContain("DELETE");
  });

  test("an empty capture compiles to no statements and parses to []", () => {
    const operation = fragmentAtom(
      constructRoutedOperation(engine(), schema.gadget, "deleteMany", {
        where: { name: "Nope" },
        select: { id: true },
      }),
      "deleteMany"
    );
    const capture = operation.planning().steps[0]!;

    const compiled = operation.compile({
      [planningKey(capture.id, "rows")]: [],
    });
    expect(compiled.steps).toEqual([]);
    expect(operation.parse(compiled.outputs)).toEqual([]);
  });

  test("without select the same payload is the single-statement count arm", () => {
    const operation = fragmentAtom(
      constructRoutedOperation(engine(), schema.gadget, "deleteMany", {
        where: { name: "Alpha" },
      }),
      "deleteMany"
    );
    expect(operation.planning().steps).toEqual([]);
    const compiled = operation.compile({});
    expect(compiled.steps.map((step) => step.kind)).toEqual(["write"]);
  });
});
