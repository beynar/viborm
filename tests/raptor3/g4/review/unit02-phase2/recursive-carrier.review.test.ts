/**
 * G4-02 phase-2 review — the recursive carrier and its TEXT path element.
 *
 * Phase 2 changed two things inside `Queries.recursive`: the carried row now
 * crosses through the ONE carrier transport owner (`carriedValue`, §P.4.2), and
 * every path element is the identity document's own TEXT so the cycle stop is
 * portable (§P.4.12). The author's `recursive-codec-fit.test.ts` re-checks the
 * codec values with a corrected flatten. These probes attack the two properties
 * the TEXT element could break and that no cell covers:
 *
 *  1. the path-local cycle stop, over a real cycle;
 *  2. two seeds reaching one row — separate overlapping occurrences;
 *  3. identity text that needs JSON escaping (a quote, a backslash, a newline
 *     and a non-ASCII code point in a compound key member).
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import type { Queries, Query } from "@query-engine/raptor3/shared/query";
import type { AnyModel } from "@schema/model";
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

interface RecursiveTraversal {
  readonly seeds: readonly { readonly args: Record<string, unknown> }[];
  readonly relation: string;
  readonly depth: number;
  readonly args?: Record<string, unknown>;
}

interface RecursiveQueries {
  recursive(model: AnyModel, traversal: RecursiveTraversal): Query;
}

function assertRecursive(
  queries: Queries
): asserts queries is Queries & RecursiveQueries {
  assert.equal(typeof Reflect.get(queries, "recursive"), "function");
}

function buildClient(driver: SQLite3Driver) {
  return createClient({ schema, driver });
}

let database: Database.Database;
let driver: SQLite3Driver;
let client: ReturnType<typeof buildClient>;
let engineSchema: EngineSchema;

beforeEach(async () => {
  database = new Database(":memory:");
  database.pragma("foreign_keys = OFF");
  driver = new SQLite3Driver({ client: database });
  client = buildClient(driver);
  assert.equal((await syncLiveSchema(client)).applied, true);
  engineSchema = new EngineSchema(schema);
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

async function traverse(traversal: RecursiveTraversal): Promise<Input[]> {
  const context = new OperationContext(engineSchema, driver, "node", "findMany");
  assertRecursive(context.queries);
  const query = context.queries.recursive(node, traversal);
  return await context.run(() => context.read(query));
}

/** Only the traversal relation is descended — never a row's own payload. */
function flatten(rows: readonly Input[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const member of value) walk(member);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    flat.push(row);
    walk(row.children);
  };
  walk(rows as unknown);
  return flat;
}

describe("G4-02 review — the recursive path carrier", () => {
  it("stops a real cycle path-locally", async () => {
    insert("root", 0, "leaf");
    insert("mid", 1, "root");
    insert("leaf", 2, "mid");
    const rows = await traverse({
      seeds: [
        { args: { where: { tenant: "t", code: "root" }, select: { code: true } } },
      ],
      relation: "children",
      depth: 8,
      args: { orderBy: [{ rank: "asc" }], select: { code: true } },
    });
    const codes = flatten(rows).map((row) => String(row.code));
    assert.deepEqual(
      codes,
      ["root", "mid", "leaf"],
      `a cycle must stop on the path, once per occurrence: ${JSON.stringify(codes)}`
    );
  });

  it("keeps two seeds reaching one row as separate occurrences", async () => {
    insert("root", 0, null);
    insert("shared", 1, "root");
    insert("under", 2, "shared");
    const rows = await traverse({
      seeds: [
        { args: { where: { tenant: "t", code: "root" }, select: { code: true } } },
        { args: { where: { tenant: "t", code: "shared" }, select: { code: true } } },
      ],
      relation: "children",
      depth: 4,
      args: { orderBy: [{ rank: "asc" }], select: { code: true } },
    });
    const codes = flatten(rows).map((row) => String(row.code)).sort();
    assert.deepEqual(
      codes,
      ["root", "shared", "shared", "under", "under"],
      `each seed keeps its own occurrence: ${JSON.stringify(codes)}`
    );
  });

  it("carries an identity whose text needs JSON escaping", async () => {
    const tricky = 'a"b\\c\ndé中';
    insert("root", 0, null);
    insert(tricky, 1, "root");
    insert("under", 2, tricky);
    const rows = await traverse({
      seeds: [
        { args: { where: { tenant: "t", code: "root" }, select: { code: true, big: true } } },
      ],
      relation: "children",
      depth: 4,
      args: { orderBy: [{ rank: "asc" }], select: { code: true, big: true } },
    });
    const flat = flatten(rows);
    const codes = flat.map((row) => String(row.code));
    assert.deepEqual(
      codes,
      ["root", tricky, "under"],
      `an escaped identity must still traverse: ${JSON.stringify(codes)}`
    );
    for (const row of flat)
      assert.equal(typeof row.big, "bigint", `bigint stays exact: ${JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
  });

  it("decodes a large bigint exactly at every depth (RF-16's own property)", async () => {
    insert("root", 0, null, 9_007_199_254_740_993n);
    insert("child", 1, "root", -9_007_199_254_740_993n);
    const rows = await traverse({
      seeds: [
        { args: { where: { tenant: "t", code: "root" }, select: { code: true, big: true } } },
      ],
      relation: "children",
      depth: 2,
      args: { orderBy: [{ rank: "asc" }], select: { code: true, big: true } },
    });
    const byCode = new Map(
      flatten(rows).map((row) => [String(row.code), row.big])
    );
    assert.equal(byCode.get("root"), 9_007_199_254_740_993n);
    assert.equal(byCode.get("child"), -9_007_199_254_740_993n);
  });
});
