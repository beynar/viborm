import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError, UnsupportedOperationError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import type { CommittedBatchNotification } from "@src/drivers/types";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import {
  type ExecutableOperation,
  OperationExecutor,
} from "@src/query-engine/write-engine/OperationExecutor";
import {
  type OperationFragment,
  type PlanningFragment,
  ref,
} from "@src/query-engine/write-engine/OperationFragment";
import { createDataUniqueWhere } from "@src/query-engine/write-engine/shared";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const pluralPublicationSchema = (() => {
  const twin = s
    .model({
      a: s.int().increment(),
      b: s.int().increment(),
      serial: s.int().unique().increment(),
      label: s.string().unique(),
      children: s.toMany(() => child),
      serialChildren: s.toMany(() => serialChild),
    })
    .id(["a", "b"])
    .map("residual_plural_twins");
  const child = s
    .model({
      id: s.string().id(),
      twinA: s.int(),
      twinB: s.int(),
      twin: s
        .toOne(() => twin)
        .fields("twinA", "twinB")
        .references("a", "b"),
    })
    .map("residual_plural_children");
  const serialChild = s
    .model({
      id: s.string().id(),
      twinSerial: s.int(),
      twin: s
        .toOne(() => twin)
        .fields("twinSerial")
        .references("serial"),
    })
    .map("residual_plural_serial_children");
  const compoundTwin = s
    .model({
      a: s.int().increment(),
      b: s.int().increment(),
      tenant: s.string().map("tenant_key"),
      slug: s.string().map("slug_key"),
      label: s.string(),
      children: s.toMany(() => compoundChild),
    })
    .id(["a", "b"])
    .unique(["tenant", "slug"], { name: "tenantSlug" })
    .map("residual_compound_locator_twins");
  const compoundChild = s
    .model({
      id: s.string().id(),
      twinA: s.int(),
      twinB: s.int(),
      twin: s
        .toOne(() => compoundTwin)
        .fields("twinA", "twinB")
        .references("a", "b"),
    })
    .map("residual_compound_locator_children");
  return { child, compoundChild, compoundTwin, serialChild, twin };
})();

const pluralUnnameableSchema = {
  twin: s
    .model({
      a: s.int().increment(),
      b: s.int().increment(),
      label: s.string(),
    })
    .id(["a", "b"])
    .index(["label"], {
      name: "residual_unnameable_label_uq",
      unique: true,
    })
    .map("residual_unnameable_plural_twins"),
};

const defaultLocatorSchema = {
  twin: s
    .model({
      a: s.int().increment(),
      b: s.int().increment(),
      label: s.string().default("materialized default"),
    })
    .id(["a", "b"])
    .unique(["label"])
    .map("residual_default_locator_twins"),
};

const selectedNullSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      code: s.string().nullable().unique(),
      // A to-ONE: `profile.accountCode` is that row's primary key, so the stored
      // reference is unique and a remote collection would contradict it (FK009).
      profile: s.toOne(() => profile),
    })
    .map("residual_null_accounts");
  const profile = s
    .model({
      accountCode: s.string().id(),
      label: s.string(),
      account: s
        .toOne(() => account)
        .fields("accountCode")
        .references("code"),
    })
    .map("residual_null_profiles");
  return { account, profile };
})();

hydrateSchemaNames(pluralPublicationSchema);
hydrateSchemaNames(pluralUnnameableSchema);
hydrateSchemaNames(defaultLocatorSchema);
hydrateSchemaNames(selectedNullSchema);

