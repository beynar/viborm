/**
 * T5a on live PostgreSQL (PGlite): a change that rewrites or scans a big table
 * is refused in-request, before any effect, with the operation and the table
 * named.
 *
 * The estate is realistic: a fifteen-field model holding 10,000 real rows,
 * analysed so the planner's estimate is the real count. The refusals run under
 * a `largeTableRows` lowered below it; the default (1,000,000) is proven on the
 * same table with its planner statistics set to 20 million rows — the catalog
 * fact `ANALYZE` itself writes. One database per describe, used in order: every
 * refusal leaves it unchanged, so the effectful steps come last.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { VibORMErrorCode } from "@errors";
import {
  createMigrationClient,
  type MigrationLimits,
  type ResolveCallback,
} from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import type { AnyModel } from "@src/schema/model";
import type { ModelShape } from "@src/schema/model/helper";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const ROWS = 10_000;
const LIMIT = 5000;
const TABLE = '"public"."accounts"';
const ACCOUNT_FOREIGN_KEY =
  /ALTER TABLE "public"\."accounts" ADD CONSTRAINT .+ FOREIGN KEY/;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  price: s.decimal({ precision: 10, scale: 2 }).nullable(),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

/** The two models; `linked` adds the account → team foreign key. */
function schemaWith(
  changes: ModelShape = {},
  linked = false
): Record<string, AnyModel> {
  const link: ModelShape = linked
    ? {
        teamId: s.string().nullable(),
        team: s
          .toOne(() => team)
          .fields("teamId")
          .references("id"),
      }
    : {};
  const account: AnyModel = s
    .model({ ...fields(), ...changes, ...link })
    .map("accounts");
  const team: AnyModel = s
    .model({
      id: s.string().id(),
      name: s.string(),
      ...(linked ? { accounts: s.toMany(() => account) } : {}),
    })
    .map("teams");
  return { team, account };
}

const resolve: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : undefined;

const seed = `INSERT INTO "accounts" ("id", "email", "name", "price", "score", "settings", "age", "updatedAt")
  SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, g % 1000, g / 7.0, '{"plan":"pro"}'::jsonb, g % 90, now()
  FROM generate_series(1, ${ROWS}) g`;

/** Each kind of rewrite or scan: name, model change, how it is named, linked. */
const variants: [string, ModelShape, string, boolean?][] = [
  ["type", { age: s.bigInt().nullable() }, 'column type change of "age"'],
  [
    "enum",
    { status: s.enum(["active", "trial", "churned"]).default("trial") },
    'column type change of "status"',
  ],
  [
    "decimal",
    { price: s.decimal({ precision: 12, scale: 4 }).nullable() },
    'CHECK validation and column type change of "price"',
  ],
  [
    "volatile",
    { trackingId: s.string().uuid({ generate: true }) },
    'volatile default on new column "trackingId"',
  ],
  ["not-null", { score: s.number() }, 'SET NOT NULL on "score"'],
  ["foreign-key", {}, "FOREIGN KEY validation", true],
];

const settle = (running: Promise<unknown>) =>
  running.then(
    () => undefined,
    (failure: unknown) => failure
  );

async function liveShape(driver: AnyDriver) {
  const columns = await driver._executeRaw<{ column: string; type: string }>(
    `SELECT attname AS "column", format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' not null' ELSE '' END AS "type"
     FROM pg_catalog.pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`
  );
  const constraints = await driver._executeRaw<{ name: string }>(
    `SELECT conname AS name FROM pg_catalog.pg_constraint WHERE conrelid = '${TABLE}'::regclass ORDER BY 1`
  );
  return { columns: columns.rows, constraints: constraints.rows };
}

