import {
  armClient,
  CHILD_HELD_EDGE,
  cascadeSchema,
  op,
  seed,
  snapshot,
} from "@tests/contracts/engine/write/nested-update-pk-transition-cascade-fixtures";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * One shared PGlite, one private schema for this file. Every arm below is built over
 * that database and carries its namespace — without one a driver addresses `public`,
 * where this suite has no tables.
 */
const getFamily = usePGliteSchemaFamily(cascadeSchema);

/**
 * The three arms that bracket the ORDERING mechanism of the PK-transition cascade
 * boundary (T3b1 finding #1). The mechanism, the bed, and the history of every
 * retarget live in `nested-update-pk-transition-cascade-fixtures.ts`.
 *
 * These three share the plain `where: { id: 1 }` locator and an EMPTY old slot, so
 * the occupied guard passes and the reordering itself is what is under test:
 *
 *  - a NO-ACTION child-held deeper edge must land on the POST-transition key,
 *  - an ON UPDATE CASCADE self-m2m edge must still run natively,
 *  - and both kinds at once must run under the SAME single ordering.
 */
const M2M_EDGE = { links: { connect: { id: 5 } } };

describe("nested update PK-transition cascade boundary (finding #1)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `child-held deeper edge under a PK transition adopts onto the new key (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const client = armClient(getFamily(), substrate);
        await seed(client);

        // No child carries the target's key 1, so the occupied guard passes and the
        // deeper connect is written against 7 — the key the self-UPDATE just wrote.
        await (client as any).node.update(op(CHILD_HELD_EDGE));
        expect((await snapshot(client)).parents).toEqual([
          [3, 10],
          [4, 20],
          [5, 7],
          [7, 10],
          [10, null],
          [20, null],
        ]);
      }
    );

    test(
      `both edge kinds at once now run under ONE ordering (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const client = armClient(getFamily(), substrate);
        await seed(client);
        // **RETARGETED BY E2-U3 (authorized test change).** This arm asserted the
        // refusal, on the reasoning that "neither ordering serves both edges": the
        // junction reads MEMBERSHIP at planning, before the self-UPDATE exists, while
        // the child-held edge must be written after it. Both halves of that reading are
        // still true — what was false is that one ordering must supply one value. The
        // junction now READS on the where-pinned pre-transition key and WRITES on the
        // post-transition one (`RelationJunctionConfig.membershipReadSource`, the split
        // N5-U1 already made for `set`), so the post-transition ordering serves both
        // edges at once. Same payload, and this arm asserts the state it produces.
        await (client as any).node.update(
          op({ ...CHILD_HELD_EDGE, ...M2M_EDGE })
        );
        const state = await snapshot(client);
        // The child-held edge landed on the key the self-UPDATE wrote …
        expect(state.parents).toEqual([
          [3, 10],
          [4, 20],
          [5, 7],
          [7, 10],
          [10, null],
          [20, null],
        ]);
        // … and so did the join row: a write against the vacated 1 has no row to
        // reference (the falsification raises a ForeignKeyError there).
        expect(state.links).toContainEqual([7, [5]]);
      }
    );

    test(
      `self-m2m deeper edge under a PK transition executes natively (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const client = armClient(getFamily(), substrate);
        await seed(client);
        await (client as any).node.update(op(M2M_EDGE));
        const state = await snapshot(client);
        // The junction FK cascades: the link written against source 1 follows the PK to 7.
        expect(state.parents).toEqual([
          [3, 10],
          [4, 20],
          [5, null],
          [7, 10],
          [10, null],
          [20, null],
        ]);
        expect(state.links).toContainEqual([7, [5]]);
      }
    );
  }
});
