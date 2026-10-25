/**
 * The server half of Neon Realtime against a recording PostgreSQL driver: the
 * nine live reads answer the ordinary value in a plain-JSON envelope, reject
 * like the ordinary read, observe like it, and refuse by name what the sealed
 * SQL cannot reproduce. Embedded PostgreSQL runs the sealed SQL itself in
 * `tests/providers/local/pglite-neon-realtime.test.ts`.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { NeonHTTPDriver } from "@drivers/neon-http";
import {
  ClientInitializationError,
  ForbiddenError,
  NotFoundError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import type { RawSqlQuery } from "@neon/realtime/server";
import { createClient, s } from "@src/index";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, it } from "vitest";
import { neonRealtime } from "../../../src/neon-realtime";
import { realtimeData } from "../../../src/neon-realtime/client";

const JSON_FUNCTIONS = /json_build|json_agg/;
const RANK_THROUGH_DISTINCT = /^SELECT [^(]*"0viborm_ordinal" FROM \(SELECT/;
const AUTH_TOKEN = /authToken/;
const QUERY_HANDLERS = /query handlers replace its answer/;
const STATEMENT_TRANSFORMS = /statement transforms/;
const RESULT_FIELDS = /computed result fields/;
const TRANSACTION = /transaction/;
const READ_GATES = /read-gated field's projection/;
const POINT = /point projection/;
const VECTOR = /vector projection/;
const DISTANCE = /`_distance` projection/;
const NOW = /`\{ now: true \}` predicate/;

class RecordingDriver extends SqlOnlyDriver {
  readonly statements: string[] = [];
  rows: Record<string, unknown>[] = [];
  constructor() {
    super(new PostgresAdapter("public", true), "postgresql");
  }
  protected override async execute<T>(_client?: null, statement = "") {
    this.statements.push(statement);
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
}

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.bigInt(),
  createdAt: s.dateTime(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => post)
    .fields("parentId")
    .references("id")
    .name("thread"),
  replies: s.toMany(() => post).name("thread"),
});
const place = s.model({ id: s.string().id(), at: s.point() });
const doc = s.model({
  id: s.string().id(),
  embedding: s.vector().dimension(3),
});
const kit = s.model({
  id: s.string().id(),
  score: s.number(),
  bytes: s.blob(),
  count: s.int(),
  meta: s.json(),
  tags: s.string().array(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => kit)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => kit),
});
// Field names the projection shape also uses as its own keys.
const odd = s.model({
  id: s.string().id(),
  scalar: s.string(),
  gated: s.int(),
});
const schema = { post, place, doc, kit, odd };

const sealed: RawSqlQuery<unknown>[] = [];
const realtime = {
  seal: async ({ query }: { readonly query: RawSqlQuery<never> }) => {
    sealed.push(query);
    return {
      capability: "capability",
      queryFingerprint: "fingerprint",
      expiresAt: Date.now() + 60_000,
    };
  },
};
const clients: { $disconnect(): Promise<void> }[] = [];
function live(driver = new RecordingDriver()) {
  const base = createClient({ schema, driver });
  clients.push(base);
  return { base, driver, db: base.$extends(neonRealtime({ realtime })) };
}
afterEach(async () => {
  sealed.length = 0;
  for (const client of clients.splice(0)) await client.$disconnect();
});

const ROW = {
  id: "p1",
  title: "First",
  views: "9007199254740993",
  createdAt: "2026-01-02 03:04:05.006+00",
  parentId: null,
};
type Reads = Record<
  string,
  (args?: unknown, options?: unknown) => Promise<unknown>
>;
const READS: [string, unknown, Record<string, unknown>[]][] = [
  ["findMany", { orderBy: { createdAt: "desc" } }, [ROW]],
  ["findFirst", { where: { title: "First" } }, [ROW]],
  ["findUnique", { where: { id: "p1" } }, [ROW]],
  ["findFirstOrThrow", { orderBy: { id: "asc" } }, [ROW]],
  ["findUniqueOrThrow", { where: { id: "p1" } }, [ROW]],
  ["count", { where: { views: { gt: 1n } } }, [{ _count: "3" }]],
  ["exist", { where: { id: "p1" } }, [{ _count: true }]],
  ["aggregate", { _max: { views: true } }, [{ _max: { views: "7" } }]],
  [
    "groupBy",
    { by: ["title"], _count: { _all: true } },
    [{ title: "First", _count: { _all: 2 } }],
  ],
];

describe("Neon Realtime server reads", () => {
  it.each(
    READS
  )("%sRealtime answers the ordinary value as plain JSON", async (operation, args, rows) => {
    const { db, driver } = live();
    driver.rows = rows;
    const reads = db.post as unknown as Reads;
    const query = (await reads[`${operation}Realtime`]!(args)) as {
      readonly data: unknown;
    };
    expect(driver.statements).toHaveLength(1);
    const ordinary = await reads[operation]!(args);
    expect(query.data).toEqual(ordinary);
    expect(Object.keys(query)).toEqual(["kind", "sealed", "plan", "encoded"]);
    const wire = JSON.parse(JSON.stringify(query));
    expect(wire.data).toBeUndefined();
    expect(realtimeData(wire)).toEqual(ordinary);
    expect(sealed[0]!.sql).not.toMatch(JSON_FUNCTIONS);
  });

  it("renews without reading the database", async () => {
    const { db, driver } = live();
    const renewal = await db.post.findManyRealtime(
      { where: { title: "First" } },
      { initialData: false }
    );
    expect(driver.statements).toEqual([]);
    expect(Object.keys(renewal)).toEqual(["kind", "sealed", "plan"]);
  });

  it("ranks an ordered page and binds each parameter in PostgreSQL text", async () => {
    const { db } = live();
    await db.post.findManyRealtime(
      {
        where: { createdAt: { gt: new Date("2026-01-01T00:00:00.000Z") } },
        orderBy: { title: "asc" },
      },
      { initialData: false }
    );
    const { sql, parameters } = sealed[0]!;
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY "q0"."title" ASC');
    expect(parameters.map((parameter) => parameter.value)).toContain(
      "2026-01-01T00:00:00.000Z"
    );
    // An emulated DISTINCT keeps the rank among the columns it publishes.
    await db.post.findManyRealtime(
      { distinct: ["title"], orderBy: { createdAt: "desc" } },
      { initialData: false }
    );
    expect(sealed[1]!.sql).toMatch(RANK_THROUGH_DISTINCT);
  });

  it("binds bytes, lists and JSON documents as PostgreSQL parameters", async () => {
    const { db } = live();
    await db.kit.findManyRealtime(
      {
        where: {
          bytes: { equals: new Uint8Array([1, 255]) },
          tags: { hasSome: ["a,b"] },
          meta: { equals: { quote: 'a"b' } },
        },
      },
      { initialData: false }
    );
    expect(sealed[0]!.parameters).toEqual(
      expect.arrayContaining([
        { typeOid: 17, value: "\\x01ff" },
        { typeOid: 0, value: '{"a,b"}' },
        { typeOid: 0, value: '{"quote":"a\\"b"}' },
      ])
    );
  });

  it("spells every carried scalar as JSON text Neon admits", async () => {
    const { db } = live();
    await db.kit.findManyRealtime(
      {
        select: {
          id: true,
          parent: {
            select: {
              score: true,
              bytes: true,
              count: true,
              meta: true,
              tags: true,
            },
          },
          children: { recurse: { depth: 2 }, select: { count: true } },
        },
      },
      { initialData: false }
    );
    const { sql } = sealed[0]!;
    expect(sql).not.toMatch(JSON_FUNCTIONS);
    // A non-finite double is a JSON string, as the ordinary read carries it.
    expect(sql).toContain("IN ('NaN', 'Infinity', '-Infinity')");
    // Recursive rows are named by their ordinal among the reached keys.
    expect(sql).toContain('"0viborm_node"');
  });

  it("reads fields named like the shape's own keys", async () => {
    const { db, driver } = live();
    driver.rows = [{ id: "o1", scalar: "S", gated: 1 }];
    const query = await db.odd.findManyRealtime();
    expect(query.data).toEqual([{ id: "o1", scalar: "S", gated: 1 }]);
    expect(realtimeData(JSON.parse(JSON.stringify(query)))).toEqual(query.data);
  });

  it("rejects exactly like the ordinary read", async () => {
    const { db, driver } = live();
    driver.rows = [];
    await expect(
      db.post.findUniqueOrThrowRealtime({ where: { id: "none" } })
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      db.post.findManyRealtime({ where: { nope: 1 } } as never)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("is observed like any read, renewals included", async () => {
    const units: string[] = [];
    const { base } = live();
    const db = base
      .$extends({
        name: "observer",
        observe: (unit, proceed) => {
          if (unit.kind === "operation")
            units.push(`${unit.model}.${unit.operation}`);
          return proceed();
        },
      })
      .$extends(neonRealtime({ realtime }));
    await db.post.findManyRealtime();
    await db.post
      .countRealtime(undefined, { initialData: false })
      .catch(() => undefined);
    expect(units).toEqual(["post.findMany", "post.count"]);
  });
});

describe("Neon Realtime refusals", () => {
  const refusal = (reason: RegExp) =>
    expect.objectContaining({
      name: "UnsupportedOperationError",
      message: expect.stringMatching(reason),
    });

  it("refuses a client it cannot serve, when it is extended", () => {
    const sqlite = createClient({
      schema: { post },
      driver: new PlanningDriver("sqlite"),
    });
    clients.push(sqlite);
    expect(() => sqlite.$extends(neonRealtime({ realtime }))).toThrow(
      UnsupportedOperationError
    );
    const authorized = createClient({
      schema: { post },
      driver: new NeonHTTPDriver({
        databaseUrl: "postgres://neon",
        options: { authToken: "jwt" },
      }),
    });
    clients.push(authorized);
    expect(() => authorized.$extends(neonRealtime({ realtime }))).toThrow(
      AUTH_TOKEN
    );
  });

  it("refuses reads whose answer depends on work only this process runs", async () => {
    const { base, driver } = live();
    const cases: [object, RegExp][] = [
      [
        base.$extends({ name: "t", statement: (context) => context.statement }),
        STATEMENT_TRANSFORMS,
      ],
      [
        base.$extends({
          name: "r",
          result: {
            post: {
              loud: {
                needs: { title: true },
                compute: (row: { title: string }) => row.title,
              },
            },
          },
        } as never),
        RESULT_FIELDS,
      ],
    ];
    for (const [client, reason] of cases) {
      const db = (client as typeof base).$extends(neonRealtime({ realtime }));
      await expect(db.post.findManyRealtime()).rejects.toEqual(refusal(reason));
    }
    const db = base.$extends(neonRealtime({ realtime }));
    await expect(
      db.$transaction(async (tx) => tx.post.findManyRealtime())
    ).rejects.toEqual(refusal(TRANSACTION));
    expect(
      driver.statements.filter((statement) => statement.startsWith("SELECT"))
    ).toEqual([]);
  });

  it("refuses query handlers that do not pass the read's own answer through", async () => {
    const { base, driver } = live();
    driver.rows = [ROW];
    for (const handler of [
      async () => [],
      async ({ proceed }: { proceed: () => Promise<unknown[]> }) => [
        ...(await proceed()),
      ],
    ]) {
      const db = base
        .$extends({
          name: "q",
          query: { post: { findMany: handler } },
        } as never)
        .$extends(neonRealtime({ realtime })) as typeof base & {
        post: Reads;
      };
      await expect(db.post.findManyRealtime!()).rejects.toEqual(
        refusal(QUERY_HANDLERS)
      );
    }
  });

  it("refuses projections the sealed SQL cannot carry", async () => {
    const { base } = live();
    const gated = base.$extends({
      name: "gates",
      rows: {
        control: "visibility",
        default: "all",
        models: {},
        verbs: {
          post: {
            predicates: { read: {}, secret: { id: "p1" } },
            read: "read",
            reads: { title: "secret" },
          },
        },
      },
    } as never) as typeof base;
    const db = base.$extends(neonRealtime({ realtime }));
    await expect(
      gated
        .$extends(neonRealtime({ realtime }))
        .post.findManyRealtime({ select: { title: true } })
    ).rejects.toEqual(refusal(READ_GATES));
    await expect(db.place.findManyRealtime()).rejects.toEqual(refusal(POINT));
    await expect(db.doc.findManyRealtime()).rejects.toEqual(refusal(VECTOR));
    await expect(
      db.place.findManyRealtime({
        select: {
          id: true,
          at: { _distance: { to: { longitude: 0, latitude: 0 } } },
        },
      })
    ).rejects.toEqual(refusal(DISTANCE));
  });
});

describe("Neon Realtime through permissions()", () => {
  const policy = permissions({
    actor: v.object({ id: v.string() }),
    models: { post: { read: { title: { actor: "id" } } } },
  });

  it("seals the permission-filtered read and admits renewals again", async () => {
    const { base, driver } = live();
    const db = base.$extends(policy).$extends(neonRealtime({ realtime }));
    const ada = db.$as({ id: "ada" });
    driver.rows = [ROW];
    const query = await ada.post.findManyRealtime({ select: { id: true } });
    expect(query.data).toEqual(
      await ada.post.findMany({ select: { id: true } })
    );
    const [first, ordinary] = driver.statements;
    expect(sealed[0]!.parameters.map(({ value }) => value)).toContain("ada");
    expect(first).toBe(ordinary);
    // The renewal passes the handlers again without reading the database.
    await ada.post.findManyRealtime(
      { select: { id: true } },
      { initialData: false }
    );
    expect(driver.statements).toHaveLength(2);
    // A model the policy does not list is forbidden, live or not.
    await expect(ada.place.findManyRealtime()).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(
      ada.place.findManyRealtime(undefined, { initialData: false })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ada.place.findMany()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a `{ now: true }` predicate, which sealing would freeze", async () => {
    const { base } = live();
    const ada = base
      .$extends(
        permissions({
          actor: v.object({ id: v.string() }),
          models: { post: { read: { createdAt: { lt: { now: true } } } } },
        })
      )
      .$extends(neonRealtime({ realtime }))
      .$as({ id: "ada" });
    for (const initialData of [true, false])
      await expect(
        ada.post.findManyRealtime(undefined, { initialData })
      ).rejects.toThrow(NOW);
  });

  it("follows permissions(), and a cached view has no live reads", () => {
    const { base } = live();
    expect(() =>
      base.$extends(neonRealtime({ realtime })).$extends(policy)
    ).toThrow(ClientInitializationError);
    const cached = base
      .$extends(cache({ driver: new MemoryCache() }))
      .$extends(neonRealtime({ realtime }));
    expect(
      (cached.$withCache().post as Partial<Reads>).findManyRealtime
    ).toBeUndefined();
  });
});
