/**
 * The two facts the depth-seam INJECTION files share.
 *
 * `depth-seam.test.ts` used to hold the located-target provenance harness and the
 * split-witness harness in one process, which booted a fresh PGlite database for every
 * arm of both. They are separate files now
 * (`depth-seam-located-provenance.test.ts`, `depth-seam-split-witness.test.ts`), and
 * these two constants are the only things both of them name.
 *
 * The fixed-expectation behavior matrix lives in `depth-seam-behavior.ts` and runs from
 * `depth-seam-transaction-matrix.test.ts` / `depth-seam-batch-matrix.test.ts`; the
 * compile-only `racePin` witnesses live in `depth-seam-race-pin.test.ts`.
 */

/** V1's verbatim not-found abort, spelled in full: a bare `/Cannot update/` also matches
 *  the occupied-slot rejection, and an arm using this must name the failure it means. */
export const TARGET_NOT_FOUND =
  /Cannot update relation 'projects': target record was not found for this parent\./;

/** The N4-U1 payload the whole instrument turns on: a nested target named by a
 *  NON-primary-key unique, carrying a deeper create whose foreign key can only be the
 *  target's primary key. */
export const nonPkLocatedDeepCreate = {
  where: { id: 2 },
  data: {
    projects: {
      update: {
        where: { code: "P-TARGET" },
        data: { title: "moved", tasks: { create: { id: 100, label: "deep" } } },
      },
    },
  },
};
