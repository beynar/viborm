import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAPTOR3_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RAPTOR3_TESTS = Object.freeze([
  "tests/raptor3/fixed.test.ts",
  "tests/raptor3/gate.test.ts",
]);
export const G1_COMPARISON_COUNTS = Object.freeze({
  "tests/raptor3/candidate.test.ts": 24,
  "tests/raptor3/candidate-handoff.test.ts": 6,
  "tests/raptor3/candidate-ordering.test.ts": 2,
  "tests/raptor3/candidate-pagination.test.ts": 4,
});
export const G1_COMPARISON_TESTS = Object.freeze(
  Object.keys(G1_COMPARISON_COUNTS)
);
export const G1_BASELINE_COUNTS = Object.freeze({
  "tests/raptor3/expanded/variant-identity-legacy.test.ts": 42,
  "tests/raptor3/expanded/legacy.test.ts": 82,
  "tests/raptor3/expanded/lifetime-legacy.test.ts": 16,
  "tests/raptor3/expanded/compound-falsifier.test.ts": 1,
});
export const G1_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/cleanup-failure.test.ts": 2,
  "tests/raptor3/expanded/variant-identity-commands.test.ts": 42,
  "tests/raptor3/expanded/commands.test.ts": 82,
  "tests/raptor3/expanded/lifetime-commands.test.ts": 16,
  "tests/raptor3/expanded/compound-falsifier.test.ts": 1,
});
export const G1_BASELINE_TESTS = Object.freeze(Object.keys(G1_BASELINE_COUNTS));
export const G1_CONTRACT_TESTS = Object.freeze(Object.keys(G1_CONTRACT_COUNTS));
export const G2_BASELINE_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-legacy.test.ts": 14,
  "tests/raptor3/transitions/singular-legacy.test.ts": 20,
  "tests/raptor3/transitions/staleness-legacy.test.ts": 3,
  "tests/raptor3/transitions/junctions-legacy.test.ts": 26,
  "tests/raptor3/transitions/junction-identity-legacy.test.ts": 2,
  "tests/raptor3/transitions/membership-own-write-legacy.test.ts": 8,
  "tests/raptor3/transitions/series-staleness-legacy.test.ts": 4,
  "tests/raptor3/transitions/required-legacy.test.ts": 8,
  "tests/raptor3/transitions/own-write-legacy.test.ts": 18,
  "tests/raptor3/transitions/occupied-keys-legacy.test.ts": 8,
  "tests/raptor3/transitions/supplier-continuations-legacy.test.ts": 10,
  "tests/raptor3/transitions/singular-lattice-legacy.test.ts": 58,
  "tests/raptor3/transitions/conditional-upsert-legacy.test.ts": 11,
  "tests/raptor3/transitions/shared-key-suppliers-legacy.test.ts": 4,
  "tests/raptor3/transitions/mixed-key-transitions-legacy.test.ts": 8,
  "tests/raptor3/transitions/variant-removals-legacy.test.ts": 14,
});
export const G2_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-commands.test.ts": 14,
  "tests/raptor3/transitions/singular-commands.test.ts": 20,
  "tests/raptor3/transitions/staleness-commands.test.ts": 3,
  "tests/raptor3/transitions/junctions-commands.test.ts": 26,
  "tests/raptor3/transitions/junction-identity-commands.test.ts": 2,
  "tests/raptor3/transitions/membership-own-write-commands.test.ts": 8,
  "tests/raptor3/transitions/series-staleness-commands.test.ts": 4,
  "tests/raptor3/transitions/required-commands.test.ts": 8,
  "tests/raptor3/transitions/own-write-commands.test.ts": 18,
  "tests/raptor3/transitions/occupied-keys-commands.test.ts": 8,
  "tests/raptor3/transitions/supplier-continuations-commands.test.ts": 10,
  "tests/raptor3/transitions/singular-lattice-commands.test.ts": 58,
  "tests/raptor3/transitions/conditional-upsert-commands.test.ts": 11,
  "tests/raptor3/transitions/shared-key-suppliers-commands.test.ts": 4,
  "tests/raptor3/transitions/mixed-key-transitions-commands.test.ts": 8,
  "tests/raptor3/transitions/variant-removals-commands.test.ts": 14,
});
export const G2_DIAGNOSTIC_COUNTS = Object.freeze({
  "tests/raptor3/transitions/diagnostics.test.ts": 2,
});
export const G2_DIAGNOSTIC_TESTS = Object.freeze(
  Object.keys(G2_DIAGNOSTIC_COUNTS)
);
export const G25_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/polish/commands.test.ts": 6,
});
export const G25_CONTRACT_TESTS = Object.freeze(
  Object.keys(G25_CONTRACT_COUNTS)
);
export const G25_PG_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/polish/recovery-live.test.ts": 2,
});
export const G25_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G25_PG_CONTRACT_COUNTS)
);
export const G27_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/ownership/commands.test.ts": 6,
});
export const G27_CONTRACT_TESTS = Object.freeze(
  Object.keys(G27_CONTRACT_COUNTS)
);
export const G27_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/ownership/live.test.ts": 1,
});
export const G27_PG_CONTRACT_COUNTS = G27_PROVIDER_CONTRACT_COUNTS;
export const G27_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G27_PG_CONTRACT_COUNTS)
);
export const G27_MYSQL_CONTRACT_COUNTS = G27_PROVIDER_CONTRACT_COUNTS;
export const G27_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G27_MYSQL_CONTRACT_COUNTS)
);
export const G3P02_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/transport.test.ts": 4,
});
export const G3P02_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P02_CONTRACT_COUNTS)
);
export const G3P02_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-constraint-ownership.test.ts": 5,
});
export const G3P02_PG_CONTRACT_COUNTS = G3P02_PROVIDER_CONTRACT_COUNTS;
export const G3P02_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P02_PG_CONTRACT_COUNTS)
);
export const G3P02_MYSQL_CONTRACT_COUNTS = G3P02_PROVIDER_CONTRACT_COUNTS;
export const G3P02_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P02_MYSQL_CONTRACT_COUNTS)
);
export const G3P03_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/set-preparation.test.ts": 6,
});
export const G3P03_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P03_CONTRACT_COUNTS)
);
export const G3P03_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-set-preparation.test.ts": 5,
});
export const G3P03_PG_CONTRACT_COUNTS = G3P03_PROVIDER_CONTRACT_COUNTS;
export const G3P03_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P03_PG_CONTRACT_COUNTS)
);
export const G3P03_MYSQL_CONTRACT_COUNTS = G3P03_PROVIDER_CONTRACT_COUNTS;
export const G3P03_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P03_MYSQL_CONTRACT_COUNTS)
);
export const G3P04_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/suppression-replay.test.ts": 5,
});
export const G3P04_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_CONTRACT_COUNTS)
);
export const G3P04_REVIEW_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/g3p04-review-regressions.test.ts": 5,
});
export const G3P04_REVIEW_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_REVIEW_CONTRACT_COUNTS)
);
export const G3P04_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-suppression-replay.test.ts": 4,
});
export const G3P04_PG_CONTRACT_COUNTS = G3P04_PROVIDER_CONTRACT_COUNTS;
export const G3P04_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_PG_CONTRACT_COUNTS)
);
export const G3P04_MYSQL_CONTRACT_COUNTS = G3P04_PROVIDER_CONTRACT_COUNTS;
export const G3P04_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_MYSQL_CONTRACT_COUNTS)
);
export const G3P05_SELECTOR_DEPENDENCY_COUNTS = Object.freeze({
  "tests/raptor3/prep/selector-dependencies.test.ts": 11,
});
export const G3P05_SELECTOR_DEPENDENCY_TESTS = Object.freeze(
  Object.keys(G3P05_SELECTOR_DEPENDENCY_COUNTS)
);
export const G3P05_VARIANT_COLLECTION_ORDER_COUNTS = Object.freeze({
  "tests/raptor3/prep/variant-collection-order.test.ts": 4,
});
export const G3P05_VARIANT_COLLECTION_ORDER_TESTS = Object.freeze(
  Object.keys(G3P05_VARIANT_COLLECTION_ORDER_COUNTS)
);
export const G3P05_RECURSIVE_READ_FIT_COUNTS = Object.freeze({
  "tests/raptor3/prep/recursive-read-fit.test.ts": 6,
});
export const G3P05_RECURSIVE_READ_FIT_TESTS = Object.freeze(
  Object.keys(G3P05_RECURSIVE_READ_FIT_COUNTS)
);
export const POST_G3_CLEARABILITY_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/clearability-consumption.test.ts": 4,
});
export const POST_G3_CLEARABILITY_CONTRACT_TESTS = Object.freeze(
  Object.keys(POST_G3_CLEARABILITY_CONTRACT_COUNTS)
);
export const POST_G3_SCHEMA_VIEW_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/schema-view-reuse.test.ts": 1,
});
export const POST_G3_SCHEMA_VIEW_TESTS = Object.freeze(
  Object.keys(POST_G3_SCHEMA_VIEW_COUNTS)
);
export const POST_G3_PROJECTION_PREPARATION_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/projection-preparation.test.ts": 4,
});
export const POST_G3_PROJECTION_PREPARATION_TESTS = Object.freeze(
  Object.keys(POST_G3_PROJECTION_PREPARATION_COUNTS)
);
export const POST_G3_SELECTOR_PREPARATION_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/selector-preparation.test.ts": 4,
});
export const POST_G3_SELECTOR_PREPARATION_TESTS = Object.freeze(
  Object.keys(POST_G3_SELECTOR_PREPARATION_COUNTS)
);
export const POST_G3_HISTORY_ANALYSIS_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/history-analysis.test.ts": 5,
});
export const POST_G3_HISTORY_ANALYSIS_TESTS = Object.freeze(
  Object.keys(POST_G3_HISTORY_ANALYSIS_COUNTS)
);
export const G29_MEMBER_DEPENDENCY_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/g29-member-dependency.test.ts": 14,
});
export const G29_MEMBER_DEPENDENCY_TESTS = Object.freeze(
  Object.keys(G29_MEMBER_DEPENDENCY_COUNTS)
);
export const G29_DEPENDENCY_BOUNDARY_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/g29-dependency-boundaries.test.ts": 4,
});
export const G29_DEPENDENCY_BOUNDARY_TESTS = Object.freeze(
  Object.keys(G29_DEPENDENCY_BOUNDARY_COUNTS)
);
export const G29_DEPENDENCY_CHOICE_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/g29-dependency-choices.test.ts": 10,
});
export const G29_DEPENDENCY_CHOICE_TESTS = Object.freeze(
  Object.keys(G29_DEPENDENCY_CHOICE_COUNTS)
);
export const G29_RESULT_PROGRESS_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/g29-result-progress.test.ts": 2,
});
export const G29_RESULT_PROGRESS_TESTS = Object.freeze(
  Object.keys(G29_RESULT_PROGRESS_COUNTS)
);
export const CS01_STRUCTURAL_REFERENCE_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/structural-reference.test.ts": 10,
});
export const CS01_STRUCTURAL_REFERENCE_TESTS = Object.freeze(
  Object.keys(CS01_STRUCTURAL_REFERENCE_COUNTS)
);
export const CS01_EXTENSION_A_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/extension-a.contract.test.ts": 6,
});
export const CS01_EXTENSION_A_TESTS = Object.freeze(
  Object.keys(CS01_EXTENSION_A_COUNTS)
);
export const CS01_EXTENSION_B_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/extension-b.contract.test.ts": 4,
});
export const CS01_EXTENSION_B_TESTS = Object.freeze(
  Object.keys(CS01_EXTENSION_B_COUNTS)
);
export const CS01_EXTENSION_COMPOSITION_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/extension-composition.contract.test.ts": 4,
});
export const CS01_EXTENSION_COMPOSITION_TESTS = Object.freeze(
  Object.keys(CS01_EXTENSION_COMPOSITION_COUNTS)
);
// Scope causal oracle: actual nested admission -> acknowledged effect -> outside
// actual admission; interactive rolls back while batch retains that prefix.
export const CS03_MEMBER_SCOPE_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/member-scope.contract.test.ts": 8,
});
export const CS03_MEMBER_SCOPE_TESTS = Object.freeze(
  Object.keys(CS03_MEMBER_SCOPE_COUNTS)
);
const CS03_EXTENSION_PROFILES = Object.freeze([
  "sqlite-interactive",
  "sqlite-atomic-batch",
]);
export const CS03_EXTENSION_CAMPAIGNS = Object.freeze({
  "cs03-extension-a-seeds": Object.freeze({
    slice: "a",
    firstSeed: 7100,
    seedCount: 100,
    replayCount: 3,
    profiles: CS03_EXTENSION_PROFILES,
  }),
  "cs03-extension-b-seeds": Object.freeze({
    slice: "b",
    firstSeed: 7200,
    seedCount: 100,
    replayCount: 3,
    profiles: CS03_EXTENSION_PROFILES,
  }),
  "cs03-extension-composition-seeds": Object.freeze({
    slice: "composition",
    firstSeed: 7300,
    seedCount: 100,
    replayCount: 3,
    profiles: CS03_EXTENSION_PROFILES,
  }),
});
export const CS03_EXTENSION_CAMPAIGN_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/measurement/extension-campaign.test.ts": 1,
});
export const CS03_EXTENSION_CAMPAIGN_TESTS = Object.freeze(
  Object.keys(CS03_EXTENSION_CAMPAIGN_COUNTS)
);
export const CS03_EXTENSION_SUPPORT_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/measurement/extension-recipes.selftest.test.ts": 5,
  "tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts": 42,
});
export const CS03_EXTENSION_SUPPORT_TESTS = Object.freeze(
  Object.keys(CS03_EXTENSION_SUPPORT_COUNTS)
);
export const CS02_REPEATED_OCCURRENCE_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/repeated-occurrence-ownership.test.ts": 5,
});
export const CS02_REPEATED_OCCURRENCE_TESTS = Object.freeze(
  Object.keys(CS02_REPEATED_OCCURRENCE_COUNTS)
);
export const CS02_STRUCTURE_MEASUREMENT_COUNTS = Object.freeze({
  "tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts": 1,
});
export const CS02_STRUCTURE_MEASUREMENT_TESTS = Object.freeze(
  Object.keys(CS02_STRUCTURE_MEASUREMENT_COUNTS)
);
export const G29_MEMBER_DEPENDENCY_PROVIDER_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/native-g29-member-dependency.test.ts": 2,
});
export const G29_MEMBER_DEPENDENCY_PG_COUNTS =
  G29_MEMBER_DEPENDENCY_PROVIDER_COUNTS;
