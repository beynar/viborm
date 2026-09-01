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
 * The dual-substrate oracle (N1-U3) on the two payloads that FAIL: the located row does
 * not exist at all, and the child the located key would carry collides on its own
 * primary key. These are the arms where the oracle's comparison is of the error class
 * and message — the half of the claim the successful shapes cannot make.
 *
 * Every arm runs on empty tables in the shared schema declared above — the two arms of a
 * scenario one after the other, truncated between. The harness, the comparison, and the
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

runOracleAgreement(getFamily, oracleScenarios);
