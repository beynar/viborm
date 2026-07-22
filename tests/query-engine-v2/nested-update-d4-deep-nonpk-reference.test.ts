import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";

/**
 * T3b-2 named reorder obligation (TO-ONE.md §7.7) — the D4-deep non-PK reference
 * boundary, post-P6 (the single engine).
 *
 * Mechanism 1/2 let a nested `update`'s located target build its own child Parts,
 * correlated to the target's PK carried by a compile-time literal (or a planned probe
 * value). That literal carries the target's PRIMARY KEY per-field. A **D4-style deeper
 * edge whose FK references a NON-PK unique** of the target (here `member.orgCode ->
 * org.code`) cannot be injected by it — the literal holds the org's `id`, not its
 * `code`. So the operation DECLINES with an {@link UnsupportedOperationError} at
 * construction: a documented narrower boundary than the root (which threads a non-PK
 * referenced value from its located row), reached by no conformance scenario, whose
 * absorption is post-P6 backlog (the nesting-depth-limit lift). With V1 deleted there is
 * no fallback: the decline is terminal.
 *
 * The witness pins the decline. Because it fires at construction — before any I/O — the
 * seeded state is untouched on BOTH substrates. Widening the depth builder to inject the
 * org's `id` into `member.orgCode` (a wrong-value divergence) would turn this from a
 * decline into a persisted mutation, and this test would catch it.
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

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: d4DeepSchema, driver });
}
type AnyClient = ReturnType<typeof makeClient>;

async function seed(client: AnyClient): Promise<void> {
  await (client as any).company.create({ data: { id: 1, name: "acme" } });
  await (client as any).org.create({
    data: { id: "o1", code: "OLD", companyId: 1 },
  });
  // A disjoint second company + org — untouched by the (declined) op.
  await (client as any).company.create({ data: { id: 2, name: "globex" } });
  await (client as any).org.create({
    data: { id: "o2", code: "OTHER", companyId: 2 },
  });
}

// Nested update: the org `o1` (the update target) creates a member whose FK references
// org.code — a non-PK unique. The deeper edge references a non-PK column of the located
// target, so the tree declines.
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

describe("nested update D4-deep non-PK reference boundary (reorder obligation)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `a deeper edge referencing a non-PK unique declines with no partial mutation (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const db = new PGlite();
        const driver =
          substrate === "tx"
            ? new PGliteDriver({ client: db })
            : new BatchOnlyPGliteDriver({ client: db });
        const client = makeClient(driver);
        await push(client as any, { force: true });
        await seed(client);

        await expect((client as any).company.update(OP)).rejects.toBeInstanceOf(
          UnsupportedOperationError
        );

        // The decline fires at construction, before any I/O: nothing changed.
        expect(await snapshot(client)).toEqual({
          orgs: [
            ["o1", "OLD"],
            ["o2", "OTHER"],
          ],
          members: [],
        });
        await client.$disconnect();
      }
    );
  }
});