export const G29_MEMBER_DEPENDENCY_PG_TESTS = Object.freeze(
  Object.keys(G29_MEMBER_DEPENDENCY_PG_COUNTS)
);
export const G29_MEMBER_DEPENDENCY_MYSQL_COUNTS =
  G29_MEMBER_DEPENDENCY_PROVIDER_COUNTS;
export const G29_MEMBER_DEPENDENCY_MYSQL_TESTS = Object.freeze(
  Object.keys(G29_MEMBER_DEPENDENCY_MYSQL_COUNTS)
);
export const POST_G3_CLEARABILITY_PROVIDER_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-clearability-ownership.test.ts": 2,
});
export const POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS =
  POST_G3_CLEARABILITY_PROVIDER_COUNTS;
export const POST_G3_CLEARABILITY_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS)
);
export const POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS =
  POST_G3_CLEARABILITY_PROVIDER_COUNTS;
export const POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS)
);
export const G3P05_CONTRACT_COUNTS = Object.freeze({
  ...G3P05_SELECTOR_DEPENDENCY_COUNTS,
  ...G3P05_VARIANT_COLLECTION_ORDER_COUNTS,
  ...G3P05_RECURSIVE_READ_FIT_COUNTS,
});
export const G3P05_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P05_CONTRACT_COUNTS)
);
export const G3_BULK_SERIES_COUNTS = Object.freeze({
  "tests/raptor3/g3/bulk-series-contract.test.ts": 6,
});
export const G3_BULK_SERIES_TESTS = Object.freeze(
  Object.keys(G3_BULK_SERIES_COUNTS)
);
export const G3_SUPPRESSION_RETRY_COUNTS = Object.freeze({
  "tests/raptor3/g3/suppression-retry-contract.test.ts": 2,
});
export const G3_SUPPRESSION_RETRY_TESTS = Object.freeze(
  Object.keys(G3_SUPPRESSION_RETRY_COUNTS)
);
export const G3_TRANSACTION_ARRAY_COUNTS = Object.freeze({
  "tests/raptor3/g3/transaction-array-contract.test.ts": 4,
});
export const G3_TRANSACTION_ARRAY_TESTS = Object.freeze(
  Object.keys(G3_TRANSACTION_ARRAY_COUNTS)
);
export const G3_DEPTH_RECURRENCE_COUNTS = Object.freeze({
  "tests/raptor3/g3/depth-recurrence-contract.test.ts": 6,
});
export const G3_DEPTH_RECURRENCE_TESTS = Object.freeze(
  Object.keys(G3_DEPTH_RECURRENCE_COUNTS)
);
export const G3_SCOPE_COMPOSITION_PROVIDER_COUNTS = Object.freeze({
  "tests/raptor3/g3/scope-composition-native.test.ts": 2,
});
export const G3_SCOPE_COMPOSITION_PG_COUNTS =
  G3_SCOPE_COMPOSITION_PROVIDER_COUNTS;
