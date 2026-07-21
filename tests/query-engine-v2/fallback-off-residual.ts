/**
 * T3 — the measured fallback-carrying decline surface (the "surface at start").
 *
 * Every entry is a `${groupTitle} > ${scenarioName}` key from
 * `tests/query-engine/nested-write-conformance.test.ts`. With the V1 fallback
 * DISABLED ({@link setV1FallbackDisabled}), the V2 engine DECLINES each of these
 * scenarios' whole tree ({@link UnsupportedOperationError}) on BOTH substrates and
 * — in production — hands it to V1, which accepts-and-executes (or, for the
 * message-pin / reject-parity shapes, rejects with its own typed message). They
 * are therefore reachable behavior living behind the router's V1 fallback arm:
 * **P6 may bulk-delete V1's runtime only when this set is EMPTY.** It is not.
 *
 * This set is the MEASURED truth (T3 enumeration at HEAD fffd62d), captured by the
 * `VIBORM_FALLBACK_OFF=1` census harness in the conformance file — NOT the curated
 * three-then-one pin list the gate carried through T1/T2. The T2 "theater replay"
 * lesson made concrete: the census is a run of the FULL conformance suite
 * fallback-off, not a hand-maintained list. The measure is `declinedToV1` (a V2
 * UnsupportedOperationError anywhere in seed/act), NOT the pass/fail flip — so it
 * counts the message-pin shapes whose reject-bool coincidentally matched V1 (e.g.
 * "to-one update (FK-holder side) with nothing connected rejects"), which a
 * pass/fail enumeration silently under-counts. Measured size: 43.
 *
 * The eight decline families (root-cause site → count):
 *   A. parent-held (FK-holder-side) to-one `update`/`delete`/`upsert` under an
 *      update root — `UpdateOperation.interpretParentHeldToOne` default (13)
 *   B. nested relation writes inside a nested to-many `update` —
 *      `RelationWritePart` scalarData boundary (8)
 *   C. nested relation writes inside an m2m nested `create`/`update` —
 *      `RelationJunctionPart` scalarData boundary (8)
 *   D. top-level `upsert` with nested-relation create/update arms —
 *      `UpsertOperation` scalar-arms-only guard (7)
 *   E. nested `create` under update whose create data carries relations / D4 (2)
 *   F. inverse-side to-one `upsert` — `interpretInverseToOneKind` default (1)
 *   G. `connectOrCreate` create-arm recursion one level too deep (1)
 *   H. to-many `upsert` create-then-update identity spelling (1)
 *
 * The bidirectional machine-check lives in the conformance harness: with
 * `VIBORM_FALLBACK_OFF=1`, a scenario in this set MUST decline on both substrates;
 * a scenario NOT in this set MUST run natively on V2 and satisfy its full V1
 * contract (declinedToV1 === false). Absorbing a family = delete its entries here;
 * the scenario then must pass fallback-off, or the gate is red. The count is
 * asserted so no entry can be dropped without a matching absorption.
 */
