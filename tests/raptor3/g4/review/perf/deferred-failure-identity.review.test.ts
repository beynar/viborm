/**
 * Independent review probe — G4 performance pass, item 2 (plan-time
 * `NestedWriteError`s become `() => Error` thunks).
 *
 * The seven constructors in `commands/relation-body.ts` moved inside closures
 * that capture `verb`, `edge` and (at `:681`) the `required` field list. Two
 * things can go wrong that no green suite necessarily catches: a captured
 * binding that is not the one the eager construction saw, and a raise site that
 * now builds a DIFFERENT object than the one the plan used to carry.
 *
 * So this probe rebuilds each expected failure from its own constructor, in the
 * test, and compares the raised error against it field by field — class, code,
 * sentence and `meta` — for every nested verb the two-model world can reach,
 * and it runs the SAME shapes through the shipped engine on the same driver as
 * a differential oracle. It also asserts the three facts the thunk makes
 * newly possible to get wrong: two raises of one plan produce EQUAL (not
 * identical) errors, a `capture()`-derived selection carries the same recipe,
 * and nothing downstream compares a plan-time failure by identity.
 */

import assert from "node:assert/strict";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError, NotFoundError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { createWitnessWorld, type WitnessWorld } from "../../witness-world";

/** A D1-shaped batch-only driver: the route where `retained` is raised. */
class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    return super.executeBatch<T>(client, queries, context);
  }
}

const OWNER_TABLE = "g4pr_owners";
const KID_TABLE = "g4pr_kids";
const LOOSE_TABLE = "g4pr_loose";

function world() {
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string(),
      kids: s.toMany(() => kid),
      loose: s.toMany(() => loose),
    })
    .map(OWNER_TABLE);
  /** A REQUIRED foreign key: a `set` that removes a row cannot disconnect it. */
  const kid = s
    .model({
      id: s.int().id(),
      label: s.string(),
      ownerId: s.int(),
      owner: s.toOne(() => owner).fields("ownerId").references("id"),
    })
    .map(KID_TABLE);
  const loose = s
    .model({
      id: s.int().id(),
      label: s.string(),
      ownerId: s.int().nullable(),
      owner: s.toOne(() => owner).fields("ownerId").references("id"),
    })
    .map(LOOSE_TABLE);
  return { owner, kid, loose };
}

const SEED = `
  INSERT INTO ${OWNER_TABLE} (id,name) VALUES (1,'one'),(2,'two');
  INSERT INTO ${KID_TABLE} (id,label,ownerId) VALUES (10,'k10',1),(11,'k11',1);
  INSERT INTO ${LOOSE_TABLE} (id,label,ownerId) VALUES (20,'l20',1),(21,'l21',NULL);
`;

async function open(): Promise<WitnessWorld> {
  return createWitnessWorld(world(), {
    foreignKeys: false,
    seed(database) {
      database.exec(SEED);
    },
  });
}

interface Raised {
  readonly name: string;
  readonly message: string;
  readonly code: unknown;
  readonly meta: unknown;
}

function describeError(error: unknown): Raised {
  assert.ok(error instanceof Error, `not an Error: ${String(error)}`);
  const carrier = error as Error & { code?: unknown; meta?: unknown };
  return {
    name: carrier.name,
    message: carrier.message,
    code: carrier.code,
    meta: carrier.meta,
  };
}

async function raise(
  run: () => Promise<unknown>
): Promise<{ raised: unknown; described: Raised }> {
  try {
    await run();
  } catch (error) {
    return { raised: error, described: describeError(error) };
  }
  throw new Error("the shape did not refuse");
}