export const G3_SCOPE_COMPOSITION_PG_TESTS = Object.freeze(
  Object.keys(G3_SCOPE_COMPOSITION_PG_COUNTS)
);
export const G3_SCOPE_COMPOSITION_MYSQL_COUNTS =
  G3_SCOPE_COMPOSITION_PROVIDER_COUNTS;
export const G3_SCOPE_COMPOSITION_MYSQL_TESTS = Object.freeze(
  Object.keys(G3_SCOPE_COMPOSITION_MYSQL_COUNTS)
);
export const G3_GENERATED_SMOKE_COUNTS = Object.freeze({
  "tests/raptor3/g3/generation/generated-smoke.test.ts": 6,
});
export const G3_GENERATED_SMOKE_TESTS = Object.freeze(
  Object.keys(G3_GENERATED_SMOKE_COUNTS)
);
export const G3_GENERATED_TRANSPORT_SMOKE_COUNTS = Object.freeze({
  "tests/raptor3/g3/generation/generated-transport-smoke.test.ts": 1,
});
export const G3_GENERATED_TRANSPORT_SMOKE_TESTS = Object.freeze(
  Object.keys(G3_GENERATED_TRANSPORT_SMOKE_COUNTS)
);
export const G3_GENERATED_MINIMIZATION_COUNTS = Object.freeze({
  "tests/raptor3/g3/generation/failure-minimization.test.ts": 1,
});
export const G3_GENERATED_MINIMIZATION_TESTS = Object.freeze(
  Object.keys(G3_GENERATED_MINIMIZATION_COUNTS)
);
export const G3_EXECUTION_REVIEW_COUNTS = Object.freeze({
  "tests/raptor3/g3/review-execution-boundaries.test.ts": 6,
});
export const G3_EXECUTION_REVIEW_TESTS = Object.freeze(
  Object.keys(G3_EXECUTION_REVIEW_COUNTS)
);
export const G3_AUTHOR_EXECUTION_REGRESSION_COUNTS = Object.freeze({
  "tests/raptor3/g3/author-execution-regressions.test.ts": 3,
});
export const G3_AUTHOR_EXECUTION_REGRESSION_TESTS = Object.freeze(
  Object.keys(G3_AUTHOR_EXECUTION_REGRESSION_COUNTS)
);
export const G3_SCOPE_FAILURE_COUNTS = Object.freeze({
  "tests/raptor3/g3/scope-failure-contract.test.ts": 2,
});
export const G3_SCOPE_FAILURE_TESTS = Object.freeze(
  Object.keys(G3_SCOPE_FAILURE_COUNTS)
);
export const G3_BULK_RESULT_BOUNDARY_COUNTS = Object.freeze({
  "tests/raptor3/g3/bulk-result-boundary.test.ts": 5,
});
export const G3_BULK_RESULT_BOUNDARY_TESTS = Object.freeze(
  Object.keys(G3_BULK_RESULT_BOUNDARY_COUNTS)
);
export const G4_READ_OPERATIONS_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-operations.test.ts": 11,
});
export const G4_READ_OPERATIONS_TESTS = Object.freeze(
  Object.keys(G4_READ_OPERATIONS_COUNTS)
);
export const G4_READ_FILTERS_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-filters.test.ts": 13,
});
export const G4_READ_FILTERS_TESTS = Object.freeze(
  Object.keys(G4_READ_FILTERS_COUNTS)
);
export const G4_READ_ORDERING_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-ordering.test.ts": 5,
});
export const G4_READ_ORDERING_TESTS = Object.freeze(
  Object.keys(G4_READ_ORDERING_COUNTS)
);
export const G4_READ_PAGINATION_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-pagination.test.ts": 6,
});
export const G4_READ_PAGINATION_TESTS = Object.freeze(
  Object.keys(G4_READ_PAGINATION_COUNTS)
);
export const G4_READ_PROJECTION_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-projection.test.ts": 7,
});
export const G4_READ_PROJECTION_TESTS = Object.freeze(
  Object.keys(G4_READ_PROJECTION_COUNTS)
);
export const G4_READ_AGGREGATE_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-aggregates.test.ts": 5,
});
export const G4_READ_AGGREGATE_TESTS = Object.freeze(
  Object.keys(G4_READ_AGGREGATE_COUNTS)
);
export const G4_READ_CODEC_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-codecs.test.ts": 12,
});
export const G4_READ_CODEC_TESTS = Object.freeze(
  Object.keys(G4_READ_CODEC_COUNTS)
);
export const G4_READ_RECURSIVE_FIT_COUNTS = Object.freeze({
  "tests/raptor3/g4/read-recursive-fit.test.ts": 3,
});
export const G4_READ_RECURSIVE_FIT_TESTS = Object.freeze(
  Object.keys(G4_READ_RECURSIVE_FIT_COUNTS)
);
/** Every fixed C01/C12 read witness, for one whole-family run. */
export const G4_READ_COUNTS = Object.freeze({
  ...G4_READ_OPERATIONS_COUNTS,
  ...G4_READ_FILTERS_COUNTS,
  ...G4_READ_ORDERING_COUNTS,
  ...G4_READ_PAGINATION_COUNTS,
  ...G4_READ_PROJECTION_COUNTS,
  ...G4_READ_AGGREGATE_COUNTS,
  ...G4_READ_CODEC_COUNTS,
  ...G4_READ_RECURSIVE_FIT_COUNTS,
});
export const G4_READ_TESTS = Object.freeze(Object.keys(G4_READ_COUNTS));
// The six two-sided modes `g4-lifecycle-events`, `g4-lifecycle-admission`,
// `g4-route-lifecycle`, `g4-route-admission`, `g4-route-cache` and
// `g4-route-transactions` were RETIRED at the C-01 cutover, not re-pointed.
// Each one ran one oracle twice — once against the shipped route as the
// control, once against the candidate — and the cutover deletes the control.
// Re-pointing them at `createClient` would compare the candidate with itself
// and report green forever. Their files are deleted by the cutover; the
// one-sided replacements that survive are `g4-read-*`, `g2-*`, `g3-*` and the
// generation campaigns, which assert against fixtures and oracles instead.
// Landed from the G4-01 author's worktree `/private/tmp/viborm-g4-unit01`
// after that unit was accepted, so its executable claims live where every
// other stream can run them. Counts are derived from the landed files.
export const G4_UNIT01_AUTHOR_COUNTS = Object.freeze({
  "tests/raptor3/g4/unit01/codec-roundtrip.test.ts": 5,
  "tests/raptor3/g4/unit01/filters.test.ts": 8,
  "tests/raptor3/g4/unit01/geo-capability.test.ts": 2,
  "tests/raptor3/g4/unit01/order-projection.test.ts": 6,
  "tests/raptor3/g4/unit01/read-verbs.test.ts": 9,
  "tests/raptor3/g4/unit01/recursive-vocabulary.test.ts": 1,
  "tests/raptor3/g4/unit01/repair2.test.ts": 22,
  "tests/raptor3/g4/unit01/repair3.test.ts": 14,
  "tests/raptor3/g4/unit01/repairs.test.ts": 13,
  "tests/raptor3/g4/unit01/variants.test.ts": 3,
});
export const G4_UNIT01_AUTHOR_TESTS = Object.freeze(
  Object.keys(G4_UNIT01_AUTHOR_COUNTS)
);
export const G4_UNIT01_REVIEW_COUNTS = Object.freeze({
  "tests/raptor3/g4/review/unit01/decode-strictness.test.ts": 7,
  "tests/raptor3/g4/review/unit01/distance-projection.test.ts": 1,
  "tests/raptor3/g4/review/unit01/having-projection.test.ts": 5,
  "tests/raptor3/g4/review/unit01/logical-forms.test.ts": 3,
  "tests/raptor3/g4/review/unit01/nested-window.test.ts": 3,
  "tests/raptor3/g4/review/unit01/null-placement-parity.test.ts": 2,
  "tests/raptor3/g4/review/unit01/order-cursor.test.ts": 6,
  "tests/raptor3/g4/review/unit01/shipped-parity.test.ts": 8,
  "tests/raptor3/g4/review/unit01/variant-arms.test.ts": 2,
  "tests/raptor3/g4/review/unit01/whole-value-operands.test.ts": 7,
  // C-01 retired the two cells that pinned the deleted engine's
  // `0viborm_distance` alias beside the candidate's `_distance` (9 -> 7).
  "tests/raptor3/g4/review/unit01-followup/distance-parity.test.ts": 7,
  "tests/raptor3/g4/review/unit01-followup/empty-arm.test.ts": 12,
  "tests/raptor3/g4/review/unit01-followup/nested-reversal.test.ts": 5,
  "tests/raptor3/g4/review/unit01-followup/operand-and-logic.test.ts": 9,
  "tests/raptor3/g4/review/unit01-followup/order-oracle.test.ts": 9,
  "tests/raptor3/g4/review/unit01-followup2/characterize.test.ts": 10,
  "tests/raptor3/g4/review/unit01-followup2/combinator-depth.test.ts": 24,
  "tests/raptor3/g4/review/unit01-followup2/cursor-refusal.test.ts": 2,
  "tests/raptor3/g4/review/unit01-followup2/decimal-fieldref.test.ts": 2,
  "tests/raptor3/g4/review/unit01-followup2/distance-depth.test.ts": 13,
  "tests/raptor3/g4/review/unit01-followup2/distance-pins.test.ts": 4,
  "tests/raptor3/g4/review/unit01-followup2/json-sentinel.test.ts": 3,
  "tests/raptor3/g4/review/unit01-followup2/selector-facts.test.ts": 5,
  "tests/raptor3/g4/review/unit01-followup3/competing-refusals.test.ts": 4,
  "tests/raptor3/g4/review/unit01-followup3/cursor-refusal-sweep.test.ts": 11,
  "tests/raptor3/g4/review/unit01-followup3/decimal-domains.test.ts": 17,
  "tests/raptor3/g4/review/unit01-followup3/decimal-reach.test.ts": 5,
  "tests/raptor3/g4/review/unit01-followup3/json-sentinel-sweep.test.ts": 9,
  "tests/raptor3/g4/review/unit01-followup3/refusal-order-history.test.ts": 3,
});
export const G4_UNIT01_REVIEW_TESTS = Object.freeze(
  Object.keys(G4_UNIT01_REVIEW_COUNTS)
);
// The G4-02 author's own checks (registered at the freeze from the unit's
// standing request, g4/unit02/note.md §R4.8). The runner refuses skipped
// cells, so the provider-gated files are registered as their own native arms
// below rather than skipped inside the credential-free mode.
export const G4_UNIT02_AUTHOR_COUNTS = Object.freeze({
  "tests/raptor3/g4/unit02/borrowed-envelope.test.ts": 5,
  "tests/raptor3/g4/unit02/decimal-having-operand.test.ts": 1,
  "tests/raptor3/g4/unit02/k-competing-refusals.test.ts": 4,
  "tests/raptor3/g4/unit02/k-refusal-order-history.test.ts": 3,
  "tests/raptor3/g4/unit02/key-arithmetic.test.ts": 21,
  "tests/raptor3/g4/unit02/lone-statement-transport.test.ts": 7,
  "tests/raptor3/g4/unit02/malformed-result-cuts.test.ts": 4,
  "tests/raptor3/g4/unit02/nested-key-refusal.test.ts": 6,
  "tests/raptor3/g4/unit02/packaged-array.test.ts": 3,
  "tests/raptor3/g4/unit02/phase2-envelope-and-arithmetic.test.ts": 7,
  "tests/raptor3/g4/unit02/physical-envelope.test.ts": 10,
  "tests/raptor3/g4/unit02/prepared-operation.test.ts": 6,
  "tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts": 5,
  "tests/raptor3/g4/unit02/prepared-statement-stability.test.ts": 3,
  "tests/raptor3/g4/unit02/recursive-codec-fit.test.ts": 3,
  "tests/raptor3/g4/unit02/returning-safety-gate.test.ts": 5,
  "tests/raptor3/g4/unit02/root-delete.test.ts": 6,
  "tests/raptor3/g4/unit02/root-member-cut-trace.test.ts": 4,
  "tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts": 8,
  "tests/raptor3/g4/unit02/upsert-key-portability.test.ts": 19,
  "tests/raptor3/g4/unit02/vector-capability.test.ts": 1,
});
export const G4_UNIT02_AUTHOR_TESTS = Object.freeze(
  Object.keys(G4_UNIT02_AUTHOR_COUNTS)
);
export const G4_UNIT02_MYSQL_COUNTS = Object.freeze({
  "tests/raptor3/g4/unit02/native-key-arithmetic.test.ts": 5,
  "tests/raptor3/g4/unit02/native-nested-key-refusal.test.ts": 3,
  "tests/raptor3/g4/unit02/unique-discriminator.test.ts": 9,
});
export const G4_UNIT02_MYSQL_TESTS = Object.freeze(
  Object.keys(G4_UNIT02_MYSQL_COUNTS)
);
export const G4_UNIT02_PG_COUNTS = Object.freeze({
  "tests/raptor3/g4/unit02/native-date-codec.test.ts": 1,
});
export const G4_UNIT02_PG_TESTS = Object.freeze(
  Object.keys(G4_UNIT02_PG_COUNTS)
);
export const G4_GENERATION_SELFTEST_COUNTS = Object.freeze({
  "tests/raptor3/g4/generation/harness.selftest.test.ts": 6,
});
export const G4_GENERATION_SELFTEST_TESTS = Object.freeze(
  Object.keys(G4_GENERATION_SELFTEST_COUNTS)
);
export const G4_NATIVE_PROVIDER_COUNTS = Object.freeze({
  "tests/raptor3/g4/native/read-envelope-native.test.ts": 5,
});
export const G4_NATIVE_PG_COUNTS = G4_NATIVE_PROVIDER_COUNTS;
export const G4_NATIVE_PG_TESTS = Object.freeze(
  Object.keys(G4_NATIVE_PG_COUNTS)
);
export const G4_NATIVE_MYSQL_COUNTS = G4_NATIVE_PROVIDER_COUNTS;
export const G4_NATIVE_MYSQL_TESTS = Object.freeze(
  Object.keys(G4_NATIVE_MYSQL_COUNTS)
);
export const G2_BASELINE_TESTS = Object.freeze(Object.keys(G2_BASELINE_COUNTS));
export const G2_CONTRACT_TESTS = Object.freeze(Object.keys(G2_CONTRACT_COUNTS));
export const G2_PROVIDER_BASELINE_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-live-legacy.test.ts": 7,
  "tests/raptor3/transitions/unique-races-live-legacy.test.ts": 3,
  "tests/raptor3/transitions/occupancy-live-legacy.test.ts": 1,
});
export const G2_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-live-commands.test.ts": 7,
  "tests/raptor3/transitions/unique-races-live-commands.test.ts": 3,
  "tests/raptor3/transitions/occupancy-live-commands.test.ts": 1,
});
export const G2_PG_BASELINE_COUNTS = Object.freeze({
  ...G2_PROVIDER_BASELINE_COUNTS,
  "tests/raptor3/transitions/staleness-live-pg-legacy.test.ts": 2,
  "tests/raptor3/transitions/junction-races-live-legacy.test.ts": 3,
  "tests/raptor3/transitions/recovery-boundaries-live-legacy.test.ts": 1,
});
export const G2_PG_CONTRACT_COUNTS = Object.freeze({
  ...G2_PROVIDER_CONTRACT_COUNTS,
  "tests/raptor3/transitions/staleness-live-pg-commands.test.ts": 2,
  "tests/raptor3/transitions/junction-races-live-commands.test.ts": 3,
  "tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts": 2,
});
export const G2_MYSQL_BASELINE_COUNTS = Object.freeze({
  ...G2_PROVIDER_BASELINE_COUNTS,
  "tests/raptor3/transitions/junction-races-live-legacy.test.ts": 2,
});
export const G2_MYSQL_CONTRACT_COUNTS = Object.freeze({
  ...G2_PROVIDER_CONTRACT_COUNTS,
  "tests/raptor3/transitions/junction-races-live-commands.test.ts": 2,
});
export const G2_MYSQL_BASELINE_TESTS = Object.freeze(
  Object.keys(G2_MYSQL_BASELINE_COUNTS)
);
export const G2_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G2_MYSQL_CONTRACT_COUNTS)
);
export const G2_PG_BASELINE_TESTS = Object.freeze(
  Object.keys(G2_PG_BASELINE_COUNTS)
);
export const G2_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G2_PG_CONTRACT_COUNTS)
);
export const G2_PROVIDER_BASELINE_TESTS = Object.freeze(
  Object.keys(G2_PROVIDER_BASELINE_COUNTS)
);
export const G2_PROVIDER_CONTRACT_TESTS = Object.freeze(
  Object.keys(G2_PROVIDER_CONTRACT_COUNTS)
);
export const G1_GENERATED_COUNTS = Object.freeze({
  "tests/raptor3/generated-smoke.test.ts": 32,
  "tests/raptor3/generated-gate.test.ts": 3,
});
export const G1_GENERATED_TESTS = Object.freeze(
  Object.keys(G1_GENERATED_COUNTS)
);
export const G1_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/generated-campaign.test.ts",
]);
export const G1_CAMPAIGN = Object.freeze({
  firstSeed: 1000,
  seedCount: 1000,
  batchSize: 100,
  replayCount: 3,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G2_CAMPAIGN = Object.freeze({
  firstSeed: 2000,
  seedCount: 5000,
  batchSize: 100,
  replayCount: 3,
  completionLimit: 5000,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G2_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g2-campaign.test.ts",
]);
export const G2_GENERATED_COUNTS = Object.freeze({
  "tests/raptor3/g2-generated.test.ts": 46,
  "tests/raptor3/g2-harness.test.ts": 6,
});
export const G2_GENERATED_TESTS = Object.freeze(
  Object.keys(G2_GENERATED_COUNTS)
);
export const G1_TRANSPORT_COUNTS = Object.freeze({
  "tests/raptor3/transport.test.ts": 44,
});
export const G1_TRANSPORT_TESTS = Object.freeze(
  Object.keys(G1_TRANSPORT_COUNTS)
);
export const G1_TRANSPORT_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/transport-campaign.test.ts",
]);
export const G1_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G1_CAMPAIGN,
  profiles: ["scripted-returning-weak", "scripted-returning-ack"],
});
export const G2_TRANSPORT_COUNTS = Object.freeze({
  "tests/raptor3/g2-transport.test.ts": 16,
});
export const G2_TRANSPORT_TESTS = Object.freeze(
  Object.keys(G2_TRANSPORT_COUNTS)
);
export const G2_TRANSPORT_CAMPAIGN_TESTS = G1_TRANSPORT_CAMPAIGN_TESTS;
export const G2_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G2_CAMPAIGN,
  profiles: G1_TRANSPORT_CAMPAIGN.profiles,
});
export const G3P06_CAMPAIGN_TESTS = G2_CAMPAIGN_TESTS;
export const G3P06_CAMPAIGN = Object.freeze({
  ...G2_CAMPAIGN,
  firstSeed: 7000,
  seedCount: 100,
});
export const G3P06_TRANSPORT_CAMPAIGN_TESTS = G2_TRANSPORT_CAMPAIGN_TESTS;
export const G3P06_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G3P06_CAMPAIGN,
  profiles: G2_TRANSPORT_CAMPAIGN.profiles,
});
export const G3_GENERATED_CAMPAIGN = Object.freeze({
  firstSeed: 8000,
  seedCount: 10_000,
  batchSize: 100,
  replayCount: 3,
  completionLimit: 10_000,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G3_GENERATED_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g3/generation/sqlite-campaign.test.ts",
]);
export const G3_GENERATED_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G3_GENERATED_CAMPAIGN,
  profiles: ["scripted-returning-weak", "scripted-returning-ack"],
});
export const G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g3/generation/transport-campaign.test.ts",
]);
/**
 * G4 generated read campaign. Frozen in `g4.md`: 25,000 new seed IDs per
 * admitted lane profile, disjoint ranges, at most 100 seeds per child.
 */
