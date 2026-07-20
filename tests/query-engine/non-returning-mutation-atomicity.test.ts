import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import type {
  DriverResultParser,
  QueryExecutionContext,
} from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { QueryEngineError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const DELETE_STATEMENT = /^DELETE\b/i;
const INSERT_STATEMENT = /^INSERT\b/i;
const SELECT_STATEMENT = /^SELECT\b/i;
const UPDATE_STATEMENT = /^UPDATE\b/i;
const FOR_UPDATE_CLAUSE = /FOR UPDATE/i;

class NonReturningPostgresAdapter
  extends PostgresAdapter
  implements DatabaseAdapter
{
  constructor() {
    super();
    this.capabilities = { ...this.capabilities, supportsReturning: false };
    this.mutations = {
      ...this.mutations,
      returning: (_columns: Sql): Sql => sql.empty,
    };
  }
}

class AtomicityPGliteDriver extends PGliteDriver {
  override readonly adapter: DatabaseAdapter =
    new NonReturningPostgresAdapter();
  override readonly result: DriverResultParser = {
    parseField: (value, type, next) => {
      const parseFailure = this.parseFailure;
      if (parseFailure) {
        this.parseFailure = undefined;
        throw parseFailure;
      }
      return next(value, type);
    },
  };
  readonly statements: string[] = [];
  readonly providerClients: Array<PGlite | Transaction> = [];
  private parseFailure: Error | undefined;
  private refetchFailure: Error | undefined;
  private finalRefetchRowsOverride: "duplicate" | "empty" | undefined;
  private hasUpdated = false;
  private nextMutationCount:
    | {
        readonly kind: "DELETE" | "INSERT" | "UPDATE";
        readonly rowCount: number;
      }
    | undefined;

  resetTrace(): void {
    this.statements.length = 0;
    this.providerClients.length = 0;
    this.hasUpdated = false;
  }

  failNextPublicParse(error: Error): void {
    this.parseFailure = error;
  }

  failRefetchAfterUpdate(error: Error): void {
    this.refetchFailure = error;
  }

  overrideFinalRefetchRows(kind: "duplicate" | "empty"): void {
    this.finalRefetchRowsOverride = kind;
  }

  overrideNextMutationCount(
    kind: "DELETE" | "INSERT" | "UPDATE",
    rowCount: number
  ): void {
    this.nextMutationCount = { kind, rowCount };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    this.providerClients.push(client);
    if (
      this.refetchFailure &&
      this.hasUpdated &&
      SELECT_STATEMENT.test(statement) &&
      !FOR_UPDATE_CLAUSE.test(statement)
    ) {
      const failure = this.refetchFailure;
      this.refetchFailure = undefined;
      throw failure;
    }

    const shouldOverrideFinalRefetch =
      this.finalRefetchRowsOverride !== undefined &&
      this.hasUpdated &&
      SELECT_STATEMENT.test(statement) &&
      !FOR_UPDATE_CLAUSE.test(statement);
    const result = await super.execute<T>(client, statement, params, context);
    if (shouldOverrideFinalRefetch) {
      const override = this.finalRefetchRowsOverride;
      this.finalRefetchRowsOverride = undefined;
      if (override === "empty") return { ...result, rows: [] };
      const row = result.rows[0];
      if (row !== undefined) return { ...result, rows: [row, row] };
    }
    const mutationKind = readMutationKind(statement);
    if (mutationKind === "UPDATE") this.hasUpdated = true;
    const countOverride = this.nextMutationCount;
    if (countOverride && countOverride.kind === mutationKind) {
      const rowCount = countOverride.rowCount;
      this.nextMutationCount = undefined;
      return { ...result, rowCount };
    }
    return result;
  }
}

class NonAtomicPGliteDriver extends AtomicityPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

class BatchOnlyPGliteDriver extends AtomicityPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const item = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("atomic_nonreturn_items");

const omittedAutoItem = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .omit({ id: true })
  .map("atomic_nonreturn_omitted_items");

const parent = s
  .model({
    id: s.string().id(),
    children: s.oneToMany(() => child),
  })
  .map("atomic_nonreturn_parents");

const child = s
  .model({
    id: s.float().id(),
    parentId: s.string(),
    parent: s
      .manyToOne(() => parent)
      .fields("parentId")
      .references("id"),
  })
  .map("atomic_nonreturn_children");

const sharedAccount = s
  .model({
    id: s.string().id(),
    profile: s.oneToOne(() => sharedProfile).optional(),
  })
  .map("atomic_nonreturn_shared_accounts");

const sharedProfile = s
  .model({
    id: s.string().id(),
    bio: s.string(),
    account: s
      .oneToOne(() => sharedAccount)
      .fields("id")
      .references("id"),
  })
  .map("atomic_nonreturn_shared_profiles");

const schema = {
  item,
  omittedAutoItem,
  parent,
  child,
  sharedAccount,
  sharedProfile,
};

describe("atomic non-returning mutation emulation", () => {
  let driver: AtomicityPGliteDriver;
  let client: ReturnType<typeof boot>;

  function boot(nextDriver = new AtomicityPGliteDriver()) {
    return createClient({ schema, driver: nextDriver });
  }

  beforeEach(async () => {
    driver = new AtomicityPGliteDriver();
    client = boot(driver);
    await push(client, { force: true });
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  test("locks by alternate unique, updates by captured PK, and refetches the changed PK on one connection", async () => {
    await client.item.create({
      data: { id: 7, email: "seven@test.com", name: "before" },
    });
    driver.resetTrace();

    const updated = await client.item.update({
      where: { email: "seven@test.com" },
      data: { id: 9, name: "after" },
    });

    expect(updated).toMatchObject({ id: 9, name: "after" });
    const lockingSelect = driver.statements.find((statement) =>
      FOR_UPDATE_CLAUSE.test(statement)
    );
    const update = driver.statements.find((statement) =>
      UPDATE_STATEMENT.test(statement)
    );
    expect(lockingSelect).toContain('"id"');
    expect(update).toContain('WHERE "id"');
    expect(update).not.toContain('WHERE "email"');
    expect(new Set(driver.providerClients).size).toBe(1);
  });

  test("accepts a MySQL-style no-op count only after locked existence and final-PK refetch", async () => {
    await client.item.create({
      data: { id: 1, email: "noop@test.com", name: "same" },
    });
    driver.overrideNextMutationCount("UPDATE", 0);

    await expect(
      client.item.update({
        where: { email: "noop@test.com" },
        data: { name: "same" },
      })
    ).resolves.toMatchObject({ id: 1, name: "same" });
  });

  test("rolls back malformed single-mutation affected-row counts", async () => {
    // Class B — maintainer decision (PLAN §P5): this asserts V1's defensive
    // rollback of a physically-unreachable malformed affected-row count on a
    // WHERE-PK write ("expected at most one" = V1's `maximumAffectedRows:1`).
    // Expressing it in V2 would GROW the FROZEN postcondition vocabulary — the
    // kill signal — so the test is retargeted to the frozen V1 runtime and dies
    // with V1 at P6. V2's observable behavior (it also rolls the batch back) is
    // correct; only V1's exact message needs the extra postcondition variant.
    client = createClient({ schema, driver, queryEngine: "v1" });
    driver.overrideNextMutationCount("INSERT", 0);
    await expect(
      client.item.create({
        data: { id: 40, email: "count-create@test.com", name: "create" },
      })
    ).rejects.toThrow("expected exactly one");
    await expect(
      client.item.findUnique({ where: { id: 40 } })
    ).resolves.toBeNull();

    await client.item.create({
      data: { id: 41, email: "count-update@test.com", name: "before" },
    });
    driver.overrideNextMutationCount("UPDATE", 2);
    await expect(
      client.item.update({ where: { id: 41 }, data: { name: "after" } })
    ).rejects.toThrow("expected at most one");
    await expect(
      client.item.findUnique({ where: { id: 41 } })
    ).resolves.toMatchObject({ name: "before" });

    driver.overrideNextMutationCount("DELETE", 0);
    await expect(
      client.item.delete({ where: { id: 41 } })
    ).rejects.toBeInstanceOf(QueryEngineError);
    await expect(
      client.item.findUnique({ where: { id: 41 } })
    ).resolves.toMatchObject({ name: "before" });
  });

  test("deletes by captured PK and preserves a requested public projection", async () => {
    await client.item.create({
      data: { id: 2, email: "delete@test.com", name: "deleted" },
    });
    driver.resetTrace();

    const deleted = await client.item.delete({
      where: { email: "delete@test.com" },
      select: { name: true },
    });

    expect(deleted).toEqual({ name: "deleted" });
    const deleteStatement = driver.statements.find((statement) =>
      DELETE_STATEMENT.test(statement)
    );
    expect(deleteStatement).toContain('WHERE "id"');
    expect(deleteStatement).not.toContain('WHERE "email"');
  });

  test("computes integer PK division before DML and refetches the persisted identity", async () => {
    await client.item.create({
      data: { id: 7, email: "divide@test.com", name: "divide" },
    });

    const updated = await client.item.update({
      where: { id: 7 },
      data: { id: { divide: 2 } },
    });

    expect(updated.id).toBe(3);
    expect(await client.item.findUnique({ where: { id: 3 } })).toMatchObject({
      email: "divide@test.com",
    });
  });

  test("rejects zero division and ambiguous prepared PK envelopes before provider access", async () => {
    await client.item.create({
      data: { id: 8, email: "guard@test.com", name: "guard" },
    });
    driver.resetTrace();

    await expect(
      client.item.update({
        where: { id: 8 },
        data: { id: { divide: 0 } },
      })
    ).rejects.toThrow("divide primary key field 'id' by zero");
    expect(driver.statements).toEqual([]);

    const pending = Reflect.apply(client.item.update, client.item, [
      {
        where: { id: 8 },
        data: { id: { increment: 1, multiply: 2 } },
      },
    ]);
    await expect(
      Reflect.apply(client.$transaction, client, [[pending]])
    ).rejects.toThrow("accepts exactly one update operation");
    expect(driver.statements).toEqual([]);
  });

  test("rolls back a single update when post-write refetch fails", async () => {
    await client.item.create({
      data: { id: 3, email: "refetch@test.com", name: "before" },
    });
    driver.failRefetchAfterUpdate(new Error("synthetic refetch failure"));

    await expect(
      client.item.update({
        where: { id: 3 },
        data: { name: "after" },
      })
    ).rejects.toMatchObject({ name: "QueryError", code: "V2001" });
    await expect(
      client.item.findUnique({ where: { id: 3 } })
    ).resolves.toMatchObject({ name: "before" });
  });

  test("rolls back createManyAndReturn when public parsing fails", async () => {
    driver.failNextPublicParse(
      new Error("synthetic bulk-create parse failure")
    );

    await expect(
      client.item.createManyAndReturn({
        data: [
          { id: 10, email: "ten@test.com", name: "ten" },
          { id: 11, email: "eleven@test.com", name: "eleven" },
        ],
      })
    ).rejects.toThrow();
    await expect(client.item.findMany()).resolves.toEqual([]);
  });

  test("rolls back updateManyAndReturn when public parsing fails", async () => {
    await client.item.createMany({
      data: [
        { id: 20, email: "twenty@test.com", name: "before" },
        { id: 21, email: "twenty-one@test.com", name: "before" },
      ],
    });
    driver.failNextPublicParse(
      new Error("synthetic bulk-update parse failure")
    );

    await expect(
      client.item.updateManyAndReturn({ data: { name: "after" } })
    ).rejects.toThrow("provider scalar decoding failed");
    const persisted = await client.item.findMany({ orderBy: { id: "asc" } });
    expect(persisted.map((row) => row.name)).toEqual(["before", "before"]);
  });

  test("rolls back a non-returning upsert update when public parsing fails", async () => {
    await client.item.create({
      data: { id: 25, email: "upsert-parse@test.com", name: "before" },
    });
    driver.failNextPublicParse(new Error("synthetic upsert parse failure"));

    await expect(
      client.item.upsert({
        where: { email: "upsert-parse@test.com" },
        create: { id: 26, email: "upsert-parse@test.com", name: "created" },
        update: { name: "after" },
      })
    ).rejects.toThrow();
    await expect(
      client.item.findUnique({ where: { id: 25 } })
    ).resolves.toMatchObject({ name: "before" });
  });

  test("rolls back a non-returning upsert when its final refetch is empty", async () => {
    await client.item.create({
      data: { id: 27, email: "empty-upsert@test.com", name: "before" },
    });
    driver.overrideFinalRefetchRows("empty");

    await expect(
      client.item.upsert({
        where: { email: "empty-upsert@test.com" },
        create: { id: 28, email: "empty-upsert@test.com", name: "created" },
        update: { name: "after" },
      })
    ).rejects.toThrow("expected exactly one");
    await expect(
      client.item.findUnique({ where: { id: 27 } })
    ).resolves.toMatchObject({ name: "before" });
  });

  test("rolls back a non-returning update when its final refetch has multiple rows", async () => {
    await client.item.create({
      data: { id: 29, email: "duplicate-update@test.com", name: "before" },
    });
    driver.overrideFinalRefetchRows("duplicate");

    await expect(
      client.item.update({
        where: { email: "duplicate-update@test.com" },
        data: { name: "after" },
      })
    ).rejects.toThrow("expected exactly one");
    await expect(
      client.item.findUnique({ where: { id: 29 } })
    ).resolves.toMatchObject({ name: "before" });
  });

  test("rolls back parser failure through the inner savepoint and outer transaction", async () => {
    await client.item.create({
      data: { id: 22, email: "savepoint@test.com", name: "before" },
    });
    driver.failNextPublicParse(new Error("synthetic savepoint parse failure"));

    await expect(
      client.$transaction(async (transaction) => {
        await transaction.item.update({
          where: { id: 22 },
          data: { name: "after" },
        });
      })
    ).rejects.toThrow();

    await expect(
      client.item.findUnique({ where: { id: 22 } })
    ).resolves.toMatchObject({ name: "before" });
  });

  test("a caught parser failure rolls back its savepoint and leaves the outer transaction usable", async () => {
    await client.item.createMany({
      data: [
        { id: 23, email: "caught@test.com", name: "before" },
        { id: 24, email: "sibling@test.com", name: "before" },
      ],
    });
    driver.failNextPublicParse(new Error("synthetic caught parse failure"));

    await client.$transaction(async (transaction) => {
      let parseFailure: unknown;
      try {
        await transaction.item.update({
          where: { id: 23 },
          data: { name: "rolled-back" },
        });
      } catch (error) {
        parseFailure = error;
      }
      expect(parseFailure).toBeInstanceOf(Error);
      await transaction.item.update({
        where: { id: 24 },
        data: { name: "committed" },
      });
    });

    await expect(
      client.item.findUnique({ where: { id: 23 } })
    ).resolves.toMatchObject({ name: "before" });
    await expect(
      client.item.findUnique({ where: { id: 24 } })
    ).resolves.toMatchObject({ name: "committed" });
  });

  test("captures an omitted generated PK internally for a non-returning upsert create branch", async () => {
    const created = await client.omittedAutoItem.upsert({
      where: { email: "omitted@test.com" },
      create: { email: "omitted@test.com", name: "created" },
      update: { name: "updated" },
    });

    expect(created).toEqual({
      email: "omitted@test.com",
      name: "created",
    });
    expect(
      await client.omittedAutoItem.findUnique({
        where: { email: "omitted@test.com" },
      })
    ).toEqual(created);
  });

  test("refetches a shared-PK one-to-one connect by the relation-rebound key", async () => {
    await client.sharedAccount.create({ data: { id: "old-account" } });
    await client.sharedAccount.create({ data: { id: "new-account" } });
    await client.sharedProfile.create({
      data: { id: "old-account", bio: "profile" },
    });

    const rebound = await client.sharedProfile.update({
      where: { id: "old-account" },
      data: { account: { connect: { id: "new-account" } } },
    });

    expect(rebound).toEqual({ id: "new-account", bio: "profile" });
    expect(
      await client.sharedProfile.findUnique({ where: { id: "old-account" } })
    ).toBeNull();
    expect(
      await client.sharedProfile.findUnique({ where: { id: "new-account" } })
    ).toEqual(rebound);
  });

  test("creates and refetches a shared-PK relation from its captured connect target", async () => {
    await client.sharedAccount.create({ data: { id: "created-account" } });

    const created = await client.sharedProfile.create({
      data: {
        bio: "created profile",
        account: { connect: { id: "created-account" } },
      },
      include: { account: true },
    });

    expect(created).toEqual({
      id: "created-account",
      bio: "created profile",
      account: { id: "created-account" },
    });
  });

  test("rejects a non-returning mutation before provider access when no atomic substrate exists", async () => {
    await client.$disconnect();
    const nonAtomicDriver = new NonAtomicPGliteDriver();
    client = boot(nonAtomicDriver);
    nonAtomicDriver.resetTrace();

    await expect(
      client.item.create({
        data: { id: 30, email: "unsupported@test.com", name: "no" },
      })
    ).rejects.toMatchObject({ name: "TransactionError" });
    expect(nonAtomicDriver.statements).toEqual([]);
  });

  test("rejects batch-only non-returning upsert before a plan-time probe", async () => {
    await client.$disconnect();
    const batchOnlyDriver = new BatchOnlyPGliteDriver();
    client = boot(batchOnlyDriver);
    batchOnlyDriver.resetTrace();

    await expect(
      client.item.upsert({
        where: { id: 31 },
        create: { id: 31, email: "batch@test.com", name: "create" },
        update: { name: "update" },
      })
    ).rejects.toThrow("public result parsing cannot be rolled back");
    expect(batchOnlyDriver.statements).toEqual([]);
  });

  test("rejects nested update and upsert float-PK arithmetic before effects", async () => {
    await client.parent.create({ data: { id: "parent" } });
    driver.resetTrace();

    await expect(
      client.parent.update({
        where: { id: "parent" },
        data: {
          children: {
            update: {
              where: { id: 1 },
              data: { id: { divide: 2 } },
            },
          },
        },
      })
    ).rejects.toThrow("not portable for float primary key");
    expect(driver.statements).toEqual([]);

    await expect(
      client.parent.update({
        where: { id: "parent" },
        data: {
          children: {
            upsert: {
              where: { id: 1 },
              create: { id: 1 },
              update: { id: { increment: 1 } },
            },
          },
        },
      })
    ).rejects.toThrow("not portable for float primary key");
    expect(driver.statements).toEqual([]);
  });
});

function readMutationKind(
  statement: string
): "DELETE" | "INSERT" | "UPDATE" | undefined {
  if (DELETE_STATEMENT.test(statement)) return "DELETE";
  if (INSERT_STATEMENT.test(statement)) return "INSERT";
  if (UPDATE_STATEMENT.test(statement)) return "UPDATE";
  return undefined;
}
