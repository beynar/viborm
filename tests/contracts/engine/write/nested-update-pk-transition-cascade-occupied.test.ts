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
 * The three arms of the PK-transition cascade boundary (T3b1 finding #1) that seed an
 * OCCUPANT on the target's old slot. The mechanism, the bed, and the history of every
 * retarget live in `nested-update-pk-transition-cascade-fixtures.ts`.
 *
 * They belong together because they are the same payload against the same occupied
 * slot and differ ONLY in the operand the SET applies to the primary key: a real
 * transition must be rejected by the CLASS IV occupied guard, while a same-value `set`
 * and an `increment: 0` move no slot at all and must be accepted — the verdict the
 * ROOT already makes.
 */
const OCCUPIED_AT_DEPTH = /current relation is occupied/;

describe("nested update PK-transition cascade boundary (finding #1)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `an OCCUPIED old slot rejects the depth transition with nothing written (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const client = armClient(getFamily(), substrate);
        await seed(client);
        // Give the transition target a child of its own: the NO-ACTION referential
        // action would strand it, so the depth occupied guard rejects — V1's verbatim
        // wording, the same the root emits, before any write.
        await (client as any).node.create({
          data: { id: 6, label: "occupant", parentId: 1 },
        });

        await expect(
          (client as any).node.update(op(CHILD_HELD_EDGE))
        ).rejects.toThrow(OCCUPIED_AT_DEPTH);
        expect((await snapshot(client)).parents).toEqual([
          [1, 10],
          [3, 10],
          [4, 20],
          [5, null],
          [6, 1],
          [10, null],
          [20, null],
        ]);
      }
    );

    for (const [name, operand] of [
      ["same-value set", { set: 1 }],
      ["increment zero", { increment: 0 }],
    ] as const) {
      test(
        `a ${name} on the primary key moves no slot, so an occupant is fine (${substrate})`,
        {
          timeout: 30_000,
        },
        async () => {
          const client = armClient(getFamily(), substrate);
          await seed(client);
          // The SAME occupant as the arm above — the difference is only the operand.
          await (client as any).node.create({
            data: { id: 6, label: "occupant", parentId: 1 },
          });

          // The ROOT accepts exactly this rule ("allows same-value set on an occupied
          // setNull relation" / "allows increment zero …" in
          // `tests/query-engine/relation-key-update-legality.test.ts`): the SET writes
          // the key's CURRENT value, so nothing is vacated and no child is stranded.
          // Depth must answer the same, or the occupied guard's own message — which
          // says a transition is happening — is false on its face.
          await (client as any).node.update({
            where: { id: 10 },
            data: {
              children: {
                update: {
                  where: { id: 1 },
                  data: { id: operand, ...CHILD_HELD_EDGE },
                },
              },
            },
          });
          expect((await snapshot(client)).parents).toEqual([
            [1, 10],
            [3, 10],
            [4, 20],
            // The deeper connect landed on the key the target still carries …
            [5, 1],
            // … and the occupant was neither rejected nor nulled.
            [6, 1],
            [10, null],
            [20, null],
          ]);
        }
      );
    }
  }
});