export const G4_GENERATED_CAMPAIGN = Object.freeze({
  firstSeed: 20_000,
  seedCount: 25_000,
  batchSize: 100,
  replayCount: 3,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G4_GENERATED_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g4/generation/sqlite-campaign.test.ts",
]);
export const G4_GENERATED_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G4_GENERATED_CAMPAIGN,
  firstSeed: 50_000,
  profiles: ["scripted-returning-weak", "scripted-returning-ack"],
});
export const G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g4/generation/transport-campaign.test.ts",
]);
/**
 * G4 write-envelope campaign — the same G3 write generator on fresh seeds.
 *
 * G3 qualified the write envelope over seeds 8000-17999 against the G3
 * candidate. G4 changed what a write costs physically (the envelope rule, root
 * `delete`, packaged reads, the prepared-operation boundary), so the same
 * generator, the same `runG3SQLiteBatch`/`runG3TransportBatch` and the same
 * `assertG3GeneratedBatchReceipt` are pointed at ranges no child has ever run:
 * SQLite 75000-99999, transport 100000-124999, both disjoint from every G1/G2/
 * G3 range and from the G4 READ campaign's 20000-74999.
 *
 * These constants are DATA. Batch size, replay count, completion limit,
 * profiles, the actor/fault quotas and the contract rotation are G3's,
 * inherited by spread, because the point is new inputs rather than a new
 * campaign: `(seed - firstSeed) % 4` picks the same C08/C09/C10/C11 rotation
 * here as there, both first seeds being multiples of four.
 */
