import {
  type OracleScenario,
  runOracleAgreement,
  seed,
} from "@tests/contracts/engine/write/located-parent-ref-fixtures";

/**
 * The dual-substrate oracle (N1-U3) on the two payloads that FAIL: the located row does
 * not exist at all, and the child the located key would carry collides on its own
 * primary key. These are the arms where the oracle's comparison is of the error class
 * and message — the half of the claim the successful shapes cannot make.
 *
 * Every arm opens a fresh database — two per scenario, one per substrate — which is why
 * the scenario list is split across three files. The harness, the comparison, and the
 * reasoning behind the oracle live in `located-parent-ref-fixtures.ts`; the plain create
 * shapes are in `located-parent-ref-oracle-create.test.ts` and the referenced-column
 * shapes in `located-parent-ref-oracle-reference.test.ts`.
 */
const oracleScenarios: OracleScenario[] = [
  {
    name: "the located row does not exist",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "absent@x" },
        data: { notes: { create: { id: 1, body: "never" } } },
        select: { id: true },
      }),
  },
  {
    name: "the created child collides on its own primary key",
    seed: async (c) => {
      await seed(c);
      await c.note.create({ data: { id: 1, body: "taken", accountId: 1 } });
    },
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: { notes: { create: { id: 1, body: "dup" } } },
        select: { id: true },
      }),
  },
];

runOracleAgreement(oracleScenarios);
