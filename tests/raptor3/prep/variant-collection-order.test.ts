import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const BOOK_MEMBERS = "g3p05_variant_crate_books";
const CLIP_MEMBERS = "g3p05_variant_crate_clips";
const NOTE_MEMBERS = "g3p05_variant_crate_notes";
const MEMBER_TABLES = [BOOK_MEMBERS, CLIP_MEMBERS, NOTE_MEMBERS] as const;
const TARGET_TABLES = [
  "g3p05_variant_books",
  "g3p05_variant_clips",
  "g3p05_variant_notes",
] as const;
const ALTERNATING_CONNECT_TARGETS = [
  "k-connect",
  "b-connect",
  "n-connect",
  "b-connect-2",
] as const;

interface ObservedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

class VariantSQLiteDriver extends SQLite3Driver {
  readonly statements: ObservedStatement[] = [];

  resetStatements(): void {
    this.statements.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, parameters: [...parameters] });
    return super.execute<T>(client, statement, parameters);
  }
}

function variantSchema(admissions?: string[]) {
  const admittedString = (name: string) =>
    s.string().schema(
      v.string({
        transform(value) {
          admissions?.push(name);
          return value;
        },
      })
    );
  const warehouse = s
    .model({
      id: s.string().id(),
      crates: s.toMany(() => crate),
    })
    .map("g3p05_variant_warehouses");
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      crates: s.toMany(() => crate),
    })
    .map("g3p05_variant_books");
  const clip = s
    .model({
      id: s.string().id(),
      label: s.string(),
      crates: s.toMany(() => crate),
    })
    .map("g3p05_variant_clips");
  const note = s
    .model({
      id: s.string().id(),
      body: admittedString("variant"),
    })
    .map("g3p05_variant_notes");
  const crate = s
    .model({
      id: s.string().id(),
      label: s.string(),
      warehouseId: s.string(),
      warehouse: s
        .toOne(() => warehouse)
        .fields("warehouseId")
        .references("id"),
      logs: s.toMany(() => log),
      items: s
        .toMany(
          { book: () => book, clip: () => clip, note: () => note },
          {
            values: {
              book: "g3p05.book.v1",
              clip: "g3p05.clip.v1",
              note: "g3p05.note.v1",
            },
          }
        )
        .through({
          book: { table: BOOK_MEMBERS, source: "crate", target: "book" },
          clip: { table: CLIP_MEMBERS, source: "crate", target: "clip" },
          note: { table: NOTE_MEMBERS, source: "crate", target: "note" },
        }),
    })
    .map("g3p05_variant_crates");
  const log = s
    .model({
      id: s.string().id(),
      body: admittedString("ordinary"),
      crateId: s.string(),
      crate: s
        .toOne(() => crate)
        .fields("crateId")
        .references("id"),
    })
    .map("g3p05_variant_logs");
  return { warehouse, crate, log, book, clip, note };
}

async function createVariantWorld(admissions?: string[]) {
  const schema = variantSchema(admissions);
  const database = new Database(":memory:");
  const driver = new VariantSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  await client.warehouse.create({ data: { id: "w1" } });
  await client.crate.create({
    data: { id: "c1", label: "left", warehouseId: "w1" },
  });
  await client.crate.create({
    data: { id: "c2", label: "right", warehouseId: "w1" },
  });
  for (const [id, title] of [
    ["b-delete", "remove"],
    ["b-other", "remove"],
    ["b-old", "old"],
    ["b-connect", "connect"],
    ["b-connect-2", "connect"],
  ] as const)
    await client.book.create({ data: { id, title } });
  for (const [id, label] of [
    ["k-update", "sweep"],
    ["k-other", "sweep"],
    ["k-connect", "connect"],
  ] as const)
    await client.clip.create({ data: { id, label } });
  for (const [id, body] of [
    ["n-remove", "remove"],
    ["n-other", "remove"],
    ["n-old", "old"],
    ["n-set", "set"],
    ["n-connect", "connect"],
  ] as const)
    await client.note.create({ data: { id, body } });
  await client.crate.update({
    where: { id: "c1" },
    data: {
      items: {
        connect: [
          { type: "book", where: { id: "b-delete" } },
          { type: "book", where: { id: "b-old" } },
          { type: "clip", where: { id: "k-update" } },
          { type: "note", where: { id: "n-remove" } },
          { type: "note", where: { id: "n-old" } },
        ],
      },
    },
  });
  await client.crate.update({
    where: { id: "c2" },
    data: {
      items: {
        connect: [
          { type: "book", where: { id: "b-other" } },
          { type: "clip", where: { id: "k-other" } },
          { type: "note", where: { id: "n-other" } },
        ],
      },
    },
  });
  admissions?.splice(0);
  driver.resetStatements();
  return {
    candidate: createCommandEngine({ schema, driver }),
    client,
    database,
    driver,
  };
}

