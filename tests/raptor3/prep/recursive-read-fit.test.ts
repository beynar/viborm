/**
 * G3P-05's recursive read fit, re-expressed through the ORDINARY projection.
 *
 * These cells once entered the retired private root-only
 * `Queries.recursive(model, { seeds, relation, depth, args })`. That slice is
 * gone (features-docs/recursive-query.md §3.6): `recurse` is now a modifier on
 * an ordinary relation node, entered here through the command engine exactly
 * as the client enters it. Every useful behaviour is kept — mapped compound
 * identities hidden by model omit, filtered and ordered descendants, the
 * singular slot name, overlapping occurrences, one statement independent of
 * depth — and the four intentional contract changes (RQ-00 ledger, "Private
 * pins that are historical") are named at the cell that meets them:
 *
 * - depth 0 is invalid: public numeric depth starts at 1;
 * - an FK cycle inside the traversed window errors instead of pruning;
 * - a numeric cutoff OMITS the repeated key instead of initializing it;
 * - the ordinary operation owns root cardinality and root order (no seeds).
 */
import assert from "node:assert/strict";
import type { QueryResult } from "@drivers";
import { QueryEngineError, ValidationError } from "@errors";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly bindCount: number;
  readonly providerRows: number;
  readonly carrierBytes: number;
}

class RecursiveReadSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    const carrier = (response.rows[0] as Record<string, unknown> | undefined)
      ?.children;
    this.statements.push({
      sql: statement,
      bindCount: parameters.length,
      providerRows: response.rows.length,
      carrierBytes: typeof carrier === "string" ? carrier.length : 0,
    });
    return response;
  }
}

const recursiveNode = s
  .model({
    tenant: s.string().map("tenant_key"),
    code: s.string().map("node_code"),
    label: s.string().map("display_label"),
    rank: s.int().map("sibling_rank"),
    active: s.int().map("is_active"),
    parentTenant: s.string().nullable().map("parent_tenant_key"),
    parentCode: s.string().nullable().map("parent_node_code"),
    parent: s
      .toOne(() => recursiveNode)
      .fields("parentTenant", "parentCode")
      .references("tenant", "code")
      .name("tree"),
    children: s.toMany(() => recursiveNode).name("tree"),
    notes: s.toMany(() => recursiveNote).name("nodeNotes"),
  })
  .id(["tenant", "code"])
  .omit({
    tenant: true,
    code: true,
    active: true,
    parentTenant: true,
    parentCode: true,
  })
  .map("g3p05_recursive_nodes");

const recursiveNote = s
  .model({
    id: s.int().id(),
    nodeTenant: s.string().map("node_tenant_key"),
    nodeCode: s.string().map("node_code_key"),
    position: s.int().map("note_position"),
    text: s.string().map("note_text"),
    node: s
      .toOne(() => recursiveNode)
      .fields("nodeTenant", "nodeCode")
      .references("tenant", "code")
      .name("nodeNotes"),
  })
  .map("g3p05_recursive_notes");

const schema = { recursiveNode, recursiveNote };

const noteInclude: Input = {
  notes: {
    orderBy: { position: "asc" },
    select: { text: true },
  },
};

/** The old private `activeDescendants`, now the recursive node's own clauses. */
const activeOrder = [{ rank: "asc" }, { label: "asc" }];

interface RecursiveWorld {
  readonly database: Database.Database;
  readonly driver: RecursiveReadSQLiteDriver;
  readonly engine: ReturnType<typeof createCommandEngine>;
}

