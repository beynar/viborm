import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { serializeModels } from "@migrations/serializer";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { validateSchema } from "@schema/validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * A polymorphic collection, END TO END: DECLARABLE, MIGRATABLE, READABLE and —
 * since Package E — WRITABLE on every surface, with no boundary left.
 *
 * Until B3 a blanket P014 refusal made every collection schema unconstructible
 * — `createClient` threw, and no DDL existed for the declaration anyway. B3
 * deleted P014 because the DDL now exists (one member junction table per
 * variant) and moved the "you cannot use this yet" refusal to the grammar owner.
 * Package C made the reads real; Package D made `create` and `update` real; and
 * Package E takes the last one, the ROOT-`createMany` ROW, by making the row
 * relation-BEARING and routing the whole call to the record series.
 *
 * These pins walk the four §2.2 topology cells through the WHOLE pipeline —
 * validation, client construction, DDL — and then check where the boundary sits
 * NOW. The cells' validation cleanliness is also pinned in isolation in
 * `tests/unit/schema-validation/polymorphic-rules.core.test.ts`; what is pinned
 * here is that they survive the client gate, produce tables, and accept the
 * write families through the public surface.
 */

/**
 * A GRAMMAR refusal, as opposed to anything the engine may say once the payload
 * gets through. Distinguishing the two is the whole point of the flipped rows:
 * a nested-write error naming `items.post` proves the family is REAL (the
 * variant-qualified carrier name only exists downstream of the parse), while a
 * `v.refused` message proves it is not.
 */
const COLLECTION_WRITE_REFUSED = /is not writable/;

class NoopDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  /** Every SQL string the engine handed the driver, in dispatch order. */
  readonly statements: string[] = [];

  constructor() {
    super("postgresql", "polymorphic-collection-client");
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // No provider resource is held.
  }

  protected async execute<T>(
    _client: null,
    sql: string
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql);
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    _client: null,
    sql: string
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql);
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

/** CELL 1 — the plainest collection: one variant, no inverse declared. */
function cellBare() {
  const post = s.model({ id: s.string().id() });
  const owner = s.model({
    id: s.string().id(),
    items: s.polymorphicToMany(
      { post: () => post },
      { values: { post: "c1.post.v1" } }
    ),
  });
  return {
    schema: { post, owner },
    tables: ["owner_items_post"],
    // P011 is the PRE-EXISTING single-variant advisory ("use an ordinary
    // relation unless future variants are required") — a warning, unrelated to
    // cardinality, and it fires identically on a one-variant to-one carrier.
    warnings: ["P011"],
  };
}

/** CELL 2 — several variants, no inverses. */
function cellMultiVariant() {
  const post = s.model({ id: s.string().id() });
  const video = s.model({ id: s.string().id() });
  const owner = s.model({
    id: s.string().id(),
    items: s.polymorphicToMany(
      { post: () => post, video: () => video },
      { values: { post: "c2.post.v1", video: "c2.video.v1" } }
    ),
  });
  return {
    schema: { post, video, owner },
    tables: ["owner_items_post", "owner_items_video"],
    warnings: [],
  };
}

/** CELL 3 — mixed inverses: one singular, one plural, one unbound. */
function cellMixedInverses() {
  const book = s.model({
    id: s.string().id(),
    shelf: s.manyToOne(() => shelf).optional(),
  });
  const video = s.model({
    id: s.string().id(),
    shelves: s.manyToMany(() => shelf),
  });
  const note = s.model({ id: s.string().id() });
  const shelf = s.model({
    id: s.string().id(),
    items: s.polymorphicToMany(
      { book: () => book, video: () => video, note: () => note },
      {
        values: {
          book: "c3.book.v1",
          video: "c3.video.v1",
          note: "c3.note.v1",
        },
      }
    ),
  });
  return {
    schema: { book, video, note, shelf },
    tables: ["shelf_items_book", "shelf_items_video", "shelf_items_note"],
    warnings: [],
  };
}

