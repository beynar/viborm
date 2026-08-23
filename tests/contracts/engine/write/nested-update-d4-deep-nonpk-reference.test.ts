import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * N1-U1 — the D4-deep non-PK reference, absorbed from the former T3b-2
 * named-reorder decline.
 *
 * DELIBERATE TEST RETARGET, authorized by the N-wave plan's N1 acceptance ("the Ref
 * works under X1c delegation at depth >= 2 — a located grandparent's column reffed by a
 * grandchild create"). Until N1 this file pinned an `UnsupportedOperationError`: a nested
 * `update` whose located target carries a deeper edge referencing a NON-PK unique of that
 * target (`member.orgCode -> org.code`) had no compile-time literal for the foreign key —
 * X1c already delegated the whole target to an `UpdateOperation`, but that root then
 * demanded the referenced column be pinned by the target's `where`, and the target's
 * `where` names its PRIMARY KEY. The decline was literal-only propagation at depth,
 * verbatim, and N1 removed its cause: the delegated root's locate now selects `code` and
 * the grandchild create resolves its foreign key from THE LOCATED ORG ROW.
 *
 * So the same payload is now an ACCEPT, and the witness pins what it persists. This is
 * the depth-2 composition proof: the located parent is itself a nested target, two
 * levels under the operation root, and the Ref rides the sub-operation's own locate.
 *
 * The falsification the old test guarded is kept and sharpened: injecting the org's `id`
 * where its `code` belongs (the wrong-value divergence) would write `member.orgCode =
 * 'o1'`, and the assertion names `'OLD'`. A second org with a DIFFERENT code is seeded so
 * "any org's code" cannot pass either.
 */

const d4DeepSchema = (() => {
  const company = s
    .model({
      id: s.int().id(),
      name: s.string(),
      orgs: s.toMany(() => org),
    })
    .map("d4_deep_companies");
  const org = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      companyId: s.int(),
      company: s
        .toOne(() => company)
        .fields("companyId")
        .references("id"),
      // member.orgCode references org.code (a NON-PK unique) — the D4-style edge.
      members: s.toMany(() => member),
    })
    .map("d4_deep_orgs");
  const member = s
    .model({
      id: s.string().id(),
      orgCode: s.string(),
      org: s
        .toOne(() => org)
        .fields("orgCode")
        .references("code"),
    })
    .map("d4_deep_members");
  return { company, org, member };
})();

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: d4DeepSchema, driver });
}
type AnyClient = ReturnType<typeof makeClient>;

async function seed(client: AnyClient): Promise<void> {
  await (client as any).company.create({ data: { id: 1, name: "acme" } });
  await (client as any).org.create({
    data: { id: "o1", code: "OLD", companyId: 1 },
  });
  // A disjoint second company + org whose code differs — so "any org's code" cannot
  // satisfy the assertion; only the LOCATED org's can.
  await (client as any).company.create({ data: { id: 2, name: "globex" } });
  await (client as any).org.create({
    data: { id: "o2", code: "OTHER", companyId: 2 },
  });
}

// Nested update: the org `o1` (the update target) creates a member whose FK references
// org.code — a non-PK unique the target's own `where` (its primary key) does not carry.
// The value comes from the row the target's locate acted on.
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

describe("nested update D4-deep non-PK reference (located-parent Ref at depth 2)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `a deeper edge referencing a non-PK unique reads it from the located target (${substrate})`,
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

        await (client as any).company.update(OP);

        // `m1.orgCode` is o1's CODE ('OLD'), not its id ('o1') and not the other org's
        // code ('OTHER'): the grandchild's foreign key came from the row the nested
        // target's locate acted on.
        expect(await snapshot(client)).toEqual({
          orgs: [
            ["o1", "OLD"],
            ["o2", "OTHER"],
          ],
          members: [["m1", "OLD"]],
        });
        await client.$disconnect();
      }
    );
  }
});
