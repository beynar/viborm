/**
 * D1 Driver Tests — a root write answering a relation projection in its own
 * statement (perf 1.3.4, `OperationContext.answersInStatement`): SQLite reads
 * the projection inside the write's `RETURNING`, so D1 sends one statement
 * where 1.3.3 sent a planning locate and a batch (update, upsert) or a batch
 * of two (create). A delete keeps its capture-then-read route: SQLite's
 * `RETURNING` reads after the rows the delete cascades to are gone.
 * The PGlite/SQLite3 pins and the declining cases are
 * tests/contracts/engine/write/write-projection-round-trips.test.ts.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@src/drivers/d1";
import { NotFoundError } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { s } from "@src/schema";
import { expect, test } from "vitest";
import { RecordingD1 } from "./d1-statements";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const user = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("wp_users");
const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id")
      .onDelete("cascade"),
  })
  .map("wp_posts");
const schema = { user, post };
const FOLDED_UPDATE = /^UPDATE .* RETURNING /;

async function boot() {
  const recording = new RecordingD1(env.DB);
  const client = createClient({ schema, database: recording.database });
  const preview = await createMigrationClient(client).push({ dryRun: true });
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
  await client.user.create({ data: { id: 1, email: "e1", name: "n1" } });
  await client.post.create({ data: { id: 10, title: "p10", authorId: 1 } });
  recording.statements.length = 0;
  return { client, recording };
}

/** Provider round trips: one per lone statement, one per batch. */
function roundTrips(recording: RecordingD1): number {
  const batches = new Set(
    recording.statements.flatMap((statement) =>
      statement.batch === undefined ? [] : [statement.batch]
    )
  );
  return (
    recording.statements.filter((statement) => statement.batch === undefined)
      .length + batches.size
  );
}

test("update, create and upsert answer an include in one statement", async () => {
  const { client, recording } = await boot();
  const author = { id: 1, email: "e1", name: "x" };

  expect(
    await client.user.update({
      where: { id: 1 },
      data: { name: "x" },
      include: { posts: true },
    })
  ).toEqual({ ...author, posts: [{ id: 10, title: "p10", authorId: 1 }] });
  expect(recording.statements).toHaveLength(1);
  expect(recording.statements[0]!.sql).toMatch(FOLDED_UPDATE);

  recording.statements.length = 0;
  expect(
    await client.post.create({
      data: { id: 11, title: "p11", authorId: 1 },
      include: { author: true },
    })
  ).toEqual({ id: 11, title: "p11", authorId: 1, author });
  expect(recording.statements).toHaveLength(1);

  recording.statements.length = 0;
  expect(
    await client.post.upsert({
      where: { id: 12 },
      create: { id: 12, title: "p12", authorId: 1 },
      update: { title: "u" },
      include: { author: true },
    })
  ).toEqual({ id: 12, title: "p12", authorId: 1, author });
  expect(recording.statements).toHaveLength(1);

  recording.statements.length = 0;
  await expect(
    client.user.update({
      where: { id: 9 },
      data: { name: "ghost" },
      include: { posts: true },
    })
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(roundTrips(recording)).toBe(1);
});

test("a delete with an include keeps its capture-then-read route", async () => {
  const { client, recording } = await boot();
  expect(
    await client.post.delete({ where: { id: 10 }, include: { author: true } })
  ).toEqual({
    id: 10,
    title: "p10",
    authorId: 1,
    author: { id: 1, email: "e1", name: "n1" },
  });
  expect(roundTrips(recording)).toBe(3);
});
