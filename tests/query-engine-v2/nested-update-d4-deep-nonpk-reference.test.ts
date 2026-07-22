import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * T3b-2 named reorder obligation (TO-ONE.md §7.7) — the D4-deep non-PK reference guard.
 *
 * Mechanism 1/2 let a nested `update`'s located target build its own child Parts,
 * correlated to the target's PK carried by a compile-time literal (or a planned probe
 * value). That literal carries the target's PRIMARY KEY per-field. A **D4-style deeper
 * edge whose FK references a NON-PK unique** of the target (here `member.orgCode ->
 * org.code`) cannot be injected by it — the literal holds the org's `id`, not its
 * `code` — AND the PK-only depth reorder check would not fire on a `code` rewrite. So
 * `buildNestedTargetChildParts` routes the whole tree to V1 (a documented narrower
 * boundary than the root, which threads a non-PK referenced value from its located row).
 *
 * The witness is a routing witness: V2 declines the tree, V1 serves it, and the state is
 * byte-identical on both substrates. Remove the guard and native V2 would inject the
 * org's `id` into `member.orgCode` — a divergence this test would catch as a state
 * mismatch (the deeper FK carrying the wrong value). A disjoint second company is
 * asserted untouched.
 */

const d4DeepSchema = (() => {
  const company = s
    .model({
      id: s.int().id(),
      name: s.string(),
      orgs: s.oneToMany(() => org),
    })
    .map("d4_deep_companies");
  const org = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      companyId: s.int(),
      company: s
        .manyToOne(() => company)
        .fields("companyId")
        .references("id"),
      // member.orgCode references org.code (a NON-PK unique) — the D4-style edge.
      members: s.oneToMany(() => member),
    })
    .map("d4_deep_orgs");
  const member = s
    .model({
      id: s.string().id(),
      orgCode: s.string(),
      org: s
        .manyToOne(() => org)
        .fields("orgCode")
        .references("code"),
    })
    .map("d4_deep_members");
  return { company, org, member };
})();

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function makeV1Client(db: PGlite) {
  return createClient({
    schema: d4DeepSchema,
    driver: new PGliteDriver({ client: db }),
    queryEngine: "v1",
  });
}
type AnyClient = ReturnType<typeof makeV1Client>;

async function seed(client: AnyClient): Promise<void> {
  await (client as any).company.create({ data: { id: 1, name: "acme" } });
  await (client as any).org.create({
    data: { id: "o1", code: "OLD", companyId: 1 },
  });
  // A disjoint second company + org — untouched by the op.
  await (client as any).company.create({ data: { id: 2, name: "globex" } });
  await (client as any).org.create({
    data: { id: "o2", code: "OTHER", companyId: 2 },
  });
}

// Nested update: the org `o1` (the update target) creates a member whose FK references
// org.code — a non-PK unique. The deeper edge must reference a non-PK column of the
// located target, so the tree routes to V1.
const OP = {
  where: { id: 1 },
  data: {
    orgs: {
      update: {
        where: { id: "o1" },
        data: { members: { create: { id: "m1" } } },
      },
    },
  },
} as const;

interface Snapshot {
  orgs: [string, string][];
  members: [string, string][];
}

async function snapshot(client: AnyClient): Promise<Snapshot> {
  const orgs = await (client as any).org.findMany({ orderBy: { id: "asc" } });
  const members = await (client as any).member.findMany({
    orderBy: { id: "asc" },
  });
  return {
    orgs: orgs.map((o: any) => [o.id, o.code]),
    members: members.map((m: any) => [m.id, m.orgCode]),
  };
}

async function runV1(): Promise<Snapshot> {
  const db = new PGlite();
  const client = makeV1Client(db);
  await push(client as any, { force: true });
  await seed(client);
  await (client as any).company.update(OP);
  const state = await snapshot(client);
  await client.$disconnect();
  return state;
}

async function runV2(
  substrate: "tx" | "batch"
): Promise<{ state: Snapshot; engines: Set<"v1" | "v2"> }> {
  const db = new PGlite();
  const fallback = makeV1Client(db);
  await push(fallback as any, { force: true });
  await seed(fallback);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const routed = createV2RoutedClient({
    schema: d4DeepSchema,
    client: fallback as unknown as Record<string, any>,
    driver,
  });
  await routed.client.company!.update!(OP as Record<string, unknown>);
  const state = await snapshot(fallback);
  await fallback.$disconnect();
  return { state, engines: new Set(routed.routes.map((r) => r.engine)) };
}

describe("nested update D4-deep non-PK reference guard (reorder obligation)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `a deeper edge referencing a non-PK unique routes to V1 and matches (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const v1 = await runV1();
        // V1 creates m1 with orgCode = o1's code ("OLD"); the disjoint org o2 untouched.
        expect(v1.orgs).toEqual([
          ["o1", "OLD"],
          ["o2", "OTHER"],
        ]);
        expect(v1.members).toEqual([["m1", "OLD"]]);
        const { state, engines } = await runV2(substrate);
        // The literal-parent depth builder cannot inject a non-PK reference — the whole
        // tree routes to V1 (one engine served it, and that engine is V1).
        expect(engines).toEqual(new Set(["v1"]));
        // Byte-identical state (the deeper FK carries the org's CODE, never its id).
        expect(state).toEqual(v1);
      }
    );
  }
});
