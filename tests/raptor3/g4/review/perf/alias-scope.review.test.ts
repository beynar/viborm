/**
 * Independent review probe — G4 performance pass, item 3 (statement-scoped
 * SQL aliases).
 *
 * `Queries.rootAlias()` RESETS the instance counter to zero, so the safety of
 * the whole item rests on one unproven sentence in the author's note (§11
 * unverified claim 4): *"no statement owner is entered while another statement
 * is being built"*. If that is ever false, one statement declares `q0` twice
 * and the SQL is silently wrong — a correlated subquery would address the
 * root's own alias. The author established it by reading callers; this probe
 * measures it.
 *
 * Three questions the author's pin (`tests/raptor3/g4/unit02/prepared-statement-stability.test.ts`,
 * one `findUnique`, one nested `findMany`, one capped `deleteMany` on a
 * two-model world) does not ask:
 *
 * 1. is a statement owner ever RE-ENTERED across the whole shape battery —
 *    compound mapped keys, a junction, a variant collection, a self-relation,
 *    every read verb, and writes that assemble one statement from several
 *    `Queries` fragments?
 * 2. does any single published statement declare the same alias twice?
 * 3. is every published statement byte-stable across repeated identical calls
 *    on ONE engine, including the batch-preparation route where a presence
 *    guard is queued ahead of the mutation on the same `Queries`?
 */

