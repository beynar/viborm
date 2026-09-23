/**
 * RQ-06 — every RQ-00 placement of a recursive relation projection, composed
 * through the SHIPPED client (`createClient`) on real in-memory SQLite.
 *
 * Recursion adds a projection, not a lifecycle, so each cell holds a placement
 * to the lifecycle it already had (features-docs/recursive-query.md §2.5, §5
 * "Execution placement" and "Resource behavior"; RQ-00's placement matrix):
 *
 *  1. every find verb, under `select` and under `include`, is ONE provider
 *     statement carrying the recursive CTE, admitted once;
 *  2. `create`, `update`, both `upsert` arms and `delete`, under `select` and
 *     under `include`, read back through their ordinary route: the same
 *     statements, in the same order, as the same mutation with an ordinary
 *     relation projection — post-write for the first four, the pre-delete
 *     snapshot for `delete` (the deleted subtree is what the result shows);
 *  3. nested placements — ordinary → recursive → ordinary, a second recursive
 *     slot inside the repeated node, one slot recursing at two positions — keep
 *     one statement with one isolated CTE and carrier per recursive position;
 *  4. the statement is one shape whatever the requested depth, and a
 *     5,000-level exhaustive chain decodes through the client;
 *  5. `$transaction([...])`: on a batch transport every member is admitted and
 *     prepared before the ONE batch is dispatched, and a member that cannot be
 *     prepared refuses the array before any statement exactly as its ordinary
 *     control does; on a transactional driver the array is one transaction;
 *  6. borrowed callback transactions stay the caller's: the operation opens a
 *     savepoint at most, and the caller alone commits or rolls back;
 *  7. read-only build answers the one read statement (D-64 unchanged: every
 *     write still answers no statement);
 *  8. request/query/statement/observation extension chains of 0, 1 and 5 keep
 *     the caller's `recurse` (no extension can inject or replace it), with one
 *     admission and one transform per statement per extension;
 *  9. the official default-omit path applies at every repeated level;
 * 10. concurrent recursive reads keep their own occurrences;
 * 11. a provider failure keeps the identity it has for the ordinary relation
 *     projection, read and write: no recursion-specific retry or wrapping; the
 *     read is one statement; the write's statements, including the ordinary
 *     route's re-run of the refused INSERT, equal the ordinary control's;
 * 12. a result-phase refusal after acknowledged work — the FK-cycle refusal or
 *     a malformed carrier — reports that work exactly as the ordinary route
 *     does (FC-05/D-58 shape): the committed segment's progress, one
 *     invalidation, commit certainty — never a rollback claim; in the
 *     operation's own region it rolls back and claims nothing;
 * 13. a malformed recursive carrier is the operation's malformed provider
 *     result: the `QueryEngineError` (V9001) that an ordinary relation column
 *     answered as an object also publishes, its `meta.scalarType` naming the
 *     carrier check that refused it; the same read decodes the well-formed
 *     answer.
 *
 * Arguments are passed untyped (`Reflect.apply`): the cells vary placements,
 * and the public static surface is the type author's probe file.
 */

import assert from "node:assert/strict";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import {
  QueryEngineError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  VibORMError,
} from "@errors";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it, vi } from "vitest";
import { chainSummary } from "./provider-sql-fixture";

const LINK_TABLE = "rq06_composition_links";

const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    secret: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("rq06Tree"),
    children: s.toMany(() => node).name("rq06Tree"),
    links: s
      .toMany(() => node)
      .name("rq06Graph")
      .through(LINK_TABLE)
      .source("fromId")
      .target("toId"),
    linkedBy: s.toMany(() => node).name("rq06Graph"),
    notes: s.toMany(() => note).name("rq06Notes"),
  })
  .map("rq06_composition_nodes");

const note = s
  .model({
    id: s.string().id(),
    text: s.string(),
    nodeId: s.string(),
    node: s
      .toOne(() => node)
      .fields("nodeId")
      .references("id")
      .name("rq06Notes"),
  })
  .map("rq06_composition_notes");

const schema = { node, note };

/** r → a → a1 → a1x, a → a2, r → b; z stands alone. */
const TREE = [
  ["r", "Root", null],
  ["a", "A", "r"],
  ["b", "B", "r"],
  ["a1", "A1", "a"],
  ["a2", "A2", "a"],
  ["a1x", "A1x", "a1"],
  ["z", "Z", null],
] as const;
/** r → a → b → r is a junction cycle; a1 links to itself. */
const LINKS = [
  ["r", "a"],
  ["r", "b"],
  ["a", "b"],
  ["b", "r"],
  ["a1", "a1"],
] as const;
const NOTES = [
  ["n1", "about a1", "a1"],
  ["n2", "about r", "r"],
] as const;

const RECURSIVE = /WITH RECURSIVE/;
const CTE_NAME = /WITH RECURSIVE "([^"]+)"/g;
const LEADING_VERB = /^\s*(\w+)/;
const SAVEPOINT_NAME = /sp_[0-9a-f]+/g;
const FK_CYCLE = "Recursive relation 'children' contains a cycle.";

/**
 * The provider seen from the test: every statement (batched members included —
 * the stock batch runs them through `execute`), each transaction, batch and
 * control statement, and an optional fault on the rows a statement answered.
 */
class CompositionDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  readonly timeline: string[] = [];
  readonly control: string[] = [];
  transactions = 0;
  batches = 0;
  corrupt: ((statement: string, rows: unknown[]) => void) | undefined;

  reset(): void {
    this.statements.length = 0;
    this.timeline.length = 0;
    this.control.length = 0;
    this.transactions = 0;
    this.batches = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    this.timeline.push(`dispatch:${verbOf(statement)}`);
    const response = await super.execute<T>(client, statement, parameters);
    this.corrupt?.(statement, response.rows);
    return response;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches += 1;
    this.timeline.push(`batch:${queries.length}`);
    return super.executeBatch<T>(client, queries);
  }

  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[]
  ): Promise<QueryResult<T>> {
    this.control.push(statement.replace(SAVEPOINT_NAME, "sp"));
    return super.executeRaw<T>(client, statement, parameters);
  }

  protected override async transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>
  ): Promise<T> {
    this.transactions += 1;
    return super.transaction(client, body);
  }
}

/** A transport with no callback transactions: its atomic unit is the batch. */
class BatchOnlyCompositionDriver extends CompositionDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

const verbOf = (statement: string): string =>
  LEADING_VERB.exec(statement)?.[1]?.toUpperCase() ?? "?";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