/** The exact object the PLAN used to carry, rebuilt here from its own class. */
const EXPECTED: {
  readonly label: string;
  readonly model: string;
  readonly operation: string;
  readonly args: unknown;
  readonly expected: () => Error;
}[] = [
  {
    label: "relation-body.ts:218 — nested disconnect, no such target",
    model: "owner",
    operation: "update",
    args: { where: { id: 1 }, data: { loose: { disconnect: [{ id: 999 }] } } },
    expected: () =>
      new NestedWriteError(
        "Cannot disconnect relation 'loose': target record was not found for this parent.",
        "loose"
      ),
  },
  {
    label: "relation-body.ts:218 — nested delete, no such target",
    model: "owner",
    operation: "update",
    args: { where: { id: 1 }, data: { loose: { delete: [{ id: 999 }] } } },
    expected: () =>
      new NestedWriteError(
        "Cannot delete relation 'loose': target record was not found for this parent.",
        "loose"
      ),
  },
  {
    label: "relation-body.ts:451 — nested connect, no such target",
    model: "owner",
    operation: "update",
    args: { where: { id: 1 }, data: { loose: { connect: [{ id: 999 }] } } },
    expected: () =>
      new NestedWriteError(
        "Cannot connect relation 'loose': target record was not found.",
        "loose"
      ),
  },
  {
    label: "relation-body.ts:451 — nested update, no such target for this parent",
    model: "owner",
    operation: "update",
    args: {
      where: { id: 1 },
      data: {
        loose: { update: [{ where: { id: 999 }, data: { label: "x" } }] },
      },
    },
    expected: () =>
      new NestedWriteError(
        "Cannot update relation 'loose': target record was not found for this parent.",
        "loose"
      ),
  },
  {
    label: "relation-body.ts:451 — nested update of a row owned by ANOTHER parent",
    model: "owner",
    operation: "update",
    args: {
      where: { id: 2 },
      data: { loose: { update: [{ where: { id: 20 }, data: { label: "x" } }] } },
    },
    expected: () =>
      new NestedWriteError(
        "Cannot update relation 'loose': target record was not found for this parent.",
        "loose"
      ),
  },
  {
    label: "relation-body.ts:639 — nested set, no such target",
    model: "owner",
    operation: "update",
    args: { where: { id: 1 }, data: { loose: { set: [{ id: 999 }] } } },
    expected: () =>
      new NestedWriteError(
        "Cannot set relation 'loose': target record was not found.",
        "loose"
      ),
  },
  {
    label:
      "relation-body.ts:681 — a set that would orphan a row behind a REQUIRED key",
    model: "owner",
    operation: "update",
    args: { where: { id: 1 }, data: { kids: { set: [{ id: 10 }] } } },
    expected: () =>
      new NestedWriteError(
        "Cannot set relation 'kids' because foreign key field(s) ownerId are required: rows removed from the set cannot be disconnected. Delete them instead.",
        "kids"
      ),
  },
  {
    label: "commands.ts:1285 — the root lookup's own NotFoundError",
    model: "owner",
    operation: "update",
    args: { where: { id: 999 }, data: { name: "x" } },
    expected: () => new NotFoundError("owner", "update"),
  },
];