describe("a change that rewrites or scans a 10,000-row PostgreSQL table", () => {
  const driver = new PGliteDriver();
  const storage = new MemoryStorage();
  const migrationsFor = (
    changes: ModelShape = {},
    limits?: MigrationLimits,
    linked = false
  ) =>
    createMigrationClient(
      createClient({ driver, schema: schemaWith(changes, linked) }),
      limits === undefined ? { storage } : { storage, limits }
    );
  let root: string;

  beforeAll(async () => {
    const first = migrationsFor();
    root = (await first.generate({ name: "v1" })).stateId!;
    await first.apply();
    await driver._executeRaw(seed);
    await driver._executeRaw(`ANALYZE ${TABLE}`);
  });
  afterAll(() => driver.disconnect());

  it("is refused in-request with the operation and the table named, before any effect", async () => {
    const before = await liveShape(driver);
    for (const [name, changes, operation, linked] of variants) {
      const migrations = migrationsFor(
        changes,
        { largeTableRows: LIMIT },
        linked
      );
      const { stateId } = await migrations.generate({
        name,
        from: root,
        resolve,
      });
      const ledger = (await migrations.log()).length;
      const refusal = await settle(migrations.apply({ to: { id: stateId! } }));
      expect(refusal, name).toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining(
          `${operation} on ${TABLE}, which the planner estimates at ${ROWS} rows, above limits.largeTableRows (${LIMIT})`
        ),
        meta: { table: TABLE, operation },
      });
      expect((await migrations.log()).length, name).toBe(ledger);
    }
    expect(await liveShape(driver)).toEqual(before);
    expect((await migrationsFor().status()).unfinished).toBe(false);
  });

  it("is refused above the default 1,000,000 estimated rows", async () => {
    await driver._executeRaw(
      `UPDATE pg_catalog.pg_class SET reltuples = 20000000 WHERE oid = '${TABLE}'::regclass`
    );
    const migrations = migrationsFor({ age: s.bigInt().nullable() });
    const { stateId } = await migrations.generate({
      name: "type",
      from: root,
      resolve,
    });
    const refusal = await settle(migrations.apply({ to: { id: stateId! } }));
    await driver._executeRaw(`ANALYZE ${TABLE}`);
    expect(refusal).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        "estimates at 20000000 rows, above limits.largeTableRows (1000000)"
      ),
      meta: { table: TABLE, operation: 'column type change of "age"' },
    });
  });

  it("admits what rewrites nothing, and a rewrite below the limit", async () => {
    const nickname = { nickname: s.string().nullable() };
    const added = migrationsFor(nickname, { largeTableRows: LIMIT });
    const { stateId } = await added.generate({ name: "nickname", from: root });
    await expect(added.apply({ to: { id: stateId! } })).resolves.toMatchObject({
      outcome: "applied",
    });

    const widened = migrationsFor(
      { ...nickname, age: s.bigInt().nullable() },
      { largeTableRows: 20_000 }
    );
    const next = await widened.generate({
      name: "widened",
      from: stateId,
      resolve,
    });
    await expect(
      widened.apply({ to: { id: next.stateId! } })
    ).resolves.toMatchObject({ outcome: "applied" });
    expect((await liveShape(driver)).columns).toContainEqual({
      column: "age",
      type: "bigint",
    });
  });

  it("refuses the rollback of that rewrite the same way, before any effect", async () => {
    const back = migrationsFor(
      { nickname: s.string().nullable(), age: s.bigInt().nullable() },
      { largeTableRows: LIMIT }
    );
    const ledger = (await back.log()).length;
    const before = await liveShape(driver);
    await expect(back.down({ steps: 1 })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(`estimates at ${ROWS} rows`),
      meta: { table: TABLE, operation: 'column type change of "age"' },
    });
    expect((await back.log()).length).toBe(ledger);
    expect(await liveShape(driver)).toEqual(before);
  });
});

describe("push of a change that rewrites a big table", () => {
  it("is refused the same way, and largeTableRows: 0 admits every size", async () => {
    const driver = new PGliteDriver();
    const live = (changes: ModelShape, largeTableRows = 1_000_000) =>
      createMigrationClient(
        createClient({ driver, schema: schemaWith(changes) }),
        { limits: { largeTableRows } }
      );
    try {
      await live({}).push();
      await driver._executeRaw(seed);
      await driver._executeRaw(`ANALYZE ${TABLE}`);
      const widened = { age: s.bigInt().nullable() };
      const refusal = {
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining(`estimates at ${ROWS} rows`),
        meta: { table: TABLE, operation: 'column type change of "age"' },
      };
      // Planning reads the same estimate, so the preview is refused as well.
      await expect(
        live(widened, LIMIT).push({ dryRun: true })
      ).rejects.toMatchObject(refusal);
      const preview = await live(widened, 0).push({ dryRun: true });
      await expect(
        live(widened, LIMIT).push({ consent: preview.consent })
      ).rejects.toMatchObject(refusal);
      await expect(
        live(widened, 0).push({ consent: preview.consent })
      ).resolves.toMatchObject({ outcome: "applied" });
    } finally {
      await driver.disconnect();
    }
  });
});