function createRecursiveWorld(): RecursiveWorld {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = OFF");
  database.exec(`
    CREATE TABLE g3p05_recursive_nodes(
      tenant_key TEXT NOT NULL,
      node_code TEXT NOT NULL,
      display_label TEXT NOT NULL,
      sibling_rank INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      parent_tenant_key TEXT,
      parent_node_code TEXT,
      PRIMARY KEY(tenant_key, node_code),
      FOREIGN KEY(parent_tenant_key, parent_node_code)
        REFERENCES g3p05_recursive_nodes(tenant_key, node_code)
    );
    CREATE TABLE g3p05_recursive_notes(
      id INTEGER PRIMARY KEY,
      node_tenant_key TEXT NOT NULL,
      node_code_key TEXT NOT NULL,
      note_position INTEGER NOT NULL,
      note_text TEXT NOT NULL,
      FOREIGN KEY(node_tenant_key, node_code_key)
        REFERENCES g3p05_recursive_nodes(tenant_key, node_code)
    );
  `);

  const insertNode = database.prepare(`
    INSERT INTO g3p05_recursive_nodes(
      tenant_key,
      node_code,
      display_label,
      sibling_rank,
      is_active,
      parent_tenant_key,
      parent_node_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const nodes: readonly (readonly [
    string,
    string,
    string,
    number,
    number,
    string | null,
    string | null,
  ])[] = [
    ["tree", "root", "Root", 0, 1, null, null],
    ["tree", "alpha", "Alpha", 20, 1, "tree", "root"],
    ["tree", "beta", "Beta", 10, 1, "tree", "root"],
    ["tree", "pruned", "Pruned", 15, 0, "tree", "root"],
    ["tree", "alpha-1", "Alpha one", 20, 1, "tree", "alpha"],
    ["tree", "alpha-2", "Alpha two", 10, 1, "tree", "alpha"],
    ["tree", "pruned-child", "Never reached", 1, 1, "tree", "pruned"],
    ["tree", "empty", "Empty", 0, 1, null, null],
    ["cycle", "one", "Cycle one", 1, 1, "cycle", "two"],
    ["cycle", "two", "Cycle two", 1, 1, "cycle", "one"],
    ["wide", "spine-0", "Spine 0", 0, 1, null, null],
  ];
  for (const node of nodes) insertNode.run(...node);
  for (let level = 1; level <= 33; level++) {
    insertNode.run(
      "wide",
      `spine-${level}`,
      `Spine ${level}`,
      1,
      1,
      "wide",
      `spine-${level - 1}`
    );
    insertNode.run(
      "wide",
      `leaf-${level}`,
      `Leaf ${level}`,
      2,
      1,
      "wide",
      `spine-${level - 1}`
    );
  }

  const insertNote = database.prepare(`
    INSERT INTO g3p05_recursive_notes(
      id,
      node_tenant_key,
      node_code_key,
      note_position,
      note_text
    ) VALUES (?, ?, ?, ?, ?)
  `);
  insertNote.run(1, "tree", "root", 2, "root second");
  insertNote.run(2, "tree", "root", 1, "root first");
  insertNote.run(3, "tree", "alpha", 1, "alpha note");
  insertNote.run(4, "tree", "alpha-2", 1, "alpha two note");

  database.pragma("foreign_keys = ON");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
  const driver = new RecursiveReadSQLiteDriver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema, driver }),
  };
}

async function closeRecursiveWorld(world: RecursiveWorld): Promise<void> {
  await world.driver.disconnect();
  world.database.close();
}

/** One ordinary `findMany`: exactly one provider statement, recursion or not. */
async function read(
  world: RecursiveWorld,
  args: Input
): Promise<{ rows: Input[]; statement: StatementObservation }> {
  const statementCount = world.driver.statements.length;
  const rows = await world.engine.execute("recursiveNode", "findMany", args);
  assert(Array.isArray(rows));
  assert.equal(
    world.driver.statements.length,
    statementCount + 1,
    "one read must execute exactly one provider statement"
  );
  return {
    rows: rows as Input[],
    statement: world.driver.statements[statementCount]!,
  };
}

/** A refusal owned by admission: it reaches no provider at all. */
async function refused(
  world: RecursiveWorld,
  args: Input,
  reason: RegExp
): Promise<void> {
  const statementCount = world.driver.statements.length;
  await assert.rejects(
    world.engine.execute("recursiveNode", "findMany", args),
    (error: unknown) => error instanceof ValidationError && reason.test(error.message)
  );
  assert.equal(world.driver.statements.length, statementCount);
}

/** An FK cycle inside the window: the one statement runs, the read fails. */
async function cycles(
  world: RecursiveWorld,
  args: Input,
  relation: string
): Promise<void> {
  const statementCount = world.driver.statements.length;
  await assert.rejects(
    world.engine.execute("recursiveNode", "findMany", args),
    (error: unknown) =>
      error instanceof QueryEngineError &&
      error.message === `Recursive relation '${relation}' contains a cycle.`
  );
  assert.equal(world.driver.statements.length, statementCount + 1);
}

function assertInput(value: unknown): asserts value is Input {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
}

function assertArray(value: unknown): asserts value is unknown[] {
  assert(Array.isArray(value));
}

function childAt(parent: Input, index: number): Input {
  const children = parent.children;
  assertArray(children);
  const child = children[index];
  assertInput(child);
  return child;
}

/**
 * Public objects and the `children` arrays they carry. A cut-off occurrence
 * carries no array at all — the repeated key is absent there.
 */
function countDownwardOutput(root: Input): {
  readonly objects: number;
  readonly arrays: number;
} {
  let objects = 0;
  let arrays = 0;
  const pending: Input[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    objects++;
    if (!Object.hasOwn(node, "children")) continue;
    assertArray(node.children);
    arrays++;
    for (const child of node.children) {
      assertInput(child);
      pending.push(child);
    }
  }
  return { objects, arrays };
}

/** Level `level` of the spine under a depth-`depth` read (the root is level 0). */
function expectedSpine(level: number, depth: number): Input {
  const node: Input = { label: `Spine ${level}`, rank: level === 0 ? 0 : 1 };
  if (level === depth) return node;
  const leaf: Input = { label: `Leaf ${level + 1}`, rank: 2 };
  if (level + 1 < depth) leaf.children = [];
  node.children = [expectedSpine(level + 1, depth), leaf];
  return node;
}

describe("G3P-05 recursive read fit through the ordinary projection", () => {
  it("keeps mapped compound keys hidden while preserving ordered overlapping downward occurrences", async () => {
    const world = createRecursiveWorld();
    try {
      // Contract change — root cardinality: the ordinary operation owns the
      // roots. The retired seeds (root, alpha, root) repeated one root; a read
      // returns each row once, so the overlap is re-expressed by `alpha`, which
      // is both a root and a node inside `root`'s traversal.
      const { rows, statement } = await read(world, {
        where: { tenant: "tree", code: { in: ["root", "alpha"] } },
        orderBy: { rank: "asc" },
        include: {
          ...noteInclude,
          children: {
            recurse: { depth: 2 },
            where: { active: 1 },
            orderBy: activeOrder,
            include: noteInclude,
          },
        },
      });

      // Contract change — cutoff: the level-2 occurrences under `root` OMIT
      // `children` (the private fit initialized it to []); the same rows at
      // level 1 under the `alpha` root end naturally, so there it is [].
      const expectedRoot = {
        label: "Root",
        rank: 0,
        notes: [{ text: "root first" }, { text: "root second" }],
        children: [
          { label: "Beta", rank: 10, notes: [], children: [] },
          {
            label: "Alpha",
            rank: 20,
            notes: [{ text: "alpha note" }],
            children: [
              { label: "Alpha two", rank: 10, notes: [{ text: "alpha two note" }] },
              { label: "Alpha one", rank: 20, notes: [] },
            ],
          },
        ],
      };
      const expectedAlpha = {
        label: "Alpha",
        rank: 20,
        notes: [{ text: "alpha note" }],
        children: [
          {
            label: "Alpha two",
            rank: 10,
            notes: [{ text: "alpha two note" }],
            children: [],
          },
          { label: "Alpha one", rank: 20, notes: [], children: [] },
        ],
      };
      assert.deepEqual(rows, [expectedRoot, expectedAlpha]);
      // Representation change — the recursive CTE is now a scalar subquery inside the ordinary SELECT's relation column (recursive-query.md §3.2/§3.6), not the statement's prefix.
      assert.match(statement.sql, /WITH RECURSIVE\b/);
      assert.match(statement.sql, /"sibling_rank"\s+ASC/);
      assert.match(statement.sql, /"display_label"\s+ASC/);
      assert.match(statement.sql, /"note_position"\s+ASC/);

      const root = rows[0]!;
      const standaloneAlpha = rows[1]!;
      const nestedAlpha = childAt(root, 1);
      assert.notStrictEqual(nestedAlpha, standaloneAlpha);
      assert.notStrictEqual(nestedAlpha.children, standaloneAlpha.children);
      assert.notStrictEqual(nestedAlpha.notes, standaloneAlpha.notes);
      assert.notStrictEqual(
        childAt(nestedAlpha, 0),
        childAt(standaloneAlpha, 0)
      );
      assert.deepEqual(Reflect.ownKeys(root).map(String).sort(), [
        "children",
        "label",
        "notes",
        "rank",
      ]);
      assert.deepEqual(Reflect.ownKeys(nestedAlpha).map(String).sort(), [
        "children",
        "label",
        "notes",
        "rank",
      ]);
      assert.deepEqual(
        Reflect.ownKeys(childAt(nestedAlpha, 0)).map(String).sort(),
        ["label", "notes", "rank"]
      );
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("uses the singular slot name at every level and refuses a per-level singular filter", async () => {
    const world = createRecursiveWorld();
    try {
      // Contract change — cutoff: at depth 2 the level-2 `Root` omits `parent`
      // (the private fit published `parent: null`); at depth 3 the same row is
      // a natural end before the cutoff, so there it IS `null`.
      const upward = (depth: number) =>
        read(world, {
          where: { tenant: "tree", code: "alpha-2" },
          include: {
            ...noteInclude,
            parent: { recurse: { depth }, include: noteInclude },
          },
        });
      const root = {
        label: "Root",
        rank: 0,
        notes: [{ text: "root first" }, { text: "root second" }],
      };
      const chain = (top: Input) => [
        {
          label: "Alpha two",
          rank: 10,
          notes: [{ text: "alpha two note" }],
          parent: {
            label: "Alpha",
            rank: 20,
            notes: [{ text: "alpha note" }],
            parent: top,
          },
        },
      ];
      assert.deepEqual((await upward(2)).rows, chain(root));
      assert.deepEqual((await upward(3)).rows, chain({ ...root, parent: null }));

      // Contract change — singular nodes admit select/include/omit only
      // (§2.3). The private fit's per-level filter on the upward chain (which
      // stopped `pruned-child` at its inactive parent) is refused before any
      // statement, never silently ignored.
      await refused(world, {
        where: { tenant: "tree", code: "pruned-child" },
        select: {
          label: true,
          parent: {
            recurse: { depth: 32 },
            where: { active: 1 },
            select: { label: true },
          },
        },
      }, /where/);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("refuses depth zero and defines empty branches by the selected slot cardinality", async () => {
    const world = createRecursiveWorld();
    try {
      // Contract change — depth 0 is invalid: direct related records are
      // level 1, so the private fit's depth-0 root rows have no public
      // spelling. Both directions are refused before any statement.
      for (const relation of ["children", "parent"])
        await refused(world, {
          where: { tenant: "tree", code: "root" },
          select: {
            label: true,
            [relation]: { recurse: { depth: 0 }, select: { rank: true } },
          },
        }, /recurse\.depth must be a positive safe integer between 1 and 1000/);

      const downwardEmpty = await read(world, {
        where: { tenant: "tree", code: "empty" },
        select: {
          label: true,
          children: { recurse: { depth: 32 }, select: { rank: true } },
        },
      });
      assert.deepEqual(downwardEmpty.rows, [{ label: "Empty", children: [] }]);

      const upwardEmpty = await read(world, {
        where: { tenant: "tree", code: "root" },
        select: {
          label: true,
          parent: { recurse: { depth: 32 }, select: { rank: true } },
        },
      });
      assert.deepEqual(upwardEmpty.rows, [{ label: "Root", parent: null }]);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("orders multiple roots by the operation without losing descendant sibling order", async () => {
    const world = createRecursiveWorld();
    try {
      // Contract change — root order: the retired single seed's `orderBy` is
      // the operation's own; depth 0 (invalid) becomes depth 1, whose level-1
      // occurrences omit `children` at the cutoff.
      const roots = (depth: number) =>
        read(world, {
          where: { tenant: "tree", code: { in: ["root", "empty"] } },
          orderBy: { label: "asc" },
          select: {
            label: true,
            children: {
              recurse: { depth },
              where: { active: 1 },
              orderBy: activeOrder,
              select: { label: true },
            },
          },
        });

      assert.deepEqual((await roots(1)).rows, [
        { label: "Empty", children: [] },
        { label: "Root", children: [{ label: "Beta" }, { label: "Alpha" }] },
      ]);
      assert.deepEqual((await roots(2)).rows, [
        { label: "Empty", children: [] },
        {
          label: "Root",
          children: [
            { label: "Beta", children: [] },
            {
              label: "Alpha",
              children: [{ label: "Alpha two" }, { label: "Alpha one" }],
            },
          ],
        },
      ]);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("fails an FK cycle inside the window without globally deduplicating roots or paths outside it", async () => {
    const world = createRecursiveWorld();
    try {
      const cycle = (relation: string, depth: number) => ({
        where: { tenant: "cycle" },
        orderBy: { code: "asc" },
        select: {
          label: true,
          [relation]: { recurse: { depth }, select: { label: true } },
        },
      });

      // Contract change — FK cycles: the private fit pruned the revisit on the
      // path; the public contract refuses a cycle that closes inside the
      // traversed window. `one ⇄ two` closes at hop 2, in both directions.
      await cycles(world, cycle("children", 32), "children");
      await cycles(world, cycle("parent", 32), "parent");
      await cycles(world, cycle("children", 2), "children");

      // Outside the window (depth 1) nothing closes, and the two roots stay
      // independent: each root's one-hop occurrence is its own public object.
      const downward = await read(world, cycle("children", 1));
      assert.deepEqual(downward.rows, [
        { label: "Cycle one", children: [{ label: "Cycle two" }] },
        { label: "Cycle two", children: [{ label: "Cycle one" }] },
      ]);
      assert.notStrictEqual(downward.rows[0], childAt(downward.rows[1]!, 0));
      assert.notStrictEqual(downward.rows[1], childAt(downward.rows[0]!, 0));

      const upward = await read(world, cycle("parent", 1));
      assert.deepEqual(upward.rows, [
        { label: "Cycle one", parent: { label: "Cycle two" } },
        { label: "Cycle two", parent: { label: "Cycle one" } },
      ]);
      assertInput(upward.rows[0]!.parent);
      assertInput(upward.rows[1]!.parent);
      assert.notStrictEqual(upward.rows[0], upward.rows[1]!.parent);
      assert.notStrictEqual(upward.rows[1], upward.rows[0]!.parent);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("keeps one recursive SQL shape while real output widens at depths 1, 2, 8 and 32", async () => {
    const world = createRecursiveWorld();
    try {
      const metrics: {
        depth: number;
        sqlChars: number;
        binds: number;
        providerRows: number;
        carrierBytes: number;
        publicObjects: number;
        publicArrays: number;
      }[] = [];

      for (const depth of [1, 2, 8, 32]) {
        const { rows, statement } = await read(world, {
          where: { tenant: "wide", code: "spine-0" },
          include: {
            children: {
              recurse: { depth },
              where: { active: 1 },
              orderBy: activeOrder,
            },
          },
        });
        assert.deepEqual(rows, [expectedSpine(0, depth)]);
        // Representation change — the recursive CTE is now a scalar subquery inside the ordinary SELECT's relation column (recursive-query.md §3.2/§3.6), not the statement's prefix.
        assert.match(statement.sql, /WITH RECURSIVE\b/);
        const publicCounts = countDownwardOutput(rows[0]!);
        // Contract change — cutoff: the private fit gave every occurrence a
        // `children` array (1 + 2·depth); now only occurrences before the
        // cutoff carry one: the root, and each level's spine row and leaf
        // below the last level (1 + 2·(depth − 1)).
        assert.deepEqual(publicCounts, {
          objects: 1 + 2 * depth,
          arrays: 2 * depth - 1,
        });
        metrics.push({
          depth,
          sqlChars: statement.sql.length,
          binds: statement.bindCount,
          providerRows: statement.providerRows,
          carrierBytes: statement.carrierBytes,
          publicObjects: publicCounts.objects,
          publicArrays: publicCounts.arrays,
        });
      }

      assert.deepEqual(
        metrics.map(({ depth, publicObjects, publicArrays }) => ({
          depth,
          publicObjects,
          publicArrays,
        })),
        [
          { depth: 1, publicObjects: 3, publicArrays: 1 },
          { depth: 2, publicObjects: 5, publicArrays: 3 },
          { depth: 8, publicObjects: 17, publicArrays: 15 },
          { depth: 32, publicObjects: 65, publicArrays: 63 },
        ]
      );
      // One statement shape at every depth: the depth is a bound value, and
      // the outer row carries the whole traversal (one provider row, not one
      // per occurrence as the private fit's flat rows were).
      assert.equal(new Set(metrics.map(({ sqlChars }) => sqlChars)).size, 1);
      assert.equal(new Set(metrics.map(({ binds }) => binds)).size, 1);
      assert.deepEqual(
        metrics.map(({ providerRows }) => providerRows),
        [1, 1, 1, 1]
      );
      // The carrier grows with the depth's transported facts, never with a
      // re-read of the same statement: strictly increasing, one per depth.
      const bytes = metrics.map(({ carrierBytes }) => carrierBytes);
      for (let index = 1; index < bytes.length; index++)
        assert(bytes[index]! > bytes[index - 1]!);
    } finally {
      await closeRecursiveWorld(world);
    }
  });
});
