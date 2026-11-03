/**
 * PGlite Driver Tests — the 1.9.0 final review (GPT-6.1 Sol): a policy's
 * tenant beside other extensions' bounds, recursive sets bounded by
 * different layers, and move's data read once. Each case was reproduced on
 * 8493d1a2b before its fix.
 */
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { ordering } from "@src/ordering";
import { permissions } from "@src/permissions";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { v } from "@validation";
import { describe, expect, test } from "vitest";

const node = s.model({
  id: s.string().id(),
  tenant: s.string(),
  group: s.string(),
  rank: s.string(),
  title: s.string(),
  flag: s.boolean(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});
const schema = { node };
const family = usePGliteSchemaFamily(schema);
const actor = { tenant: "a" };
const nodes = [
  {
    id: "a",
    tenant: "a",
    group: "g1",
    rank: "15",
    title: "a",
    flag: false,
    parentId: null,
  },
  {
    id: "b",
    tenant: "b",
    group: "g1",
    rank: "16",
    title: "b",
    flag: true,
    parentId: "a",
  },
  {
    id: "c",
    tenant: "a",
    group: "g1",
    rank: "17",
    title: "c",
    flag: false,
    parentId: "b",
  },
  {
    id: "d",
    tenant: "b",
    group: "g2",
    rank: "18",
    title: "d",
    flag: false,
    parentId: "c",
  },
  {
    id: "e",
    tenant: "a",
    group: "g2",
    rank: "19",
    title: "e",
    flag: true,
    parentId: "a",
  },
];
function governed(base: any, rule: any, bounded: boolean) {
  return base
    .$extends(
      permissions({
        actor: v.object({ tenant: v.string() }),
        ...(bounded ? { tenant: { field: "tenant", actor: "tenant" } } : {}),
        models: {
          node: {
            actions: { read: [], see: ["read"], audit: ["read"] },
            read: true,
            see: rule,
            audit: rule,
          },
        },
      })
    )
    .$as(actor);
}

describe("adversarial review repros", () => {
  test("polarity monotonicity over nested reference and recursive filters", async () => {
    const base = createClient({
      schema,
      driver: new PGliteDriver({
        client: family().database,
        namespace: family().namespace,
        relationsPerStatement: 1,
      }),
    });
    await base.node.createMany({ data: nodes });
    const leaves: any[] = [
      { flag: true },
      { flag: false },
      { id: "b" },
      { NOT: { flag: true } },
    ];
    const rules: any[] = [...leaves];
    for (const leaf of leaves) {
      for (const q of ["some", "none", "every"]) {
        rules.push({ children: { [q]: leaf } });
        rules.push({ NOT: { children: { [q]: leaf } } });
        rules.push({ children: { recurse: { depth: false }, [q]: leaf } });
        rules.push({
          NOT: { children: { recurse: { depth: false }, [q]: leaf } },
        });
      }
      for (const q of ["is", "isNot"]) {
        rules.push({ parent: { [q]: leaf } });
        rules.push({ NOT: { parent: { [q]: leaf } } });
      }
    }
    const inner = [...rules];
    for (const rule of inner) {
      for (const q of ["some", "none", "every"])
        rules.push({ children: { [q]: rule } });
      for (const q of ["is", "isNot"]) rules.push({ parent: { [q]: rule } });
    }
    for (let i = 0; i < rules.length; i++) {
      const plain = await governed(base, rules[i], false).node.findMany({
        select: { id: true, $access: true },
        orderBy: { id: "asc" },
      });
      const bound = await governed(base, rules[i], true).node.findMany({
        select: { id: true, $access: true },
        orderBy: { id: "asc" },
      });
      for (let j = 0; j < bound.length; j++)
        if (bound[j].$access.see && !plain[j].$access.see)
          throw new Error(
            "WIDEN " +
              i +
              " " +
              JSON.stringify(rules[i]) +
              " " +
              JSON.stringify({ plain, bound })
          );
    }
  }, 120_000);

  test("move restriction snapshot with accessor", async () => {
    const base = family().client;
    const db = base.$extends(
      ordering({ node: { key: "rank", within: ["group"] } })
    );
    await base.node.createMany({ data: nodes });
    let calls = 0;
    const data = {
      get group() {
        return calls++ === 0 ? undefined : "g2";
      },
      title: "changed",
    };
    const result = await (db.node as any).move({
      where: { id: "a" },
      key: "155",
      data,
    });
    expect(result.group).toBe("g1");
  });

  test("move nested self alias", async () => {
    const base = family().client;
    const db = base.$extends(
      ordering({ node: { key: "rank", within: ["group"] } })
    );
    await base.node.createMany({ data: nodes });
    await expect(
      (db.node as any).move({
        where: { id: "a" },
        key: "155",
        data: {
          children: {
            update: {
              where: { id: "b" },
              data: { parent: { update: { group: "g2" } } },
            },
          },
        },
      })
    ).rejects.toThrow("data writes the model's own fields");
    expect((await base.node.findUnique({ where: { id: "a" } }))!.group).toBe(
      "g1"
    );
  });
});

test("rows.bound, its name before 1.11, is refused rather than dropped", () => {
  const base = family().client;
  expect(() =>
    base.$extends({
      name: "renamed-bound",
      rows: {
        control: "scope",
        default: "on",
        models: { node: { on: {} } },
        bound: { node: { tenant: "b" } },
      },
    } as any)
  ).toThrow(
    "rows.bound is not a rows key: it is named rows.confine since 1.11"
  );
});

test("a confine reading a relation is refused when applied", async () => {
  const base = family().client;
  expect(() =>
    base.$extends({
      name: "relational-bound",
      rows: {
        control: "scope",
        default: "on",
        models: {
          node: { on: { root: { children: { some: { flag: true } } } } },
        },
        confine: { node: { parent: { is: { flag: true } } } },
      },
    } as any)
  ).toThrow("which is not a scalar field");
});

test("a missing optional tenant actor reads bounded sets as empty", async () => {
  const base = family().client;
  await base.node.createMany({ data: nodes });
  const db = base
    .$extends(
      permissions({
        actor: v.object({ tenant: v.optional(v.string()) }),
        tenant: { field: "tenant", actor: "tenant" },
        models: {
          node: {
            actions: { read: [], see: ["read"], audit: ["read"] },
            read: true,
            see: { children: { some: { flag: true } } },
            audit: { children: { some: { flag: true } } },
          },
        },
      })
    )
    .$as({});
  const rows = await db.node.findMany({
    where: { id: "a" },
    select: { id: true, $access: true },
  });
  expect(rows[0]!.$access.see).toBe(false);
});

describe("composed bounds", () => {
  const page = s.model({
    id: s.string().id(),
    tenant: s.string(),
    title: s.string().default("old"),
    grants: s.toMany(() => grant),
  });
  const team = s.model({
    id: s.string().id(),
    tenant: s.string(),
    active: s.boolean(),
    grants: s.toMany(() => grant),
  });
  const grant = s.model({
    id: s.string().id(),
    tenant: s.string(),
    pageId: s.string(),
    teamId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
  });
  const f = usePGliteSchemaFamily({ page, team, grant });
  test("adding tenant never substitutes another layer bound", async () => {
    const base = f().client;
    await base.page.create({ data: { id: "p", tenant: "a" } });
    await base.team.create({ data: { id: "t", tenant: "a", active: true } });
    await base.grant.create({
      data: { id: "g", tenant: "a", pageId: "p", teamId: "t" },
    });
    const other = {
      name: "other-bound",
      rows: {
        control: "other",
        default: "on",
        models: {
          grant: { on: { related: { team: { is: { active: true } } } } },
        },
        confine: { team: { tenant: "b" } },
      },
    };
    const run = async (bounded: boolean) => {
      const statements: string[] = [];
      const policy = permissions({
        actor: v.object({ tenant: v.string() }),
        ...(bounded ? { tenant: { field: "tenant", actor: "tenant" } } : {}),
        models: {
          page: {
            actions: { read: [], audit: ["read"], update: ["read"] },
            update: { grants: { some: { id: { not: "-" } } } },
            read: { grants: { some: { id: { not: "-" } } } },
            audit: { grants: { some: { id: { not: "-" } } } },
          },
        },
      });
      const db = base
        .$extends(policy)
        .$extends(other as any)
        .$extends({
          name: "sql",
          statement(c) {
            statements.push(c.statement.toStatement());
            return c.statement;
          },
        })
        .$as({ tenant: "a" });
      const rows = await db.page.findMany({
        select: { id: true, $access: true },
      });
      return rows;
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

test("shared reaching sets distinguish which layer bounds them", async () => {
  const { database, namespace } = family();
  const base = createClient({
    schema,
    driver: new PGliteDriver({
      client: database,
      namespace,
      relationsPerStatement: 1,
    }),
  });
  await base.node.createMany({ data: nodes });
  const walk = {
    children: { recurse: { depth: false }, some: { flag: true } },
  };
  const run = async (bounded: boolean) => {
    const policy = permissions({
      actor: v.object({ tenant: v.string() }),
      ...(bounded ? { tenant: { field: "tenant", actor: "tenant" } } : {}),
      models: {
        node: {
          actions: { read: [], see: ["read"], audit: ["read"] },
          read: true,
          see: walk,
          audit: walk,
        },
      },
    });
    const second = {
      name: "second-bound",
      rows: {
        control: "second",
        default: "on",
        models: { node: { on: { root: { AND: [walk, walk] } } } },
        confine: { node: { tenant: "b" } },
      },
    };
    const statements: string[] = [];
    const db = base
      .$extends(policy)
      .$extends(second as any)
      .$extends({
        name: "sql",
        statement(c) {
          statements.push(c.statement.toStatement());
          return c.statement;
        },
      })
      .$as({ tenant: "a" });
    const rows = await db.node.findMany({
      where: { id: "a" },
      select: { id: true, $access: true },
    });
    return rows;
  };
  expect(await run(true)).toEqual(await run(false));
});

test("two generic bounds do not share their different reaching sets", async () => {
  const { database, namespace } = family();
  const base = createClient({
    schema,
    driver: new PGliteDriver({
      client: database,
      namespace,
      relationsPerStatement: 1,
    }),
  });
  await base.node.createMany({ data: nodes });
  const walk = {
    children: { recurse: { depth: false }, some: { flag: true } },
  };
  const extension = (name: string, bound?: string) => ({
    name,
    rows: {
      control: name,
      default: "on",
      models: { node: { on: { root: { AND: [walk, walk] } } } },
      ...(bound ? { confine: { node: { tenant: bound } } } : {}),
    },
  });
  const run = async (bounded: boolean) => {
    const statements: string[] = [];
    const db = base
      .$extends(extension("one", bounded ? "a" : undefined) as any)
      .$extends(extension("two", "b") as any)
      .$extends({
        name: "sql",
        statement(c) {
          statements.push(c.statement.toStatement());
          return c.statement;
        },
      });
    const rows = await db.node.findMany({
      where: { id: "a" },
      select: { id: true },
    });
    return rows;
  };
  expect(await run(true)).toEqual(await run(false));
});
