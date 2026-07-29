import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import {
  QueryEngineError,
  UnsupportedOperationError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { UnsupportedOperationError as RootExport } from "../../src/index";
import { UnsupportedOperationError as EngineReexport } from "../../src/query-engine-v2/shared";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { manyToManySchema } from "../fixtures/many-to-many-schema";

/**
 * Part B of the M2M generated-PK fix: a DELIBERATE capability boundary must not
 * look like an engine crash. UnsupportedOperationError carries its own
 * diagnostic name and taxonomy code (V8003 UNSUPPORTED_OPERATION, distinct from
 * QueryEngineError's V9001 INTERNAL_ERROR and from FeatureNotSupportedError's
 * V8001 dialect-capability class) and is exported from src/errors and the
 * package root so users can `instanceof` it.
 */
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

  test("a live engine refusal surfaces the class with the V8003 code", () => {
    hydrateSchemaNames(manyToManySchema);
    const schemas = createSchemaRegistry(manyToManySchema);
    const engine = new QueryEngine(
      new PGliteDriver({ client: new PGlite() }),
      createModelRegistry(manyToManySchema, schemas)
    );
    // RETARGETED by N3-U2, which absorbed the specimen this test used to use
    // (upsert-through-junction with a DB-generated create-arm PK — the create data's
    // complete unique now names the row). Its replacement is the M2M generated-key
    // refusal N3-U1 ADDED, in the same family and on the same relation: a
    // `createMany skipDuplicates` whose target primary key is database-generated. A
    // skipped INSERT produces no identity for its join row, and no guard can catch the
    // stale-`insertId` join that results, so it is refused at construction.
    let caught: unknown;
    try {
      new UpdateOperation(engine, manyToManySchema.article, {
        where: { id: 1 },
        data: {
          labels: {
            createMany: { data: [{ name: "x" }], skipDuplicates: true },
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    expect((caught as UnsupportedOperationError).code).toBe("V8003");
    expect((caught as UnsupportedOperationError).name).toBe(
      "UnsupportedOperationError"
    );
  });
});