async function world(
  transport: "transactional" | "batch-only" = "transactional"
) {
  const database = new Database(":memory:");
  const driver =
    transport === "batch-only"
      ? new BatchOnlyCompositionDriver({ client: database })
      : new CompositionDriver({ client: database });
  const client = createClient({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  if (!(await syncLiveSchema(client)).applied)
    throw new Error("the composition schema was not applied");
  const insertNode = database.prepare(
    "INSERT INTO rq06_composition_nodes(id, label, secret, parentId) VALUES (?, ?, ?, ?)"
  );
  for (const [id, label, parentId] of TREE)
    insertNode.run(id, label, `s-${id}`, parentId);
  const insertLink = database.prepare(
    `INSERT INTO ${LINK_TABLE}(fromId, toId) VALUES (?, ?)`
  );
  for (const [from, to] of LINKS) insertLink.run(from, to);
  const insertNote = database.prepare(
    "INSERT INTO rq06_composition_notes(id, text, nodeId) VALUES (?, ?, ?)"
  );
  for (const [id, text, nodeId] of NOTES) insertNote.run(id, text, nodeId);
  driver.reset();
  return { client, database, driver };
}

/** A property of an object-like value; client surfaces are callable proxies. */
const get = (value: unknown, key: PropertyKey): unknown =>
  (typeof value === "object" && value !== null) || typeof value === "function"
    ? Reflect.get(value, key)
    : undefined;

/** `target[method](...args)`, on a surface whose static type a cell ignores. */
function invoke(target: unknown, method: string, ...args: unknown[]): unknown {
  const member = get(target, method);
  if (typeof member !== "function") throw new Error(`no '${method}' here`);
  return Reflect.apply(member, target, args);
}

/** One pending model operation (lazy until awaited). */
const call = (
  client: unknown,
  model: string,
  operation: string,
  args: Record<string, unknown>
) => invoke(get(client, model), operation, args) as PromiseLike<unknown>;

/** Count the ONE admission boundary and log it on the provider's timeline. */
function spyAdmission(driver: CompositionDriver) {
  const admit = EngineSchema.prototype.admit;
  return vi.spyOn(EngineSchema.prototype, "admit").mockImplementation(function (
    this: EngineSchema,
    ...args
  ) {
    driver.timeline.push(`admit:${String(args[1])}`);
    return admit.apply(this, args);
  });
}

/** Log every prepared read's construction on the provider's timeline. */
function spyPreparedReads(driver: CompositionDriver) {
  const read = Queries.prototype.read;
  return vi.spyOn(Queries.prototype, "read").mockImplementation(function (
    this: Queries,
    ...args
  ) {
    driver.timeline.push(`prepare:${String(args[1])}`);
    return read.apply(this, args);
  });
}

interface Measured {
  readonly value: unknown;
  readonly failure: unknown;
  readonly statements: readonly string[];
  readonly admissions: number;
}

/** One operation's value or failure, its statements and its admissions. */
async function measure(
  driver: CompositionDriver,
  run: () => PromiseLike<unknown>
): Promise<Measured> {
  const admissions = spyAdmission(driver);
  const start = driver.statements.length;
  try {
    return {
      value: await run(),
      failure: undefined,
      statements: driver.statements.slice(start),
      admissions: admissions.mock.calls.length,
    };
  } catch (failure) {
    return {
      value: undefined,
      failure,
      statements: driver.statements.slice(start),
      admissions: admissions.mock.calls.length,
    };
  } finally {
    admissions.mockRestore();
  }
}

const recursiveStatements = (statements: readonly string[]) =>
  statements.filter((statement) => RECURSIVE.test(statement));

/** The published failure, minus the one field no two executions share. */
function identity(failure: unknown): unknown {
  if (!(failure instanceof VibORMError))
    return { raw: failure instanceof Error ? failure.name : String(failure) };
  const { correlationId: _correlationId, ...meta } = failure.meta as Record<
    string,
    unknown
  >;
  return {
    name: failure.name,
    code: failure.code,
    message: failure.message,
    meta,
  };
}

/** A chain read iteratively: the ids along it and how it ends. */
const chainOf = chainSummary("children", "id");

// ---------------------------------------------------------------------------
// Shared projections and their hand-written answers (from TREE above)
// ---------------------------------------------------------------------------

const treeSelect = () => ({
  id: true,
  label: true,
  children: {
    recurse: { depth: 2 },
    orderBy: { id: "asc" },
    select: { id: true, label: true },
  },
});
const treeInclude = () => ({
  children: { recurse: { depth: 2 }, orderBy: { id: "asc" } },
});

const R_SELECTED = {
  id: "r",
  label: "Root",
  children: [
    {
      id: "a",
      label: "A",
      children: [
        { id: "a1", label: "A1" },
        { id: "a2", label: "A2" },
      ],
    },
    { id: "b", label: "B", children: [] },
  ],
};
const Z_SELECTED = { id: "z", label: "Z", children: [] };
const row = (id: string, label: string, parentId: string | null) => ({
  id,
  label,
  secret: `s-${id}`,
  parentId,
});
const R_INCLUDED = {
  ...row("r", "Root", null),
  children: [
    {
      ...row("a", "A", "r"),
      children: [row("a1", "A1", "a"), row("a2", "A2", "a")],
    },
    { ...row("b", "B", "r"), children: [] },
  ],
};
const Z_INCLUDED = { ...row("z", "Z", null), children: [] };

describe("RQ-06 recursive projections composed through the shipped client", () => {
  it("1. every find verb projects one recursive statement under select and include", async () => {
    const { client, driver } = await world();
    const roots = { where: { parentId: null } };
    const placements: [string, Record<string, unknown>, unknown][] = [
      ["findUnique", { where: { id: "r" }, select: treeSelect() }, R_SELECTED],
      [
        "findUnique",
        { where: { id: "r" }, include: treeInclude() },
        R_INCLUDED,
      ],
      [
        "findUniqueOrThrow",
        { where: { id: "r" }, select: treeSelect() },
        R_SELECTED,
      ],
      [
        "findUniqueOrThrow",
        { where: { id: "r" }, include: treeInclude() },
        R_INCLUDED,
      ],
      // Root pagination stays ordinary: roots r and z, descending, skip one.
      [
        "findFirst",
        { ...roots, orderBy: { id: "desc" }, skip: 1, select: treeSelect() },
        R_SELECTED,
      ],
      [
        "findFirst",
        { ...roots, orderBy: { id: "desc" }, skip: 1, include: treeInclude() },
        R_INCLUDED,
      ],
      [
        "findFirstOrThrow",
        { where: { label: "Root" }, select: treeSelect() },
        R_SELECTED,
      ],
      [
        "findFirstOrThrow",
        { where: { label: "Root" }, include: treeInclude() },
        R_INCLUDED,
      ],
      [
        "findMany",
        { ...roots, orderBy: { id: "asc" }, take: 2, select: treeSelect() },
        [R_SELECTED, Z_SELECTED],
      ],
      [
        "findMany",
        { ...roots, orderBy: { id: "asc" }, take: 2, include: treeInclude() },
        [R_INCLUDED, Z_INCLUDED],
      ],
    ];
    for (const [operation, args, expected] of placements) {
      const seen = await measure(driver, () =>
        call(client, "node", operation, args)
      );
      const label = `${operation} ${"select" in args ? "select" : "include"}`;
      assert.equal(seen.failure, undefined, label);
      assert.deepStrictEqual(seen.value, expected, label);
      assert.equal(seen.statements.length, 1, `${label}: statements`);
      assert.equal(recursiveStatements(seen.statements).length, 1, label);
      assert.equal(seen.admissions, 1, `${label}: admissions`);
    }
    // The …OrThrow arm is the ordinary one: a missing row, one statement.
    const missing = await measure(driver, () =>
      call(client, "node", "findUniqueOrThrow", {
        where: { id: "absent" },
        select: treeSelect(),
      })
    );
    assert.equal(get(missing.failure, "name"), "NotFoundError");
    assert.equal(missing.statements.length, 1);
    assert.equal(missing.admissions, 1);
  });

  it("2. create, update, both upsert arms and delete read back through their ordinary route under select and include", async () => {
    // Every mutation runs under both projections: the recursive slot against
    // the same slot without `recurse`, each in a fresh world.
    const projections = ["select", "include"] as const;
    type Projection = (typeof projections)[number];
    const slots: Readonly<
      Record<
        Projection,
        { readonly recursive: unknown; readonly ordinary: unknown }
      >
    > = {
      select: {
        recursive: { recurse: true, select: { id: true } },
        ordinary: { select: { id: true } },
      },
      include: { recursive: { recurse: true }, ordinary: true },
    };
    /** a1x's included ancestry: a1x → a1 → a → r, then `null`. */
    const a1xIncluded = {
      ...row("a1x", "A1x", "a1"),
      parent: {
        ...row("a1", "A1", "a"),
        parent: {
          ...row("a", "A", "r"),
          parent: { ...row("r", "Root", null), parent: null },
        },
      },
    };
    const mutations: {
      readonly name: string;
      readonly operation: string;
      readonly args: (
        projection: Record<string, unknown>
      ) => Record<string, unknown>;
      /** The fields selected beside `parent` under `select`. */
      readonly selected: Record<string, unknown>;
      readonly expected: Readonly<Record<Projection, unknown>>;
      readonly control: Readonly<Record<Projection, unknown>>;
    }[] = [
      {
        name: "create",
        operation: "create",
        args: (projection) => ({
          data: { id: "n", label: "N", secret: "s-n", parentId: "a1x" },
          ...projection,
        }),
        selected: { id: true },
        expected: {
          select: {
            id: "n",
            parent: {
              id: "a1x",
              parent: {
                id: "a1",
                parent: { id: "a", parent: { id: "r", parent: null } },
              },
            },
          },
          include: { ...row("n", "N", "a1x"), parent: a1xIncluded },
        },
        control: {
          select: { id: "n", parent: { id: "a1x" } },
          include: {
            ...row("n", "N", "a1x"),
            parent: row("a1x", "A1x", "a1"),
          },
        },
      },
      {
        // Post-write: the moved row's new ancestry is what recursion reads.
        name: "update",
        operation: "update",
        args: (projection) => ({
          where: { id: "a" },
          data: { parentId: "b" },
          ...projection,
        }),
        selected: { id: true },
        expected: {
          select: {
            id: "a",
            parent: { id: "b", parent: { id: "r", parent: null } },
          },
          include: {
            ...row("a", "A", "b"),
            parent: {
              ...row("b", "B", "r"),
              parent: { ...row("r", "Root", null), parent: null },
            },
          },
        },
        control: {
          select: { id: "a", parent: { id: "b" } },
          include: { ...row("a", "A", "b"), parent: row("b", "B", "r") },
        },
      },
      {
        name: "upsert (create arm)",
        operation: "upsert",
        args: (projection) => ({
          where: { id: "u" },
          create: { id: "u", label: "U", secret: "s-u", parentId: "a1x" },
          update: { label: "U2" },
          ...projection,
        }),
        selected: { id: true, label: true },
        expected: {
          select: {
            id: "u",
            label: "U",
            parent: {
              id: "a1x",
              parent: {
                id: "a1",
                parent: { id: "a", parent: { id: "r", parent: null } },
              },
            },
          },
          include: { ...row("u", "U", "a1x"), parent: a1xIncluded },
        },
        control: {
          select: { id: "u", label: "U", parent: { id: "a1x" } },
          include: {
            ...row("u", "U", "a1x"),
            parent: row("a1x", "A1x", "a1"),
          },
        },
      },
      {
        name: "upsert (update arm)",
        operation: "upsert",
        args: (projection) => ({
          where: { id: "a2" },
          create: { id: "a2", label: "unused", secret: "s", parentId: null },
          update: { parentId: "a1x" },
          ...projection,
        }),
        selected: { id: true, label: true },
        expected: {
          select: {
            id: "a2",
            label: "A2",
            parent: {
              id: "a1x",
              parent: {
                id: "a1",
                parent: { id: "a", parent: { id: "r", parent: null } },
              },
            },
          },
          include: { ...row("a2", "A2", "a1x"), parent: a1xIncluded },
        },
        control: {
          select: { id: "a2", label: "A2", parent: { id: "a1x" } },
          include: {
            ...row("a2", "A2", "a1x"),
            parent: row("a1x", "A1x", "a1"),
          },
        },
      },
    ];
    for (const mutation of mutations)
      for (const projection of projections) {
        const project = (parent: unknown) =>
          projection === "select"
            ? { select: { ...mutation.selected, parent } }
            : { include: { parent } };
        const control = await world();
        const controlRun = await measure(control.driver, () =>
          call(
            control.client,
            "node",
            mutation.operation,
            mutation.args(project(slots[projection].ordinary))
          )
        );
        const subject = await world();
        const run = await measure(subject.driver, () =>
          call(
            subject.client,
            "node",
            mutation.operation,
            mutation.args(project(slots[projection].recursive))
          )
        );
        const label = `${mutation.name} under ${projection}`;
        assert.equal(controlRun.failure, undefined, `${label}: control`);
        assert.deepStrictEqual(
          controlRun.value,
          mutation.control[projection],
          label
        );
        assert.equal(run.failure, undefined, label);
        assert.deepStrictEqual(run.value, mutation.expected[projection], label);
        // The same route: the same statements in the same order; the ONE
        // recursive read sits where the ordinary relation read sits — last,
        // after the write.
        assert.deepEqual(
          run.statements.map(verbOf),
          controlRun.statements.map(verbOf),
          `${label}: route`
        );
        assert.equal(
          recursiveStatements(controlRun.statements).length,
          0,
          label
        );
        assert.equal(recursiveStatements(run.statements).length, 1, label);
        assert.match(run.statements.at(-1)!, RECURSIVE, `${label}: readback`);
        assert.ok(
          run.statements.slice(0, -1).some((sql) => verbOf(sql) !== "SELECT"),
          `${label}: the write precedes the read`
        );
        assert.equal(run.admissions, 1, `${label}: admissions`);
        assert.equal(
          subject.driver.transactions,
          control.driver.transactions,
          `${label}: transactions`
        );
      }

    // `delete`: the pre-delete snapshot, under both projections. The subtree
    // the result shows is the one that existed; afterwards `a` is gone and its
    // children are detached (the nullable reference's own ON DELETE SET NULL).
    const deletions: Readonly<
      Record<
        Projection,
        {
          readonly ordinary: Record<string, unknown>;
          readonly recursive: Record<string, unknown>;
          readonly control: unknown;
          readonly expected: unknown;
        }
      >
    > = {
      select: {
        ordinary: {
          select: {
            id: true,
            children: { orderBy: { id: "asc" }, select: { id: true } },
          },
        },
        recursive: {
          select: {
            id: true,
            children: {
              recurse: true,
              orderBy: { id: "asc" },
              select: { id: true },
            },
          },
        },
        control: { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
        expected: {
          id: "a",
          children: [
            { id: "a1", children: [{ id: "a1x", children: [] }] },
            { id: "a2", children: [] },
          ],
        },
      },
      include: {
        ordinary: { include: { children: { orderBy: { id: "asc" } } } },
        recursive: {
          include: { children: { recurse: true, orderBy: { id: "asc" } } },
        },
        control: {
          ...row("a", "A", "r"),
          children: [row("a1", "A1", "a"), row("a2", "A2", "a")],
        },
        expected: {
          ...row("a", "A", "r"),
          children: [
            {
              ...row("a1", "A1", "a"),
              children: [{ ...row("a1x", "A1x", "a1"), children: [] }],
            },
            { ...row("a2", "A2", "a"), children: [] },
          ],
        },
      },
    };
    for (const projection of projections) {
      const deletion = deletions[projection];
      const control = await world();
      const controlRun = await measure(control.driver, () =>
        call(control.client, "node", "delete", {
          where: { id: "a" },
          ...deletion.ordinary,
        })
      );
      const subject = await world();
      const run = await measure(subject.driver, () =>
        call(subject.client, "node", "delete", {
          where: { id: "a" },
          ...deletion.recursive,
        })
      );
      const label = `delete under ${projection}`;
      assert.deepStrictEqual(controlRun.value, deletion.control, label);
      assert.deepStrictEqual(run.value, deletion.expected, label);
      assert.deepEqual(
        run.statements.map(verbOf),
        controlRun.statements.map(verbOf),
        `${label}: route`
      );
      const read = run.statements.findIndex((sql) => RECURSIVE.test(sql));
      const write = run.statements.findIndex((sql) => verbOf(sql) === "DELETE");
      assert.equal(recursiveStatements(run.statements).length, 1, label);
      assert.ok(
        read >= 0 && write > read,
        `${label}: the snapshot precedes the delete`
      );
      assert.equal(run.admissions, 1, `${label}: admissions`);
      assert.deepEqual(
        subject.database
          .prepare(
            "SELECT id, parentId FROM rq06_composition_nodes WHERE id IN ('a', 'a1', 'a2', 'a1x') ORDER BY id"
          )
          .all(),
        [
          { id: "a1", parentId: null },
          { id: "a1x", parentId: "a1" },
          { id: "a2", parentId: null },
        ],
        label
      );
    }
  });
  it("3. nested placements keep one statement and one isolated carrier per recursive position", async () => {
    const { client, driver } = await world();
    // Ordinary → recursive → ordinary.
    const nested = await measure(driver, () =>
      call(client, "note", "findMany", {
        orderBy: { id: "asc" },
        select: {
          text: true,
          node: {
            select: {
              id: true,
              children: {
                recurse: true,
                orderBy: { id: "asc" },
                select: {
                  id: true,
                  notes: { orderBy: { id: "asc" }, select: { text: true } },
                },
              },
            },
          },
        },
      })
    );
    assert.deepStrictEqual(nested.value, [
      {
        text: "about a1",
        node: {
          id: "a1",
          children: [{ id: "a1x", notes: [], children: [] }],
        },
      },
      {
        text: "about r",
        node: {
          id: "r",
          children: [
            {
              id: "a",
              notes: [],
              children: [
                {
                  id: "a1",
                  notes: [{ text: "about a1" }],
                  children: [{ id: "a1x", notes: [], children: [] }],
                },
                { id: "a2", notes: [], children: [] },
              ],
            },
            { id: "b", notes: [], children: [] },
          ],
        },
      },
    ]);
    assert.equal(nested.statements.length, 1);
    assert.equal(nested.admissions, 1);

    // A second recursive slot inside the repeated node: parent recursion whose
    // every occurrence also recurses into its children.
    const second = await measure(driver, () =>
      call(client, "node", "findUnique", {
        where: { id: "a1x" },
        select: {
          id: true,
          parent: {
            recurse: { depth: 2 },
            select: {
              id: true,
              children: {
                recurse: { depth: 1 },
                orderBy: { id: "asc" },
                select: { id: true },
              },
            },
          },
        },
      })
    );
    assert.deepStrictEqual(second.value, {
      id: "a1x",
      parent: {
        id: "a1",
        children: [{ id: "a1x" }],
        parent: { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
      },
    });

    // One slot recursing at two positions, under two different depths.
    const repeated = await measure(driver, () =>
      call(client, "node", "findUnique", {
        where: { id: "r" },
        select: {
          id: true,
          children: {
            recurse: { depth: 1 },
            orderBy: { id: "asc" },
            select: { id: true },
          },
          notes: {
            select: {
              text: true,
              node: {
                select: {
                  id: true,
                  children: {
                    recurse: { depth: 2 },
                    orderBy: { id: "asc" },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      })
    );
    assert.deepStrictEqual(repeated.value, {
      id: "r",
      children: [{ id: "a" }, { id: "b" }],
      notes: [
        {
          text: "about r",
          node: {
            id: "r",
            children: [
              { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
              { id: "b", children: [] },
            ],
          },
        },
      ],
    });
    for (const [label, seen, positions] of [
      ["second slot", second, 2],
      ["repeated slot", repeated, 2],
    ] as const) {
      assert.equal(seen.statements.length, 1, label);
      assert.equal(seen.admissions, 1, label);
      const names = [...seen.statements[0]!.matchAll(CTE_NAME)].map(
        (match) => match[1]
      );
      assert.equal(names.length, positions, `${label}: one CTE per position`);
      assert.equal(new Set(names).size, positions, `${label}: isolated names`);
    }
  });

  it("4. one statement shape at every requested depth, and a 5,000-level chain", async () => {
    const database = new Database(":memory:");
    const driver = new CompositionDriver({ client: database });
    const client = createClient({ schema, driver });
    closers.push(async () => {
      await client.$disconnect();
      database.close();
    });
    assert.equal((await syncLiveSchema(client)).applied, true);
    const LENGTH = 5000;
    const idOf = (index: number) => `c${String(index).padStart(5, "0")}`;
    const insert = database.prepare(
      "INSERT INTO rq06_composition_nodes(id, label, secret, parentId) VALUES (?, ?, ?, ?)"
    );
    database.transaction(() => {
      for (let index = 0; index < LENGTH; index += 1)
        insert.run(
          idOf(index),
          idOf(index),
          "s",
          index === 0 ? null : idOf(index - 1)
        );
    })();
    driver.reset();
    const read = (recurse: unknown) => ({
      where: { id: idOf(0) },
      select: {
        id: true,
        children: { recurse, orderBy: { id: "asc" }, select: { id: true } },
      },
    });
    const bounded: string[] = [];
    for (const [recurse, length, end] of [
      [{ depth: 1 }, 1, "omitted"],
      [{ depth: 2 }, 2, "omitted"],
      [{ depth: 8 }, 8, "omitted"],
      [{ depth: 32 }, 32, "omitted"],
      [true, 100, "omitted"],
      [{ depth: 1000 }, 1000, "omitted"],
    ] as const) {
      const seen = await measure(driver, () =>
        call(client, "node", "findUnique", read(recurse))
      );
      assert.equal(seen.failure, undefined);
      assert.deepEqual(chainOf(seen.value).labels.length, length);
      assert.equal(chainOf(seen.value).end, end);
      assert.equal(seen.statements.length, 1, JSON.stringify(recurse));
      bounded.push(seen.statements[0]!);
    }
    // Depth is a bound value: every numeric depth runs the SAME statement text.
    assert.equal(new Set(bounded).size, 1);
    // Exhaustive: the whole 4,999-hop chain, decoded without a stack failure.
    const whole = await measure(driver, () =>
      call(client, "node", "findUnique", read({ depth: false }))
    );
    assert.equal(whole.failure, undefined, String(whole.failure));
    const chain = chainOf(whole.value);
    assert.equal(chain.labels.length, LENGTH - 1);
    assert.equal(chain.labels.at(-1), idOf(LENGTH - 1));
    assert.equal(chain.end, "empty");
    assert.equal(whole.statements.length, 1);
  });

  it("5. arrays prepare every member before one dispatch, or refuse before any", async () => {
    // Batch transport: the whole array is ONE batch, sent only after every
    // member was admitted and its statements prepared.
    const batch = await world("batch-only");
    const batchAdmissions = spyAdmission(batch.driver);
    const batchReads = spyPreparedReads(batch.driver);
    const members = [
      call(batch.client, "node", "findMany", {
        where: { id: "r" },
        select: treeSelect(),
      }),
      call(batch.client, "node", "findUnique", {
        where: { id: "r" },
        include: treeInclude(),
      }),
      call(batch.client, "node", "create", {
        data: { id: "n", label: "N", secret: "s-n", parentId: "a1x" },
        select: {
          id: true,
          parent: { recurse: { depth: 2 }, select: { id: true } },
        },
      }),
    ];
    assert.deepEqual(batch.driver.timeline, [], "construction is lazy");
    assert.deepStrictEqual(
      await invoke(batch.client, "$transaction", members),
      [
        [R_SELECTED],
        R_INCLUDED,
        { id: "n", parent: { id: "a1x", parent: { id: "a1" } } },
      ]
    );
    // Admission and preparation of the whole array, THEN the one batch: the
    // two reads' prepared statements and the create's fold (its recursive
    // readback included) exist before the provider sees anything.
    assert.deepEqual(batch.driver.timeline, [
      "admit:findMany",
      "prepare:findMany",
      "admit:findUnique",
      "prepare:findUnique",
      "admit:create",
      "batch:4",
      "dispatch:SELECT",
      "dispatch:SELECT",
      "dispatch:INSERT",
      "dispatch:SELECT",
    ]);
    assert.equal(batch.driver.batches, 1);
    assert.equal(recursiveStatements(batch.driver.statements).length, 3);
    assert.equal(batchAdmissions.mock.calls.length, 3);
    batchAdmissions.mockRestore();
    batchReads.mockRestore();

    // A member whose write needs a statement answered before it can be
    // prepared refuses the whole array BEFORE any statement — exactly as the
    // same member with an ordinary relation projection does. Every verb here
    // reads before it writes; only the projection differs between the pairs.
    const unprepared: readonly [
      string,
      (slot: Record<string, unknown>) => Record<string, unknown>,
    ][] = [
      [
        "update",
        (parent) => ({
          where: { id: "a" },
          data: { label: "A2" },
          select: { id: true, parent },
        }),
      ],
      [
        "upsert",
        (parent) => ({
          where: { id: "u" },
          create: { id: "u", label: "U", secret: "s-u", parentId: "a" },
          update: { label: "U2" },
          select: { id: true, parent },
        }),
      ],
      [
        "upsert",
        (parent) => ({
          where: { id: "a" },
          create: { id: "a", label: "A", secret: "s-a", parentId: "r" },
          update: { label: "A2" },
          select: { id: true, parent },
        }),
      ],
      [
        "delete",
        (children) => ({ where: { id: "a2" }, select: { id: true, children } }),
      ],
    ];
    for (const [operation, args] of unprepared)
      for (const slot of [
        { recurse: true, select: { id: true } },
        { select: { id: true } },
      ]) {
        const refused = await world("batch-only");
        const failure = await Promise.resolve(
          invoke(refused.client, "$transaction", [
            call(refused.client, "node", "findMany", {
              where: { id: "r" },
              select: treeSelect(),
            }),
            call(refused.client, "node", operation, args(slot)),
          ])
        ).then(
          () => undefined,
          (error: unknown) => error
        );
        const label = `${operation} ${"recurse" in slot ? "recursive" : "ordinary"}`;
        assert.ok(failure instanceof TransactionError, `${label}: ${failure}`);
        assert.deepEqual(refused.driver.statements, [], label);
        assert.equal(refused.driver.batches, 0, label);
      }

    // A transactional driver runs the array as ONE transaction, each member
    // admitted once, reads and mutation readbacks recursive alike; the
    // pre-delete snapshot already sees the earlier member's move.
    const plain = await world();
    const admissions = spyAdmission(plain.driver);
    assert.deepStrictEqual(
      await invoke(plain.client, "$transaction", [
        call(plain.client, "node", "findMany", {
          where: { id: "r" },
          select: treeSelect(),
        }),
        call(plain.client, "node", "update", {
          where: { id: "a2" },
          data: { parentId: "b" },
          select: { id: true, parent: { recurse: true, select: { id: true } } },
        }),
        call(plain.client, "node", "delete", {
          where: { id: "a" },
          select: {
            id: true,
            children: { recurse: true, select: { id: true } },
          },
        }),
      ]),
      [
        [R_SELECTED],
        { id: "a2", parent: { id: "b", parent: { id: "r", parent: null } } },
        {
          id: "a",
          children: [{ id: "a1", children: [{ id: "a1x", children: [] }] }],
        },
      ]
    );
    assert.equal(plain.driver.transactions, 1);
    assert.equal(admissions.mock.calls.length, 3);
    assert.equal(recursiveStatements(plain.driver.statements).length, 3);
  });

  it("6. a borrowed callback transaction stays the caller's", async () => {
    for (const rethrow of [false, true]) {
      const { client, database, driver } = await world();
      const admissions = spyAdmission(driver);
      let refused: unknown;
      const outcome = await Promise.resolve(
        invoke(client, "$transaction", async (tx: unknown) => {
          const tree = await call(tx, "node", "findMany", {
            where: { id: "r" },
            select: treeSelect(),
          });
          const moved = await call(tx, "node", "update", {
            where: { id: "a2" },
            data: { label: "A2 moved", parentId: "b" },
            select: {
              id: true,
              label: true,
              parent: { recurse: true, select: { id: true } },
            },
          });
          try {
            // Closes r → a → a1 → r inside the traversed window: the readback
            // refuses AFTER its own write ran in the caller's transaction.
            await call(tx, "node", "update", {
              where: { id: "r" },
              data: { parentId: "a1" },
              select: {
                id: true,
                children: { recurse: true, select: { id: true } },
              },
            });
          } catch (failure) {
            refused = failure;
            if (rethrow) throw failure;
          }
          return { tree, moved };
        })
      ).then(
        (value) => ({ value }),
        (failure: unknown) => ({ failure })
      );
      assert.ok(refused instanceof QueryEngineError, String(refused));
      assert.equal(refused.message, FK_CYCLE);
      // One transaction, the caller's. The one-statement read needs no region;
      // each multi-statement update is a savepoint inside the caller's scope,
      // and the refused one rolled back to its own savepoint only.
      assert.equal(driver.transactions, 1);
      assert.equal(
        admissions.mock.calls.length,
        3,
        "one admission per operation"
      );
      admissions.mockRestore();
      assert.deepEqual(driver.control, [
        "SAVEPOINT sp",
        "RELEASE SAVEPOINT sp",
        "SAVEPOINT sp",
        "ROLLBACK TO SAVEPOINT sp",
        "RELEASE SAVEPOINT sp",
      ]);
      const rows = database
        .prepare(
          "SELECT id, label, parentId FROM rq06_composition_nodes WHERE id IN ('a2', 'r') ORDER BY id"
        )
        .all();
      if (rethrow) {
        // The caller rolled back: nothing of the callback survives.
        assert.ok("failure" in outcome && outcome.failure === refused);
        assert.deepEqual(rows, [
          { id: "a2", label: "A2", parentId: "a" },
          { id: "r", label: "Root", parentId: null },
        ]);
      } else {
        // The caller committed: its first update survives; the refused one had
        // already been rolled back to its own savepoint.
        assert.ok("value" in outcome, String(get(outcome, "failure")));
        assert.deepStrictEqual(outcome.value, {
          tree: [R_SELECTED],
          moved: {
            id: "a2",
            label: "A2 moved",
            parent: { id: "b", parent: { id: "r", parent: null } },
          },
        });
        assert.deepEqual(rows, [
          { id: "a2", label: "A2 moved", parentId: "b" },
          { id: "r", label: "Root", parentId: null },
        ]);
      }
    }
  });

  it("7. read-only build answers the one read statement; every write still answers none (D-64)", async () => {
    const { client, driver } = await world();
    const admissions = spyAdmission(driver);
    const pending = call(client, "node", "findMany", {
      where: { id: "r" },
      select: treeSelect(),
    });
    const built = invoke(pending, "buildStatement");
    assert.ok(built, "a read builds its statement");
    assert.equal(
      invoke(pending, "buildStatement"),
      built,
      "asking twice answers the same statement, not a second lowering"
    );
    const text = invoke(built, "toStatement", "?");
    assert.equal(typeof text, "string");
    assert.match(String(text), RECURSIVE);
    assert.deepEqual(driver.statements, [], "building sends nothing");
    // Awaiting the SAME operation runs the statement it built, admitted once.
    assert.deepStrictEqual(await pending, [R_SELECTED]);
    assert.deepEqual(driver.statements, [text]);
    assert.equal(admissions.mock.calls.length, 1);
    const parent = { recurse: true, select: { id: true } };
    for (const [operation, args] of [
      [
        "create",
        {
          data: { id: "n", label: "N", secret: "s-n", parentId: "a" },
          select: { id: true, parent },
        },
      ],
      [
        "update",
        {
          where: { id: "a" },
          data: { label: "A!" },
          select: { id: true, parent },
        },
      ],
      [
        "upsert",
        {
          where: { id: "a" },
          create: { id: "a", label: "A", secret: "s", parentId: null },
          update: { label: "A!" },
          select: { id: true, parent },
        },
      ],
      [
        "delete",
        {
          where: { id: "a2" },
          select: {
            id: true,
            children: { recurse: true, select: { id: true } },
          },
        },
      ],
    ] as const) {
      const write = call(client, "node", operation, args);
      assert.equal(invoke(write, "buildStatement"), undefined, operation);
    }
    assert.deepEqual(driver.statements, [text], "no write was sent");
  });

  it("8. extension chains of 0, 1 and 5 cannot inject or replace recurse", async () => {
    const { client, driver } = await world();
    const calls: string[] = [];
    const seen: { recurse: unknown; frozen: boolean; replaced: boolean }[] = [];
    const inspect = (input: unknown) => {
      const slot =
        get(get(input, "select"), "children") ??
        get(get(input, "select"), "parent");
      const recurse = get(slot, "recurse");
      seen.push({
        // The admitted form is a null-prototype record; compare its entries.
        recurse:
          typeof recurse === "object" && recurse !== null
            ? { ...recurse }
            : recurse,
        frozen: Object.isFrozen(input) && Object.isFrozen(slot),
        replaced: Reflect.set(slot as object, "recurse", { depth: 1 }),
      });
    };
    const extension = (name: string) => ({
      name,
      request: {
        node: {
          findMany() {
            calls.push(`${name}:request`);
            // Every protected result-shape key, carrying a different recursion.
            return {
              select: { id: true, children: { recurse: { depth: 1 } } },
              include: { children: { recurse: { depth: false } } },
              omit: { label: true },
            };
          },
          update() {
            calls.push(`${name}:request`);
            return { select: { id: true, parent: { recurse: { depth: 1 } } } };
          },
        },
      },
      query: {
        node: {
          async findMany({
            input,
            proceed,
          }: {
            readonly input: unknown;
            readonly proceed: () => Promise<unknown>;
          }) {
            calls.push(`${name}:query`);
            inspect(input);
            return proceed();
          },
          async update({
            input,
            proceed,
          }: {
            readonly input: unknown;
            readonly proceed: () => Promise<unknown>;
          }) {
            calls.push(`${name}:query`);
            inspect(input);
            return proceed();
          },
        },
      },
      statement({ statement }: { readonly statement: unknown }) {
        calls.push(`${name}:statement`);
        return statement;
      },
      observe(unit: { readonly kind: string }) {
        if (unit.kind === "operation" || unit.kind === "statement")
          calls.push(`${name}:observe:${unit.kind}`);
      },
    });
    const extend = (chain: unknown, length: number) => {
      let extended = chain;
      for (let position = 1; position <= length; position += 1)
        extended = invoke(extended, "$extends", extension(`e${position}`));
      return extended;
    };
    const read = { where: { id: "r" }, select: treeSelect() };
    const write = {
      where: { id: "a1x" },
      data: { label: "A1x!" },
      select: {
        id: true,
        label: true,
        parent: { recurse: true, select: { id: true } },
      },
    };
    const readValue = [R_SELECTED];
    const writeValue = {
      id: "a1x",
      label: "A1x!",
      parent: {
        id: "a1",
        parent: { id: "a", parent: { id: "r", parent: null } },
      },
    };
    let writeStatements: number | undefined;
    for (const length of [0, 1, 5]) {
      const chain = extend(client, length);
      calls.length = 0;
      seen.length = 0;
      const reading = await measure(driver, () =>
        call(chain, "node", "findMany", read)
      );
      assert.equal(reading.failure, undefined, String(reading.failure));
      assert.deepStrictEqual(reading.value, readValue, `chain ${length}`);
      assert.equal(reading.statements.length, 1);
      assert.equal(reading.admissions, 1, `chain ${length}: admissions`);
      const writing = await measure(driver, () =>
        call(chain, "node", "update", write)
      );
      assert.equal(writing.failure, undefined, String(writing.failure));
      assert.deepStrictEqual(writing.value, writeValue, `chain ${length}`);
      assert.equal(writing.admissions, 1, `chain ${length}: admissions`);
      writeStatements ??= writing.statements.length;
      assert.equal(writing.statements.length, writeStatements);
      // Each extension ran once per operation and once per statement: no
      // handler ran twice, and none ran for a statement that was not sent.
      const statements = reading.statements.length + writing.statements.length;
      const count = (entry: string) =>
        calls.filter((other) => other === entry).length;
      for (let position = 1; position <= length; position += 1)
        assert.deepEqual(
          [
            "observe:operation",
            "request",
            "query",
            "observe:statement",
            "statement",
          ].map((kind) => count(`e${position}:${kind}`)),
          [2, 2, 2, statements, statements],
          `chain ${length}, e${position}`
        );
      assert.equal(calls.length, length * (6 + 2 * statements));
      // Interceptors read the ADMITTED recursion — the caller's, normalized —
      // frozen, and cannot write it back (the read's `depth: 2`, then the
      // write's default 100).
      const admitted = (depth: number) => ({
        recurse: { depth, cycles: "reject" },
        frozen: true,
        replaced: false,
      });
      assert.deepEqual(seen, [
        ...Array.from({ length }, () => admitted(2)),
        ...Array.from({ length }, () => admitted(100)),
      ]);
    }
    // A top-level `recurse` is no operation key: refused at admission, before
    // any statement.
    const injected = invoke(client, "$extends", {
      name: "rq06-top-level-recurse",
      request: () => ({ recurse: { depth: 3 } }),
    });
    const refused = await measure(driver, () =>
      call(injected, "node", "findMany", read)
    );
    assert.ok(
      refused.failure instanceof ValidationError,
      String(refused.failure)
    );
    assert.deepEqual(refused.statements, []);
  });

  it("9. the official default-omit path applies at every repeated level", async () => {
    const { client, driver } = await world();
    const omitting = invoke(
      client,
      "$extends",
      defaultOmit<typeof schema>()({ node: { secret: true } })
    );
    const withoutSecret = (value: Record<string, unknown>) => {
      const { secret: _secret, ...rest } = value;
      return rest;
    };
    const included = await measure(driver, () =>
      call(omitting, "node", "findUnique", {
        where: { id: "r" },
        include: treeInclude(),
      })
    );
    assert.deepStrictEqual(included.value, {
      ...withoutSecret(row("r", "Root", null)),
      children: [
        {
          ...withoutSecret(row("a", "A", "r")),
          children: [
            withoutSecret(row("a1", "A1", "a")),
            withoutSecret(row("a2", "A2", "a")),
          ],
        },
        { ...withoutSecret(row("b", "B", "r")), children: [] },
      ],
    });
    assert.equal(included.statements.length, 1);
    assert.equal(included.admissions, 1);
    // An explicit select overrides the client default at every level.
    const selected = await measure(driver, () =>
      call(omitting, "node", "findUnique", {
        where: { id: "a" },
        select: {
          id: true,
          children: {
            recurse: true,
            orderBy: { id: "asc" },
            select: { id: true, secret: true },
          },
        },
      })
    );
    assert.deepStrictEqual(selected.value, {
      id: "a",
      children: [
        {
          id: "a1",
          secret: "s-a1",
          children: [{ id: "a1x", secret: "s-a1x", children: [] }],
        },
        { id: "a2", secret: "s-a2", children: [] },
      ],
    });
    assert.equal(selected.statements.length, 1);
  });

  it("10. concurrent recursive reads keep their own statements and occurrences", async () => {
    const { client, driver } = await world();
    const admissions = spyAdmission(driver);
    const read = (id: string, recurse: unknown) =>
      call(client, "node", "findUnique", {
        where: { id },
        select: {
          id: true,
          children: { recurse, orderBy: { id: "asc" }, select: { id: true } },
        },
      });
    const whole = {
      id: "r",
      children: [
        {
          id: "a",
          children: [
            { id: "a1", children: [{ id: "a1x", children: [] }] },
            { id: "a2", children: [] },
          ],
        },
        { id: "b", children: [] },
      ],
    };
    const values = await Promise.all([
      read("r", { depth: 1 }),
      read("r", { depth: 2 }),
      read("a", true),
      read("a1", { depth: false }),
      read("z", true),
      read("r", { depth: false }),
    ]);
    assert.deepStrictEqual(values, [
      { id: "r", children: [{ id: "a" }, { id: "b" }] },
      {
        id: "r",
        children: [
          { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
          { id: "b", children: [] },
        ],
      },
      whole.children[0],
      { id: "a1", children: [{ id: "a1x", children: [] }] },
      { id: "z", children: [] },
      whole,
    ]);
    assert.equal(driver.statements.length, 6);
    assert.equal(admissions.mock.calls.length, 6);
    assert.equal(recursiveStatements(driver.statements).length, 6);
    const [, two, fromA, , , fromR] = values as {
      children: { children: object[] }[];
    }[];
    assert.notStrictEqual(two!.children[0], fromR!.children[0]);
    assert.notStrictEqual(fromA!.children[0], fromR!.children[0]!.children[0]);
  });

  it("11. a provider failure keeps the identity it has for the ordinary projection", async () => {
    // Read: the junction table is gone, so the provider rejects the statement.
    const reading = await world();
    reading.database.exec(`DROP TABLE ${LINK_TABLE}`);
    const recursiveRead = await measure(reading.driver, () =>
      call(reading.client, "node", "findUnique", {
        where: { id: "r" },
        select: { id: true, links: { recurse: true, select: { id: true } } },
      })
    );
    const ordinaryRead = await measure(reading.driver, () =>
      call(reading.client, "node", "findUnique", {
        where: { id: "r" },
        select: { id: true, links: { select: { id: true } } },
      })
    );
    // The provider's rejection, published as the execution failure it is for
    // any read — not a recursion-specific error.
    assert.deepEqual(identity(recursiveRead.failure), {
      name: "QueryError",
      code: "V2001",
      message: "Query execution failed",
      meta: { driver: "sqlite3", model: "node", operation: "findUnique" },
    });
    assert.deepEqual(
      identity(recursiveRead.failure),
      identity(ordinaryRead.failure)
    );
    assert.equal(recursiveRead.statements.length, 1, "no retry, no fallback");
    assert.match(recursiveRead.statements[0]!, RECURSIVE);
    assert.equal(ordinaryRead.statements.length, 1);
    assert.equal(recursiveRead.value, undefined, "no partial success");

    // Write: the provider refuses the INSERT, so no readback is ever sent.
    const duplicate = (parent: Record<string, unknown>) => ({
      data: { id: "a", label: "again", secret: "s", parentId: "r" },
      select: { id: true, parent },
    });
    const control = await world();
    const ordinaryWrite = await measure(control.driver, () =>
      call(
        control.client,
        "node",
        "create",
        duplicate({ select: { id: true } })
      )
    );
    const subject = await world();
    const recursiveWrite = await measure(subject.driver, () =>
      call(
        subject.client,
        "node",
        "create",
        duplicate({ recurse: true, select: { id: true } })
      )
    );
    assert.ok(recursiveWrite.failure instanceof UniqueConstraintError);
    assert.deepEqual(identity(recursiveWrite.failure), {
      name: "UniqueConstraintError",
      code: "V3001",
      message: "Unique constraint violation",
      meta: {
        columns: ["rq06_composition_nodes.id"],
        driver: "sqlite3",
        model: "node",
        operation: "create",
      },
    });
    assert.deepEqual(
      identity(recursiveWrite.failure),
      identity(ordinaryWrite.failure)
    );
    assert.deepEqual(
      recursiveWrite.statements.map(verbOf),
      ordinaryWrite.statements.map(verbOf)
    );
    assert.equal(recursiveStatements(recursiveWrite.statements).length, 0);
    assert.deepEqual(
      subject.database
        .prepare("SELECT id, label FROM rq06_composition_nodes WHERE id = 'a'")
        .all(),
      [{ id: "a", label: "A" }]
    );
  });

  it("12. a result-phase refusal after acknowledged work reports that work as the ordinary route does", async () => {
    /**
     * One cycle-closing update: recursive, recursive with a malformed carrier,
     * or with a corrupted ordinary readback.
     */
    async function refusedUpdate(
      transport: "transactional" | "batch-only",
      readback: "recursive" | "malformed" | "ordinary"
    ) {
      const { client, database, driver } = await world(transport);
      const invalidations: string[] = [];
      class InvalidationCache extends MemoryCache {
        protected override async clear(prefix: string): Promise<void> {
          invalidations.push(prefix);
          return super.clear(prefix);
        }
      }
      const background: Promise<unknown>[] = [];
      const completions: unknown[] = [];
      const extended = invoke(
        invoke(
          client,
          "$extends",
          cache({
            driver: new InvalidationCache(),
            waitUntil(promise) {
              background.push(promise);
            },
          })
        ),
        "$extends",
        {
          name: "rq06-outcome",
          observe(
            unit: { readonly kind: string },
            proceed: () => Promise<{
              readonly status: string;
              readonly commitCertainty?: string;
            }>
          ) {
            if (unit.kind !== "operation") return;
            proceed().then((completion) =>
              completions.push({
                status: completion.status,
                certainty: completion.commitCertainty,
              })
            );
          },
        }
      );
      if (readback === "ordinary")
        // The ordinary control's result phase fails the only way it can: the
        // provider answers its relation column malformed.
        driver.corrupt = (statement, rows) => {
          if (!RECURSIVE.test(statement))
            for (const answered of rows)
              if (
                typeof answered === "object" &&
                answered !== null &&
                Object.hasOwn(answered, "children")
              )
                Reflect.set(answered, "children", "{");
        };
      if (readback === "malformed")
        // The recursive readback's own fault: its carrier is not an object.
        driver.corrupt = (statement, rows) => {
          if (RECURSIVE.test(statement))
            for (const answered of rows)
              if (
                typeof answered === "object" &&
                answered !== null &&
                Object.hasOwn(answered, "children")
              )
                Reflect.set(answered, "children", "[]");
        };
      const children =
        readback === "ordinary"
          ? { select: { id: true } }
          : { recurse: true, select: { id: true } };
      const run = await measure(driver, () =>
        call(extended, "node", "update", {
          where: { id: "r" },
          // Closes r → a → a1 → r: inside the recursive readback's window.
          data: { parentId: "a1" },
          cache: { autoInvalidate: true },
          select: { id: true, children },
        })
      );
      await Promise.allSettled(background.splice(0));
      await Promise.resolve();
      return {
        failure: run.failure,
        progress: get(get(run.failure, "meta"), "recordSeriesProgress"),
        stored: database
          .prepare("SELECT parentId FROM rq06_composition_nodes WHERE id = 'r'")
          .get(),
        invalidations: invalidations.length,
        completions,
        admissions: run.admissions,
      };
    }

    // The batch transport acknowledges the write BEFORE it decodes: the write
    // is durable, and the refusal says so — it never claims a rollback.
    const recursive = await refusedUpdate("batch-only", "recursive");
    const malformed = await refusedUpdate("batch-only", "malformed");
    const ordinary = await refusedUpdate("batch-only", "ordinary");
    assert.ok(recursive.failure instanceof QueryEngineError);
    assert.equal(recursive.failure.message, FK_CYCLE);
    // A malformed carrier is the operation's malformed result (cell 13).
    const malformedCarrier =
      'Driver "sqlite3" returned a malformed recursive carrier scalar for operation "update": the carrier is not an object.';
    assert.ok(malformed.failure instanceof QueryEngineError);
    assert.equal(malformed.failure.message, malformedCarrier);
    assert.equal(malformed.failure.meta.scalarType, "recursive carrier");
    assert.ok(
      ordinary.failure instanceof VibORMError,
      String(ordinary.failure)
    );
    for (const observed of [recursive, malformed, ordinary])
      assert.deepEqual(
        {
          progress: observed.progress,
          stored: observed.stored,
          invalidations: observed.invalidations,
          completions: observed.completions,
          admissions: observed.admissions,
        },
        {
          progress: {
            atomicity: "segment",
            phase: "result",
            committedSegments: 1,
            committedWriteMembers: 1,
            completedMembers: 0,
          },
          stored: { parentId: "a1" },
          invalidations: 1,
          completions: [{ status: "failure", certainty: "committed" }],
          admissions: 1,
        }
      );

    // In the operation's OWN region the refusal rolls the write back, and
    // nothing is claimed: no progress, no invalidation, no certainty.
    const owned = await refusedUpdate("transactional", "recursive");
    const ownedMalformed = await refusedUpdate("transactional", "malformed");
    const ownedControl = await refusedUpdate("transactional", "ordinary");
    assert.ok(owned.failure instanceof QueryEngineError);
    assert.equal(owned.failure.message, FK_CYCLE);
    assert.ok(ownedMalformed.failure instanceof QueryEngineError);
    assert.equal(ownedMalformed.failure.message, malformedCarrier);
    for (const observed of [owned, ownedMalformed, ownedControl])
      assert.deepEqual(
        {
          progress: observed.progress,
          stored: observed.stored,
          invalidations: observed.invalidations,
          completions: observed.completions,
        },
        {
          progress: undefined,
          stored: { parentId: null },
          invalidations: 0,
          completions: [{ status: "failure", certainty: undefined }],
        }
      );
  });

  it("13. a malformed recursive carrier is the operation's malformed provider result", async () => {
    const { client, driver } = await world();
    /** r's junction graph to depth 3: r → a → b → r closes inside it. */
    const read = (links: Record<string, unknown>) =>
      measure(driver, () =>
        call(client, "node", "findUnique", {
          where: { id: "r" },
          select: {
            id: true,
            links: { ...links, orderBy: { id: "asc" }, select: { id: true } },
          },
        })
      );
    type Carrier = Record<string, unknown>;
    /** The driver answers every recursive carrier as `rewrite` spells it. */
    const answer = (rewrite: (carrier: Carrier) => unknown) => {
      driver.corrupt = (statement, rows) => {
        if (!RECURSIVE.test(statement)) return;
        for (const answered of rows) {
          const text = get(answered, "links");
          assert(
            typeof text === "string",
            "SQLite answers the carrier as text"
          );
          assert(typeof answered === "object" && answered !== null);
          Reflect.set(
            answered,
            "links",
            JSON.stringify(rewrite(JSON.parse(text)))
          );
        }
      };
    };
    /** One identity, spelled as the carrier spells a key tuple. */
    const key = (id: string) => JSON.stringify([id]);
    /** The carrier without the one `member` entry `drop` names. */
    const without = (
      carrier: Carrier,
      member: "__rq_nodes" | "__rq_edges",
      drop: (entry: unknown) => boolean
    ) => {
      const entries = carrier[member];
      assert(Array.isArray(entries));
      const kept = entries.filter((entry) => !drop(entry));
      assert.equal(kept.length, entries.length - 1, `one ${member} entry`);
      return { ...carrier, [member]: kept };
    };

    // The provider's own answer, through the same rewrite, decodes.
    answer((carrier) => carrier);
    const wellFormed = await read({ recurse: { depth: 3 } });
    assert.equal(wellFormed.failure, undefined, String(wellFormed.failure));
    assert.deepStrictEqual(wellFormed.value, {
      id: "r",
      links: [
        { id: "a", links: [{ id: "b", links: [] }] },
        { id: "b", links: [] },
      ],
    });

    const malformed: [string, (carrier: Carrier) => unknown, string][] = [
      ["recursive carrier", () => [], "the carrier is not an object"],
      [
        "recursive carrier",
        (carrier) => ({
          __rq_root: carrier.__rq_root,
          __rq_nodes: carrier.__rq_nodes,
        }),
        "the carrier's root, nodes or edges member is not an array",
      ],
      // P2: 'b' is reached at level 1 and, through 'a', at level 2; without
      // the level-3 fact b → r, the hop from 'b' at level 2 omits its child.
      [
        "recursive depth",
        (carrier) =>
          without(
            carrier,
            "__rq_edges",
            (edge) =>
              JSON.stringify(get(edge, "__rq_parent")) === key("b") &&
              JSON.stringify(get(edge, "__rq_child")) === key("r") &&
              get(edge, "__rq_depth") === 3
          ),
        "a hop below the cutoff omits some of its parent's children",
      ],
      [
        "recursive edge endpoint",
        (carrier) =>
          without(
            carrier,
            "__rq_nodes",
            (node) => JSON.stringify(get(node, "__rq_key")) === key("b")
          ),
        "an edge's child is not a carried node",
      ],
    ];
    for (const [scalarType, rewrite, reason] of malformed) {
      answer(rewrite);
      const seen = await read({ recurse: { depth: 3 } });
      assert.ok(seen.failure instanceof QueryEngineError, String(seen.failure));
      assert.deepEqual(identity(seen.failure), {
        name: "QueryEngineError",
        code: "V9001",
        message: `Driver "sqlite3" returned a malformed ${scalarType} scalar for operation "findUnique": ${reason}.`,
        meta: { driver: "sqlite3", operation: "findUnique", scalarType },
      });
      assert.equal(seen.value, undefined, "no partial answer");
      assert.equal(seen.statements.length, 1, "no retry, no fallback");
    }

    // The ordinary projection of the same relation, answered as an object
    // instead of an array, fails through the same translation.
    driver.corrupt = (_statement, rows) => {
      for (const answered of rows)
        if (
          typeof answered === "object" &&
          answered !== null &&
          Object.hasOwn(answered, "links")
        )
          Reflect.set(answered, "links", "{}");
    };
    const ordinary = await read({});
    assert.deepEqual(identity(ordinary.failure), {
      name: "QueryEngineError",
      code: "V9001",
      message:
        'Driver "sqlite3" returned a malformed collection scalar for operation "findUnique": a requested relation is not a provider array.',
      meta: {
        driver: "sqlite3",
        operation: "findUnique",
        scalarType: "collection",
      },
    });
  });
});