type VariantWorld = Awaited<ReturnType<typeof createVariantWorld>>;

async function closeWorld(world: VariantWorld): Promise<void> {
  await world.client.$disconnect();
  world.database.close();
}

function mixedMutation() {
  return {
    items: {
      updateMany: [
        {
          type: "clip",
          where: { label: "sweep" },
          data: { label: "updated-owned" },
        },
      ],
      deleteMany: [
        { type: "note", where: { body: "remove" } },
        { type: "book", where: { title: "remove" } },
      ],
      set: [{ type: "note", where: { id: "n-set" } }],
      connect: [
        { type: "clip", where: { id: "k-connect" } },
        { type: "book", where: { id: "b-connect" } },
        { type: "note", where: { id: "n-connect" } },
        { type: "book", where: { id: "b-connect-2" } },
      ],
      create: [
        {
          type: "clip",
          data: { id: "k-created", label: "created" },
        },
      ],
      createMany: [
        {
          type: "note",
          data: [{ id: "n-bulk", body: "bulk" }],
        },
      ],
    },
  };
}

function statementIndexes(
  statements: readonly ObservedStatement[],
  predicate: (statement: ObservedStatement) => boolean
): number[] {
  const indexes: number[] = [];
  statements.forEach((statement, index) => {
    if (predicate(statement)) indexes.push(index);
  });
  return indexes;
}

function mentionsAny(sql: string, names: readonly string[]): boolean {
  return names.some((name) => sql.includes(name));
}

function directlyMutatesAny(sql: string, names: readonly string[]): boolean {
  if (!/^(?:DELETE|INSERT|UPDATE)\b/.test(sql)) return false;
  const boundaries = [
    sql.search(/\bWHERE\b/),
    sql.search(/\bSET\b/),
    sql.indexOf("("),
  ].filter((index) => index >= 0);
  const head = sql.slice(
    0,
    boundaries.length === 0 ? sql.length : Math.min(...boundaries)
  );
  return mentionsAny(head, names);
}

function assertGuardClearWriteOrder(driver: VariantSQLiteDriver): void {
  const guards = statementIndexes(
    driver.statements,
    ({ sql }) => /^SELECT\b/.test(sql) && mentionsAny(sql, TARGET_TABLES)
  );
  const clears = statementIndexes(
    driver.statements,
    ({ sql }) => /^DELETE\b/.test(sql) && directlyMutatesAny(sql, MEMBER_TABLES)
  );
  const writes = statementIndexes(
    driver.statements,
    ({ sql }) =>
      directlyMutatesAny(sql, [...TARGET_TABLES, ...MEMBER_TABLES]) &&
      !(directlyMutatesAny(sql, MEMBER_TABLES) && /^DELETE\b/.test(sql))
  );
  assert(guards.length > 0);
  assert(writes.length > 0);
  assert.deepEqual(
    MEMBER_TABLES.map(
      (table) =>
        clears.filter((index) => {
          const statement = driver.statements[index];
          assert(statement);
          return statement.sql.includes(table);
        }).length
    ),
    [1, 1, 1],
    "Set must clear every configured member table exactly once"
  );
  assert(
    Math.max(...guards) < Math.min(...clears),
    "Every target guard must complete before the first relation-wide clear"
  );
  assert(
    Math.max(...clears) < Math.min(...writes),
    "Every configured member clear must complete before target or membership writes"
  );
  const guardedConnectTargets = guards.flatMap((index) => {
    const statement = driver.statements[index];
    assert(statement);
    return statement.parameters.filter(
      (parameter): parameter is (typeof ALTERNATING_CONNECT_TARGETS)[number] =>
        typeof parameter === "string" &&
        ALTERNATING_CONNECT_TARGETS.some((target) => target === parameter)
    );
  });
  assert.deepEqual(
    guardedConnectTargets,
    ALTERNATING_CONNECT_TARGETS,
    "Alternating variant guards must retain their caller positions"
  );
  assert.deepEqual(
    driver.statements
      .filter(({ sql }) => directlyMutatesAny(sql, TARGET_TABLES))
      .map(({ sql }) => {
        const verb = sql.split(/\s+/, 1)[0];
        const table = TARGET_TABLES.find((candidate) =>
          directlyMutatesAny(sql, [candidate])
        );
        assert(verb);
        assert(table);
        return `${verb}:${table}`;
      }),
    [
      "UPDATE:g3p05_variant_clips",
      "DELETE:g3p05_variant_notes",
      "DELETE:g3p05_variant_books",
      "INSERT:g3p05_variant_clips",
      "INSERT:g3p05_variant_notes",
    ],
    "Canonical collection verb order must include deleteMany before adders"
  );
}

