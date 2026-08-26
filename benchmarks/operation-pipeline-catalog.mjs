/** Immutable protocol and single workload catalog for pipeline comparisons. */

export const ALLOCATION_SAMPLING_INTERVAL = 4096;
export const ALL_MODES = Object.freeze(["alloc", "cpu", "retained"]);
export const EXTENSION_ARMS = Object.freeze([
  "unextended",
  "request",
  "query",
  "statement",
  "observe",
  "client",
  "model",
]);
export const CROSS_PROVIDER_BASELINE_COMMIT =
  "52eef9ebfc710407e1e5fe6042e2ed5a11adf19e";

export const PROVIDERS = Object.freeze({
  sqlite3: Object.freeze({
    runtime: "node",
    fixture: "local",
    responseBytes: false,
  }),
  "bun-sqlite": Object.freeze({
    runtime: "bun",
    fixture: "local",
    responseBytes: false,
  }),
  libsql: Object.freeze({
    runtime: "node",
    fixture: "local",
    responseBytes: false,
  }),
  pglite: Object.freeze({
    runtime: "node",
    fixture: "local",
    responseBytes: false,
  }),
  pg: Object.freeze({
    runtime: "node",
    fixture: "service",
    responseBytes: false,
    environment: "VIBORM_BENCH_PG_URL",
  }),
  "postgres.js": Object.freeze({
    runtime: "node",
    fixture: "service",
    responseBytes: false,
    environment: "VIBORM_BENCH_POSTGRES_JS_URL",
  }),
  "bun-sql": Object.freeze({
    runtime: "bun",
    fixture: "service",
    responseBytes: false,
    environment: "VIBORM_BENCH_BUN_SQL_URL",
  }),
  mysql2: Object.freeze({
    runtime: "node",
    fixture: "service",
    responseBytes: false,
    environment: "VIBORM_BENCH_MYSQL2_URL",
  }),
  planetscale: Object.freeze({
    runtime: "node",
    fixture: "deterministic-sdk",
    responseBytes: false,
  }),
  "neon-http": Object.freeze({
    runtime: "node",
    fixture: "deterministic-fetch",
    responseBytes: true,
  }),
  d1: Object.freeze({
    runtime: "workerd",
    fixture: "workers-d1",
    responseBytes: true,
    unavailableReason:
      "The D1 leg requires a Workers runtime runner and a deterministic local D1 binding.",
  }),
});

export const ALL_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

const stages = Object.freeze({
  allRead: Object.freeze(["prepare", "execute", "parse", "raw-parse", "full"]),
  parseRead: Object.freeze(["parse", "raw-parse", "full"]),
  parseFull: Object.freeze(["parse", "full"]),
  prepareFull: Object.freeze(["prepare", "full"]),
  prepareParseFull: Object.freeze(["prepare", "parse", "full"]),
  mutation: Object.freeze(["prepare", "execute", "raw-parse", "full"]),
  atomic: Object.freeze(["prepare", "execute", "full"]),
  fullOnly: Object.freeze(["full"]),
  providerRead: Object.freeze([
    "provider-execute",
    "driver-wrapper",
    "unowned-parse",
    "provider-parse",
    "full",
  ]),
  executionForms: Object.freeze([
    "direct",
    "prepared",
    "transaction",
    "fallback-batch",
    "native-batch",
  ]),
});

const ASYNC_STAGES = new Set([
  "provider-execute",
  "provider-parse",
  "driver-wrapper",
  "execute",
  "raw-parse",
  "full",
  "direct",
  "prepared",
  "transaction",
  "fallback-batch",
  "native-batch",
]);

function workload(fixture, selectedStages, rowsPerOperation, options = {}) {
  return Object.freeze({
    fixture,
    stages: selectedStages,
    stageKinds: Object.freeze(
      Object.fromEntries(
        selectedStages.map((stage) => [
          stage,
          options.asyncStages?.includes(stage) || ASYNC_STAGES.has(stage)
            ? "async"
            : "sync",
        ])
      )
    ),
    rowsPerOperation,
    substrate: options.substrate ?? "transactional",
    providers: options.providers ?? Object.freeze(["sqlite3"]),
    extensionProof: options.extensionProof === true,
    ...(options.providerShape
      ? { providerShape: Object.freeze(options.providerShape) }
      : {}),
  });
}

const providerWorkloads = Object.fromEntries([
  ...[1, 20, 1000, 10_000].flatMap((rows) =>
    ["identity", "mixed-scalar"].map((kind) => [
      `provider-${kind}-${rows}`,
      workload("provider-read", stages.providerRead, rows, {
        providers: ALL_PROVIDERS,
        providerShape: { kind, rows },
      }),
    ])
  ),
  [
    "provider-wide-scalar-100",
    workload("provider-read", stages.providerRead, 1, {
      providers: ALL_PROVIDERS,
      providerShape: { kind: "wide-scalar", rows: 1, fields: 100 },
    }),
  ],
  ...["fixed-nested", "variant-nested"].map((kind) => [
    `provider-${kind}-20`,
    workload("provider-read", stages.providerRead, 20, {
      providers: ALL_PROVIDERS,
      providerShape: { kind, rows: 20 },
    }),
  ]),
  ...["count", "aggregate"].map((kind) => [
    `provider-${kind}-10000`,
    workload("provider-read", stages.providerRead, 1, {
      providers: ALL_PROVIDERS,
      providerShape: { kind, sourceRows: 10_000 },
    }),
  ]),
  [
    "provider-returning-one",
    workload("provider-read", stages.providerRead, 1, {
      providers: ALL_PROVIDERS,
      providerShape: { kind: "returning", rows: 1 },
    }),
  ],
  [
    "provider-relation-count-20",
    workload("provider-read", stages.providerRead, 20, {
      providers: ALL_PROVIDERS,
      providerShape: { kind: "relation-count", rows: 20 },
    }),
  ],
  [
    "provider-execution-forms",
    workload("provider-read", stages.executionForms, 1, {
      providers: ALL_PROVIDERS,
      providerShape: { kind: "execution", rows: 1 },
    }),
  ],
]);