export const G4_WRITE_CAMPAIGN = Object.freeze({
  ...G3_GENERATED_CAMPAIGN,
  firstSeed: 75_000,
  seedCount: 25_000,
});
export const G4_WRITE_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g4/generation/write-campaign.test.ts",
]);
export const G4_WRITE_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G3_GENERATED_TRANSPORT_CAMPAIGN,
  firstSeed: 100_000,
  seedCount: 25_000,
});
export const G4_WRITE_TRANSPORT_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g4/generation/write-transport-campaign.test.ts",
]);
/**
 * The read-transport model each campaign profile must actually exhibit.
 *
 * The profile names are frozen in `g4.md`; this table is what stops them from
 * becoming four names for one behaviour. `tests/raptor3/g4/generation/world.ts`
 * reports what its transport DID for each cell without consulting this table,
 * and `assertG4BatchShape` compares the two. A profile that quietly collapses
 * into another fails every child receipt.
 *
 * `supportsBatch`, `supportsTransactions` and `supportsOrderedCommittedSegments`
 * — the declarations that separate these names on the write side — are not the
 * distinction here: no read path consults one.
 */
export const G4_TRANSPORT_MODELS = Object.freeze({
  "sqlite-interactive": "interactive-session",
  "sqlite-atomic-batch": "atomic-submission",
  "scripted-returning-weak": "detached-returning",
  "scripted-returning-ack": "acknowledged-returning",
});
export const G4_READ_CONTRACT_FAMILIES = Object.freeze([
  "Q-W",
  "Q-O",
  "Q-P",
  "Q-S",
  "Q-A",
]);
export const G4_READ_SCHEMA_FAMILIES = Object.freeze([
  "codec",
  "relation",
  "compound",
]);

