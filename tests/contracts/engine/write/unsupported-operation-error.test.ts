import { createClient } from "@client/client";
import {
  QueryEngineError,
  UnsupportedOperationError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";

import { UnsupportedOperationError as RootExport } from "@src/index";
import { UnsupportedOperationError as EngineReexport } from "@src/query-engine/write-engine/shared";
import { operationFragmentSchema } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * A deliberate execution boundary must not look like an engine crash. A batch-only
 * createMany member cannot write a parent-held target before a skippable root, because
 * a skipped root would strand that earlier target. UnsupportedOperationError carries its
 * diagnostic name and taxonomy code (V8003 UNSUPPORTED_OPERATION, distinct from
 * QueryEngineError's V9001 INTERNAL_ERROR and from FeatureNotSupportedError's
 * V8001 dialect-capability class) and is exported from src/errors and the
 * package root so users can `instanceof` it.
 */
const getFamily = usePGliteSchemaFamily(operationFragmentSchema);

describe("UnsupportedOperationError public surface", () => {
  test("distinct name, diagnostic name, and V8003 code", () => {
    const error = new UnsupportedOperationError("shape boundary");
    expect(error.name).toBe("UnsupportedOperationError");
    expect(UnsupportedOperationError.diagnosticName).toBe(
      "UnsupportedOperationError"
    );
    expect(error.code).toBe(VibORMErrorCode.UNSUPPORTED_OPERATION);
    expect(error.code).toBe("V8003");
    // Serialization carries the honest identity too (trusted-error snapshot).
    expect(error.toJSON()).toMatchObject({
      name: "UnsupportedOperationError",
      code: "V8003",
    });
  });

  test("remains a QueryEngineError (pre-existing instanceof handling keeps working)", () => {
    const error = new UnsupportedOperationError("shape boundary");
    expect(error).toBeInstanceOf(QueryEngineError);
    expect(error).toBeInstanceOf(VibORMError);
  });

  test("one class identity across the errors module, the engine re-export, and the package root", () => {
    expect(EngineReexport).toBe(UnsupportedOperationError);
    expect(RootExport).toBe(UnsupportedOperationError);
  });

  test("a live pre-effect refusal surfaces the class with the V8003 code", async () => {
    const family = getFamily();
    const state = family.client;
    // The batch-only client is a SECOND driver over the same database, so it must
    // name the same Postgres schema the family provisioned; otherwise it would
    // address `public`, where this suite has no tables.
    const client = createClient({
      schema: operationFragmentSchema,
      driver: new BatchOnlyPGliteDriver({
        client: family.database,
        namespace: family.driver.adapter.namespace,
      }),
    });

    let caught: unknown;
    try {
      await client.post.createMany({
        data: [
          {
            id: 1,
            title: "skippable",
            slug: "skippable",
            author: {
              create: { id: 99, name: "must-not-land" },
            },
          },
        ],
        skipDuplicates: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    if (!(caught instanceof UnsupportedOperationError)) throw caught;
    expect(caught.code).toBe("V8003");
    expect(caught.name).toBe("UnsupportedOperationError");
    expect(caught.message).toBe(
      "Driver 'pglite' cannot execute this record series as committed segments because skipping root 'post.create' would leave prior effect 'user.create' committed."
    );
    await expect(state.user.findMany({})).resolves.toEqual([]);
    await expect(state.post.findMany({})).resolves.toEqual([]);
  }, 30_000);
});
