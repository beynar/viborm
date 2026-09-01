import { locatedParentRefSchema } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import {
  type OracleScenario,
  runOracleAgreement,
  seed,
} from "@tests/contracts/engine/write/located-parent-ref-fixtures";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

/**
 * One shared PGlite, one private schema for this file. Both arms of every scenario run
 * in it, and every driver the harness builds carries its namespace — without one a
 * driver addresses `public`, where this suite has no tables.
 */
const getFamily = usePGliteSchemaFamily(locatedParentRefSchema);

/**
 * The dual-substrate oracle (N1-U3) on the two shapes where the REFERENCED column is
 * not the discriminator the caller spelled: a D4 reference to `code` alongside a scalar
 * SET on the same row, and a COMPOUND reference whose selector (`handle`) names neither
 * member of the referenced tuple.
 *
 * Every arm runs on empty tables in the shared schema declared above — the two arms of a
 * scenario one after the other, truncated between. The harness, the comparison, and the
 * reasoning behind the oracle live in `located-parent-ref-fixtures.ts`; the plain create
 * shapes are in `located-parent-ref-oracle-create.test.ts` and the two failing premises
 * in `located-parent-ref-oracle-failure.test.ts`.
 */
const oracleScenarios: OracleScenario[] = [
  {
    name: "a D4 referenced column plus a scalar SET",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: {
          label: "renamed",
          tickets: { create: { id: 1, subject: "s" } },
        },
        select: {
          id: true,
          label: true,
          tickets: { select: { id: true, accountCode: true } },
        },
      }),
  },
  {
    name: "a compound reference located by a unique naming neither member",
    seed: async (c) => {
      await c.owner.create({
        data: { tenantId: "t1", slot: "a", handle: "h-t1-a" },
      });
      await c.owner.create({
        data: { tenantId: "t1", slot: "b", handle: "h-t1-b" },
      });
    },
    act: (c) =>
      c.owner.update({
        where: { handle: "h-t1-b" },
        data: { memos: { create: { id: 1, text: "m" } } },
        select: { handle: true },
      }),
  },
];

runOracleAgreement(getFamily, oracleScenarios);
