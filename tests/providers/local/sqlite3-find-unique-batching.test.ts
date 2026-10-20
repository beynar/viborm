/** findUnique batching on SQLite3: one read per tick, each caller its own answer. */

import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { s } from "@schema";
import {
  type RecordingDriver,
  runFindUniqueBatchingBehavior,
} from "@tests/contracts/public-client/find-unique-batching-behavior";
import type Database from "better-sqlite3";
import { expect, test } from "vitest";

class RecordingSQLite3Driver extends SQLite3Driver implements RecordingDriver {
  readonly statements: string[] = [];
  failWhen: ((statement: string) => boolean) | undefined;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    if (this.failWhen?.(statement))
      throw new Error("injected statement failure");
    return super.execute<T>(client, statement, parameters, context);
  }
}

runFindUniqueBatchingBehavior({
  name: "SQLite3",
  createDriver: () => new RecordingSQLite3Driver({ dataDir: ":memory:" }),
});

test("a key column the database compares case-insensitively answers every caller as its own call would", async () => {
  const tag = s
    .model({ id: s.int().id(), label: s.string().unique() })
    .map("fub_nocase_tags");
  const driver = new RecordingSQLite3Driver({ dataDir: ":memory:" });
  const db = createClient({ schema: { tag }, driver });
  // A table VibORM did not create: its key compares under NOCASE, which
  // a lone `findUnique` honours and JavaScript equality does not.
  await driver._executeRaw(
    `CREATE TABLE "fub_nocase_tags" ("id" INTEGER PRIMARY KEY, "label" TEXT COLLATE NOCASE NOT NULL UNIQUE)`
  );
  await db.tag.createMany({
    data: [
      { id: 1, label: "Alpha" },
      { id: 2, label: "Beta" },
    ],
  });
  const labels = ["alpha", "BETA", "Alpha", "gamma"];
  const alone: unknown[] = [];
  for (const label of labels)
    alone.push(await db.tag.findUnique({ where: { label } }));
  expect(alone.map((row) => (row as { id: number } | null)?.id)).toEqual([
    1,
    2,
    1,
    undefined,
  ]);
  driver.statements.length = 0;
  const batched = await Promise.all(
    labels.map((label) => db.tag.findUnique({ where: { label } }))
  );
  expect(batched).toEqual(alone);
  // The merged read, then the three labels it could not match exactly.
  expect(driver.statements).toHaveLength(4);
  await db.$disconnect();
});
