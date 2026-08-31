import type { AnyDriver } from "@drivers";
import { TransactionError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";

/**
 * The two refusals the implicit-returning surface inherits, both scoped to
 * ASKING FOR THE ROWS BACK. The same payload without `select` is the ordinary
 * `{ count }` bulk write and must keep working on the very same driver — that
 * asymmetry is the whole content of these tests, and it is what makes the
 * refusals honest rather than a capability regression.
 *
 *  1. ATOM §7 (kept as contract): a NON-returning driver in a forced atomic
 *     batch cannot resolve the returned rows, because public result parsing
 *     happens after the batch commits and cannot be rolled back. Typed
 *     `TransactionError`, never weakened into a silent divergence.
 *  2. The one deliberate `UnsupportedOperationError` (operation-construction-inventory category
 *     ii): `skipDuplicates` + `select` on a non-returning driver — a skipped
 *     INSERT would refetch the PRE-EXISTING row and report it as created.
 *
 * Both are decided from capability flags at construction, before any I/O, so no
 * MySQL server is needed.
 */
const gadget = s
  .model({
    id: s.string().id(),
    code: s.string().unique(),
    name: s.string(),
  })
  .map("refusal_gadgets");

const schema = { gadget };

// SQL is built (through the model's name registry) before the route decision, so
// the names must be hydrated exactly as a real client would.
beforeAll(() => {
  hydrateSchemaNames(schema);
});

function batchOnlyMySQL(): PlanningDriver {
  return new PlanningDriver("mysql", {
    driverName: "mysql2",
    supportsTransactions: false,
    supportsBatch: true,
  });
}

function makeEngine(driver: AnyDriver = batchOnlyMySQL()) {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

const rows = [
  { id: "g1", code: "c1", name: "Alpha" },
  { id: "g2", code: "c2", name: "Beta" },
];
const select = { id: true, name: true };

describe("implicit returning on a deterministic non-returning batch driver", () => {
  test("createMany with select refuses with a typed TransactionError", () => {
    const engine = makeEngine();
    let thrown: Error | undefined;
    try {
      constructRoutedOperation(engine, schema.gadget, "createMany", {
        data: rows,
        select,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(TransactionError);
    expect(thrown?.message).toBe(
      "Driver 'mysql2' cannot execute 'createMany' with 'select' because public result parsing cannot be rolled back."
    );
    // The kept-as-contract refusal is NOT an UnsupportedOperationError — it must
    // never be weakened into a route or a silent divergence (ATOM §7).
    expect(thrown).not.toBeInstanceOf(UnsupportedOperationError);
  });

  test("updateMany with select refuses with a typed TransactionError", () => {
    const engine = makeEngine();
    let thrown: Error | undefined;
    try {
      constructRoutedOperation(engine, schema.gadget, "updateMany", {
        where: { name: "x" },
        data: { name: "y" },
        select,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(TransactionError);
    expect(thrown?.message).toBe(
      "Driver 'mysql2' cannot execute 'updateMany' with 'select' because public result parsing cannot be rolled back."
    );
  });

  test("the same payloads WITHOUT select construct fine ({ count } arm)", () => {
    // The refusal is scoped to the rows, not to the family: dropping `select`
    // must leave a working bulk write on the identical driver.
    const engine = makeEngine();
    expect(
      constructRoutedOperation(engine, schema.gadget, "createMany", {
        data: rows,
      })
    ).toBeDefined();
    expect(
      constructRoutedOperation(engine, schema.gadget, "updateMany", {
        where: { name: "x" },
        data: { name: "y" },
      })
    ).toBeDefined();
  });
});

describe("createMany skipDuplicates + select on a non-returning driver", () => {
  // A transaction-capable non-returning driver, so the ATOM §7 batch refusal
  // above does not pre-empt this decision.
  const engine = () =>
    makeEngine(new PlanningDriver("mysql", { driverName: "mysql2" }));

  test("constructs, as a per-row capture (E6.9)", () => {
    // RETARGETED from a refusal to an accept-and-construct assertion on the SAME payload.
    // U-E6.9, maintainer-authorized (expressible-shapes-plan.md, Risks item 3): the shape
    // is not inexpressible, only unfoldable — the writes have to be OBSERVED. The
    // operation now carries one skippable INSERT per input row in its capture fragment and
    // refetches the rows that were not skipped; behavior on the live server is in
    // `skip-select-capture-docker.test.ts` (MySQL) with a PGlite RETURNING control.
    //
    // This file's remaining claim is the STRUCTURE, which no behavior test can see: the
    // operation is transaction-mode and its capture is exactly one step per input row.
    const operation = constructRoutedOperation(
      engine(),
      schema.gadget,
      "createMany",
      { data: rows, skipDuplicates: true, select }
    ) as { mode: string; planning(): { steps: readonly unknown[] } };
    expect(operation.mode).toBe("transaction");
    expect(operation.planning().steps).toHaveLength(rows.length);
  });

  test("skipDuplicates WITHOUT select is fully supported on the same driver", () => {
    expect(
      constructRoutedOperation(engine(), schema.gadget, "createMany", {
        data: rows,
        skipDuplicates: true,
      })
    ).toBeDefined();
  });
});
