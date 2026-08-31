import {
  CHILD_HELD_EDGE,
  freshClient,
  seed,
  snapshot,
} from "@tests/contracts/engine/write/nested-update-pk-transition-cascade-fixtures";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * The two N4/N5 MERGE arms of the PK-transition cascade boundary (T3b1 finding #1):
 * the nested target is located by the NON-primary-key unique `label` rather than by
 * the `where`-pinned literal id. The mechanism, the bed, and the history of every
 * retarget live in `nested-update-pk-transition-cascade-fixtures.ts`.
 *
 * They belong together because they are the same locator with and without the PK
 * transition — the pair is what separates "the derivation ran at compile" from "the
 * planned source alone was the whole answer".
 */
describe("nested update PK-transition cascade boundary (finding #1)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `D2 LIFT: a non-PK locator plus a PK transition now executes (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const { client } = freshClient(substrate);
        await syncLiveSchema(client as any);
        await seed(client);

        // RETARGETED BY PACKAGE D2. This was "the merge's one refusal": N4-U1's
        // provenance (locate by `label`, Ref the probe) and N5-U1b's ordering (bind the
        // deeper edge to the POST-transition key) were said to be unserviceable
        // together, because "the probe already ran, so the value it publishes is the key
        // 7 replaces". Both halves were true and the conclusion was not: the probe
        // publishing the PRE-transition key is exactly what a post-transition derivation
        // needs, once the derivation is allowed to run at COMPILE instead of at
        // construction. D2's `postTransitionReference` is that, so the payload compiles
        // and lands the identical state the PK-locator arm produces.
        await (client as any).node.update({
          where: { id: 10 },
          data: {
            children: {
              update: {
                where: { label: "target" },
                data: { id: 7, ...CHILD_HELD_EDGE },
              },
            },
          },
        });
        expect((await snapshot(client)).parents).toEqual([
          [3, 10],
          [4, 20],
          // The deeper connect took the POST-transition key …
          [5, 7],
          // … which the self-UPDATE wrote, and the second root's subtree is untouched.
          [7, 10],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );

    test(
      `the same non-PK locator with no PK transition executes (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const { client } = freshClient(substrate);
        await syncLiveSchema(client as any);
        await seed(client);

        // Drop the `id` from the SET and the intersection dissolves: N4-U1's planned
        // source is the whole answer, and node 5's FK lands on 1 — the key of THE ROW
        // THE PROBE LOCKED, not a value re-derived from the `where`.
        await (client as any).node.update({
          where: { id: 10 },
          data: {
            children: {
              update: {
                where: { label: "target" },
                data: { label: "renamed", ...CHILD_HELD_EDGE },
              },
            },
          },
        });
        expect((await snapshot(client)).parents).toEqual([
          [1, 10],
          [3, 10],
          [4, 20],
          [5, 1],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );
  }
});
