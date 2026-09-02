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
 * The dual-substrate oracle (N1-U3) on the three CREATE shapes: the located parent's
 * primary key is the value a freshly created child must carry, once as a single
 * `create`, once as a `createMany` leaf, and once through a whole create SUBTREE whose
 * own child is produced a level deeper.
 *
 * Every arm runs on empty tables in the shared schema declared above — the two arms of a
 * scenario one after the other, truncated between. The harness, the comparison, and the
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

runOracleAgreement(getFamily, oracleScenarios);
