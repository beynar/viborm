import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { CountingMemoryCache } from "@tests/fixtures/counting-memory-cache";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const node = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .name("Tree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => node).name("Tree"),
});

const graphNode = s.model({
  id: s.string().id(),
  label: s.string(),
  links: s.toMany(() => graphNode).name("Graph"),
  linkedBy: s.toMany(() => graphNode).name("Graph"),
});

const person = s.model({
  id: s.string().id(),
  mateId: s.string().nullable().unique(),
  mate: s
    .toOne(() => person)
    .name("Mate")
    .fields("mateId")
    .references("id"),
  mateOf: s.toOne(() => person).name("Mate"),
});

const keyless = s.model({
  code: s.string().unique(),
  parentCode: s.string().nullable(),
  parent: s
    .toOne(() => keyless)
    .name("KeylessTree")
    .fields("parentCode")
    .references("code"),
  children: s.toMany(() => keyless).name("KeylessTree"),
});

const left = s.model({
  id: s.string().id(),
  links: s.toMany(() => right).name("Lookalike"),
  linkedBy: s.toMany(() => right).name("LookalikeBack"),
});

const right = s.model({
  id: s.string().id(),
  links: s.toMany(() => left).name("Lookalike"),
  linkedBy: s.toMany(() => left).name("LookalikeBack"),
});

const schemas = createSchemaRegistry({
  node,
  graphNode,
  person,
  keyless,
  left,
  right,
}).proxy;

describe("recursive relation admission", () => {
  test("normalizes foreign-key recursion once", () => {
    expect(parse(schemas.node.relations.children.include, true)).toEqual({
      value: { select: { id: true, label: true, parentId: true } },
    });
    const defaultRecurrence = {
      value: {
        recurse: { depth: 100, cycles: "reject" },
        select: { id: true, label: true, parentId: true },
      },
    };
    expect(
      parse(schemas.node.relations.children.include, { recurse: true })
    ).toEqual(defaultRecurrence);
    expect(
      parse(schemas.node.relations.children.include, { recurse: {} })
    ).toEqual(defaultRecurrence);
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: { depth: undefined },
      })
    ).toEqual(defaultRecurrence);
    expect(
      parse(schemas.node.relations.parent.select, {
        recurse: { depth: false },
        select: { id: true },
      })
    ).toEqual({
      value: {
        recurse: { depth: false, cycles: "reject" },
        select: { id: true },
      },
    });
  });

  test("admits both directions of a resolved self one-to-one edge", () => {
    expect(
      parse(schemas.person.relations.mate.include, { recurse: true }).issues
    ).toBeUndefined();
    expect(
      parse(schemas.person.relations.mateOf.include, { recurse: { depth: 2 } })
        .issues
    ).toBeUndefined();
  });

  test("normalizes graph cycle policy and rejects exhaustive cycle allowance", () => {
    expect(
      parse(schemas.graphNode.relations.links.include, {
        recurse: { depth: 3, preventCycles: false },
      })
    ).toMatchObject({
      value: { recurse: { depth: 3, cycles: "allow" } },
    });
    expect(
      parse(schemas.graphNode.relations.links.include, {
        recurse: { depth: false },
      })
    ).toMatchObject({
      value: { recurse: { depth: false, cycles: "prevent" } },
    });
    expect(
      parse(schemas.graphNode.relations.links.include, {
        recurse: { depth: false, preventCycles: false },
      }).issues
    ).toBeDefined();
  });

  test("refuses unsafe relation and key facts at admission", () => {
    expect(
      parse(schemas.keyless.relations.children.include, { recurse: true })
        .issues
    ).toBeDefined();
    expect(
      parse(schemas.left.relations.links.include, { recurse: true }).issues
    ).toBeDefined();
  });

  test.each([
    0,
    -1,
    1.5,
    1001,
    Number.MAX_SAFE_INTEGER + 1,
  ])("refuses invalid depth %s", (depth) => {
    expect(
      parse(schemas.node.relations.children.include, { recurse: { depth } })
        .issues
    ).toBeDefined();
  });

  test("refuses recursive pagination, duplicate asking keys, and typos", () => {
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: true,
        take: 1,
      }).issues
    ).toBeDefined();
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: true,
        include: { children: true },
      }).issues
    ).toBeDefined();
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: true,
        where: { label: "ok", lable: "typo" },
      }).issues
    ).toBeDefined();
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: { depth: 2, depths: 3 },
      }).issues
    ).toBeDefined();
  });
});