describe("push's preview on a table the planner estimates at 20,000,000 rows", () => {
  const driver = new PGliteDriver();
  const preview = (changes: ModelShape, linked?: boolean) =>
    createMigrationClient(
      createClient({ driver, schema: schemaWith(changes, linked) })
    ).push({ dryRun: true, resolve });

  beforeAll(async () => {
    await createMigrationClient(
      createClient({ driver, schema: schemaWith() })
    ).push();
    await driver._executeRaw(seed);
    await driver._executeRaw(`ANALYZE ${TABLE}`);
    await driver._executeRaw(
      `UPDATE pg_catalog.pg_class SET reltuples = 20000000 WHERE oid = '${TABLE}'::regclass`
    );
  });
  afterAll(() => driver.disconnect());

  it.each(
    variants
  )("refuses the %s change above the default 1,000,000", async (_, changes, operation, linked) => {
    await expect(preview(changes, linked)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        `${operation} on ${TABLE}, which the planner estimates at 20000000 rows, above limits.largeTableRows (1000000)`
      ),
    });
  });
});

describe("push({ forceReset }) of a big table with a foreign key", () => {
  it("is admitted: the key lands on the table it recreates empty", async () => {
    const driver = new PGliteDriver();
    const linked = () =>
      createMigrationClient(
        createClient({ driver, schema: schemaWith({}, true) }),
        { limits: { largeTableRows: LIMIT } }
      );
    try {
      await linked().push();
      await driver._executeRaw(seed);
      await driver._executeRaw(`ANALYZE ${TABLE}`);
      const reset = await linked().push({ forceReset: true, dryRun: true });
      expect(reset.statements.map(({ sql: text }) => text).join(";")).toMatch(
        ACCOUNT_FOREIGN_KEY
      );
      await expect(
        linked().push({ consent: reset.consent })
      ).resolves.toMatchObject({ outcome: "applied" });
    } finally {
      await driver.disconnect();
    }
  });
});

describe("CONCURRENTLY in a manual transition", () => {
  const driver = new PGliteDriver();
  const migrations = createMigrationClient(
    createClient({ driver, schema: schemaWith() }),
    { storage: new MemoryStorage() }
  );
  const spellings = [
    'CREATE INDEX CONCURRENTLY "accounts_email_cc" ON "public"."accounts" ("email")',
    'CREATE UNIQUE INDEX CONCURRENTLY "accounts_email_ucc" ON "public"."accounts" ("email")',
    'DROP INDEX CONCURRENTLY "accounts_email_cc"',
    'REINDEX TABLE CONCURRENTLY "public"."accounts"',
    'REINDEX (VERBOSE, CONCURRENTLY) INDEX "accounts_email_cc"',
    'ALTER TABLE "public"."events" DETACH PARTITION "public"."events 2026" CONCURRENTLY',
  ];
  const check = {
    kind: "trusted-read" as const,
    query: sql.raw("SELECT true AS ok"),
    equals: true,
  };
  let root: string;

  beforeAll(async () => {
    root = (await migrations.generate({ name: "v1" })).stateId!;
    await migrations.apply();
  });
  afterAll(() => driver.disconnect());

  it("is refused at generate when declared transactional, in each spelling", async () => {
    for (const text of spellings) {
      await expect(
        migrations.generate({
          name: "concurrent",
          manualMigration: {
            transitions: [
              {
                from: root,
                execution: "transactional",
                up: [sql.raw(text)],
                rollback: { kind: "irreversible", reason: "test" },
              },
            ],
          },
        }),
        text
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("forward SQL dispatch 0"),
      });
    }
    // The rollback program is held to its own declared boundary.
    await expect(
      migrations.generate({
        name: "concurrent-rollback",
        manualMigration: {
          transitions: [
            {
              from: root,
              execution: "stepwise",
              originChecks: [check],
              up: [sql.raw(spellings[1]!)],
              rollback: {
                kind: "manual",
                execution: "transactional",
                sql: [sql.raw('DROP INDEX CONCURRENTLY "accounts_email_ucc"')],
              },
            },
          ],
          destinationChecks: [check],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("rollback SQL dispatch 0"),
    });
  });

  it("is admitted at generate when declared stepwise", async () => {
    const generated = await migrations.generate({
      name: "concurrent",
      dryRun: true,
      manualMigration: {
        transitions: [
          {
            from: root,
            execution: "stepwise",
            originChecks: [check],
            up: spellings.map((text) => sql.raw(text)),
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
        destinationChecks: [check],
      },
    });
    expect(generated.sql).toContain(spellings[1]);
  });
});