/** CELL 4 — compound owner key plus an explicit `.through()` mapping. */
function cellCompoundThrough() {
  const post = s.model({ id: s.string().id() });
  const owner = s
    .model({
      tenantId: s.string(),
      localId: s.string(),
      items: s
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "c4.post.v1" } }
        )
        .through({
          post: { table: "owner_catalog", source: "holder", target: "entry" },
        }),
    })
    .id(["tenantId", "localId"]);
  // Single-variant, so it carries the same P011 advisory as cell 1.
  return {
    schema: { post, owner },
    tables: ["owner_catalog"],
    warnings: ["P011"],
  };
}

const cells = [
  ["bare single variant", cellBare],
  ["multiple variants", cellMultiVariant],
  ["mixed singular/plural/unbound inverses", cellMixedInverses],
  ["compound owner key with .through()", cellCompoundThrough],
] as const;

describe("collection topology cells are declarable end to end", () => {
  test.each(cells)("%s validates clean", (_label, build) => {
    const { schema, warnings } = build();
    hydrateSchemaNames(schema);
    const result = validateSchema(schema);
    // ZERO errors is the B3 claim. The only warnings admitted are the
    // pre-existing single-variant advisory each cell declares for itself.
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((entry) => entry.code)).toEqual(warnings);
  });

  test.each(cells)("%s survives the client gate", (_label, build) => {
    const { schema } = build();
    // `validateClientSchemaOrThrow` runs the FULL graph validation for any
    // schema carrying a polymorphic relation, so this is the exact call P014
    // used to fail. Constructing at all is the assertion.
    expect(() =>
      createClient({ schema, driver: new NoopDriver() })
    ).not.toThrow();
  });

  test.each(cells)("%s emits its member junction tables", (_label, build) => {
    const { schema, tables } = build();
    hydrateSchemaNames(schema);
    // Validation is what MATERIALIZES the stored member topology the serializer
    // reads; without it the descriptor is absent and no member table emits.
    // `generate()` itself never validates — it serializes `client.$schema`
    // directly — but the CLIENT validated at construction
    // (`validateClientSchemaOrThrow`, pinned by the gate test above), so by the
    // time any migration path serializes, the descriptors exist. Running
    // validation here reproduces that ordering rather than inventing one.
    expect(validateSchema(schema).errors).toEqual([]);
    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const modelTables = new Set(Object.keys(schema));
    const emitted = snapshot.tables
      .map((table) => table.name)
      .filter((name) => !modelTables.has(name));
    expect(emitted).toEqual(tables);
  });
});