// =============================================================================
// RQ-02 — one admission rule, both placements, refused before any work
// =============================================================================

const tree = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => tree)
    .name("PlacementTree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => tree).name("PlacementTree"),
  groves: s.toMany(() => grove).name("GroveRoot"),
});

const grove = s.model({
  id: s.string().id(),
  rootId: s.string().nullable(),
  root: s
    .toOne(() => tree)
    .name("GroveRoot")
    .fields("rootId")
    .references("id"),
});

// A self VARIANT carrier and the inverse bound to its storage: both resolve to
// a variant edge, never to an ordinary foreign-key or junction edge.
const thread = s.model({
  id: s.string().id(),
  replyTo: s
    .toOne({ thread: () => thread }, { values: { thread: "thread.reply.v1" } })
    .name("ThreadReply")
    .optional(),
  replies: s.toMany(() => thread).name("ThreadReply"),
});

// A widened relation name is a pairing TypeScript cannot prove, but the
// resolver pairs the runtime value; runtime admission follows the resolver.
const widenedName: string = "WidenedTree";
const widenedNode = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => widenedNode)
    .name(widenedName)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => widenedNode).name(widenedName),
});

const placementSchemas = createSchemaRegistry({ tree, grove }).proxy;
const variantSchemas = createSchemaRegistry({ thread }).proxy;
const widenedSchemas = createSchemaRegistry({ widenedNode }).proxy;

const treeRow = { id: true, label: true, parentId: true } as const;

function issueOf(result: { issues?: readonly { message: string }[] }) {
  const issue = result.issues?.[0];
  if (!issue) throw new Error("Expected an admission issue");
  return issue.message;
}

describe("recursive relation admission — depth, cycle and clause rules", () => {
  test("admits both numeric depth bounds and exhaustive traversal in every eligible direction", () => {
    for (const depth of [1, 1000]) {
      expect(
        parse(schemas.node.relations.children.include, { recurse: { depth } })
      ).toEqual({
        value: {
          recurse: { depth, cycles: "reject" },
          select: { id: true, label: true, parentId: true },
        },
      });
    }
    for (const relation of [
      schemas.node.relations.children.include,
      schemas.node.relations.parent.include,
      schemas.person.relations.mate.include,
      schemas.person.relations.mateOf.include,
    ]) {
      expect(parse(relation, { recurse: { depth: false } })).toMatchObject({
        value: { recurse: { depth: false, cycles: "reject" } },
      });
    }
    for (const relation of [
      schemas.graphNode.relations.links.include,
      schemas.graphNode.relations.linkedBy.include,
    ]) {
      expect(parse(relation, { recurse: true })).toMatchObject({
        value: { recurse: { depth: 100, cycles: "prevent" } },
      });
      expect(
        parse(relation, { recurse: { depth: false, preventCycles: true } })
      ).toMatchObject({
        value: { recurse: { depth: false, cycles: "prevent" } },
      });
      // An omitted graph depth is the same default depth as `true`.
      expect(parse(relation, { recurse: {} })).toMatchObject({
        value: { recurse: { depth: 100, cycles: "prevent" } },
      });
      expect(
        parse(relation, { recurse: { preventCycles: false } })
      ).toMatchObject({
        value: { recurse: { depth: 100, cycles: "allow" } },
      });
    }
  });

  test("reads recurse: undefined as the ordinary node and refuses recurse: false", () => {
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: undefined,
        where: { label: "x" },
        take: 2,
      })
    ).toEqual(
      parse(schemas.node.relations.children.include, {
        where: { label: "x" },
        take: 2,
      })
    );
    expect(
      parse(schemas.left.relations.links.include, { recurse: undefined })
    ).toEqual(parse(schemas.left.relations.links.include, {}));
    expect(
      parse(schemas.node.relations.children.include, { recurse: false }).issues
    ).toBeDefined();
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: { depth: true },
      }).issues
    ).toBeDefined();
  });

  test("refuses a caller-selected cycle policy on every foreign-key direction", () => {
    for (const relation of [
      schemas.node.relations.children.include,
      schemas.node.relations.parent.select,
      schemas.person.relations.mateOf.include,
    ]) {
      for (const preventCycles of [false, true]) {
        expect(
          issueOf(parse(relation, { recurse: { depth: 3, preventCycles } }))
        ).toContain(
          "preventCycles applies only to a junction graph; a foreign-key recursion rejects every cycle it reaches"
        );
      }
    }
  });

  test("refuses every per-parent window clause beside recurse", () => {
    for (const [clause, value] of [
      ["take", 1],
      ["skip", 1],
      ["cursor", { id: "node" }],
      ["distinct", ["label"]],
    ] as const) {
      expect(
        issueOf(
          parse(schemas.node.relations.children.include, {
            recurse: true,
            [clause]: value,
          })
        )
      ).toBe(`${clause} cannot be combined with recurse`);
    }
  });

  test("refuses the asking key in either projection of its own recursive node", () => {
    const sentence = (key: string) =>
      `${key} is produced by recurse and cannot be selected again inside its own recursive node`;
    expect(
      issueOf(
        parse(schemas.node.relations.children.include, {
          recurse: true,
          select: { label: true, children: true },
        })
      )
    ).toBe(sentence("children"));
    expect(
      issueOf(
        parse(schemas.node.relations.children.select, {
          recurse: true,
          include: { children: { select: { id: true } } },
        })
      )
    ).toBe(sentence("children"));
    expect(
      issueOf(
        parse(schemas.node.relations.parent.include, {
          recurse: true,
          include: { parent: true },
        })
      )
    ).toBe(sentence("parent"));
    // Another eligible slot is an ordinary member of the repeated node.
    expect(
      parse(schemas.node.relations.children.include, {
        recurse: true,
        include: { parent: { recurse: { depth: 2 } } },
      }).issues
    ).toBeUndefined();
  });

  test("refuses a misspelled node clause beside recurse", () => {
    expect(
      issueOf(
        parse(schemas.node.relations.children.include, {
          recurse: true,
          wher: { label: "x" },
        })
      )
    ).toBe("Unknown key: wher");
  });
});