export const WORKLOADS = Object.freeze({
  ...providerWorkloads,
  "driver-raw": workload(
    "core",
    Object.freeze(["provider-execute", "driver-wrapper"]),
    1
  ),
  "scalar-find-unique": workload("core", stages.allRead, 1),
  "scalar-find-many-1": workload("core", stages.parseRead, 1, {
    extensionProof: true,
  }),
  "scalar-find-many-20": workload("core", stages.allRead, 20),
  "scalar-find-many-1000": workload("core", stages.parseRead, 1000, {
    extensionProof: true,
  }),
  "wide-scalar-select-1": workload("wide", stages.prepareFull, 1),
  "wide-scalar-select-20": workload("wide", stages.prepareFull, 1),
  "wide-scalar-select-100": workload("wide", stages.prepareFull, 1),
  "wide-scalar-predicates-10": workload("wide", stages.prepareFull, 1),
  "scalar-cursor-take": workload("core", stages.prepareFull, 20),
  "fixed-singular-rowref-20": workload("core", stages.allRead, 20),
  "fixed-singular-rowref-1000": workload("core", stages.allRead, 1000),
  "fixed-collection-rowref-20": workload("core", stages.allRead, 20),
  "fixed-collection-rowref-1000": workload("core", stages.allRead, 1000),
  "variant-singular-rowref-20": workload("variant", stages.allRead, 20),
  "variant-singular-rowref-1000": workload("variant", stages.allRead, 1000),
  "variant-collection-junction-20": workload("variant", stages.allRead, 20),
  "variant-collection-junction-1000": workload("variant", stages.allRead, 1000),
  "fixed-singular-junction": workload("variant", stages.prepareParseFull, 20),
  "fixed-collection-junction": workload("variant", stages.prepareParseFull, 20),
  "enum-heavy-20": workload("core", stages.parseFull, 20),
  "enum-heavy-1000": workload("core", stages.parseFull, 1000),
  "flat-create-explicit-id": workload("core", stages.mutation, 1, {
    extensionProof: true,
  }),
  "flat-create-generated-id": workload("core", stages.mutation, 1),
  "flat-scalar-update": workload("core", stages.mutation, 1),
  "wide-create-1": workload("wide", stages.prepareFull, 1),
  "wide-create-20": workload("wide", stages.prepareFull, 1),
  "wide-update-1": workload("wide", stages.prepareFull, 1),
  "wide-update-20": workload("wide", stages.prepareFull, 1),
  "fixed-rowref-create": workload("core", stages.fullOnly, 1, {
    extensionProof: true,
  }),
  "fixed-rowref-update": workload("core", stages.fullOnly, 1),
  "fixed-junction-create": workload("variant", stages.fullOnly, 1),
  "fixed-junction-update": workload("variant", stages.fullOnly, 1),
  "variant-singular-create": workload("variant", stages.fullOnly, 1),
  "variant-singular-update": workload("variant", stages.fullOnly, 1),
  "variant-collection-create": workload("variant", stages.fullOnly, 1),
  "variant-collection-update": workload("variant", stages.fullOnly, 1),
  "variant-row-storage-create-many-100": workload(
    "variant",
    stages.fullOnly,
    100
  ),
  "atomic-batch-1": workload("core", stages.atomic, 1, {
    substrate: "batch-only",
  }),
  "atomic-batch-10": workload("core", stages.atomic, 10, {
    substrate: "batch-only",
  }),
  "atomic-batch-100": workload("core", stages.atomic, 100, {
    substrate: "batch-only",
    extensionProof: true,
  }),
  "nested-transaction-0-reference": workload("core", stages.fullOnly, 2, {
    substrate: "batch-only",
  }),
  "nested-transaction-1-reference": workload("core", stages.fullOnly, 2, {
    substrate: "batch-only",
  }),
  "bulk-create-returning-100": workload("core", stages.prepareParseFull, 100, {
    asyncStages: ["prepare"],
  }),
  "bulk-update-returning-100": workload("core", stages.prepareParseFull, 100, {
    asyncStages: ["prepare"],
  }),
  ...Object.fromEntries(
    [2, 20, 100].flatMap((fieldCount) =>
      [1, 2, 3].map((depth) => [
        `relation-projection-${fieldCount}-depth-${depth}`,
        workload("wide", stages.prepareFull, 1),
      ])
    )
  ),
});
