/**
 * G4-02 phase-2 review — the recursive carrier's identities, through the
 * ordinary projection.
 *
 * Phase 2's private `Queries.recursive` carried a TEXT path element per hop;
 * that slice and its growing paths are gone (features-docs/recursive-query.md
 * §3.6). A recursive relation is now one ordinary projected field whose private
 * carrier transports complete row-key TUPLES for the root, each node and each
 * edge, and the decoder unfolds path occurrences. These probes keep attacking
 * what an identity encoding could break, now through the command engine:
 *
 *  1. an FK cycle — it now fails inside the traversed window and is simply not
 *     reached outside it (contract change: the private fit pruned it);
 *  2. two roots reaching one row — separate overlapping occurrences (contract
 *     change: the operation, not a seed list, owns the roots);
 *  3. identity text that needs JSON escaping (a quote, a backslash, a newline
 *     and a non-ASCII code point in a compound key member);
 *  4. a large bigint decoded exactly at every depth (RF-16's own property).
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";

const NODE_TABLE = "r2_rec_nodes";

const node = s
  .model({
    tenant: s.string().map("tenant_key"),
    code: s.string().map("node_code"),
    rank: s.int().map("sibling_rank"),
    big: s.bigInt().map("node_big"),
    parentTenant: s.string().nullable().map("parent_tenant_key"),
    parentCode: s.string().nullable().map("parent_node_code"),
    parent: s
      .toOne(() => node)
      .fields("parentTenant", "parentCode")
      .references("tenant", "code")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
  })
  .id(["tenant", "code"])
  .map(NODE_TABLE);

const schema = { node };

function buildClient(driver: SQLite3Driver) {
  return createClient({ schema, driver });
}

let database: Database.Database;
let driver: SQLite3Driver;
let client: ReturnType<typeof buildClient>;

beforeEach(async () => {
  database = new Database(":memory:");
  database.pragma("foreign_keys = OFF");
  driver = new SQLite3Driver({ client: database });
  client = buildClient(driver);
  assert.equal((await syncLiveSchema(client)).applied, true);
});

afterEach(async () => {
  await client?.$disconnect();
  database?.close();
});

function insert(
  code: string,
  rank: number,
  parent: string | null,
  big = 1n
): void {
  database
    .prepare(
      `INSERT INTO ${NODE_TABLE} (tenant_key, node_code, sibling_rank, node_big, parent_tenant_key, parent_node_code) VALUES (?,?,?,?,?,?)`
    )
    .run("t", code, rank, String(big), parent === null ? null : "t", parent);
}

/** The ordinary `findMany`, descending `children` from the named roots. */
async function descend(
  roots: readonly string[],
  depth: number,
  select: Input = { code: true }
): Promise<Input[]> {
  const rows = await createCommandEngine({ schema, driver }).execute(
    "node",
    "findMany",
    {
      where: { tenant: "t", code: { in: [...roots] } },
      orderBy: { rank: "asc" },
      select: {
        ...select,
        children: {
          recurse: { depth },
          orderBy: [{ rank: "asc" }],
          select,
        },
      },
    }
  );
  assert(Array.isArray(rows));
  return rows as Input[];
}

/** Only the traversal relation is descended — never a row's own payload. */
function flatten(rows: readonly Input[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  const pending: unknown[] = [...rows].reverse();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    flat.push(row);
    if (Array.isArray(row.children))
      pending.push(...[...row.children].reverse());
  }
  return flat;
}

describe("G4-02 review — the recursive carrier's identities", () => {
  it("fails an FK cycle inside the window and does not reach it outside", async () => {
    insert("root", 0, "leaf");
    insert("mid", 1, "root");
    insert("leaf", 2, "mid");
    // Contract change: the private fit pruned the revisit path-locally; the
    // public contract refuses an FK cycle that closes inside the window. The
    // ring closes at hop 3.
    for (const depth of [3, 8])
      await assert.rejects(
        descend(["root"], depth),
        (error: unknown) =>
          error instanceof QueryEngineError &&
          error.message === "Recursive relation 'children' contains a cycle."
      );
    const codes = flatten(await descend(["root"], 2)).map((row) =>
      String(row.code)
    );
    assert.deepEqual(
      codes,
      ["root", "mid", "leaf"],
      `outside the window the ring is not reached: ${JSON.stringify(codes)}`
    );
  });

  it("keeps two roots reaching one row as separate occurrences", async () => {
    insert("root", 0, null);
    insert("shared", 1, "root");
    insert("under", 2, "shared");
    // Contract change: the roots are the operation's rows, not seeds.
    const rows = await descend(["root", "shared"], 4);
    const codes = flatten(rows)
      .map((row) => String(row.code))
      .sort();
    assert.deepEqual(
      codes,
      ["root", "shared", "shared", "under", "under"],
      `each root keeps its own occurrence: ${JSON.stringify(codes)}`
    );
    const nested = (rows[0]!.children as Input[])[0]!;
    assert.equal(nested.code, "shared");
    assert.notStrictEqual(nested, rows[1]);
  });

  it("carries an identity whose text needs JSON escaping", async () => {
    const tricky = 'a"b\\c\ndé中';
    insert("root", 0, null);
    insert(tricky, 1, "root");
    insert("under", 2, tricky);
    const flat = flatten(await descend(["root"], 4, { code: true, big: true }));
    const codes = flat.map((row) => String(row.code));
    assert.deepEqual(
      codes,
      ["root", tricky, "under"],
      `an escaped identity must still traverse: ${JSON.stringify(codes)}`
    );
    for (const row of flat)
      assert.equal(
        typeof row.big,
        "bigint",
        `bigint stays exact: ${JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`
      );
  });

  it("decodes a large bigint exactly at every depth (RF-16's own property)", async () => {
    insert("root", 0, null, 9_007_199_254_740_993n);
    insert("child", 1, "root", -9_007_199_254_740_993n);
    const byCode = new Map(
      flatten(await descend(["root"], 2, { code: true, big: true })).map(
        (row) => [String(row.code), row.big]
      )
    );
    assert.equal(byCode.get("root"), 9_007_199_254_740_993n);
    assert.equal(byCode.get("child"), -9_007_199_254_740_993n);
  });
});
