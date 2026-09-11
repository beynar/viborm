import assert from "node:assert/strict";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { Query, Queries } from "@query-engine/raptor3/shared/query";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import {
  type Arguments,
  EngineSchema,
  type Input,
} from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

type TraversalArgs = Partial<
  Pick<Arguments, "where" | "select" | "include" | "orderBy">
>;

interface RecursiveTraversal {
  readonly seeds: readonly { readonly args: TraversalArgs }[];
  readonly relation: string;
  readonly depth: number;
  readonly args?: TraversalArgs;
}

interface RecursiveQueries {
  recursive(model: AnyModel, traversal: RecursiveTraversal): Query;
}

interface StatementObservation {
  readonly sql: string;
  readonly bindCount: number;
  readonly providerRows: number;
}

class RecursiveReadSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    this.statements.push({
      sql: statement,
      bindCount: parameters.length,
      providerRows: response.rows.length,
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

const activeDescendants: TraversalArgs = {
  where: { active: 1 },
  orderBy: [{ rank: "asc" }, { label: "asc" }],
  include: noteInclude,
};

interface RecursiveWorld {
  readonly database: Database.Database;
  readonly driver: RecursiveReadSQLiteDriver;
  readonly engineSchema: EngineSchema;
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
    engineSchema: new EngineSchema(schema),
  };
}

async function closeRecursiveWorld(world: RecursiveWorld): Promise<void> {
  await world.driver.disconnect();
  world.database.close();
}

function assertRecursiveQueries(
  queries: Queries
): asserts queries is Queries & RecursiveQueries {
  assert.equal(
    typeof Reflect.get(queries, "recursive"),
    "function",
    "G3P-05 Queries.recursive private fit capability is missing"
  );
}

async function traverse(
  world: RecursiveWorld,
  traversal: RecursiveTraversal
): Promise<{ rows: Input[]; statement: StatementObservation }> {
  const context = new OperationContext(
    world.engineSchema,
    world.driver,
    "recursiveNode",
    "findMany"
  );
  assertRecursiveQueries(context.queries);
  const query = context.queries.recursive(recursiveNode, traversal);
  const statementCount = world.driver.statements.length;
  const rows = await context.run(() => context.read(query));
  assert.equal(
    world.driver.statements.length,
    statementCount + 1,
    "one traversal call must execute exactly one provider statement"
  );
  return {
    rows,
    statement: world.driver.statements[statementCount]!,
  };
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

function countDownwardOutput(root: Input): {
  readonly objects: number;
  readonly arrays: number;
} {
  let objects = 0;
  let arrays = 0;
  const visit = (node: Input): void => {
    objects++;
    assertArray(node.children);
    arrays++;
    for (const child of node.children) {
      assertInput(child);
      visit(child);
    }
  };
  visit(root);
  return { objects, arrays };
}

function expectedSpine(level: number, remainingDepth: number): Input {
  if (remainingDepth === 0) {
    return { label: `Spine ${level}`, rank: level === 0 ? 0 : 1, children: [] };
  }
  return {
    label: `Spine ${level}`,
    rank: level === 0 ? 0 : 1,
    children: [
      expectedSpine(level + 1, remainingDepth - 1),
      { label: `Leaf ${level + 1}`, rank: 2, children: [] },
    ],
  };
}

describe("G3P-05 private recursive read fit", () => {
  it("keeps mapped compound keys hidden while preserving ordered overlapping downward occurrences", async () => {
    const world = createRecursiveWorld();
    try {
      const { rows, statement } = await traverse(world, {
        seeds: [
          {
            args: {
              where: { tenant_code: { tenant: "tree", code: "root" } },
              include: noteInclude,
            },
          },
          {
            args: {
              where: { tenant_code: { tenant: "tree", code: "alpha" } },
              include: noteInclude,
            },
          },
          {
            args: {
              where: { tenant_code: { tenant: "tree", code: "root" } },
              include: noteInclude,
            },
          },
        ],
        relation: "children",
        depth: 2,
        args: activeDescendants,
      });

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
          {
            label: "Alpha one",
            rank: 20,
            notes: [],
            children: [],
          },
        ],
      };
      const expectedRoot = {
        label: "Root",
        rank: 0,
        notes: [{ text: "root first" }, { text: "root second" }],
        children: [
          { label: "Beta", rank: 10, notes: [], children: [] },
          expectedAlpha,
        ],
      };
      assert.deepEqual(rows, [expectedRoot, expectedAlpha, expectedRoot]);
      assert.match(statement.sql, /^WITH RECURSIVE\b/);
      assert.match(statement.sql, /"sibling_rank"\s+ASC/);
      assert.match(statement.sql, /"display_label"\s+ASC/);
      assert.match(statement.sql, /"note_position"\s+ASC/);

      const firstRoot = rows[0]!;
      const standaloneAlpha = rows[1]!;
      const repeatedRoot = rows[2]!;
      assert.notStrictEqual(firstRoot, repeatedRoot);
      assert.notStrictEqual(firstRoot.children, repeatedRoot.children);
      assert.notStrictEqual(childAt(firstRoot, 1), standaloneAlpha);
      assert.notStrictEqual(childAt(repeatedRoot, 1), standaloneAlpha);
      assert.notStrictEqual(childAt(firstRoot, 1), childAt(repeatedRoot, 1));
      assert.notStrictEqual(firstRoot.notes, repeatedRoot.notes);
      assert.deepEqual(Reflect.ownKeys(firstRoot).map(String).sort(), [
        "children",
        "label",
        "notes",
        "rank",
      ]);
      assert.deepEqual(
        Reflect.ownKeys(childAt(firstRoot, 1)).map(String).sort(),
        ["children", "label", "notes", "rank"]
      );
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("uses the singular slot name and prunes the upward descent at every level", async () => {
    const world = createRecursiveWorld();
    try {
      const upward = await traverse(world, {
        seeds: [
          {
            args: {
              where: {
                tenant_code: { tenant: "tree", code: "alpha-2" },
              },
              include: noteInclude,
            },
          },
        ],
        relation: "parent",
        depth: 2,
        args: activeDescendants,
      });
      assert.deepEqual(upward.rows, [
        {
          label: "Alpha two",
          rank: 10,
          notes: [{ text: "alpha two note" }],
          parent: {
            label: "Alpha",
            rank: 20,
            notes: [{ text: "alpha note" }],
            parent: {
              label: "Root",
              rank: 0,
              notes: [{ text: "root first" }, { text: "root second" }],
              parent: null,
            },
          },
        },
      ]);

      const pruned = await traverse(world, {
        seeds: [
          {
            args: {
              where: {
                tenant_code: { tenant: "tree", code: "pruned-child" },
              },
            },
          },
        ],
        relation: "parent",
        depth: 32,
        args: activeDescendants,
      });
      assert.deepEqual(pruned.rows, [
        { label: "Never reached", rank: 1, parent: null },
      ]);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("defines depth zero and empty branches by the selected slot cardinality", async () => {
    const world = createRecursiveWorld();
    try {
      const downwardZero = await traverse(world, {
        seeds: [
          {
            args: {
              where: { tenant_code: { tenant: "tree", code: "root" } },
              select: { label: true },
            },
          },
        ],
        relation: "children",
        depth: 0,
        args: { select: { rank: true } },
      });
      assert.deepEqual(downwardZero.rows, [{ label: "Root", children: [] }]);

      const upwardZero = await traverse(world, {
        seeds: [
          {
            args: {
              where: {
                tenant_code: { tenant: "tree", code: "alpha-2" },
              },
              select: { label: true },
            },
          },
        ],
        relation: "parent",
        depth: 0,
        args: { select: { rank: true } },
      });
      assert.deepEqual(upwardZero.rows, [{ label: "Alpha two", parent: null }]);

      const downwardEmpty = await traverse(world, {
        seeds: [
          {
            args: {
              where: { tenant_code: { tenant: "tree", code: "empty" } },
              select: { label: true },
            },
          },
        ],
        relation: "children",
        depth: 32,
        args: { select: { rank: true } },
      });
      assert.deepEqual(downwardEmpty.rows, [{ label: "Empty", children: [] }]);

      const upwardEmpty = await traverse(world, {
        seeds: [
          {
            args: {
              where: { tenant_code: { tenant: "tree", code: "root" } },
              select: { label: true },
            },
          },
        ],
        relation: "parent",
        depth: 32,
        args: { select: { rank: true } },
      });
      assert.deepEqual(upwardEmpty.rows, [{ label: "Root", parent: null }]);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("orders multiple roots from one seed without losing descendant sibling order", async () => {
    const world = createRecursiveWorld();
    try {
      const seed: { readonly args: TraversalArgs } = {
        args: {
          where: {
            tenant: "tree",
            code: { in: ["root", "empty"] },
          },
          orderBy: { label: "asc" },
          select: { label: true },
        },
      };

      const depthZero = await traverse(world, {
        seeds: [seed],
        relation: "children",
        depth: 0,
        args: { select: { label: true } },
      });
      assert.deepEqual(depthZero.rows, [
        { label: "Empty", children: [] },
        { label: "Root", children: [] },
      ]);

      const depthTwo = await traverse(world, {
        seeds: [seed],
        relation: "children",
        depth: 2,
        args: {
          where: { active: 1 },
          orderBy: [{ rank: "asc" }, { label: "asc" }],
          select: { label: true },
        },
      });
      assert.deepEqual(depthTwo.rows, [
        { label: "Empty", children: [] },
        {
          label: "Root",
          children: [
            { label: "Beta", children: [] },
            {
              label: "Alpha",
              children: [
                { label: "Alpha two", children: [] },
                { label: "Alpha one", children: [] },
              ],
            },
          ],
        },
      ]);
    } finally {
      await closeRecursiveWorld(world);
    }
  });

  it("stops a complete-key revisit on one path without globally deduplicating roots or paths", async () => {
    const world = createRecursiveWorld();
    try {
      const downward = await traverse(world, {
        seeds: [
          {
            args: {
              where: { tenant_code: { tenant: "cycle", code: "one" } },
              select: { label: true },
            },
          },
          {
            args: {
              where: { tenant_code: { tenant: "cycle", code: "two" } },
              select: { label: true },
            },
          },
        ],
        relation: "children",
        depth: 32,
        args: { select: { label: true } },
      });
      assert.deepEqual(downward.rows, [
        {
          label: "Cycle one",
          children: [{ label: "Cycle two", children: [] }],
        },
        {
          label: "Cycle two",
          children: [{ label: "Cycle one", children: [] }],
        },
      ]);
      assert.notStrictEqual(downward.rows[0], childAt(downward.rows[1]!, 0));
      assert.notStrictEqual(downward.rows[1], childAt(downward.rows[0]!, 0));

      const upward = await traverse(world, {
        seeds: [
          {
            args: {
              where: { tenant_code: { tenant: "cycle", code: "one" } },
              select: { label: true },
            },
          },
          {
            args: {
              where: { tenant_code: { tenant: "cycle", code: "two" } },
              select: { label: true },
            },
          },
        ],
        relation: "parent",
        depth: 32,
        args: { select: { label: true } },
      });
      assert.deepEqual(upward.rows, [
        {
          label: "Cycle one",
          parent: { label: "Cycle two", parent: null },
        },
        {
          label: "Cycle two",
          parent: { label: "Cycle one", parent: null },
        },
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
        publicObjects: number;
        publicArrays: number;
      }[] = [];

      for (const depth of [1, 2, 8, 32]) {
        const { rows, statement } = await traverse(world, {
          seeds: [
            {
              args: {
                where: {
                  tenant_code: { tenant: "wide", code: "spine-0" },
                },
              },
            },
          ],
          relation: "children",
          depth,
          args: {
            where: { active: 1 },
            orderBy: [{ rank: "asc" }, { label: "asc" }],
          },
        });
        assert.deepEqual(rows, [expectedSpine(0, depth)]);
        assert.match(statement.sql, /^WITH RECURSIVE\b/);
        const publicCounts = countDownwardOutput(rows[0]!);
        assert.deepEqual(publicCounts, {
          objects: 1 + 2 * depth,
          arrays: 1 + 2 * depth,
        });
        metrics.push({
          depth,
          sqlChars: statement.sql.length,
          binds: statement.bindCount,
          providerRows: statement.providerRows,
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
          { depth: 1, publicObjects: 3, publicArrays: 3 },
          { depth: 2, publicObjects: 5, publicArrays: 5 },
          { depth: 8, publicObjects: 17, publicArrays: 17 },
          { depth: 32, publicObjects: 65, publicArrays: 65 },
        ]
      );
      assert.equal(new Set(metrics.map(({ sqlChars }) => sqlChars)).size, 1);
      assert.equal(new Set(metrics.map(({ binds }) => binds)).size, 1);
    } finally {
      await closeRecursiveWorld(world);
    }
  });
});