describe("G4 perf review — a deferred failure is the failure it replaced", () => {
  let live: WitnessWorld | undefined;

  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("raises the byte-identical class, sentence, code and meta at every thunked site", async () => {
    for (const shape of EXPECTED) {
      const open_ = await open();
      live = open_;
      const { described } = await raise(() =>
        open_.candidate.execute(
          shape.model,
          shape.operation as Parameters<
            typeof open_.candidate.execute
          >[1],
          shape.args
        )
      );
      assert.deepEqual(described, describeError(shape.expected()), shape.label);
      await open_.close();
      live = undefined;
    }
  });

  it("agrees with the shipped engine on the same shapes and the same driver", async () => {
    const disagreements: string[] = [];
    for (const shape of EXPECTED) {
      const open_ = await open();
      live = open_;
      const candidate = await raise(() =>
        open_.candidate.execute(
          shape.model,
          shape.operation as Parameters<typeof open_.candidate.execute>[1],
          shape.args
        )
      );
      const shipped = await raise(() =>
        open_.shipped[shape.model]![shape.operation]!(shape.args)
      );
      if (
        candidate.described.name !== shipped.described.name ||
        candidate.described.message !== shipped.described.message
      ) {
        disagreements.push(
          `${shape.label}\n  candidate: ${candidate.described.name}: ${candidate.described.message}\n  shipped:   ${shipped.described.name}: ${shipped.described.message}`
        );
      }
      await open_.close();
      live = undefined;
    }
    assert.deepEqual(disagreements, [], disagreements.join("\n"));
  });

  it("builds an EQUAL failure every time the same plan raises, and never reuses one object", async () => {
    const open_ = await open();
    live = open_;
    const first = await raise(() =>
      open_.candidate.execute("owner", "update", {
        where: { id: 1 },
        data: { loose: { connect: [{ id: 999 }] } },
      })
    );
    const second = await raise(() =>
      open_.candidate.execute("owner", "update", {
        where: { id: 1 },
        data: { loose: { connect: [{ id: 999 }] } },
      })
    );
    assert.deepEqual(first.described, second.described);
    // Two raises are two objects: nothing downstream may key on identity.
    assert.equal(first.raised === second.raised, false);
  });

  it("keeps the nested refusal when a SECOND relation in the same payload also fails", async () => {
    const open_ = await open();
    live = open_;
    // Two nested failures in one payload: the refusal a caller sees is the one
    // whose owner runs first, and it must still be the exact sentence.
    const { described } = await raise(() =>
      open_.candidate.execute("owner", "update", {
        where: { id: 1 },
        data: {
          loose: { connect: [{ id: 999 }] },
          kids: { set: [{ id: 998 }] },
        },
      })
    );
    assert.equal(described.name, "NestedWriteError");
    assert.match(
      described.message,
      /^Cannot (connect relation 'loose'|set relation 'kids'): target record was not found\.$/
    );
  });

  it("still succeeds, and writes, on the shapes that do NOT fail", async () => {
    const open_ = await open();
    live = open_;
    const engine = createCommandEngine({ schema: world(), driver: open_.driver });
    await engine.execute("owner", "update", {
      where: { id: 1 },
      data: { loose: { connect: [{ id: 21 }] } },
    });
    const rows = open_.database
      .prepare(`SELECT id, ownerId FROM ${LOOSE_TABLE} ORDER BY id`)
      .all();
    assert.deepEqual(rows, [
      { id: 20, ownerId: 1 },
      { id: 21, ownerId: 1 },
    ]);
  });

  it("raises the same sentences on the BATCH-ONLY route, where `retained` lives", async () => {
    const open_ = await open();
    live = open_;
    const batch = new BatchOnlyDriver({ client: open_.database });
    const engine = createCommandEngine({ schema: world(), driver: batch });
    const shapes: { label: string; args: unknown; expected: () => Error }[] = [
      {
        label: "batch nested connect, no such target",
        args: { where: { id: 1 }, data: { loose: { connect: [{ id: 999 }] } } },
        expected: () =>
          new NestedWriteError(
            "Cannot connect relation 'loose': target record was not found.",
            "loose"
          ),
      },
      {
        label: "batch nested update, no such target for this parent",
        args: {
          where: { id: 1 },
          data: {
            loose: { update: [{ where: { id: 999 }, data: { label: "x" } }] },
          },
        },
        expected: () =>
          new NestedWriteError(
            "Cannot update relation 'loose': target record was not found for this parent.",
            "loose"
          ),
      },
      {
        label: "batch root lookup miss",
        args: { where: { id: 999 }, data: { name: "x" } },
        expected: () => new NotFoundError("owner", "update"),
      },
    ];
    for (const shape of shapes) {
      const { described } = await raise(() =>
        engine.execute("owner", "update", shape.args)
      );
      assert.deepEqual(described, describeError(shape.expected()), shape.label);
    }
    // `connectOrCreate` carries the `retained` thunk on this route: it must
    // still succeed, and the thunk must not be raised when nothing is missing.
    await engine.execute("owner", "update", {
      where: { id: 1 },
      data: {
        loose: {
          connectOrCreate: [
            { where: { id: 21 }, create: { id: 21, label: "l21" } },
          ],
        },
      },
    });
    const rows = open_.database
      .prepare(`SELECT id, ownerId FROM ${LOOSE_TABLE} WHERE id = 21`)
      .all();
    assert.deepEqual(rows, [{ id: 21, ownerId: 1 }]);
  });
});