describe("a declared collection reads and writes; only the bulk ROW stays refused", () => {
  // Reached through the PUBLIC client, which is the surface a user actually
  // touches. The driver answers zero rows, so what these rows measure is that
  // the payload PARSES and COMPILES to SQL — the boundary, not the data.
  //
  // Built lazily, not at module scope: if the schema ever stopped constructing,
  // a module-scope `createClient` would fail COLLECTION and this file would
  // report "no tests" instead of a named failure.
  let client: ReturnType<typeof buildClient>["client"];
  let driver: NoopDriver;
  function buildClient() {
    const { schema } = cellBare();
    const noop = new NoopDriver();
    return { client: createClient({ schema, driver: noop }), driver: noop };
  }
  beforeAll(() => {
    const built = buildClient();
    client = built.client;
    driver = built.driver;
  });

  test.each([
    [
      "findMany where",
      () =>
        client.owner.findMany({
          where: { items: { some: { type: "post", is: { id: "p1" } } } },
        }),
    ],
    [
      "findMany select",
      () => client.owner.findMany({ select: { items: true } }),
    ],
    [
      "findMany include with an allow-list",
      () => client.owner.findMany({ include: { items: { only: ["post"] } } }),
    ],
    [
      "findMany include with an arm projection",
      () =>
        client.owner.findMany({
          include: { items: { variants: { post: { take: 2 } } } },
        }),
    ],
    [
      "findMany orderBy on the collection count",
      () => client.owner.findMany({ orderBy: { items: { _count: "desc" } } }),
    ],
    [
      "findMany _count of the collection",
      () => client.owner.findMany({ select: { _count: true } }),
    ],
  ])("%s reads", async (_label, run) => {
    await expect(run()).resolves.toEqual([]);
  });

  /**
   * Whatever the call did — resolved or threw — rendered as a string.
   *
   * The claim these rows measure is about the GRAMMAR, and a grammar refusal is
   * observable either way: if the key were still refused the promise would
   * reject naming it. Asserting `.rejects` instead would make the pin depend on
   * whether a driver that answers zero rows can complete a write, which is a
   * different question and not this file's.
   */
  const outcomeOf = async (run: () => PromiseLike<unknown>): Promise<string> =>
    await run().then(
      () => "",
      (error: unknown) => String(error)
    );

  // THE WRITE HALF, PACKAGE D. Three of the four families are real now, so
  // three `@ts-expect-error` suppressions had to die IN THE SAME CHANGE as the
  // runtime flip: an unused directive is itself a build error, which is what
  // makes the suppression INVERTED-LOAD-BEARING rather than decorative.
  //
  // The payloads are the TAGGED spelling (`{ type, where }` / `{ type, data }`),
  // because a pin whose payload no longer compiles measures nothing — the B3
  // rows spelled `{ post: { id } }`, which this grammar never accepted.
  test.each([
    [
      "create data",
      () =>
        client.owner.create({
          data: {
            id: "o1",
            items: { create: [{ type: "post", data: { id: "p1" } }] },
          },
        }),
    ],
    [
      "update data",
      () =>
        client.owner.update({
          where: { id: "o1" },
          data: { items: { set: [] } },
        }),
    ],
    [
      "upsert create half",
      () =>
        client.owner.upsert({
          where: { id: "o1" },
          create: {
            id: "o1",
            items: { connect: [{ type: "post", where: { id: "p1" } }] },
          },
          update: {},
        }),
    ],
  ])("%s no longer refuses the collection key", async (_label, run) => {
    expect(await outcomeOf(run)).not.toMatch(COLLECTION_WRITE_REFUSED);
  });

  test("a collection create reaches the member junction table in SQL", async () => {
    driver.statements.length = 0;
    await outcomeOf(() =>
      client.owner.create({
        data: {
          id: "o1",
          items: { create: [{ type: "post", data: { id: "p1" } }] },
        },
      })
    );
    // The whole point of the family: the payload does not merely parse, it
    // lowers to a membership INSERT on the per-variant member table.
    expect(driver.statements.join("\n")).toContain("owner_items_post");
  });

  // THE LAST SURVIVOR, FLIPPED (Package E). `createMany`'s ROW context mounts the
  // same collection family the other three do, and the fourth `@ts-expect-error`
  // died in the same change as the runtime flip — same inverted-load-bearing
  // discipline: an unused directive is itself a build error.
  //
  // The payload is the TAGGED spelling, because the B3-era `{ post: { id } }`
  // this row used to carry was never valid in this grammar; a pin whose payload
  // does not compile measures nothing.
  test("createMany rows no longer refuse the collection key", async () => {
    const outcome = await outcomeOf(() =>
      client.owner.createMany({
        data: [
          {
            id: "o1",
            items: { connect: [{ type: "post", where: { id: "p1" } }] },
          },
        ],
      })
    );
    expect(outcome).not.toMatch(COLLECTION_WRITE_REFUSED);
  });

  test("a collection createMany row routes to the record series and reaches the member table", async () => {
    driver.statements.length = 0;
    await outcomeOf(() =>
      client.owner.createMany({
        data: [
          {
            id: "o1",
            items: { create: [{ type: "post", data: { id: "p1" } }] },
          },
        ],
      })
    );
    // The route, not just the grammar: a grouped bulk INSERT has no member
    // statement at all, so the member table name appearing here is what proves
    // `relationBearingRow` sent the whole call to the record series.
    expect(driver.statements.join("\n")).toContain("owner_items_post");
  });
});
