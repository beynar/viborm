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
 * pass/fail enumeration silently under-counts. Measured size at T3 start: 43; after
 * T3-r2 absorbed family F (inverse-side to-one upsert, size 1): 42; after T3a
 * absorbed 11 of family A's 13 (see below): 31.
 *
 * The decline families (root-cause site → remaining count):
 *   A. parent-held (FK-holder-side) to-one `update`/`delete`/`upsert` under an
 *      update root — ABSORBED (T3a): 11 of 13 now run natively (native
 *      `UpdateOperation` parent-held correlated `update`/`delete`/`upsert` arms:
 *      locate the referenced target by the parent's FINAL FK value, mutate/delete
 *      it, or found→update / absent→create+rebind). The **2 remaining** are the
 *      parent-held update whose located-target DATA carries a nested relation write
 *      (`container: { update: { nodes: { update } } }`) — the parent-held projection
 *      of family B's nested-relation-in-update boundary, which stays pinned (2)
 *   B. nested relation writes inside a nested to-many `update` —
 *      `RelationWritePart` scalarData boundary (8)
 *   C. nested relation writes inside an m2m nested `create`/`update` (incl. the
 *      deep-nested-update variant) — `RelationJunctionPart` scalarData boundary (10)
 *   D. top-level `upsert` with nested-relation create/update arms —
 *      `UpsertOperation` scalar-arms-only guard (7)
 *   E. nested `create` under update whose create data carries relations / D4 (2)
 *   F. inverse-side to-one `upsert` — ABSORBED (T3-r2): native V2 correlated upsert
 *      arm in `RelationWritePart` (found → update / absent → create, fk = parent) (0)
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
  "nested-write conformance: FK relations (tx vs batch) > connectOrCreate create branch accepts recursive nested writes",
  "nested-write conformance: FK relations (tx vs batch) > to-many upsert creates then updates the current parent's child",
  "nested-write conformance: FK relations (tx vs batch) > top-level upsert setWhere no-match skips the update branch",
  "nested-write conformance: FK relations (tx vs batch) > top-level upsert targetWhere no-match skips the update branch",
  "nested-write conformance: FK relations (tx vs batch) > top-level upsert targetWhere+setWhere match runs the update branch",
  "nested-write conformance: create root barrier (tx vs batch) > missing top-level upsert applies the create-branch insert barrier",
  // ABSORBED (T3-r2, family F): "to-one ops … > to-one upsert (inverse side)
  // creates then updates the profile" was pinned here; the inverse-side to-one
  // upsert is now handled natively by V2 (RelationWritePart correlated upsert arm),
  // so it runs fallback-off and is no longer a fallback carrier. Count 43 → 42.
  //
  // ABSORBED (T3b-1, family B — mechanism 1, update-arm literal-parent recursion):
  // the 6 child-held nested-relation-in-update shapes now run fallback-off. A nested
  // to-many `update`'s located target builds its OWN child Parts (m2m junction /
  // to-many createMany), correlated to its compile-time literal PK, with its self-
  // UPDATE reordered AFTER those children on a PK transition (ON UPDATE CASCADE
  // ported to depth — the `nested identity transition` witness: id 1→4, friend
  // sourceId cascades to 4). Removed from this set (Count 31 → 25):
  //   · transitive createMany > nested createMany and disjoint later decision succeed
  //   · transitive membership > nested identity transition exports the exact final
  //     membership source
  //   · transitive membership > nested physical membership allows a disjoint source endpoint
  //   · transitive membership > nested physical membership allows a disjoint target endpoint
  //   · transitive membership > nested physical membership stays isolated by named junction scope
  //   · update predicate root > nested to-many update allows a disjoint child decision
  "nested-write conformance: transitive target dependencies (tx vs batch) > selected top-level upsert create branch gets inherited traversal",
  "nested-write conformance: transitive target dependencies (tx vs batch) > selected top-level upsert update branch gets inherited traversal",
  // ABSORBED (T3b-1, family B ×2 + family A-remainder ×2 — mechanism 1 extended to
  // the parent-held to-one `update` arm). A parent-held `update`'s located target now
  // builds its OWN child Parts, correlated to its captured PK by a `planned` source on
  // the parent-held probe (the parent-held projection of the child-held nested-update
  // recursion). This unblocked the four "update membership root" scenarios whose FIRST
  // decline was the children/container relation-in-update boundary (Count 25 → 21):
  //   · nested create membership allows a disjoint cross-scope to-one upsert
  //     (children.update.data.partnerOf: create + container.update.nodes.update
  //      .partnerOf.upsert — a 3-level parent-held/inverse-to-one chain)
  //   · connectOrCreate membership allows a disjoint cross-scope to-one upsert
  //   · non-self nested FK rebind allows a disjoint inverse holder  (container.update
  //     .nodes.update scalar grandchild, container located at the final FK)
  //   · same-node non-self FK rebind allows a disjoint inverse holder
  "nested-write conformance: update predicate root (tx vs batch) > existing top-level upsert uses its exact pk for disjointness",
  // ABSORBED (T3b-2, family C — mechanism 2 create-arm / mechanism 1 update-arm
  // reuse, TO-ONE.md §7.7): the 10 m2m-junction-target-carrying-relations shapes now
  // run fallback-off. A junction create/update/upsert target whose data carries its
  // own relations folds them one level deeper against the target's literal PK through
  // the same `buildNestedTargetChildParts` seam the child-held families use — a
  // located update target (its `where` PK) or a fresh create target (its explicit
  // `create` PK, fresh-parent elision ATOM §4). `RelationJunctionPart` slots carry the
  // per-target child Parts; `planning` plans their probes one level deeper (superset,
  // ATOM §3 technique 2), `compile` emits only the taken arm's writes after the
  // relevant junction row. Removed from this set (Count 21 → 11):
  //   · alternative branch > merged alternative writes allow a numerically disjoint later sibling
  //   · alternative branch > upsert alternatives may repeat a nested connectOrCreate key when the target exists
  //   · alternative branch > upsert alternatives may repeat a nested connectOrCreate key when the target is missing
  //   · deep transitive target > deep nested update create and disjoint root decision succeed
  //   · deep transitive target > deep nested update create then root decision rejects
  //   · transitive predicate > nested predicate update allows a later identity-only root filter
  //   · transitive predicate > nested predicate update allows a numerically disjoint root filter
  //   · transitive predicate > upsert update alternative predicate delta ignores an id-only filter
  //   · transitive target > nested create and disjoint later root connectOrCreate succeed
  //   · transitive target > outer create and disjoint nested connectOrCreate succeed
  // ABSORBED (T3b-2, family E — mechanism 2 create-arm, TO-ONE.md §7.7): the 2 nested-
  // `create`-under-update shapes now run fallback-off. A child-held to-many `create`/
  // `createMany` under the update root builds a literal-parent create leaf; its FK is a
  // construction-time literal (the referenced column pinned by the unique `where`, or —
  // D4 — rewritten by the root SET, its new value threaded to the fresh row with the
  // root UPDATE ordered BEFORE the INSERT). Removed from this set (Count 11 → 9):
  //   · D4 non-PK reference > D4: updating the referenced non-PK column threads the new value to a nested create
  //   · own-write dependencies > create then disjoint numeric update is allowed
]);

