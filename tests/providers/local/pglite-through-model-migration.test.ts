/**
 * Moving a generated junction to a declared model of the same table: the table
 * and its rows stay, and the plan adds what the model adds. A NOT NULL column
 * with no default on a populated table takes the refusal any such column takes.
 */

import { createClient as createPGliteClient } from "@drivers/pglite";
import { createMigrationClient } from "@migrations";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const DROP_TABLE = /DROP TABLE/;
const ADD_CREATED_AT = /ADD COLUMN "createdAt"/;
const NAMES_ROLE = /role/;
const CREATE_TABLE = /CREATE TABLE/;

const generated = () => {
  const team = s.model({
    id: s.string().id(),
    parents: s
      .toMany(() => team)
      .name("g")
      .through("teamParent")
      .source("childId")
      .target("parentId"),
    children: s.toMany(() => team).name("g"),
  });
  return { team };
};

const declared = (
  extra: Record<string, unknown> = { createdAt: s.dateTime().now() }
) => {
  const teamParent = s
    .model({
      childId: s.string(),
      parentId: s.string(),
      ...(extra as Record<never, never>),
      child: s
        .toOne(() => team)
        .fields("childId")
        .references("id")
        .onDelete("cascade"),
      parent: s
        .toOne(() => team)
        .fields("parentId")
        .references("id")
        .onDelete("cascade"),
    })
    .id(["childId", "parentId"]);
  const team = s.model({
    id: s.string().id(),
    parents: s
      .toMany(() => team)
      .name("g")
      .through(() => teamParent)
      .source("child")
      .target("parent"),
    children: s.toMany(() => team).name("g"),
  });
  return { team, teamParent };
};

const populated = async () => {
  const pglite = await openTestPGlite();
  const first = createPGliteClient({
    schema: generated(),
    client: pglite,
  } as never) as any;
  await syncLiveSchema(first);
  await first.team.create({
    data: { id: "a", parents: { create: { id: "b" } } },
  });
  return { pglite, first };
};

test("the move adds a column and keeps the table and its rows", async () => {
  const { pglite, first } = await populated();
  const client = createPGliteClient({
    schema: declared(),
    client: pglite,
  } as never) as any;
  const plan = await createMigrationClient(client).push({ dryRun: true });
  const text = plan.statements
    .map((statement: any) => statement.sql)
    .join("\n");
  expect(text).not.toMatch(DROP_TABLE);
  expect(text).toMatch(ADD_CREATED_AT);
  await syncLiveSchema(client);
  expect(await client.teamParent.findMany({})).toMatchObject([
    { childId: "a", parentId: "b", createdAt: expect.any(Date) },
  ]);
  const read = await client.team.findUnique({
    where: { id: "a" },
    select: { parents: { select: { id: true } } },
  });
  expect(read.parents).toEqual([{ id: "b" }]);
  const again = await createMigrationClient(client).push({ dryRun: true });
  expect(again.statements).toEqual([]);
  await first.$disconnect();
}, 60_000);

test("a NOT NULL column with no default on a populated table is refused as any is", async () => {
  const { pglite, first } = await populated();
  const client = createPGliteClient({
    schema: declared({ role: s.string() }),
    client: pglite,
  } as never) as any;
  await expect(syncLiveSchema(client)).rejects.toThrow(NAMES_ROLE);
  expect(await first.team.count()).toBe(2);
  const rows = await pglite.query(
    `SELECT count(*)::int AS n FROM "teamParent"`
  );
  expect(rows.rows).toEqual([{ n: 1 }]);
  await first.$disconnect();
}, 60_000);

test("a declared junction generates no table and no constraint of its own", async () => {
  const pglite = await openTestPGlite();
  const client = createPGliteClient({
    schema: declared(),
    client: pglite,
  } as never) as any;
  const plan = await createMigrationClient(client).push({ dryRun: true });
  const creates = plan.statements
    .map((statement: any) => statement.sql)
    .filter((sql: string) => CREATE_TABLE.test(sql));
  expect(creates).toHaveLength(2);
  await client.$disconnect();
}, 60_000);
