import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import {
  QueryEngineError,
  UnsupportedOperationError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { UnsupportedOperationError as RootExport } from "@src/index";
import { UnsupportedOperationError as EngineReexport } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";

/**
 * The live-refusal specimen, inline because it is about a SHAPE and never touches a
 * database: a junction target with a DB-generated primary key and TWO nameable uniques,
 * both spelled by the row. E6.8 re-proved that this one has no probe (see
 * `junction-skip-adoption-behavior.ts` for the wrong-row decoy that says why).
 */
const refusalSpecimenSchema = (() => {
  const shelf = s
    .model({
      id: s.string().id(),
      books: s.manyToMany(() => book).through("uoe_book_shelf"),
    })
    .map("uoe_shelves");
  const book = s
    .model({
      id: s.int().id().increment(),
      isbn: s.string().unique(),
      code: s.string().unique(),
      title: s.string(),
      shelves: s.manyToMany(() => shelf).through("uoe_book_shelf"),
    })
    .map("uoe_books");
  return { shelf, book };
})();

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
    hydrateSchemaNames(refusalSpecimenSchema);
    const schemas = createSchemaRegistry(refusalSpecimenSchema);
    const engine = new QueryEngine(
      new PGliteDriver({ client: new PGlite() }),
      createModelRegistry(refusalSpecimenSchema, schemas)
    );
    // RETARGETED TWICE, each time because the previous specimen was absorbed.
    //  - N3-U2 absorbed the first (upsert-through-junction with a DB-generated
    //    create-arm PK — the create data's complete unique now names the row).
    //  - E6.8 absorbed most of the second (`createMany skipDuplicates` on a
    //    generated-key target): a row spelling exactly ONE nameable unique is now a
    //    `connectOrCreate` adopt, and a target with nothing to conflict on drops the flag.
    // What SURVIVES that refusal — and is the specimen now — is the sub-shape whose
    // impossibility E6.8 re-proved: a row spelling TWO complete uniques. The probe would
    // have to name the row a constraint fires on, and either unique can be the one that
    // fires, so no single probe names it. Refused at construction, before any effect.
    let caught: unknown;
    try {
      new UpdateOperation(engine, refusalSpecimenSchema.shelf, {
        where: { id: "s1" },
        data: {
          books: {
            createMany: {
              data: [{ isbn: "i1", code: "c1", title: "t" }],
              skipDuplicates: true,
            },
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
