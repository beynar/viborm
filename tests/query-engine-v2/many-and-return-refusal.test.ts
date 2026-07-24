import { MySQL2Driver } from "@drivers/mysql2";
import { PendingOperation } from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import { ManyAndReturnOperation } from "../../src/query-engine-v2/ManyAndReturnOperation";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";

/**
 * A non-returning driver that reports only batch support — the driver class for
 * which V1 refuses `*AndReturn` (public result parsing cannot be rolled back
 * after an atomic batch commits). It never connects: the refusal is decided from
 * capability flags before any I/O, so no MySQL server is needed.
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

// V1 builds SQL (through the model's name registry) before it refuses at execute,
// so the names must be hydrated exactly as a real client would.
beforeAll(() => {
  hydrateSchemaNames(schema);
});

function makeEngine(driver: MySQL2Driver = new BatchOnlyMySQL2Driver()) {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

describe("query-engine-v2 *AndReturn on a non-returning batch-only driver", () => {
  const validArgs = {
    data: [
      { id: "g1", code: "c1", name: "Alpha" },
      { id: "g2", code: "c2", name: "Beta" },
    ],
  };

  test("V2 refuses createManyAndReturn with V1's byte-identical TransactionError", async () => {
    const engine = makeEngine();

    // V1's refusal (no I/O — decided from capability flags in executeProgram).
    const v1Error = await PendingOperation.create(
      engine,
      schema.gadget,
      "createManyAndReturn",
      validArgs
    )
      .execute()
      .then(
        () => {
          throw new Error("V1 did not refuse");
        },
        (error: unknown) => error as Error
      );

    // V2's refusal (thrown at construction, before any I/O).
    let v2Error: Error | undefined;
    try {
      new ManyAndReturnOperation(
        engine,
        schema.gadget,
        "createManyAndReturn",
        validArgs
      );
    } catch (error) {
      v2Error = error as Error;
    }

    expect(v2Error).toBeInstanceOf(Error);
    expect(v2Error?.name).toBe(v1Error.name);
    expect(v2Error?.message).toBe(v1Error.message);
    // The kept-as-contract refusal is NOT an UnsupportedOperationError — it must
    // never be weakened into a route to V1 (ATOM §7).
    expect(v2Error).not.toBeInstanceOf(UnsupportedOperationError);
  });

  test("V2 refuses updateManyAndReturn with V1's byte-identical TransactionError", async () => {
    const engine = makeEngine();
    const args = { where: { name: "x" }, data: { name: "y" } };

    const v1Error = await PendingOperation.create(
      engine,
      schema.gadget,
      "updateManyAndReturn",
      args
    )
      .execute()
      .then(
        () => {
          throw new Error("V1 did not refuse");
        },
        (error: unknown) => error as Error
      );

    let v2Error: Error | undefined;
    try {
      new ManyAndReturnOperation(
        engine,
        schema.gadget,
        "updateManyAndReturn",
        args
      );
    } catch (error) {
      v2Error = error as Error;
    }

    expect(v2Error?.name).toBe(v1Error.name);
    expect(v2Error?.message).toBe(v1Error.message);
  });

  test("createManyAndReturn skipDuplicates on a non-returning driver routes to V1", () => {
    // A skipped INSERT would refetch a pre-existing row, so this shape is not
    // expressible as linear steps: V2 declines it (UnsupportedOperationError),
    // which the per-tree router hands to V1 — an honest route, not the ATOM §7
    // refusal. Uses a transaction-capable non-returning driver so the refusal
    // (batch-only) does not pre-empt the route decision.
    const engine = makeEngine(new MySQL2Driver());
    expect(
      () =>
        new ManyAndReturnOperation(
          engine,
          schema.gadget,
          "createManyAndReturn",
          {
            ...validArgs,
            skipDuplicates: true,
          }
        )
    ).toThrow(UnsupportedOperationError);
  });
});