async function itemsOf(
  world: VariantWorld,
  crateId: string
): Promise<string[]> {
  const crate = await world.client.crate.findUnique({
    where: { id: crateId },
    include: { items: true },
  });
  assert(crate);
  return crate.items.map((item) => `${item.type}:${item.data.id}`).sort();
}

async function assertMixedState(world: VariantWorld): Promise<void> {
  assert.deepEqual(await itemsOf(world, "c1"), [
    "book:b-connect",
    "book:b-connect-2",
    "clip:k-connect",
    "clip:k-created",
    "note:n-bulk",
    "note:n-connect",
    "note:n-set",
  ]);
  assert.deepEqual(await itemsOf(world, "c2"), [
    "book:b-other",
    "clip:k-other",
    "note:n-other",
  ]);
  assert.deepEqual(
    await world.client.book.findMany({
      orderBy: { id: "asc" },
      select: { id: true, title: true },
    }),
    [
      { id: "b-connect", title: "connect" },
      { id: "b-connect-2", title: "connect" },
      { id: "b-old", title: "old" },
      { id: "b-other", title: "remove" },
    ]
  );
  assert.deepEqual(
    await world.client.clip.findMany({
      orderBy: { id: "asc" },
      select: { id: true, label: true },
    }),
    [
      { id: "k-connect", label: "connect" },
      { id: "k-created", label: "created" },
      { id: "k-other", label: "sweep" },
      { id: "k-update", label: "updated-owned" },
    ]
  );
  assert.deepEqual(
    await world.client.note.findMany({
      orderBy: { id: "asc" },
      select: { id: true, body: true },
    }),
    [
      { id: "n-bulk", body: "bulk" },
      { id: "n-connect", body: "connect" },
      { id: "n-old", body: "old" },
      { id: "n-other", body: "remove" },
      { id: "n-set", body: "set" },
    ]
  );
}

describe("G3P-05 mixed variant collection ordering", () => {
  it("guards every root target, clears each member table once, then writes", async () => {
    const world = await createVariantWorld();
    try {
      await world.candidate.execute("crate", "update", {
        where: { id: "c1" },
        data: mixedMutation(),
        select: { id: true },
      });

      assertGuardClearWriteOrder(world.driver);
      await assertMixedState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("keeps the same guard-clear-write contract in a nested record", async () => {
    const world = await createVariantWorld();
    try {
      await world.candidate.execute("warehouse", "update", {
        where: { id: "w1" },
        data: {
          crates: {
            update: {
              where: { id: "c1" },
              data: mixedMutation(),
            },
          },
        },
        select: { id: true },
      });

      assertGuardClearWriteOrder(world.driver);
      await assertMixedState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("set of the empty collection clears all variants without deleting targets", async () => {
    const world = await createVariantWorld();
    try {
      await world.candidate.execute("crate", "update", {
        where: { id: "c1" },
        data: { items: { set: [] } },
        select: { id: true },
      });

      assert.deepEqual(await itemsOf(world, "c1"), []);
      assert.equal((await world.client.book.findMany({})).length, 5);
      assert.equal((await world.client.clip.findMany({})).length, 3);
      assert.equal((await world.client.note.findMany({})).length, 5);
      const clearSql = driverClearStatements(world.driver);
      assert.deepEqual(
        MEMBER_TABLES.map(
          (table) => clearSql.filter((sql) => sql.includes(table)).length
        ),
        [1, 1, 1]
      );
    } finally {
      await closeWorld(world);
    }
  });

  it("admits an ordinary relation before a later-declared variant relation", async () => {
    const admissions: string[] = [];
    const world = await createVariantWorld(admissions);
    try {
      await world.candidate.execute("crate", "update", {
        where: { id: "c1" },
        data: {
          items: {
            create: [
              {
                type: "note",
                data: { id: "n-admitted", body: "variant-body" },
              },
            ],
          },
          logs: { create: [{ id: "l-admitted", body: "ordinary-body" }] },
        },
        select: { id: true },
      });

      assert.deepEqual(admissions, ["ordinary", "variant"]);
      assert.deepEqual(await itemsOf(world, "c1"), [
        "book:b-delete",
        "book:b-old",
        "clip:k-update",
        "note:n-admitted",
        "note:n-old",
        "note:n-remove",
      ]);
      assert.deepEqual(
        await world.client.log.findMany({
          select: { id: true, body: true, crateId: true },
        }),
        [{ id: "l-admitted", body: "ordinary-body", crateId: "c1" }]
      );
    } finally {
      await closeWorld(world);
    }
  });
});

function driverClearStatements(driver: VariantSQLiteDriver): string[] {
  return driver.statements
    .map(({ sql }) => sql)
    .filter(
      (sql) => /^DELETE\b/.test(sql) && directlyMutatesAny(sql, MEMBER_TABLES)
    );
}