describe("recursive relation admission — eligibility", () => {
  test("refuses recursion on a variant carrier and on the inverse bound to its storage", () => {
    const sentence =
      "recurse is available only on an ordinary self relation (a foreign key or a junction, never variant storage) whose model has a complete primary key";
    expect(
      issueOf(
        parse(variantSchemas.thread.relations.replies.include, {
          recurse: true,
        })
      )
    ).toContain(sentence);
    expect(
      parse(variantSchemas.thread.relations.replies.include, true).issues
    ).toBeUndefined();
    expect(
      parse(variantSchemas.thread.args.findMany, {
        include: { replyTo: { thread: { recurse: true } } },
      }).issues
    ).toBeDefined();
  });

  test("admits the runtime-resolved pair a widened name hides from TypeScript", () => {
    expect(
      parse(widenedSchemas.widenedNode.relations.children.include, {
        recurse: { depth: 2 },
      })
    ).toEqual({
      value: {
        recurse: { depth: 2, cycles: "reject" },
        select: { id: true, parentId: true },
      },
    });
  });
});

describe("recursive relation admission — one rule in both placements", () => {
  test("admits the same recursive node under select and under include", () => {
    expect(
      parse(placementSchemas.tree.args.findMany, {
        select: {
          label: true,
          children: { recurse: { depth: 2 }, select: { label: true } },
        },
      })
    ).toEqual({
      value: {
        select: {
          label: true,
          children: {
            recurse: { depth: 2, cycles: "reject" },
            select: { label: true },
          },
        },
      },
    });
    expect(
      parse(placementSchemas.tree.args.findMany, {
        include: { children: { recurse: { depth: 2 } } },
      })
    ).toEqual({
      value: {
        include: {
          children: {
            recurse: { depth: 2, cycles: "reject" },
            select: treeRow,
          },
        },
      },
    });
    for (const clause of ["select", "include"] as const) {
      expect(
        parse(placementSchemas.tree.args.findMany, {
          [clause]: { children: { recurse: { depth: 0 } } },
        }).issues
      ).toBeDefined();
    }
  });

  test("admits recursion below an ordinary node and a second slot inside the repeated node", () => {
    expect(
      parse(placementSchemas.grove.args.findMany, {
        include: {
          root: {
            select: {
              label: true,
              children: {
                recurse: true,
                include: { parent: { recurse: { depth: false } } },
              },
            },
          },
        },
      })
    ).toEqual({
      value: {
        include: {
          root: {
            select: {
              label: true,
              children: {
                recurse: { depth: 100, cycles: "reject" },
                include: {
                  parent: {
                    recurse: { depth: false, cycles: "reject" },
                    select: treeRow,
                  },
                },
                select: treeRow,
              },
            },
          },
        },
      },
    });
    expect(
      parse(placementSchemas.grove.args.findMany, {
        include: {
          root: {
            include: {
              children: {
                recurse: true,
                include: { parent: { recurse: { depth: 2, depths: 3 } } },
              },
            },
          },
        },
      }).issues
    ).toBeDefined();
  });

  test("keeps every non-recursive node on its ordinary admission", () => {
    expect(
      parse(placementSchemas.tree.relations.children.include, true)
    ).toEqual({ value: { select: treeRow } });
    expect(
      parse(placementSchemas.tree.relations.children.include, {
        where: { label: "x" },
        orderBy: { label: "asc" },
        take: -2,
        skip: 1,
        cursor: { id: "node" },
        distinct: ["label"],
      })
    ).toEqual({
      value: {
        where: { label: { equals: "x" } },
        orderBy: { label: "asc" },
        take: -2,
        skip: 1,
        cursor: { id: "node" },
        distinct: ["label"],
        select: treeRow,
      },
    });
    expect(
      parse(placementSchemas.tree.relations.parent.select, {
        select: { label: true, parent: true },
      })
    ).toEqual({
      value: { select: { label: true, parent: { select: treeRow } } },
    });
    expect(
      parse(placementSchemas.grove.relations.root.include, {
        include: { children: true },
      })
    ).toEqual({
      value: {
        include: { children: { select: treeRow } },
        select: treeRow,
      },
    });
    expect(
      issueOf(
        parse(placementSchemas.grove.relations.root.include, { recurse: true })
      )
    ).toContain(
      "recurse is available only on an ordinary self relation (a foreign key or a junction, never variant storage) whose model has a complete primary key"
    );
  });
});