export const FALLBACK_OFF_RESIDUAL: ReadonlySet<string> = new Set([
  "nested-write conformance: D4 non-PK reference (tx vs batch) > D4: updating the referenced non-PK column threads the new value to a nested create",
  "nested-write conformance: FK relations (tx vs batch) > connectOrCreate create branch accepts recursive nested writes",
  "nested-write conformance: FK relations (tx vs batch) > parent-holds-FK scalar rebind targets the final related row",
  "nested-write conformance: FK relations (tx vs batch) > to-many upsert creates then updates the current parent's child",
  "nested-write conformance: FK relations (tx vs batch) > to-one upsert creates then updates the current target",
  "nested-write conformance: FK relations (tx vs batch) > top-level upsert setWhere no-match skips the update branch",
  "nested-write conformance: FK relations (tx vs batch) > top-level upsert targetWhere no-match skips the update branch",
  "nested-write conformance: FK relations (tx vs batch) > top-level upsert targetWhere+setWhere match runs the update branch",
  "nested-write conformance: alternative branch dependencies (tx vs batch) > merged alternative writes allow a numerically disjoint later sibling",
  "nested-write conformance: alternative branch dependencies (tx vs batch) > upsert alternatives may repeat a nested connectOrCreate key when the target exists",
  "nested-write conformance: alternative branch dependencies (tx vs batch) > upsert alternatives may repeat a nested connectOrCreate key when the target is missing",
  "nested-write conformance: create root barrier (tx vs batch) > missing top-level upsert applies the create-branch insert barrier",
  "nested-write conformance: deep transitive target dependencies (tx vs batch) > deep nested update create and disjoint root decision succeed",
  "nested-write conformance: deep transitive target dependencies (tx vs batch) > deep nested update create then root decision rejects",
  "nested-write conformance: own-write dependencies (tx vs batch) > create then disjoint numeric update is allowed",
  "nested-write conformance: to-one ops (tx vs batch) > to-one delete true (FK-holder side) nulls the FK then deletes the target",
  "nested-write conformance: to-one ops (tx vs batch) > to-one update (FK-holder side) updates the connected author",
  "nested-write conformance: to-one ops (tx vs batch) > to-one update (FK-holder side) with nothing connected rejects, state unchanged",
  "nested-write conformance: to-one ops (tx vs batch) > to-one upsert (inverse side) creates then updates the profile",
  "nested-write conformance: transitive createMany dependencies (tx vs batch) > nested createMany and disjoint later decision succeed",
  "nested-write conformance: transitive membership dependencies (tx vs batch) > nested identity transition exports the exact final membership source",
  "nested-write conformance: transitive membership dependencies (tx vs batch) > nested physical membership allows a disjoint source endpoint",
  "nested-write conformance: transitive membership dependencies (tx vs batch) > nested physical membership allows a disjoint target endpoint",
  "nested-write conformance: transitive membership dependencies (tx vs batch) > nested physical membership stays isolated by named junction scope",
  "nested-write conformance: transitive membership dependencies (tx vs batch) > nested scalar FK rebind does not leak into a direct relation read",
  "nested-write conformance: transitive predicate dependencies (tx vs batch) > nested predicate update allows a later identity-only root filter",
  "nested-write conformance: transitive predicate dependencies (tx vs batch) > nested predicate update allows a numerically disjoint root filter",
  "nested-write conformance: transitive predicate dependencies (tx vs batch) > upsert update alternative predicate delta ignores an id-only filter",
  "nested-write conformance: transitive target dependencies (tx vs batch) > nested create and disjoint later root connectOrCreate succeed",
  "nested-write conformance: transitive target dependencies (tx vs batch) > outer create and disjoint nested connectOrCreate succeed",
  "nested-write conformance: transitive target dependencies (tx vs batch) > selected top-level upsert create branch gets inherited traversal",
  "nested-write conformance: transitive target dependencies (tx vs batch) > selected top-level upsert update branch gets inherited traversal",
  "nested-write conformance: update membership root (tx vs batch) > connectOrCreate membership allows a disjoint cross-scope to-one upsert",
  "nested-write conformance: update membership root (tx vs batch) > direct self parent update stays legal after scalar FK rebind",
  "nested-write conformance: update membership root (tx vs batch) > direct self partner update consumes the rebound FK and stays legal",
  "nested-write conformance: update membership root (tx vs batch) > inverse root seed does not taint a direct relation in the same write",
  "nested-write conformance: update membership root (tx vs batch) > nested create membership allows a disjoint cross-scope to-one upsert",
  "nested-write conformance: update membership root (tx vs batch) > non-self nested FK rebind allows a disjoint inverse holder",
  "nested-write conformance: update membership root (tx vs batch) > same-node non-self FK rebind allows a disjoint inverse holder",
  "nested-write conformance: update membership root (tx vs batch) > self parent and inverse disjoint updates stay legal (direct-first)",
  "nested-write conformance: update membership root (tx vs batch) > self parent and inverse disjoint updates stay legal (inverse-first)",
  "nested-write conformance: update predicate root (tx vs batch) > existing top-level upsert uses its exact pk for disjointness",
  "nested-write conformance: update predicate root (tx vs batch) > nested to-many update allows a disjoint child decision",
]);

/** The measured count at T3 start — asserted by the gate so the set cannot be
 *  silently trimmed. Shrinks by exactly the family size when a family is absorbed. */
export const FALLBACK_OFF_RESIDUAL_COUNT = 43;
