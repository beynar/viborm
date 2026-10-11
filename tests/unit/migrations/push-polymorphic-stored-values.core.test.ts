/**
 * Push refuses a polymorphic stored-value change that orphans stored rows
 * (Track A engine-06).
 *
 * `generate` refuses the change by comparing authored snapshots, but push
 * diffs against the live database, which keeps no polymorphic history: the
 * stored discriminators ARE that history. Push therefore probes them before any
 * effect, and the refusal is data-driven — a value no row stores still pushes.
 */

import { createClient } from "@client/client";
import { VibORMErrorCode } from "@errors";
import { lenientResolver } from "@migrations";
import { createMigrationClient } from "@migrations/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { expect, test } from "vitest";

const ROWS = 10_000;
const EMPTY_SLOTS = 100;

const schema = (values: { readonly post: string; readonly video: string }) => {
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      reactions: s.toMany(() => reaction).name("target"),
    })
    .map("post");
  const video = s
    .model({
      id: s.string().id(),
      title: s.string(),
      reactions: s.toMany(() => reaction).name("target"),
    })
    .map("video");
  const reaction = s
    .model({
      id: s.string().id(),
      kind: s.enum(["like", "love", "laugh"]),
      weight: s.int().default(1),
      score: s.number().default(0),
      flagged: s.boolean().default(false),
      locale: s.string().default("en"),
      note: s.string().nullable(),
      source: s.string().nullable(),
      rank: s.int().nullable(),
      meta: s.json().nullable(),
      editedAt: s.dateTime().nullable(),
      createdAt: s.dateTime().now(),
      target: s
        .toOne({ post: () => post, video: () => video }, { values })
        .optional()
        .name("target"),
    })
    .map("reaction");
  return { post, video, reaction };
};

const V1 = { post: "post.v1", video: "video.v1" } as const;
/** The same schema plus one additive table, to show push ran no effect. */
const withAudit = (values: {
  readonly post: string;
  readonly video: string;
}) => ({
  ...schema(values),
  audit: s.model({ id: s.string().id() }).map("audit"),
});

/** ROWS reactions store 'post.v1'; EMPTY_SLOTS more store no target at all. */
async function populated() {
  const driver = createInMemorySQLite3Driver();
  const v1 = createClient({ schema: schema(V1), driver });
  await createMigrationClient(v1).push();
  await v1.post.create({ data: { id: "p1", title: "Post" } });
  await driver._executeRaw(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS + EMPTY_SLOTS - 1})
     INSERT INTO "reaction" ("id", "kind", "target_type", "target_id")
     SELECT 'r' || i, 'like', CASE WHEN i < ${ROWS} THEN 'post.v1' END, CASE WHEN i < ${ROWS} THEN 'p1' END FROM n`
  );
  const stored = async () =>
    (
      await driver._executeRaw<{ value: string | null; count: number }>(
        `SELECT "target_type" AS value, count(*) AS count FROM "reaction" GROUP BY 1 ORDER BY 1`
      )
    ).rows;
  const tables = async () =>
    (
      await driver._executeRaw<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`
      )
    ).rows.map((row) => row.name);
  return { driver, v1, stored, tables };
}

test("push refuses, before any effect, a stored-value change that orphans stored rows", async () => {
  const { driver, v1, stored, tables } = await populated();
  try {
    const before = await stored();
    const v2 = createClient({
      schema: withAudit({ post: "post.v2", video: "video.v1" }),
      driver,
    });
    const refusal = {
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining(
        'Polymorphic storage "reaction.target" stores "post.v1"'
      ),
      meta: expect.objectContaining({
        table: "reaction",
        relation: "target",
      }),
    };
    await expect(
      createMigrationClient(v2).push({ dryRun: true })
    ).rejects.toMatchObject(refusal);
    await expect(createMigrationClient(v2).push()).rejects.toMatchObject(
      refusal
    );
    // The accompanying additive table was never created and no row moved.
    expect(await tables()).not.toContain("audit");
    expect(await stored()).toEqual(before);
    expect(before).toEqual([
      { value: null, count: EMPTY_SLOTS },
      { value: "post.v1", count: ROWS },
    ]);
    await expect(
      v1.reaction.findUnique({ where: { id: "r0" }, include: { target: true } })
    ).resolves.toMatchObject({ target: { type: "post", data: { id: "p1" } } });
  } finally {
    await driver.disconnect();
  }
});

test("a stored-value change no row stores still pushes, and an unchanged schema stays a no-op", async () => {
  const { driver, v1 } = await populated();
  try {
    expect((await createMigrationClient(v1).push()).outcome).toBe("noop");
    // No row stores 'video.v1' (the empty slots store NULL): nothing orphans.
    const v2 = createClient({
      schema: withAudit({ post: "post.v1", video: "video.v2" }),
      driver,
    });
    const pushed = await createMigrationClient(v2).push();
    expect(pushed.operations.map((operation) => operation.label)).toEqual([
      expect.stringContaining('"audit"'),
    ]);
    await expect(
      v2.reaction.findUnique({
        where: { id: `r${ROWS - 1}` },
        include: { target: true },
      })
    ).resolves.toMatchObject({ target: { type: "post", data: { id: "p1" } } });
  } finally {
    await driver.disconnect();
  }
});

test("the probe follows an accepted rename of the slot to the live column", async () => {
  const slotSchema = (field: "target" | "subject", value: string) => {
    const post = s.model({ id: s.string().id() }).map("post");
    const note = s
      .model({
        id: s.string().id(),
        [field]: s.toOne({ post: () => post }, { values: { post: value } }),
      })
      .map("note");
    return { post, note };
  };
  const driver = createInMemorySQLite3Driver();
  try {
    await createMigrationClient(
      createClient({ schema: slotSchema("target", "post.v1"), driver })
    ).push();
    await driver._executeRaw(
      `INSERT INTO "note" ("id", "target_type", "target_id") VALUES ('n1', 'post.v1', 'p1')`
    );
    const renamed = createClient({
      schema: slotSchema("subject", "post.v2"),
      driver,
    });
    await expect(
      createMigrationClient(renamed).push({ resolve: lenientResolver })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining(
        'Polymorphic storage "note.subject" stores "post.v1"'
      ),
    });
  } finally {
    await driver.disconnect();
  }
});
