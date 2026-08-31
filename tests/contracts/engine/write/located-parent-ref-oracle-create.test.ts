import {
  type OracleScenario,
  runOracleAgreement,
  seed,
} from "@tests/contracts/engine/write/located-parent-ref-fixtures";

/**
 * The dual-substrate oracle (N1-U3) on the three CREATE shapes: the located parent's
 * primary key is the value a freshly created child must carry, once as a single
 * `create`, once as a `createMany` leaf, and once through a whole create SUBTREE whose
 * own child is produced a level deeper.
 *
 * Every arm opens a fresh database — two per scenario, one per substrate — which is why
 * the scenario list is split across three files. The harness, the comparison, and the
 * reasoning behind the oracle live in `located-parent-ref-fixtures.ts`; the reference
 * shapes are in `located-parent-ref-oracle-reference.test.ts` and the two failing
 * premises in `located-parent-ref-oracle-failure.test.ts`.
 */
const oracleScenarios: OracleScenario[] = [
  {
    name: "nested create by a non-PK unique",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: { notes: { create: { id: 1, body: "b" } } },
        select: { id: true, notes: { select: { id: true, accountId: true } } },
      }),
  },
  {
    name: "nested createMany by a non-PK unique",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: {
          notes: {
            createMany: {
              data: [
                { id: 1, body: "b" },
                { id: 2, body: "c" },
              ],
            },
          },
        },
        select: { id: true, notes: { select: { id: true, accountId: true } } },
      }),
  },
  {
    name: "a relation-carrying create subtree",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: {
          notes: {
            create: {
              id: 1,
              body: "subtree",
              attachments: { create: { id: 2, name: "a.txt" } },
            },
          },
        },
        select: { id: true },
      }),
  },
];

runOracleAgreement(oracleScenarios);
