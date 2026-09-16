/**
 * G4-02 author check — RF-16's property, measured with a traversal-only walk.
 *
 * This is `tests/raptor3/g4/read-recursive-fit.test.ts` (the witness estate's
 * RF-16 cells) with ONE change: the flattening walk descends the traversal
 * relation (`children`) instead of every nested value. The witness's own walk
 * adopts each row's `document: { code }` JSON payload as if it were a traversal
 * row — the payload carries a string `code`, so it lands in `byCode` AFTER the
 * row it belongs to and overwrites it, and `root.amount` then reads
 * `undefined`. That is a witness defect, not a candidate gap: with the walk
 * corrected, all three cells pass on the candidate. The requested one-line
 * change is recorded in `g4/unit02/note.md` §P.11.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import type { Query, Queries } from "@query-engine/raptor3/shared/query";
import { DbNull, s } from "@schema";
import { Decimal } from "@src/index";
import type { AnyModel } from "@schema/model";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";

const NODE_TABLE = "g4_recursive_nodes";

type TraversalArgs = {
  where?: Input;
  select?: Input;
  include?: Input;
  orderBy?: Input | Input[];
};

interface RecursiveTraversal {
  readonly seeds: readonly { readonly args: TraversalArgs }[];
  readonly relation: string;
  readonly depth: number;
  readonly args?: TraversalArgs;
}

interface RecursiveQueries {
  recursive(model: AnyModel, traversal: RecursiveTraversal): Query;
}

const node = s
  .model({
    tenant: s.string().map("tenant_key"),
    code: s.string().map("node_code"),
    label: s.string().map("display_label"),
    rank: s.int().map("sibling_rank"),
    amount: s.decimal({ precision: 10, scale: 2 }).map("node_amount"),
    moment: s.dateTime().map("node_moment"),
    big: s.bigInt().map("node_big"),
    status: s.enum(["OPEN", "CLOSED"]).map("node_status"),
    document: s.json().nullable().map("node_document"),
    labels: s.string().array().map("node_labels"),
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

interface NodeSeed {
  readonly tenant: string;
  readonly code: string;
  readonly label: string;
  readonly rank: number;
  readonly amount: string;
  readonly moment: Date;
  readonly big: bigint;
  readonly status: "OPEN" | "CLOSED";
  readonly document: unknown;
  readonly labels: readonly string[];
  readonly parentTenant: string | null;
  readonly parentCode: string | null;
}

function seedNode(
  code: string,
  rank: number,
  parent: string | null,
  overrides: Partial<NodeSeed> = {}
): NodeSeed {
  return {
    tenant: "tree",
    code,
    label: `Label ${code}`,
    rank,
    amount: "12.34",
    moment: new Date("2024-05-06T07:08:09.000Z"),
    big: 9_007_199_254_740_993n,
    status: "OPEN",
    document: { code },
    labels: [code, "common"],
    parentTenant: parent === null ? null : "tree",
    parentCode: parent,
    ...overrides,
  };
}

const NODES: readonly NodeSeed[] = [
  seedNode("root", 0, null, { amount: "100.05", big: 1n }),
  seedNode("beta", 10, "root", { status: "CLOSED", document: null }),
  seedNode("alpha", 20, "root", { labels: ["alpha"] }),
  seedNode("alpha-1", 20, "alpha", { amount: "-0.01" }),
  seedNode("alpha-2", 10, "alpha", {
    moment: new Date("1970-01-01T00:00:00.000Z"),
  }),
  seedNode("other", 0, null),
];

function createRecursiveClient(driver: SQLite3Driver) {
  return createClient({ schema, driver });
}

class RecursiveWitnessDriver extends SQLite3Driver {
  readonly statements: { sql: string; binds: number }[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ) {
    this.statements.push({ sql: statement, binds: parameters.length });
    return super.execute<T>(client, statement, parameters);
  }
}

function assertRecursiveQueries(
  queries: Queries
): asserts queries is Queries & RecursiveQueries {
  assert.equal(
    typeof Reflect.get(queries, "recursive"),
    "function",
    "the private Queries.recursive fit capability is missing"
  );
}

describe("G4 RF-16 recursive-read fit on the fuller codec set", () => {
  let database: Database.Database;
  let driver: RecursiveWitnessDriver;
  let client: ReturnType<typeof createRecursiveClient>;
  let engineSchema: EngineSchema;

  beforeEach(async () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = OFF");
    driver = new RecursiveWitnessDriver({ client: database });
    client = createRecursiveClient(driver);
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const writer = client as unknown as Record<
      string,
      { create(args: unknown): Promise<unknown> }
    >;
    for (const seed of NODES) {
      await writer.node?.create({
        data: { ...seed, document: seed.document ?? DbNull },
      });
    }
    engineSchema = new EngineSchema(schema);
    driver.statements.length = 0;
  });

  afterEach(async () => {
    await client?.$disconnect();
    database?.close();
  });

  async function traverse(traversal: RecursiveTraversal): Promise<Input[]> {
    const context = new OperationContext(
      engineSchema,
      driver,
      "node",
      "findMany"
    );
    assertRecursiveQueries(context.queries);
    const query = context.queries.recursive(node, traversal);
    const before = driver.statements.length;
    const rows = await context.run(() => context.read(query));
    assert.equal(
      driver.statements.length,
      before + 1,
      "one traversal must execute exactly one provider statement"
    );
    return rows;
  }

  it("RF-16 projects the fuller codec set at every depth", async () => {
    const rows = await traverse({
      seeds: [
        {
          args: {
            where: { tenant: "tree", code: "root" },
            select: {
              code: true,
              amount: true,
              moment: true,
              big: true,
              status: true,
              document: true,
              labels: true,
            },
          },
        },
      ],
      relation: "children",
      depth: 2,
      args: {
        orderBy: [{ rank: "asc" }, { code: "asc" }],
        select: {
          code: true,
          amount: true,
          moment: true,
          big: true,
          status: true,
          document: true,
          labels: true,
        },
      },
    });
    const flat: Record<string, unknown>[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const member of value) walk(member);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (typeof row.code === "string") flat.push(row);
      walk(row.children);
    };
    walk(rows);
    const byCode = new Map(flat.map((row) => [String(row.code), row]));
    assert.deepEqual(
      [...byCode.keys()].sort(),
      ["alpha", "alpha-1", "alpha-2", "beta", "root"],
      "the traversal reached every node within the depth bound"
    );
    const root = byCode.get("root");
    assert.ok(root);
    assert.equal(canonicalizeDecimal(root.amount), "100.05");
    assert.ok(root.amount instanceof Decimal);
    assert.ok(root.moment instanceof Date);
    assert.equal(
      (root.moment as Date).toISOString(),
      "2024-05-06T07:08:09.000Z"
    );
    assert.equal(root.big, 1n);
    assert.equal(root.status, "OPEN");
    assert.deepEqual(root.document, { code: "root" });
    assert.deepEqual(root.labels, ["root", "common"]);
    const beta = byCode.get("beta");
    assert.ok(beta);
    assert.equal(beta.status, "CLOSED");
    assert.equal(beta.document, null);
    const epoch = byCode.get("alpha-2");
    assert.ok(epoch);
    assert.equal(
      (epoch.moment as Date).toISOString(),
      "1970-01-01T00:00:00.000Z"
    );
  });

  it("RF-16 applies descendant where, select and orderBy at every level", async () => {
    const rows = await traverse({
      seeds: [
        {
          args: {
            where: { tenant: "tree", code: "root" },
            select: { code: true },
          },
        },
      ],
      relation: "children",
      depth: 2,
      args: {
        where: { status: "OPEN" },
        orderBy: [{ rank: "asc" }, { code: "asc" }],
        select: { code: true },
      },
    });
    const codes: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const member of value) walk(member);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (typeof row.code === "string") codes.push(row.code);
      for (const nested of Object.values(row)) walk(nested);
    };
    walk(rows);
    assert.equal(
      codes.includes("beta"),
      false,
      "a descendant filtered out by the traversal where must not appear"
    );
    assert.ok(codes.includes("alpha"));
    assert.ok(codes.includes("alpha-2"));
  });

  it("RF-16 orders roots by seed and keeps one statement per traversal", async () => {
    const rows = await traverse({
      seeds: [
        {
          args: {
            where: { tenant: "tree", code: "other" },
            select: { code: true },
          },
        },
        {
          args: {
            where: { tenant: "tree", code: "root" },
            select: { code: true },
          },
        },
      ],
      relation: "children",
      depth: 0,
      args: { select: { code: true } },
    });
    assert.deepEqual(
      rows.map((row) => row.code),
      ["other", "root"],
      "roots follow seed order, not the physical row order"
    );
    assert.equal(driver.statements.length, 1);
  });
});