import assert from "node:assert/strict";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { Queries } from "@query-engine/raptor3/shared/query";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import {
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "../../read-schema";
import { createWitnessWorld, type WitnessWorld } from "../../witness-world";

/** The six methods of `Queries` that open a statement's alias scope. */
const STATEMENT_OWNERS = [
  "select",
  "aggregated",
  "grouped",
  "selectSeries",
  "recursive",
  "junction",
] as const;

type OwnerName = (typeof STATEMENT_OWNERS)[number];
type AnyFunction = (...args: never[]) => unknown;

const entered: string[] = [];
let depth = 0;
let maxDepth = 0;
const originals = new Map<OwnerName, AnyFunction>();

beforeAll(() => {
  const prototype = Queries.prototype as unknown as Record<string, AnyFunction>;
  for (const owner of STATEMENT_OWNERS) {
    const original = prototype[owner];
    assert.equal(
      typeof original,
      "function",
      `Queries.${owner} is not a method — the probe's owner list is stale`
    );
    originals.set(owner, original!);
    prototype[owner] = function instrumented(
      this: unknown,
      ...args: never[]
    ): unknown {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      if (depth > 1) entered.push(owner);
      try {
        return original!.apply(this, args);
      } finally {
        depth--;
      }
    } as AnyFunction;
  }
});

afterAll(() => {
  const prototype = Queries.prototype as unknown as Record<string, AnyFunction>;
  for (const [owner, original] of originals) prototype[owner] = original;
});

/** Every `"qN"` an alias is DECLARED under in one statement. */
function declaredAliases(sql: string): string[] {
  return [...sql.matchAll(/AS "(q\d+)"/g)].map((match) => match[1]!);
}

function assertNoDuplicateAlias(label: string, sql: string): void {
  const declared = declaredAliases(sql);
  assert.deepEqual(
    [...new Set(declared)].length,
    declared.length,
    `${label} declared one alias twice: ${sql}`
  );
}

type Engine = ReturnType<typeof createCommandEngine>;
type EngineOperation = Parameters<Engine["execute"]>[1];

interface Call {
  readonly label: string;
  readonly model: string;
  readonly operation: EngineOperation;
  readonly args: unknown;
}

/** Reads and writes that reach every alias minter the read world can reach. */
const BATTERY: Call[] = [
  {
    label: "findUnique compound mapped key",
    model: "author",
    operation: "findUnique",
    args: { where: { tenant_handle: { tenant: "acme", handle: "ada" } } },
  },
  {
    label: "findMany nested to-many + to-one + counts",
    model: "author",
    operation: "findMany",
    args: {
      orderBy: { handle: "asc" },
      select: {
        handle: true,
        posts: { orderBy: { id: "asc" }, select: { id: true } },
        profile: { select: { headline: true } },
        _count: { select: { posts: true, tags: true } },
      },
    },
  },
  {
    label: "findMany junction collection",
    model: "author",
    operation: "findMany",
    args: {
      orderBy: { handle: "asc" },
      select: { handle: true, tags: { orderBy: { id: "asc" } } },
    },
  },
  {
    label: "findMany self-relation both directions",
    model: "author",
    operation: "findMany",
    args: {
      orderBy: { handle: "asc" },
      select: {
        handle: true,
        mentor: { select: { handle: true } },
        mentees: { orderBy: { handle: "asc" }, select: { handle: true } },
      },
    },
  },
  {
    label: "findMany variant collection",
    model: "board",
    operation: "findMany",
    args: { orderBy: { id: "asc" }, select: { id: true, items: true } },
  },
  {
    label: "findMany with a relation filter and a relation order term",
    model: "post",
    operation: "findMany",
    args: {
      where: { author: { is: { rank: { gt: 0 } } } },
      orderBy: { author: { rank: "asc" } },
    },
  },
  {
    label: "findMany cursor window",
    model: "post",
    operation: "findMany",
    args: {
      where: { views: { gte: 0 } },
      orderBy: { id: "asc" },
      cursor: { id: 2 },
      skip: 1,
      take: 2,
    },
  },
  {
    label: "findFirst with a to-many quantifier",
    model: "author",
    operation: "findFirst",
    args: {
      where: { posts: { some: { views: { gt: 5 } } } },
      orderBy: { handle: "asc" },
    },
  },
  {
    label: "count with a selection",
    model: "post",
    operation: "count",
    args: { select: { _all: true, id: true } },
  },
  {
    label: "count plain",
    model: "post",
    operation: "count",
    args: { where: { views: { gt: 1 } } },
  },
  {
    label: "aggregate",
    model: "post",
    operation: "aggregate",
    args: { _count: true, _sum: { views: true }, _max: { views: true } },
  },
  {
    label: "groupBy with having",
    model: "post",
    operation: "groupBy",
    args: {
      by: ["authorTenant"],
      _count: { id: true },
      orderBy: { authorTenant: "asc" },
    },
  },
  {
    label: "findMany paginated nested collection (two parents, one child set)",
    model: "author",
    operation: "findMany",
    args: {
      orderBy: { handle: "asc" },
      select: {
        handle: true,
        posts: { orderBy: { id: "asc" }, take: 1, skip: 0, select: { id: true } },
      },
    },
  },
];

/** Writes: several `Queries` fragments assemble ONE statement here. */
const WRITE_BATTERY: Call[] = [
  {
    label: "updateMany with a limit (capped subquery fragment + mutation)",
    model: "post",
    operation: "updateMany",
    args: { where: { views: { gt: 0 } }, data: { title: "x" }, limit: 1 },
  },
  {
    label: "deleteMany with a limit",
    model: "post",
    operation: "deleteMany",
    args: { where: { views: { lt: 0 } }, limit: 1 },
  },
  {
    label: "update with a nested junction set",
    model: "author",
    operation: "update",
    args: {
      where: { tenant_handle: { tenant: "acme", handle: "ada" } },
      data: { tags: { set: [{ id: 3 }] } },
    },
  },
  {
    label: "update with a nested to-many update",
    model: "author",
    operation: "update",
    args: {
      where: { tenant_handle: { tenant: "acme", handle: "ada" } },
      data: { posts: { update: [{ where: { id: 1 }, data: { views: 11 } }] } },
    },
  },
  {
    label: "createMany",
    model: "post",
    operation: "createMany",
    args: {
      data: [
        { id: 90, slug: "p-90", title: "Ninety", views: 1 },
        { id: 91, slug: "p-91", title: "Ninety one", views: 2 },
      ],
    },
  },
];

describe("G4 perf review — statement-scoped aliases never collide", () => {
  let world: WitnessWorld | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it("never re-enters a statement owner, and no statement declares an alias twice", async () => {
    const open = await createWitnessWorld(relationWorldSchema(), {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
    world = open;
    entered.length = 0;
    maxDepth = 0;
    const observed = new Map<string, string[]>();
    for (const call of [...BATTERY, ...WRITE_BATTERY]) {
      open.reset();
      await open.candidate.execute(call.model, call.operation, call.args);
      const sql = open.statements.map((statement) => statement.sql);
      assert.ok(sql.length > 0, `${call.label} dispatched no statement`);
      for (const statement of sql) assertNoDuplicateAlias(call.label, statement);
      observed.set(call.label, sql);
    }
    assert.deepEqual(
      entered,
      [],
      `a statement owner was entered while another statement was being built: ${entered.join(", ")}`
    );
    assert.equal(maxDepth, 1, "no statement owner ran at all");
    // The battery really does exercise nested scopes, or cell (2) is vacuous.
    const nested = observed.get("findMany nested to-many + to-one + counts")![0]!;
    assert.ok(
      declaredAliases(nested).length > 2,
      `the nested projection declared ${declaredAliases(nested).length} aliases: ${nested}`
    );
  });

  it("publishes byte-identical SQL for repeated identical calls on one engine", async () => {
    const open = await createWitnessWorld(relationWorldSchema(), {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
    world = open;
    const first = new Map<string, string[]>();
    for (const call of BATTERY) {
      open.reset();
      await open.candidate.execute(call.model, call.operation, call.args);
      first.set(
        call.label,
        open.statements.map((statement) => statement.sql)
      );
    }
    // Two full passes, so every call has other operations minting aliases
    // between its two observations.
    for (let pass = 0; pass < 2; pass++) {
      for (const call of BATTERY) {
        open.reset();
        await open.candidate.execute(call.model, call.operation, call.args);
        assert.deepEqual(
          open.statements.map((statement) => statement.sql),
          first.get(call.label),
          `${call.label} published different SQL on pass ${pass + 2}`
        );
      }
    }
  });
});

/** A D1-shaped batch-only driver: the batch-preparation route, recorded. */
class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly statements: string[] = [];
  reset(): void {
    this.statements.length = 0;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries, context);
  }
}

describe("G4 perf review — the packaged route shares one alias owner", () => {
  let world: WitnessWorld | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it("queues a presence guard and its mutation without colliding aliases, twice identically", async () => {
    const schema = relationWorldSchema();
    const open = await createWitnessWorld(schema, {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
    world = open;
    const driver = new BatchOnlyDriver({ client: open.database });
    const engine = createCommandEngine({ schema, driver });
    entered.length = 0;
    const runs: string[][] = [];
    for (let pass = 0; pass < 3; pass++) {
      driver.reset();
      await engine.execute("post", "update", {
        where: { id: 1 },
        data: { views: 10 + pass },
      });
      // The guard and the mutation are two statements of ONE operation, built
      // by one `Queries`: each must be internally consistent…
      for (const statement of driver.statements)
        assertNoDuplicateAlias("packaged root update", statement);
      runs.push([...driver.statements]);
    }
    assert.ok(runs[0]!.length >= 1, "the packaged route dispatched nothing");
    // …and the whole operation's text must not drift between calls.
    assert.deepEqual(runs[1], runs[0]);
    assert.deepEqual(runs[2], runs[0]);
    assert.deepEqual(entered, []);
  });
});