export const G1_PROVIDER_TESTS = Object.freeze([
  "tests/raptor3/expanded/produced-commands.test.ts",
  "tests/raptor3/expanded/batch-produced-commands.test.ts",
  "tests/raptor3/post-prep/g29-result-progress-pglite.test.ts",
]);
export const G1_PROVIDER_BASELINE_TESTS = Object.freeze([
  "tests/raptor3/expanded/produced-legacy.test.ts",
  "tests/raptor3/expanded/batch-produced-legacy.test.ts",
]);
export const G0_CAMPAIGN = Object.freeze({
  firstSeed: 0,
  seedCount: 100,
  replayCount: 3,
  completionLimit: 2000,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G0_RESOURCES = Object.freeze({
  heapMb: 768,
  rssMb: 1536,
  wallMs: 120_000,
});
export const G0_FALSIFIERS = Object.freeze([
  "wrong-row",
  "missing-write",
  "changed-value",
  "changed-error",
  "rollback-leak",
  "equivalent-changed-sql",
  "success-failure-replay",
  "corrupt-event-tape",
  "controlled-default-clock",
  "uncontrolled-source",
  "missing-event",
  "invalid-replay",
  "harness-exception",
  "swallowed-failure",
  "event-limit",
  "split-atomic-cut",
  "missing-eligible-cut",
  "controlled-cut-failure",
  "atomic-surrounding-faults",
  "zero-case-selection",
  "stale-evidence",
]);

function sourceFiles(root, directory) {
  const files = [];
  for (const entry of readdirSync(resolve(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(root, path));
    else if (/\.(?:ts|mts|mjs|js|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function fingerprint(root, files) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(root, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

/** Conservative executed-source identity, independent of Git's dirty-doc state. */
export function captureRaptor3Identity(root = RAPTOR3_ROOT) {
  const require = createRequire(resolve(root, "package.json"));
  const configuration = [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.workspace.ts",
    "vitest.d1.config.ts",
  ];
  return {
    production: fingerprint(root, [
      ...sourceFiles(root, "src"),
      ...configuration,
    ]),
    harness: fingerprint(root, [
      ...sourceFiles(root, "tests/raptor3"),
      ...sourceFiles(root, "scripts"),
      ...sourceFiles(root, "benchmarks"),
      "tests/contracts/public-client/cli/_clack.ts",
      ...configuration,
    ]),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      sqliteDriver: require("better-sqlite3/package.json").version,
      vitest: require("vitest/package.json").version,
    },
  };
}

export function assertRaptor3Identity(
  expected,
  actual = captureRaptor3Identity()
) {
  assert.deepEqual(
    actual,
    expected,
    "Stale Raptor 3 evidence: executed source or runtime changed"
  );
}

export const RAPTOR3_MEASUREMENT_NODE_VERSION = "v24.21.0";

export function assertStructuralMeasurementRuntime(
  baseIdentity,
  instrumentedIdentity
) {
  assert.equal(
    baseIdentity.runtime.node,
    RAPTOR3_MEASUREMENT_NODE_VERSION,
    "Structural measurement base runtime is not the qualified Node version"
  );
  assert.equal(
    instrumentedIdentity.runtime.node,
    RAPTOR3_MEASUREMENT_NODE_VERSION,
    "Structural measurement runtime is not the qualified Node version"
  );
}

/**
 * The instrumentation a structural-measurement receipt NAMES must be the one
 * that produced the measurement. Naming it and hashing it says only which file
 * was pointed at; a patch that no longer describes this source — the retired
 * `reference-instrumentation.patch` is one, 20 of its 29 hunks stale at
 * `a9e62d8dc` — would otherwise be recorded beside counters some OTHER
 * instrumentation produced, and the receipt would read as a new baseline for
 * an alternative nothing measured.
 *
 * What makes it checkable is that an applied patch reverse-applies: the
 * instrumented tree contains exactly what the patch adds. `git apply` is
 * exact, so a patch that only fits with fuzz is refused too — it does not
 * describe the measured source, which is the whole claim of the receipt.
 */
export function assertStructuralMeasurementPatch(
  patchFile,
  root = RAPTOR3_ROOT
) {
  const checked = spawnSync(
    "git",
    ["-C", root, "apply", "--check", "--reverse", patchFile],
    { encoding: "utf8" }
  );
  assert.equal(
    checked.error,
    undefined,
    `Structural measurement patch could not be checked: ${checked.error?.message}`
  );
  assert.equal(
    checked.status,
    0,
    "Structural measurement patch is not applied to the measured tree " +
      `(${patchFile}): ${(checked.stderr || "").trim() || "git apply --check --reverse failed"}`
  );
}

export function assertG0CampaignReceipt(receipt) {
  assert.deepEqual(
    receipt.campaign,
    G0_CAMPAIGN,
    "Incomplete or changed G0 campaign"
  );
  assert.equal(receipt.fixedCells, 24, "Missing required G0 profile/case");
  assert.equal(receipt.seededCells, 200, "Missing G0 schedule seeds");
  assert.equal(
    receipt.replays,
    (receipt.fixedCells + receipt.seededCells) * G0_CAMPAIGN.replayCount
  );
  assert.equal(receipt.skipped, 0, "Required G0 cells cannot be skipped");
  assert.deepEqual(
    [...receipt.falsifiers].sort(),
    [...G0_FALSIFIERS].sort(),
    "Missing or duplicate G0 harness falsifier"
  );
}

export function assertGeneratedBatchReceipt(
  receipt,
  firstSeed,
  campaign = G1_CAMPAIGN
) {
  assert.equal(receipt.firstSeed, firstSeed);
  assert.equal(receipt.seedCount, campaign.batchSize);
  assert.deepEqual(receipt.profiles, campaign.profiles);
  assert.equal(receipt.skipped, 0);
  assert.equal(
    receipt.replays,
    campaign.batchSize * campaign.profiles.length * campaign.replayCount
  );
  const expected = campaign.profiles
    .flatMap((profile) =>
      Array.from(
        { length: campaign.batchSize },
        (_, offset) => `${profile}:${firstSeed + offset}`
      )
    )
    .sort();
  assert.deepEqual(
    receipt.completed.map((cell) => `${cell.profile}:${cell.seed}`).sort(),
    expected,
    "Incomplete or duplicated generated batch"
  );
  for (const profile of campaign.profiles) {
    const cells = receipt.completed.filter((cell) => cell.profile === profile);
    assert(
      cells.filter((cell) => cell.actors === 2).length >= 20,
      "Missing two-actor quota"
    );
    assert(
      cells.filter((cell) => cell.faults > 0).length >= 20,
      "Missing actually injected fault quota"
    );
  }
}

export function assertG3GeneratedBatchReceipt(
  receipt,
  firstSeed,
  campaign,
  identity
) {
  assertRaptor3Identity(receipt.identity, identity);
  assert.equal(receipt.formatVersion, 1);
  assert.equal(receipt.qualifying, true);
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.firstSeed, firstSeed);
  assert(
    Number.isInteger(receipt.seedCount) &&
      receipt.seedCount >= 1 &&
      receipt.seedCount <= campaign.batchSize,
    "G3 child exceeds the frozen 1–100 seed bound"
  );
  assert(
    firstSeed >= campaign.firstSeed &&
      firstSeed + receipt.seedCount <= campaign.firstSeed + campaign.seedCount,
    "G3 child seed range is outside the frozen campaign"
  );
  assert.deepEqual(receipt.profiles, campaign.profiles);
  assert.equal(receipt.skipped, 0);
  assert.equal(
    receipt.replays,
    receipt.seedCount * campaign.profiles.length * campaign.replayCount
  );
  assert.equal(
    receipt.completed.length,
    receipt.seedCount * campaign.profiles.length
  );
  const expected = campaign.profiles
    .flatMap((profile) =>
      Array.from(
        { length: receipt.seedCount },
        (_, offset) => `${profile}:${firstSeed + offset}`
      )
    )
    .sort();
  assert.deepEqual(
    receipt.completed.map((cell) => `${cell.profile}:${cell.seed}`).sort(),
    expected,
    "Incomplete or duplicated G3 generated batch"
  );
  for (const profile of campaign.profiles) {
    const cells = receipt.completed.filter((cell) => cell.profile === profile);
    for (const cell of cells) {
      const expectedActors = cell.seed % 5 === 0 ? 2 : 1;
      const expectedFault = cell.seed % 5 === 1;
      const expectedContract = ["C08", "C09", "C10", "C11"][
        (cell.seed - campaign.firstSeed) % 4
      ];
      assert.equal(cell.actors, expectedActors, "Changed G3 actor recipe");
      assert.equal(
        cell.actorOverlap,
        expectedActors === 2,
        "G3 actor recipe lacks an actual overlap cut"
      );
      assert.equal(
        cell.faults > 0,
        expectedFault,
        "G3 fault recipe lacks an actual legal injected failure"
      );
      assert.equal(
        cell.contract,
        expectedContract,
        "Changed G3 contract family"
      );
      assert(
        Number.isInteger(cell.operations) &&
          cell.operations >= 1 &&
          cell.operations <= 32,
        "G3 operation count is outside the frozen campaign bound"
      );
      assert(
        Number.isInteger(cell.completions) &&
          cell.completions >= 0 &&
          cell.completions <= campaign.completionLimit,
        "G3 scheduled completion count is outside the frozen campaign bound"
      );
    }
  }
}

export function assertExtensionCampaignReceipt(receipt, campaign, identity) {
  assertRaptor3Identity(receipt.identity, identity);
  assert.equal(receipt.slice, campaign.slice);
  assert.equal(receipt.firstSeed, campaign.firstSeed);
  assert.equal(receipt.seedCount, campaign.seedCount);
  assert.deepEqual(receipt.profiles, campaign.profiles);
  assert.equal(receipt.skipped, 0, "Required CS-03 cells cannot be skipped");
  assert.equal(
    receipt.replays,
    campaign.seedCount * campaign.profiles.length * campaign.replayCount
  );
  assert.equal(
    receipt.completed.length,
    campaign.seedCount * campaign.profiles.length
  );
  const expected = campaign.profiles
    .flatMap((profile) =>
      Array.from(
        { length: campaign.seedCount },
        (_, offset) => `${profile}:${campaign.firstSeed + offset}`
      )
    )
    .sort();
  assert.deepEqual(
    receipt.completed.map((cell) => `${cell.profile}:${cell.seed}`).sort(),
    expected,
    "Incomplete or duplicated CS-03 extension campaign"
  );
  for (const cell of receipt.completed) {
    assert.equal(cell.recipe.formatVersion, 1);
    assert.equal(cell.recipe.slice, campaign.slice);
    assert.equal(cell.recipe.seed, cell.seed);
    assert.deepEqual(cell.schedule, cell.recipe.schedule);
    assert(cell.schedule.length > 0, "CS-03 recipe omitted its schedule");
    const expectedOutcome =
      cell.recipe.outcome === "missing-terminal-row" ||
      cell.recipe.outcome === "invalid-limit"
        ? "failure"
        : "success";
    assert.equal(cell.observation.outcome.kind, expectedOutcome);
  }
}

export function assertEquivalentExtensionCampaignReceipts(
  reference,
  candidate
) {
  const canonicalCells = (receipt) =>
    receipt.completed
      .map((cell) => ({
        seed: cell.seed,
        profile: cell.profile,
        recipe: cell.recipe,
        schedule: cell.schedule,
        observation: cell.observation,
      }))
      .sort((left, right) =>
        `${left.profile}:${left.seed}`.localeCompare(
          `${right.profile}:${right.seed}`
        )
      );
  assert.equal(candidate.slice, reference.slice);
  assert.equal(candidate.firstSeed, reference.firstSeed);
  assert.equal(candidate.seedCount, reference.seedCount);
  assert.deepEqual(candidate.profiles, reference.profiles);
  assert.equal(candidate.replays, reference.replays);
  assert.equal(candidate.skipped, reference.skipped);
  assert.deepEqual(
    canonicalCells(candidate),
    canonicalCells(reference),
    "CS-03 alternatives diverged in recipes, schedules, or semantic outcomes"
  );
}

function assertG4BatchShape(receipt, firstSeed, campaign, identity) {
  assertRaptor3Identity(receipt.identity, identity);
  assert.equal(receipt.formatVersion, 1);
  assert.equal(receipt.firstSeed, firstSeed);
  assert(
    Number.isInteger(receipt.seedCount) &&
      receipt.seedCount >= 1 &&
      receipt.seedCount <= campaign.batchSize,
    "G4 child exceeds the frozen 1-100 seed bound"
  );
  assert(
    firstSeed >= campaign.firstSeed &&
      firstSeed + receipt.seedCount <= campaign.firstSeed + campaign.seedCount,
    "G4 child seed range is outside the frozen campaign"
  );
  assert.deepEqual(receipt.profiles, campaign.profiles);
  // Every profile in a lane must denote a DIFFERENT read transport, or the
  // lane pays for cells it cannot distinguish.
  assert.equal(
    new Set(campaign.profiles.map((profile) => G4_TRANSPORT_MODELS[profile]))
      .size,
    campaign.profiles.length,
    "Two G4 campaign profiles denote the same read transport model"
  );
  assert.equal(receipt.skipped, 0, "Required G4 cells cannot be skipped");
  assert.equal(
    receipt.replays,
    receipt.seedCount * campaign.profiles.length * campaign.replayCount
  );
  assert.equal(
    receipt.completed.length,
    receipt.seedCount * campaign.profiles.length
  );
  const expected = campaign.profiles
    .flatMap((profile) =>
      Array.from(
        { length: receipt.seedCount },
        (_, offset) => `${profile}:${firstSeed + offset}`
      )
    )
    .sort();
  assert.deepEqual(
    receipt.completed.map((cell) => `${cell.profile}:${cell.seed}`).sort(),
    expected,
    "Incomplete or duplicated G4 generated batch"
  );
  for (const cell of receipt.completed) {
    const expectedContract =
      G4_READ_CONTRACT_FAMILIES[
        (cell.seed - campaign.firstSeed) % G4_READ_CONTRACT_FAMILIES.length
      ];
    assert.equal(cell.contract, expectedContract, "Changed G4 contract family");
    assert(
      G4_READ_SCHEMA_FAMILIES.includes(cell.family),
      "Unknown G4 schema family"
    );
    if (cell.contract === "Q-S")
      assert.equal(cell.family, "relation", "Q-S must use the relation family");
    if (cell.contract === "Q-A")
      assert.equal(cell.family, "codec", "Q-A must use the codec family");
    // This campaign injects no peer actor and no fault: reads publish no
    // effect for a peer to observe. The quota is therefore an exact zero,
    // which a recipe that silently started injecting would break.
    assert.equal(cell.actors, 1, "G4 read cells carry exactly one actor");
    assert.equal(cell.faults, 0, "G4 read cells inject no fault");
    assert(
      Number.isInteger(cell.rows) && cell.rows >= 0 && cell.rows <= 64,
      "G4 cell row count is outside the frozen campaign bound"
    );
    assert(
      Number.isInteger(cell.statements) && cell.statements >= 1,
      "A G4 read cell must reach the provider at least once"
    );
    assert.equal(
      cell.transport,
      G4_TRANSPORT_MODELS[cell.profile],
      `G4 profile ${cell.profile} did not exhibit its transport model`
    );
    // An atomic submission is BEGIN + statement + COMMIT, so the physical
    // stream of that profile is exactly three entries per submitted read.
    if (cell.transport === "atomic-submission")
      assert.equal(
        cell.statements % 3,
        0,
        "An atomic-submission cell did not wrap every statement"
      );
  }
}

/** The qualifying G4 child receipt: the CANDIDATE answered every cell. */
export function assertG4GeneratedBatchReceipt(
  receipt,
  firstSeed,
  campaign,
  identity
) {
  assert.equal(
    receipt.subject,
    "candidate",
    "Only a candidate-subject G4 child can qualify"
  );
  assert.equal(receipt.qualifying, true);
  assert.equal(receipt.status, "complete");
  assertG4BatchShape(receipt, firstSeed, campaign, identity);
}

/**
 * The non-qualifying companion: the same worlds, requests, oracle and replays
 * run against the SHIPPED engine. It validates the oracle and measures a
 * complete child's cost; it is never evidence for the candidate.
 */
export function assertG4OracleValidationReceipt(
  receipt,
  firstSeed,
  campaign,
  identity
) {
  assert.equal(
    receipt.subject,
    "shipped",
    "An oracle-validation G4 child runs the shipped subject"
  );
  assert.equal(receipt.qualifying, false);
  assert.equal(receipt.status, "oracle-validation");
  assertG4BatchShape(receipt, firstSeed, campaign, identity);
}

/**
 * The raptor3 tests that run against a live Docker provider, stated once:
 * `vitest.workspace.ts` builds the `raptor3-live-provider` project from it and
 * `tests/inventory.ts` reads it to mark the same files as needing SQL
 * execution. The G1 provider pair below is the `raptor3-provider` project.
 */
export const RAPTOR3_LIVE_PROVIDER_TESTS = Object.freeze([
  ...G2_PG_BASELINE_TESTS,
  ...G2_PG_CONTRACT_TESTS,
  ...G25_PG_CONTRACT_TESTS,
  ...G27_PG_CONTRACT_TESTS,
  ...G27_MYSQL_CONTRACT_TESTS,
  ...G3P02_PG_CONTRACT_TESTS,
  ...G3P03_PG_CONTRACT_TESTS,
  ...G3P04_PG_CONTRACT_TESTS,
  ...G3_SCOPE_COMPOSITION_PG_TESTS,
  ...POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
  ...POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
  ...G29_MEMBER_DEPENDENCY_PG_TESTS,
  ...G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
  ...G4_NATIVE_PG_TESTS,
  ...G4_NATIVE_MYSQL_TESTS,
  ...G4_UNIT02_MYSQL_TESTS,
  ...G4_UNIT02_PG_TESTS,
]);
/**
 * The release units' deterministic pins (SQLite, both routes): D-46 the
 * upsert on the array route, D-50 the increment key's width, N2 the lax
 * to-one no-op with N3's race cells, N3 the series member premise at capture,
 * M1 the key a provider without RETURNING must already know.
 * Engine coverage is measured on them (`coverage-raptor3`); the live-PGlite
 * pins are `D50_PROVIDER_TESTS`.
 */
export const G4_PARITY_COUNTS = Object.freeze({
  "tests/raptor3/g4/parity/upsert-array-route.test.ts": 6,
  "tests/raptor3/g4/parity/increment-key-width.test.ts": 1,
  "tests/raptor3/g4/parity/lax-to-one.test.ts": 27,
  "tests/raptor3/g4/parity/batch-observed-publication.test.ts": 10,
  "tests/raptor3/g4/parity/batch-captured-bulk.test.ts": 7,
  "tests/raptor3/g4/parity/combinator-named-scalar.test.ts": 4,
  "tests/raptor3/g4/parity/series-member-premise.test.ts": 4,
  "tests/raptor3/g4/parity/singular-slot-transition.test.ts": 10,
  "tests/raptor3/g4/parity/member-boundary-packaging.test.ts": 5,
  "tests/raptor3/g4/parity/blind-premise-attribution.test.ts": 1,
  "tests/raptor3/g4/parity/correlated-membership.test.ts": 5,
  "tests/raptor3/g4/parity/suppressed-membership-target.test.ts": 7,
  "tests/raptor3/g4/parity/exclusive-member-cardinality.test.ts": 14,
  "tests/raptor3/g4/parity/published-key.test.ts": 12,
  "tests/raptor3/g4/parity/captured-identity-domains.test.ts": 18,
  "tests/raptor3/g4/parity/transport-witnesses.test.ts": 7,
  "tests/raptor3/g4/parity/reference-representability.test.ts": 26,
  "tests/raptor3/g4/parity/one-write-outcome-composition.test.ts": 4,
  "tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts": 3,
  "tests/raptor3/g4/parity/fresh-member-placement.test.ts": 16,
  "tests/raptor3/g4/parity/prepared-set-predicates.test.ts": 9,
  "tests/raptor3/g4/parity/cascaded-current-identity.test.ts": 21,
  "tests/raptor3/g4/parity/generated-key-reach.test.ts": 7,
  "tests/raptor3/g4/parity/read-only-build-contract.test.ts": 3,
});
export const G4_PARITY_TESTS = Object.freeze(Object.keys(G4_PARITY_COUNTS));
/** D-50: the exact identity scratch on a PostgreSQL batch-only transport (live PGlite). */
export const D50_PROVIDER_TESTS = Object.freeze([
  "tests/raptor3/g4/parity/postgres-identity-scratch.test.ts",
  "tests/raptor3/g4/parity/postgres-declared-type-scratch.test.ts",
]);
/** D-53: the PostgreSQL half of the transport witnesses (live PGlite). */
export const D53_PROVIDER_TESTS = Object.freeze([
  "tests/raptor3/g4/parity/transport-seam-pglite.test.ts",
]);
export const RAPTOR3_PROVIDER_TESTS = Object.freeze([
  ...G1_PROVIDER_TESTS,
  ...G1_PROVIDER_BASELINE_TESTS,
  ...D50_PROVIDER_TESTS,
  ...D53_PROVIDER_TESTS,
]);

/**
 * The `raptor3` vitest project, stated once. Two halves: the DETERMINISTIC
 * files run under plain vitest (and are therefore the engine's coverage
 * project, `coverage-raptor3`), while the RUNNER-ONLY files — the seeded
 * campaigns and the structural measurements — need the mode runner's
 * environment (`scripts/run-raptor3.mjs`) and fail under a bare project run.
 */
export const RAPTOR3_DETERMINISTIC_TESTS = Object.freeze([
  ...RAPTOR3_TESTS,
  ...G4_PARITY_TESTS,
  ...G1_COMPARISON_TESTS,
  ...G1_BASELINE_TESTS,
  ...G1_CONTRACT_TESTS,
  ...G2_BASELINE_TESTS,
  ...G2_CONTRACT_TESTS,
  ...G25_CONTRACT_TESTS,
  ...G27_CONTRACT_TESTS,
  ...G3P03_CONTRACT_TESTS,
  ...G3P04_CONTRACT_TESTS,
  ...G3P04_REVIEW_CONTRACT_TESTS,
  ...G3P05_CONTRACT_TESTS,
  ...G3_BULK_SERIES_TESTS,
  ...G3_SUPPRESSION_RETRY_TESTS,
  ...G3_TRANSACTION_ARRAY_TESTS,
  ...G3_DEPTH_RECURRENCE_TESTS,
  ...G3_GENERATED_SMOKE_TESTS,
  ...G3_GENERATED_TRANSPORT_SMOKE_TESTS,
  ...G3_GENERATED_MINIMIZATION_TESTS,
  ...G4_READ_TESTS,
  ...G4_GENERATION_SELFTEST_TESTS,
  ...G4_UNIT01_AUTHOR_TESTS,
  ...G4_UNIT01_REVIEW_TESTS,
  ...G4_UNIT02_AUTHOR_TESTS,
  ...G3_EXECUTION_REVIEW_TESTS,
  ...G3_AUTHOR_EXECUTION_REGRESSION_TESTS,
  ...G3_SCOPE_FAILURE_TESTS,
  ...G3_BULK_RESULT_BOUNDARY_TESTS,
  ...POST_G3_CLEARABILITY_CONTRACT_TESTS,
  ...POST_G3_SCHEMA_VIEW_TESTS,
  ...POST_G3_PROJECTION_PREPARATION_TESTS,
  ...POST_G3_SELECTOR_PREPARATION_TESTS,
  ...POST_G3_HISTORY_ANALYSIS_TESTS,
  ...G29_MEMBER_DEPENDENCY_TESTS,
  ...G29_DEPENDENCY_BOUNDARY_TESTS,
  ...G29_DEPENDENCY_CHOICE_TESTS,
  ...G29_RESULT_PROGRESS_TESTS,
  ...CS01_STRUCTURAL_REFERENCE_TESTS,
  ...CS01_EXTENSION_A_TESTS,
  ...CS01_EXTENSION_B_TESTS,
  ...CS01_EXTENSION_COMPOSITION_TESTS,
  ...CS03_MEMBER_SCOPE_TESTS,
  ...CS02_REPEATED_OCCURRENCE_TESTS,
  ...G2_DIAGNOSTIC_TESTS,
  ...G1_GENERATED_TESTS,
  ...G1_CAMPAIGN_TESTS,
  ...G1_TRANSPORT_TESTS,
  ...G1_TRANSPORT_CAMPAIGN_TESTS,
  ...G2_CAMPAIGN_TESTS,
  ...G2_TRANSPORT_TESTS,
  ...G2_GENERATED_TESTS,
  // Both CS-03 support files run bare: the runner has no mode that names
  // either of them (its `cs03-extension-*-seeds` modes run the campaign
  // itself, `CS03_EXTENSION_CAMPAIGN_TESTS`), and the campaign self-test
  // reaches its cells through an ordinary SQLite world — measured under a
  // bare project run, 42 / 42 (FC-06). Stating them here through the group
  // that owns them is what keeps one file out of two halves at once.
  ...CS03_EXTENSION_SUPPORT_TESTS,
]);
export const RAPTOR3_RUNNER_ONLY_TESTS = Object.freeze([
  ...CS02_STRUCTURE_MEASUREMENT_TESTS,
  ...CS03_EXTENSION_CAMPAIGN_TESTS,
  ...G3_GENERATED_CAMPAIGN_TESTS,
  ...G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  ...G4_GENERATED_CAMPAIGN_TESTS,
  ...G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  ...G4_WRITE_CAMPAIGN_TESTS,
  ...G4_WRITE_TRANSPORT_CAMPAIGN_TESTS,
]);
export const RAPTOR3_PROJECT_TESTS = Object.freeze([
  ...RAPTOR3_DETERMINISTIC_TESTS,
  ...RAPTOR3_RUNNER_ONLY_TESTS,
]);
