/**
 * The acceptance of a junction that is a model: on synthetic organizations of
 * teams, a governed `recurse` walk under `tenant` answers what the same walk
 * answers through a generated junction, and reads fewer link rows, as EXPLAIN
 * ANALYZE counts them. The walk's forms: the shared-body path, the Neki form
 * (`relationsPerStatement: 256`), `selective` and `fewRows`.
 */

import { createClient as createPGliteClient } from "@drivers/pglite";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation/primitives/v";
import { afterAll, beforeAll, expect, test } from "vitest";

const ORGANIZATIONS = 40;
const TEAMS = 30;

const generated = () => {
  const team = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    name: s.string().default("team"),
    parents: s
      .toMany(() => team)
      .name("teamGraph")
      .through("teamParent")
      .source("childId")
      .target("parentId"),
    children: s.toMany(() => team).name("teamGraph"),
  });
  return { team };
};

const declared = () => {
  const teamParent = s
    .model({
      organizationId: s.string(),
      childId: s.string(),
      parentId: s.string(),
      child: s
        .toOne(() => team)
        .fields("organizationId", "childId")
        .references("organizationId", "id")
        .onDelete("cascade"),
      parent: s
        .toOne(() => team)
        .fields("organizationId", "parentId")
        .references("organizationId", "id")
        .onDelete("cascade"),
    })
    .id(["childId", "parentId"]);
  const team = s
    .model({
      id: s.string().id(),
      organizationId: s.string(),
      name: s.string().default("team"),
      parents: s
        .toMany(() => team)
        .name("teamGraph")
        .through(() => teamParent)
        .source("child")
        .target("parent"),
      children: s.toMany(() => team).name("teamGraph"),
    })
    .unique(["organizationId", "id"]);
  return { team, teamParent };
};

const policy = (recurse: Record<string, unknown>) =>
  permissions({
    actor: v.object({ organizationId: v.string() }),
    tenant: { field: "organizationId", actor: "organizationId" },
    models: {
      team: {
        mandatory: { organizationId: { actor: "organizationId" } },
        read: {
          parents: {
            recurse: { depth: false, ...recurse },
            some: { name: "root" },
          },
        },
      },
    },
  } as never);

interface Fixture {
  readonly client: any;
  readonly raw: (sql: string, params?: unknown[]) => Promise<any[]>;
}

const open = async (
  schema: Record<string, unknown>,
  linkColumns: readonly string[],
  options: Record<string, unknown> = {}
): Promise<Fixture> => {
  const pglite = await openTestPGlite();
  const client: any = createPGliteClient({
    schema: schema as never,
    client: pglite,
    ...options,
  } as never);
  await syncLiveSchema(client);
  const teams: string[] = [];
  const links: string[] = [];
  for (let o = 0; o < ORGANIZATIONS; o++)
    for (let t = 0; t < TEAMS; t++) {
      teams.push(`('o${o}t${t}','o${o}','${t === 0 ? "root" : "team"}')`);
      if (t > 0) {
        const link = [`'o${o}t${t}'`, `'o${o}t${Math.floor((t - 1) / 2)}'`];
        links.push(
          `(${linkColumns.includes("organizationId") ? `'o${o}',` : ""}${link.join(",")})`
        );
      }
    }
  await pglite.exec(
    `INSERT INTO "team" ("id","organizationId","name") VALUES ${teams.join(",")}`
  );
  await pglite.exec(
    `INSERT INTO "teamParent" (${linkColumns.map((c) => `"${c}"`).join(",")}) VALUES ${links.join(",")}; ANALYZE;`
  );
  const raw = async (sql: string, params: unknown[] = []) =>
    (await pglite.query(sql, params as never[])).rows as any[];
  return { client, raw };
};

/** Every `teamParent` row the statement read, filtered out or not, loops counted. */
const linkRowsRead = (plan: any): number => {
  let rows = 0;
  const walk = (node: any) => {
    if (node["Relation Name"] === "teamParent")
      rows +=
        (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) *
        node["Actual Loops"];
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan.Plan);
  return rows;
};

