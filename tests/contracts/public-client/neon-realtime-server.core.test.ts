/**
 * The server half of Neon Realtime against a recording PostgreSQL driver: the
 * nine live reads answer the ordinary value in a plain-JSON envelope, reject
 * like the ordinary read, observe like it, and refuse by name what the sealed
 * SQL cannot reproduce. Embedded PostgreSQL runs the sealed SQL itself in
 * `tests/providers/local/pglite-neon-realtime.test.ts`.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { NeonHTTPDriver } from "@drivers/neon-http";
import {
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
const AUTH_TOKEN = /authToken/;
const QUERY_HANDLERS = /query handlers/;
const STATEMENT_TRANSFORMS = /statement transforms/;
const RESULT_FIELDS = /computed result fields/;
const TRANSACTION = /transaction/;
const READ_GATES = /field read gates/;
const POINT = /point projection/;
const RECURSIVE_KEY = /recursive 'replies' without its key fields/;

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
const schema = { post, place };

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
    expect(realtimeData(renewal)).toBeUndefined();
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
        base.$extends({
          name: "q",
          query: { post: { findMany: ({ proceed }) => proceed() } },
        }),
        QUERY_HANDLERS,
      ],
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
      [
        base
          .$extends(
            permissions({
              actor: v.object({ id: v.string() }),
              models: { post: { read: true } },
            })
          )
          .$as({ id: "ada" }),
        QUERY_HANDLERS,
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
    await expect(
      db.post.findManyRealtime({
        select: {
          title: true,
          replies: { recurse: { depth: 2 }, select: { title: true } },
        },
      })
    ).rejects.toEqual(refusal(RECURSIVE_KEY));
  });
});
