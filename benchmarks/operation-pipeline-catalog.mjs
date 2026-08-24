/** Immutable protocol and single workload catalog for pipeline comparisons. */

export const ALLOCATION_SAMPLING_INTERVAL = 4096;
export const ALL_MODES = Object.freeze(["alloc", "cpu", "retained"]);

const stages = Object.freeze({
  allRead: Object.freeze(["prepare", "execute", "parse", "raw-parse", "full"]),
  parseRead: Object.freeze(["parse", "raw-parse", "full"]),
  parseFull: Object.freeze(["parse", "full"]),
  prepareFull: Object.freeze(["prepare", "full"]),
  prepareParseFull: Object.freeze(["prepare", "parse", "full"]),
  mutation: Object.freeze(["prepare", "execute", "raw-parse", "full"]),
  atomic: Object.freeze(["prepare", "execute", "full"]),
  fullOnly: Object.freeze(["full"]),
});

const ASYNC_STAGES = new Set([
  "provider-execute",
  "driver-wrapper",
  "execute",
  "raw-parse",
  "full",
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
  });
}

export const WORKLOADS = Object.freeze({
  "driver-raw": workload(
    "core",
    Object.freeze(["provider-execute", "driver-wrapper"]),
    1
  ),
  "scalar-find-unique": workload("core", stages.allRead, 1),
  "scalar-find-many-20": workload("core", stages.allRead, 20),
  "scalar-find-many-1000": workload("core", stages.parseRead, 1000),
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
  "flat-create-explicit-id": workload("core", stages.mutation, 1),
  "flat-create-generated-id": workload("core", stages.mutation, 1),
  "flat-scalar-update": workload("core", stages.mutation, 1),
  "wide-create-1": workload("wide", stages.prepareFull, 1),
  "wide-create-20": workload("wide", stages.prepareFull, 1),
  "wide-update-1": workload("wide", stages.prepareFull, 1),
  "wide-update-20": workload("wide", stages.prepareFull, 1),
  "fixed-rowref-create": workload("core", stages.fullOnly, 1),
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