let plain: Fixture;
let model: Fixture;

beforeAll(async () => {
  plain = await open(generated(), ["childId", "parentId"]);
  model = await open(declared(), ["organizationId", "childId", "parentId"]);
}, 120_000);
afterAll(async () => {
  await plain.client.$disconnect();
  await model.client.$disconnect();
});

const answers = async (fixture: Fixture, recurse: Record<string, unknown>) => {
  const governed = fixture.client.$extends(policy(recurse));
  const out: unknown[] = [];
  for (const organizationId of ["o0", "o17", "o39"])
    out.push(
      await governed.$as({ organizationId }).team.findMany({
        orderBy: { id: "asc" },
        select: { id: true },
      })
    );
  return out;
};

test.each([
  ["the plain walk", {}],
  ["selective", { selective: true }],
])(
  "%s answers the same through either junction",
  async (_name, recurse) => {
    const left = await answers(plain, recurse);
    const right = await answers(model, recurse);
    expect(right).toEqual(left);
    expect((right[0] as unknown[]).length).toBe(TEAMS - 1);
  },
  120_000
);

test("a selective walk through the model reads fewer link rows", async () => {
  const read = async (fixture: Fixture) => {
    const spy = { sql: "", params: [] as unknown[] };
    const governed = fixture.client
      .$extends({
        name: "capture",
        statement(context: any) {
          spy.sql = context.statement.toStatement("$n");
          spy.params = context.statement.values;
          return context.statement;
        },
      })
      .$extends(policy({ selective: true }));
    await governed.$as({ organizationId: "o17" }).team.findMany({
      select: { id: true },
    });
    const [row] = await fixture.raw(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${spy.sql}`,
      spy.params
    );
    return { rows: linkRowsRead(row["QUERY PLAN"][0]), sql: spy.sql };
  };
  const generatedRead = await read(plain);
  const modelRead = await read(model);
  console.info(
    `link rows read: generated ${generatedRead.rows}, model ${modelRead.rows}\n${modelRead.sql}`
  );
  expect(modelRead.rows).toBeLessThan(generatedRead.rows);
}, 120_000);

test("the Neki form, under a relation budget, answers the same", async () => {
  const neki = await open(
    declared(),
    ["organizationId", "childId", "parentId"],
    { relationsPerStatement: 256 }
  );
  try {
    expect(await answers(neki, {})).toEqual(await answers(plain, {}));
  } finally {
    await neki.client.$disconnect();
  }
}, 120_000);

test("fewRows projects the same walk through either junction", async () => {
  const walk = async (fixture: Fixture, fewRows: boolean) =>
    fixture.client.team.findUnique({
      where: { id: "o3t7" },
      select: {
        id: true,
        parents: {
          select: { id: true },
          recurse: { depth: false, ...(fewRows ? { fewRows: true } : {}) },
        },
      },
    });
  const expected = await walk(plain, false);
  expect(await walk(model, false)).toEqual(expected);
  expect(await walk(model, true)).toEqual(expected);
  expect(await walk(plain, true)).toEqual(expected);
}, 120_000);

test("counts and $through read the same links, governed by a rule that hides nothing", async () => {
  const governed = model.client.$extends(
    permissions({
      actor: v.object({ organizationId: v.string() }),
      tenant: { field: "organizationId", actor: "organizationId" },
      models: {
        team: { read: { organizationId: { actor: "organizationId" } } },
        teamParent: { read: true },
      },
    } as never)
  );
  const row = await governed.$as({ organizationId: "o5" }).team.findUnique({
    where: { id: "o5t3" },
    select: {
      _count: { select: { parents: true } },
      parents: {
        select: { id: true, $through: { select: { childId: true } } },
      },
    },
  });
  expect(row).toEqual({
    _count: { parents: 1 },
    parents: [{ id: "o5t1", $through: { childId: "o5t3" } }],
  });
}, 120_000);