/** The measured residual count — asserted by the gate so the set cannot be silently
 *  trimmed. Shrinks by exactly the absorbed size when a family (or a coherent slice
 *  of one) is absorbed. Started at 43 (T3 enumeration); 42 after T3-r2 absorbed
 *  family F (inverse-side to-one upsert, size 1); 31 after T3a absorbed 11 of family
 *  A's 13 (parent-held to-one update/delete/upsert with scalar target data; the 2
 *  nested-relation-target-data shapes stay pinned); 25 after T3b-1 absorbed the 6
 *  child-held family-B shapes (mechanism 1 — a nested to-many `update`'s located
 *  target builds its own child Parts + reorder/cascade to depth); 21 after T3b-1
 *  extended mechanism 1 to the parent-held `update` arm (family B's 2 remaining
 *  membership-root shapes + family A-remainder's 2); 11 after T3b-2 absorbed family C
 *  (mechanism 2 create-arm / mechanism 1 update-arm reuse — a m2m junction
 *  create/update/upsert target whose data carries its own relations folds them one
 *  level deeper against the target's literal PK); 9 after T3b-2 absorbed family E (a
 *  nested `create`/`createMany` under the update root on a child-held to-many, its FK a
 *  construction-time literal — the `where`-pinned PK or a D4 root-SET-rewritten column,
 *  the root UPDATE ordered before the fresh INSERT). Each further absorption drops this
 *  by that slice's size. */
export const FALLBACK_OFF_RESIDUAL_COUNT = 9;