function engineFor<S extends Schema>(
  driver: AnyDriver,
  schema: S
): QueryEngine {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

function captureThrown(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function captureRejected(action: PromiseLike<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

class ReturningControlPGliteDriver extends PGliteDriver {
  constructor(returning: boolean) {
    super();
    this.adapter.capabilities.supportsReturning = returning;
    // Keep the relation projection off the mutation-CTE fast path so the INSERT's
    // field-keyed publication remains visible in the compiled fragment.
    this.adapter.capabilities.supportsCteWithMutations = false;
  }
}

class BeforeAtomicBatchNonReturningPGliteDriver extends BatchOnlyPGliteDriver {
  override readonly supportsOrderedCommittedSegments = true;
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(database: PGlite, beforeBatch: () => Promise<void>) {
    super({ client: database });
    this.adapter.capabilities.supportsReturning = false;
    this.adapter.capabilities.supportsCteWithMutations = false;
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
    }
    const results = await super.executeBatch<T>(client, queries);
    await committed?.();
    return results;
  }
}

describe("residual refusal falsifiers", () => {
  const pluralFamily = usePGliteSchemaFamily(pluralPublicationSchema);

  test("the locator owner admits only complete explicit addressable uniques", () => {
    expect(
      createDataUniqueWhere(
        pluralPublicationSchema.compoundTwin,
        { tenant: "eu", slug: "exact" },
        new Set(["tenant", "slug"])
      )
    ).toEqual({ tenantSlug: { tenant: "eu", slug: "exact" } });
    expect(
      createDataUniqueWhere(
        pluralPublicationSchema.compoundTwin,
        { tenant: "defaulted", slug: "exact" },
        new Set(["slug"])
      )
    ).toBeUndefined();
    expect(
      createDataUniqueWhere(
        pluralPublicationSchema.compoundTwin,
        { tenant: null, slug: "exact" },
        new Set(["tenant", "slug"])
      )
    ).toBeUndefined();
    expect(
      createDataUniqueWhere(
        pluralPublicationSchema.compoundTwin,
        { tenant: sql`upper(${"eu"})`, slug: "exact" },
        new Set(["tenant", "slug"])
      )
    ).toBeUndefined();
    expect(
      createDataUniqueWhere(
        pluralUnnameableSchema.twin,
        { label: "raw-index only" },
        new Set(["label"])
      )
    ).toBeUndefined();
  });

  test("an explicit alternate unique publishes plural generated keys", async () => {
    const { client, driver } = pluralFamily();
    driver.adapter.capabilities.supportsReturning = false;
    try {
      const created = await client.twin.create({
        data: {
          label: "stable locator",
          children: { create: { id: "exact child" } },
        },
        include: { children: true },
      });

      expect(created).toEqual({
        a: 1,
        b: 1,
        serial: 1,
        label: "stable locator",
        children: [{ id: "exact child", twinA: 1, twinB: 1 }],
      });
      expect(await client.child.findMany()).toEqual([
        { id: "exact child", twinA: 1, twinB: 1 },
      ]);
    } finally {
      driver.adapter.capabilities.supportsReturning = true;
    }
  });

  test("the alternate locator publishes a demanded generated non-key field", async () => {
    const { client, driver } = pluralFamily();
    driver.adapter.capabilities.supportsReturning = false;
    try {
      const created = await client.twin.create({
        data: {
          label: "non-key publication",
          serialChildren: { create: { id: "serial child" } },
        },
        include: { serialChildren: true },
      });

      expect(created).toEqual({
        a: 1,
        b: 1,
        serial: 1,
        label: "non-key publication",
        serialChildren: [{ id: "serial child", twinSerial: 1 }],
      });
      expect(await client.serialChild.findMany()).toEqual([
        { id: "serial child", twinSerial: 1 },
      ]);

      const operation = new CreateOperation(
        engineFor(
          new ReturningControlPGliteDriver(false),
          pluralPublicationSchema
        ),
        pluralPublicationSchema.twin,
        {
          data: {
            label: "structural locator",
            serialChildren: { create: { id: "structural child" } },
          },
          include: { serialChildren: true },
        }
      );
      const fragment = operation.compile({});
      const producedRead = fragment.steps.find((step) =>
        step.id.includes(".produced")
      );
      if (!producedRead || producedRead.kind !== "read") {
        throw new Error("Expected one focused produced-value read.");
      }
      expect(Object.keys(producedRead.outputs).sort()).toEqual([
        "produced:a",
        "produced:b",
        "produced:serial",
      ]);
    } finally {
      driver.adapter.capabilities.supportsReturning = true;
    }
  });

  test("site 19 keeps the exact refusal when no stable locator exists", () => {
    const operation = new CreateOperation(
      engineFor(
        new ReturningControlPGliteDriver(false),
        pluralUnnameableSchema
      ),
      pluralUnnameableSchema.twin,
      {
        data: { label: "two generated members" },
      }
    );

    const error = captureThrown(() => operation.compile({}));
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    if (!(error instanceof UnsupportedOperationError)) throw error;
    expect(error.message).toBe(
      "query-engine-v2 create cannot publish the database-produced field 'a' of 'twin' without RETURNING: no complete stable selector exists until every database-assigned row-key member has been published."
    );
  });

  test("a materialized unique default is not an explicit post-write locator", () => {
    for (const data of [{}, { label: undefined }]) {
      const operation = new CreateOperation(
        engineFor(
          new ReturningControlPGliteDriver(false),
          defaultLocatorSchema
        ),
        defaultLocatorSchema.twin,
        { data }
      );

      const error = captureThrown(() => operation.compile({}));
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      if (!(error instanceof UnsupportedOperationError)) throw error;
      expect(error.message).toContain("no complete stable selector exists");
    }
  });

  test("site 19 preserves a mapped compound alternate locator", async () => {
    const { client, driver } = pluralFamily();
    driver.adapter.capabilities.supportsReturning = false;
    try {
      const created = await client.compoundTwin.create({
        data: {
          tenant: "eu",
          slug: "mapped",
          label: "compound locator",
          children: { create: { id: "compound child" } },
        },
        include: { children: true },
      });

      expect(created).toEqual({
        a: 1,
        b: 1,
        tenant: "eu",
        slug: "mapped",
        label: "compound locator",
        children: [{ id: "compound child", twinA: 1, twinB: 1 }],
      });
    } finally {
      driver.adapter.capabilities.supportsReturning = true;
    }
  });

  test("a concurrent alternate-unique occupant fails instead of redirecting the focused read", async () => {
    const family = pluralFamily();
    let injected = false;
    const driver = new BeforeAtomicBatchNonReturningPGliteDriver(
      family.database,
      async () => {
        injected = true;
        await family.client.twin.create({
          data: { label: "concurrent occupant" },
        });
      }
    );
    const client = createClient({ schema: pluralPublicationSchema, driver });

    const failure = await captureRejected(
      client.twin.create({
        data: {
          label: "concurrent occupant",
          children: { create: { id: "must not redirect" } },
        },
      })
    );

    expect(injected).toBe(true);
    expect(failure).toBeInstanceOf(UniqueConstraintError);
    expect(failure).toMatchObject({
      meta: { constraint: "residual_plural_twins_label_key" },
    });
    expect(await family.client.child.count()).toBe(0);
    await expect(family.client.twin.findMany()).resolves.toEqual([
      expect.objectContaining({ label: "concurrent occupant" }),
    ]);
  });

  test("site 19 control publishes both compound row-key members with RETURNING", () => {
    const operation = new CreateOperation(
      engineFor(
        new ReturningControlPGliteDriver(true),
        pluralPublicationSchema
      ),
      pluralPublicationSchema.twin,
      {
        data: { label: "two generated members" },
        include: { children: true },
      }
    );
    const fragment = operation.compile({});
    const insert = fragment.steps.find(
      (step) => step.kind === "write" && step.id === "twin.create"
    );
    if (!insert || insert.kind !== "write") {
      throw new Error("The returning control did not compile its root INSERT.");
    }

    expect(insert.outputs).toEqual({
      "produced:a": { kind: "firstRowField", field: "a" },
      "produced:b": { kind: "firstRowField", field: "b" },
    });
    expect(fragment.steps.some((step) => step.id.includes(".produced"))).toBe(
      false
    );
  });
});

describe("site 20 selected shared-primary-key value", () => {
  const family = usePGliteSchemaFamily(selectedNullSchema);

  test("refuses a selected null key before the root INSERT", async () => {
    const { client } = family();
    await client.account.create({
      data: { id: "null-account", email: "null@example.test", code: null },
    });

    const error = await captureRejected(
      client.profile.create({
        data: {
          label: "must not be inserted",
          account: { connect: { email: "null@example.test" } },
        },
      })
    );
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    if (!(error instanceof UnsupportedOperationError)) throw error;
    expect(error.message).toBe(
      "query-engine-v2 create does not support a shared-primary-key connect on relation 'account' whose foreign key 'accountCode' (this record's primary key) does not resolve to one final value."
    );
    expect(await client.profile.count()).toBe(0);
  });

  test("accepts the same selected arm when the key is concrete", async () => {
    const { client } = family();
    await client.account.create({
      data: {
        id: "named-account",
        email: "named@example.test",
        code: "ACCOUNT-CODE",
      },
    });

    await expect(
      client.profile.create({
        data: {
          label: "inserted",
          account: { connect: { email: "named@example.test" } },
        },
        select: { accountCode: true, label: true },
      })
    ).resolves.toEqual({ accountCode: "ACCOUNT-CODE", label: "inserted" });
  });
});

class RecordingAtomicSQLiteDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batches = 0;

  override _executeBatch<T>(queries: BatchQuery[]): Promise<QueryResult<T>[]> {
    this.batches += 1;
    return Promise.resolve(
      queries.map(() => ({ rows: [], rowCount: 1, insertId: 41 }))
    );
  }
}

class LiteralControlReachedParse extends Error {}

function publishedConsumedOperation(
  source:
    | { readonly kind: "literal"; readonly value: unknown }
    | { readonly kind: "reference"; readonly reference: ReturnType<typeof ref> }
): ExecutableOperation {
  const writtenValue =
    source.kind === "reference" ? source.reference : source.value;
  const fragment: OperationFragment = {
    steps: [
      {
        id: "producer",
        kind: "write",
        statement: sql`INSERT INTO "residual_probe" DEFAULT VALUES`,
        outputs: { id: { kind: "insertId" } },
      },
      {
        id: "forwarder",
        kind: "write",
        statement: sql`INSERT INTO "residual_probe" ("value") VALUES (${writtenValue})`,
        outputs: {
          forwarded: { kind: "consumedValue", source },
        },
      },
    ],
    outputs: { result: ref("forwarder", "forwarded") },
  };
  return {
    mode: "batch",
    planning: (): PlanningFragment => ({ steps: [] }),
    compile: () => fragment,
    parse: <T>(outputs: Readonly<Record<string, unknown>>): T => {
      throw new LiteralControlReachedParse(String(outputs.result));
    },
  };
}

function locallyConsumedScratchOperation(): ExecutableOperation {
  const fragment: OperationFragment = {
    steps: [
      {
        id: "producer",
        kind: "write",
        statement: sql`INSERT INTO "residual_probe" DEFAULT VALUES`,
        outputs: { id: { kind: "insertId" } },
      },
      {
        id: "forwarder",
        kind: "write",
        statement: sql`INSERT INTO "residual_probe" ("value") VALUES (${ref("producer", "id")})`,
        outputs: {
          forwarded: {
            kind: "consumedValue",
            source: {
              kind: "reference",
              reference: ref("producer", "id"),
            },
          },
        },
      },
      {
        id: "local-consumer",
        kind: "write",
        statement: sql`INSERT INTO "residual_probe" ("value") VALUES (${ref("forwarder", "forwarded")})`,
        outputs: { count: { kind: "rowCount" } },
      },
    ],
    outputs: { result: ref("local-consumer", "count") },
  };
  return {
    mode: "batch",
    planning: (): PlanningFragment => ({ steps: [] }),
    compile: () => fragment,
    parse: <T>(outputs: Readonly<Record<string, unknown>>): T => {
      throw new LiteralControlReachedParse(String(outputs.result));
    },
  };
}

describe("retired site 29 consumed output publication", () => {
  test("publishes an exact batch-local insert id after the provider returns", async () => {
    const driver = new RecordingAtomicSQLiteDriver();
    const executor = new OperationExecutor(
      engineFor(driver, selectedNullSchema)
    );

    await expect(
      executor.execute(
        publishedConsumedOperation({
          kind: "reference",
          reference: ref("producer", "id"),
        }),
        createOperationExecutionContext("profile", "create")
      )
    ).rejects.toThrowError("41");
    expect(driver.batches).toBe(1);
  });

  test("allows the same scratch reference while it stays batch-local", async () => {
    const driver = new RecordingAtomicSQLiteDriver();
    const executor = new OperationExecutor(
      engineFor(driver, selectedNullSchema)
    );

    await expect(
      executor.execute(
        locallyConsumedScratchOperation(),
        createOperationExecutionContext("profile", "create")
      )
    ).rejects.toThrowError("1");
    expect(driver.batches).toBe(1);
  });

  test("allows a concrete consumed literal to reach the provider", async () => {
    const driver = new RecordingAtomicSQLiteDriver();
    const executor = new OperationExecutor(
      engineFor(driver, selectedNullSchema)
    );

    await expect(
      executor.execute(
        publishedConsumedOperation({ kind: "literal", value: "concrete" }),
        createOperationExecutionContext("profile", "create")
      )
    ).rejects.toThrowError("concrete");
    expect(driver.batches).toBe(1);
  });
});
