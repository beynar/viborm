/**
 * C-01 cutover round-4 review probe (independent reviewer, not a registered mode).
 *
 * Round 4 restores the fifteen class-A suites and deletes, cell by cell, "the
 * cells that are red against the new engine". Note R4.5 and the commit-message
 * draft describe every one of those 240 cells as an "SQL-text, message-text,
 * source-text and oracle pin of the deleted engine".
 *
 * These cells ask whether that description holds for a sample of the deleted
 * cells whose base assertion was a REGISTERED REFUSAL on a READ path — not a
 * text pin. Each one restates the base cell's own call through the PUBLIC
 * client, so the answer is the shipped user-visible behaviour, not a `build()`
 * artefact. They assert what the cutover tree ACTUALLY does, so they are green
 * here and are evidence for a review finding, not a claim of the unit's.
 *
 * Base cells restated (all from
 * `tests/contracts/engine/query/sql-generation.core.test.ts` at 5a37bcd7):
 *   - "refuses non-portable JSON string path %s"  (6 cells, `.toThrow(message)`)
 *   - "json filter with only a path fails closed" (1 cell)
 *   - "empty accepted scalar filter fails closed" (1 cell)
 *   - "json string paths compile to the same SQL as the array form" (1 cell)
 */
import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { hydrateSchemaNames, s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
    metadata: s.json().nullable(),
  })
  .map("g4rc4_authors");
const schema = { author };
hydrateSchemaNames(schema);

const opened: Database.Database[] = [];
const clients: { $disconnect(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
  for (const database of opened.splice(0)) database.close();
});

async function world() {
  const database = new Database(":memory:");
  opened.push(database);
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ driver, schema });
  clients.push(client as unknown as { $disconnect(): Promise<unknown> });
  assert.equal((await syncLiveSchema(client)).applied, true);
  await client.author.create({
    data: { name: "Ada", metadata: { status: "active", pet: { toys: ["ball"] } } },
  });
  await client.author.create({
    data: { name: "Bob", metadata: { status: "retired", pet: { toys: ["bone"] } } },
  });
  return client;
}

async function outcome(run: () => PromiseLike<unknown>) {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe("round-4 review — deleted class-A cells that pinned a READ-path refusal", () => {
  it("does not refuse the six non-portable JSON string paths the base refused", async () => {
    const client = await world();
    // The base cell: `expect(() => getSql(...)).toThrow(message)` for each pair.
    const paths: readonly [string, string][] = [
      ["status", "must start with '$'"],
      ["$.", "object key may not be empty"],
      ["$.*", "wildcards are not supported"],
      ["$[last]", "not a non-negative integer array index"],
      ["$[0", "an unclosed '['"],
      ["$status", "unexpected 's'"],
    ];
    const seen: Record<string, unknown> = {};
    for (const [path] of paths)
      seen[path] = await outcome(() =>
        client.author.findMany({
          where: { metadata: { path, equals: "active" } },
          select: { name: true },
        })
      );
    // Every one resolves: no refusal at all, and the malformed path is simply
    // not applied — the predicate compares the whole document instead.
    for (const [path] of paths) {
      const result = seen[path] as { ok?: unknown; error?: string };
      assert.equal(
        result.error,
        undefined,
        `${path} refused with ${result.error}`
      );
      assert.deepEqual(result.ok, []);
    }
  });

  it("does not refuse a JSON filter that carries only a path, and answers every row", async () => {
    const client = await world();
    // The base cell: "json filter with only a path fails closed".
    const result = await outcome(() =>
      client.author.findMany({
        where: { metadata: { path: ["status"] } },
        select: { name: true },
      })
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(result.ok, [{ name: "Ada" }, { name: "Bob" }]);
  });

  it("does not refuse an empty scalar filter, and answers every row", async () => {
    const client = await world();
    // The base cell: "empty accepted scalar filter fails closed", which pinned
    // `Filter for field 'name' must contain at least one operation`.
    const result = await outcome(() =>
      client.author.findMany({ where: { name: {} }, select: { name: true } })
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(result.ok, [{ name: "Ada" }, { name: "Bob" }]);
  });

  it("carries the empty-scalar-filter fail-open into deleteMany and updateMany", async () => {
    const client = await world();
    const updated = await outcome(() =>
      client.author.updateMany({
        where: { name: {} },
        data: { name: "overwritten" },
      })
    );
    assert.deepEqual(updated, { ok: { count: 2 } });
    const deleted = await outcome(() =>
      client.author.deleteMany({ where: { name: {} } })
    );
    assert.deepEqual(deleted, { ok: { count: 2 } });
    assert.deepEqual(
      await outcome(() => client.author.findMany({ select: { name: true } })),
      { ok: [] }
    );
  });

  it("answers a string JSON path and the equivalent array path differently", async () => {
    const client = await world();
    // The base cell: "json string paths compile to the same SQL as the array
    // form" — the two spellings were one query.
    const arrayForm = await outcome(() =>
      client.author.findMany({
        where: { metadata: { path: ["pet", "toys", "0"], equals: "ball" } },
        select: { name: true },
      })
    );
    const stringForm = await outcome(() =>
      client.author.findMany({
        where: { metadata: { path: "$.pet.toys[0]", equals: "ball" } },
        select: { name: true },
      })
    );
    assert.deepEqual(arrayForm, { ok: [{ name: "Ada" }] });
    assert.notDeepEqual(stringForm, arrayForm);
    assert.deepEqual(stringForm, { ok: [] });
  });
});
