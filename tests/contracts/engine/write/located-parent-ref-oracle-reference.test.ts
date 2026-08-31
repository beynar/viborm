import {
  type OracleScenario,
  runOracleAgreement,
  seed,
} from "@tests/contracts/engine/write/located-parent-ref-fixtures";

/**
 * The dual-substrate oracle (N1-U3) on the two shapes where the REFERENCED column is
 * not the discriminator the caller spelled: a D4 reference to `code` alongside a scalar
 * SET on the same row, and a COMPOUND reference whose selector (`handle`) names neither
 * member of the referenced tuple.
 *
 * Every arm opens a fresh database — two per scenario, one per substrate — which is why
 * the scenario list is split across three files. The harness, the comparison, and the
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

runOracleAgreement(oracleScenarios);
