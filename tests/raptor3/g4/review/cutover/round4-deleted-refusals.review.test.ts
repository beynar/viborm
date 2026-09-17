/**
 * C-01 cutover round-4 review probe (independent reviewer, not a registered mode).
 *
 * REPAIRED by parity lane Q / U1 (2026-09-17). Every cell below found a
 * registered READ-path refusal that the cutover tree had stopped raising, and
 * asserted the fail-OPEN behaviour as the finding's evidence. U1 moved those
 * refusals to the admission boundary (rule 5), so each cell now asserts the
 * refusal it was written to document. The call sites are unchanged: this file
 * still restates the base cells through the PUBLIC client.
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

/** The one sentence every empty-filter arm below answers. */
const NO_OPERATION = /must contain at least one operation/;
/** Escapes a reason string so it can be matched literally. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

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
  it("refuses the six non-portable JSON string paths the base refused", async () => {
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
    // Every one refuses, with its own reason, before any statement.
    for (const [path, reason] of paths) {
      const result = seen[path] as { ok?: unknown; error?: string };
      assert.equal(result.ok, undefined, `${path} resolved`);
      assert.match(
        String(result.error),
        new RegExp(reason.replace(REGEX_METACHARACTERS, "\\$&"))
      );
    }
  });

  it("refuses a JSON filter that carries only a path", async () => {
    const client = await world();
    // The base cell: "json filter with only a path fails closed".
    const result = await outcome(() =>
      client.author.findMany({
        where: { metadata: { path: ["status"] } },
        select: { name: true },
      })
    );
    assert.equal(result.ok, undefined);
    assert.match(String(result.error), NO_OPERATION);
  });

  it("refuses an empty scalar filter", async () => {
    const client = await world();
    // The base cell: "empty accepted scalar filter fails closed", which pinned
    // `Filter for field 'name' must contain at least one operation`. The
    // admission owner is interned per scalar type and cannot name the field,
    // so the field moved into the ValidationError's issue path.
    const result = await outcome(() =>
      client.author.findMany({ where: { name: {} }, select: { name: true } })
    );
    assert.equal(result.ok, undefined);
    assert.match(String(result.error), NO_OPERATION);
    // …and the empty `where` still matches everything.
    assert.deepEqual(
      await outcome(() => client.author.findMany({ select: { name: true } })),
      { ok: [{ name: "Ada" }, { name: "Bob" }] }
    );
  });

  it("carries the empty-scalar-filter refusal into deleteMany and updateMany", async () => {
    const client = await world();
    const updated = await outcome(() =>
      client.author.updateMany({
        where: { name: {} },
        data: { name: "overwritten" },
      })
    );
    assert.equal(updated.ok, undefined);
    assert.match(String(updated.error), NO_OPERATION);
    const deleted = await outcome(() =>
      client.author.deleteMany({ where: { name: {} } })
    );
    assert.equal(deleted.ok, undefined);
    assert.match(String(deleted.error), NO_OPERATION);
    // Nothing was written or removed.
    assert.deepEqual(
      await outcome(() => client.author.findMany({ select: { name: true } })),
      { ok: [{ name: "Ada" }, { name: "Bob" }] }
    );
  });

  it("answers a string JSON path and the equivalent array path identically", async () => {
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
    assert.deepEqual(stringForm, arrayForm);
  });
});