class CountingDriver extends SqlOnlyDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  statements = 0;

  constructor() {
    super(
      new PostgresAdapter("public", true),
      "postgresql",
      "recursive-admission-test"
    );
  }

  protected override async execute<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.statements += 1;
    return await super.execute<T>();
  }

  protected override async executeRaw<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.statements += 1;
    return await super.executeRaw<T>();
  }
}

describe("recursive relation admission — the admission boundary", () => {
  test("refuses invalid recursion before the cache or the provider is asked", async () => {
    const driver = new CountingDriver();
    const cacheDriver = new CountingMemoryCache();
    const client = createClient({ schema: { tree, grove }, driver });
    const cached = client.$extends(cache({ driver: cacheDriver }));
    try {
      // Control: an admitted read reaches both, so the counts can move.
      await expect(
        cached.$withCache().tree.findMany({ where: { label: "x" } })
      ).resolves.toEqual([]);
      expect(cacheDriver.reads).toBeGreaterThan(0);
      expect(driver.statements).toBeGreaterThan(0);
      const reads = cacheDriver.reads;
      const writes = cacheDriver.writes;
      const statements = driver.statements;

      for (const args of [
        { include: { children: { recurse: { depth: 0 } } } },
        { include: { children: { recurse: true, take: 1 } } },
        { include: { groves: { recurse: true } } },
        {
          include: {
            children: { recurse: { depth: 3, preventCycles: false } },
          },
        },
        {
          select: {
            children: { recurse: true, select: { children: true } },
          },
        },
      ]) {
        await expect(
          Reflect.apply(
            Reflect.get(cached.$withCache().tree, "findMany"),
            undefined,
            [args]
          )
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
          Reflect.apply(Reflect.get(client.tree, "findMany"), undefined, [args])
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(cacheDriver.reads).toBe(reads);
      expect(cacheDriver.writes).toBe(writes);
      expect(driver.statements).toBe(statements);
    } finally {
      await client.$disconnect();
    }
  });
});
