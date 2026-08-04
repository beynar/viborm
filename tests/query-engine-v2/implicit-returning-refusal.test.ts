import { MySQL2Driver } from "@drivers/mysql2";
import { TransactionError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import { constructRoutedOperation } from "../../src/query-engine/write-engine/routing";
import { UnsupportedOperationError } from "../../src/query-engine/write-engine/shared";

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
 *  2. The one deliberate `UnsupportedOperationError` (route-inventory category
 *     ii): `skipDuplicates` + `select` on a non-returning driver — a skipped
 *     INSERT would refetch the PRE-EXISTING row and report it as created.
 *
 * Both are decided from capability flags at construction, before any I/O, so no
 * MySQL server is needed.
 */
class BatchOnlyMySQL2Driver extends MySQL2Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

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

function makeEngine(driver: MySQL2Driver = new BatchOnlyMySQL2Driver()) {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

const rows = [
  { id: "g1", code: "c1", name: "Alpha" },
  { id: "g2", code: "c2", name: "Beta" },
];
const select = { id: true, name: true };

describe("implicit returning on a non-returning, batch-only driver", () => {
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
  const engine = () => makeEngine(new MySQL2Driver());

  test("refuses with the V8003 UnsupportedOperationError naming the way out", () => {
    let thrown: Error | undefined;
    try {
      constructRoutedOperation(engine(), schema.gadget, "createMany", {
        data: rows,
        skipDuplicates: true,
        select,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedOperationError);
    expect(thrown?.message).toContain(
      "does not support 'skipDuplicates' on a driver without RETURNING"
    );
    // The message must name BOTH escapes, because both are real.
    expect(thrown?.message).toContain("Drop 'select'");
    expect(thrown?.message).toContain("drop 'skipDuplicates'");
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
