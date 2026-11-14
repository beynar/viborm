/**
 * The tests that hold the extension subsystem (`src/extensions`, and the
 * official `on`, `ordering`, `permissions` and `soft-delete` entries) at
 * 100%. One list, read by the coverage policy and by the `coverage-extensions`
 * project: written twice, the two drifted (deleted files kept, new ones
 * missing) and nothing failed.
 */

/** Deterministic contracts: in-memory drivers, no provider resource. */
const contracts = [
  "tests/contracts/architecture/extension-system-census.core.test.ts",
  "tests/contracts/engine/query/operation-program-read-contracts.core.test.ts",
  "tests/contracts/engine/query/pending-operation-contracts.core.test.ts",
  "tests/contracts/public-client/adversarial-v1-extension.core.test.ts",
  "tests/contracts/public-client/default-omit-extension.core.test.ts",
  "tests/contracts/public-client/extension-admission-reuse.core.test.ts",
  "tests/contracts/public-client/extension-authoring-refusals.core.test.ts",
  "tests/contracts/public-client/extension-batch-atomicity.core.test.ts",
  "tests/contracts/public-client/extension-bound-views.core.test.ts",
  "tests/contracts/public-client/extension-call-facts.core.test.ts",
  "tests/contracts/public-client/extension-composition.core.test.ts",
  "tests/contracts/public-client/extension-controls.core.test.ts",
  "tests/contracts/public-client/extension-deletion.core.test.ts",
  "tests/contracts/public-client/extension-differential-review.core.test.ts",
  "tests/contracts/public-client/extension-evidence.core.test.ts",
  "tests/contracts/public-client/extension-lazy-verbs.core.test.ts",
  "tests/contracts/public-client/extension-methods-host.core.test.ts",
  "tests/contracts/public-client/extension-order.core.test.ts",
  "tests/contracts/public-client/extension-parts-review.core.test.ts",
  "tests/contracts/public-client/extension-parts.core.test.ts",
  "tests/contracts/public-client/extension-produced.core.test.ts",
  "tests/contracts/public-client/extension-relation-depth.core.test.ts",
  "tests/contracts/public-client/extension-row-checks.core.test.ts",
  "tests/contracts/public-client/extension-rows-split-review.core.test.ts",
  "tests/contracts/public-client/extension-rule-native.core.test.ts",
  "tests/contracts/public-client/extension-shared-bodies.core.test.ts",
  "tests/contracts/public-client/extension-step5-review-officials.core.test.ts",
  "tests/contracts/public-client/extension-step5-review.core.test.ts",
  "tests/contracts/public-client/extension-verbs.core.test.ts",
  "tests/contracts/public-client/extension-words-edges.core.test.ts",
  "tests/contracts/public-client/extensions-foundation.core.test.ts",
  "tests/contracts/public-client/extensions/array-admission.core.test.ts",
  "tests/contracts/public-client/official-cache-extension.core.test.ts",
  "tests/contracts/public-client/official-cache-swr.core.test.ts",
  "tests/contracts/public-client/official-instrumentation-extension.core.test.ts",
  "tests/contracts/public-client/on.core.test.ts",
  "tests/contracts/public-client/ordering-append.core.test.ts",
  "tests/contracts/public-client/ordering-composition.core.test.ts",
  "tests/contracts/public-client/ordering-identity.core.test.ts",
  "tests/contracts/public-client/ordering-keys.core.test.ts",
  "tests/contracts/public-client/ordering-placed.core.test.ts",
  "tests/contracts/public-client/ordering-refusals.core.test.ts",
  "tests/contracts/public-client/ordering.core.test.ts",
  "tests/contracts/public-client/permissions-field-write-nested.core.test.ts",
  "tests/contracts/public-client/permissions-reach.core.test.ts",
  "tests/contracts/public-client/query-interceptors-array.core.test.ts",
  "tests/contracts/public-client/query-interceptors-integration.core.test.ts",
  "tests/contracts/public-client/query-interceptors.core.test.ts",
  "tests/contracts/public-client/request-transforms.core.test.ts",
  "tests/contracts/public-client/soft-delete.core.test.ts",
  "tests/contracts/public-client/statement-transforms-integration.core.test.ts",
  "tests/contracts/public-client/units.core.test.ts",
  "tests/contracts/public-client/written.core.test.ts",
  "tests/unit/cache/adversarial-v1-cache.core.test.ts",
  "tests/unit/cache/brand-token-keys.core.test.ts",
  "tests/unit/cache/coverage-low-value.core.test.ts",
  "tests/unit/cache/operand-callback-keys.core.test.ts",
  "tests/unit/instrumentation/one-generation.core.test.ts",
  "tests/unit/permissions/actor.core.test.ts",
  "tests/unit/permissions/availability-boundaries.core.test.ts",
  "tests/unit/permissions/compile.core.test.ts",
];

/**
 * Local SQLite suites, each in its own bounded process: the complete
 * Permissions oracle sweeps, computed fields, and the read-gated fields
 * `$rows()` and a `$through` link refuse. (A PGlite suite does not
 * fit: instrumented, one peaked at 1,636 MiB against the 1,536 MiB ceiling.)
 */
const providerSweeps = [
  "tests/providers/local/sqlite3-permissions-compiled-policy.test.ts",
  "tests/providers/local/sqlite3-permissions-entry.test.ts",
  "tests/providers/local/sqlite3-permissions-extends.test.ts",
  "tests/providers/local/sqlite3-permissions-inherited-key.test.ts",
  "tests/providers/local/sqlite3-permissions-quantifiers.test.ts",
  "tests/providers/local/sqlite3-permissions-reuse-review.test.ts",
  "tests/providers/local/sqlite3-permissions-reuse.test.ts",
  "tests/providers/local/sqlite3-raw-rows.test.ts",
  "tests/providers/local/sqlite3-result-fields.test.ts",
  "tests/providers/local/sqlite3-through-model-governed.test.ts",
];

export const EXTENSION_COVERAGE_TESTS = Object.freeze([
  ...contracts,
  ...providerSweeps,
]);

/**
 * One bounded process per group: the contracts in halves (one process for
 * all of them peaks near the 1536 MiB ceiling), then each sweep alone. Every
 * part is merged under the unchanged 100% gate.
 */
const half = Math.ceil(contracts.length / 2);
export const EXTENSION_COVERAGE_TEST_GROUPS = Object.freeze([
  contracts.slice(0, half),
  contracts.slice(half),
  ...providerSweeps.map((test) => [test]),
]);
