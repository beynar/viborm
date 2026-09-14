/** Public contract families; later gates add cells, not another vocabulary. */
export const CONTRACTS = {
  C01: {
    meaning: "Root/nested reads and record occurrences",
    owner: "G1-05",
    complete: "G4-01",
  },
  C02: {
    meaning: "Conditional relation changes across storage mappings",
    owner: "G1-03",
    complete: "G1-06",
  },
  C03: {
    meaning: "One final assignment and complete reference tuples",
    owner: "G1-03",
    complete: "G1-06",
  },
  C04: {
    meaning: "Exact successful producer-field publication",
    owner: "G1-04",
    complete: "G3",
  },
  C05: {
    meaning: "Selected-row continuity and reference transitions",
    owner: "G2-01",
    complete: "G2",
  },
  C06: {
    meaning: "Membership occupancy, transfer and clear/refill",
    owner: "G2-01",
    complete: "G2",
  },
  C07: {
    meaning: "Own effects and supply-before-modify ordering",
    owner: "G2-01",
    complete: "G2",
  },
  C08: {
    meaning: "Set-oriented bulk versus admitted record series",
    owner: "G3",
    complete: "G3",
  },
  C09: {
    meaning: "Subtree skip and exact race recovery",
    owner: "G3",
    complete: "G3",
  },
  C10: {
    meaning: "Transactions, segments, acknowledgement and failure",
    owner: "G1-05",
    complete: "G4",
  },
  C11: {
    meaning: "Self-relations, recursion and ancestor occurrences",
    owner: "G3",
    complete: "G3",
  },
  C12: {
    meaning: "Shaped query outputs, decoding and container ownership",
    owner: "G1-05",
    complete: "G4-01",
  },
  C13: {
    meaning: "Admission, defaults, lifecycle and public types",
    owner: "G1-05",
    complete: "G4",
  },
} as const;

export type ContractId = keyof typeof CONTRACTS;
export type WitnessFamily = "S1" | "S2" | "S3" | "S4" | ContractId;

export const G0_CASE_IDS = [
  "s1-parent-found",
  "s1-parent-missing",
  "s1-parent-rollback",
  "s1-child-found",
  "s1-child-missing",
  "s1-child-rollback",
  "s2-distinct-defaults",
  "s2-changed-dependency",
  "s3-grouped",
  "s3-empty",
  "s4-parent-pages",
  "s4-shared-occurrences",
] as const;

export const HARNESS_CASE_IDS = [
  "g0-cut-split",
  "g0-cut-atomic",
  "g0-cut-missing",
  "g0-clock-controlled",
  "g0-clock-uncontrolled",
] as const;

export const G1_CASE_IDS = [
  "g1-parent-fresh-create",
  "g1-parent-selected-create",
  "g1-parent-fresh-connect-foreign",
  "g1-parent-selected-connect-missing",
  "g1-parent-fresh-coc-missing",
  "g1-parent-selected-coc-found-foreign",
  "g1-parent-selected-upsert-found",
  "g1-parent-selected-upsert-missing",
  "g1-parent-fresh-upsert-refused",
  "g1-child-fresh-create",
  "g1-child-selected-create",
  "g1-child-fresh-connect-foreign",
  "g1-child-selected-connect-missing",
  "g1-child-fresh-coc-missing",
  "g1-child-selected-coc-found-foreign",
  "g1-child-fresh-upsert-found-foreign",
  "g1-child-selected-upsert-missing",
  "g1-child-selected-upsert-foreign",
  "g1-junction-fresh-create",
  "g1-junction-selected-create",
  "g1-junction-fresh-connect-foreign",
  "g1-junction-selected-connect-missing",
  "g1-junction-selected-connect-owned",
  "g1-junction-fresh-coc-missing",
  "g1-junction-selected-coc-found-foreign",
  "g1-junction-fresh-upsert-found-foreign",
  "g1-junction-selected-upsert-missing",
  "g1-junction-selected-upsert-foreign",
  "g1-selected-upsert-reparent",
  "g1-selected-upsert-explicit-fk-conflict",
  "g1-compound-agree-partial",
  "g1-compound-agree-complete",
  "g1-compound-conflict",
  "g1-compound-null",
  "g1-compound-selected-owned-key",
  "g1-compound-create-owned-key",
  "g1-compound-generated-parent",
  "g1-compound-unknown-component",
  "g1-read-unique-found",
  "g1-read-unique-missing",
  "g1-read-null-empty",
] as const;

export const G1_PROVIDER_CASE_IDS = [
  "g1-produced-nonprimary-fanout",
  "g1-produced-before-parent",
  "g1-produced-distinct-channels",
] as const;

export const G1_LIFETIME_CASE_IDS = [
  "g1-upsert-illegal-update-selected",
  "g1-upsert-illegal-update-untaken",
  "g1-upsert-invalid-create-untaken",
  "g1-upsert-invalid-update-untaken",
  "g1-upsert-invalid-nested-update-untaken",
  "g1-upsert-nested-admission-publication",
  "g1-reuse-after-rollback",
  "g1-concurrent-queued-creates",
] as const;

export const G1_VARIANT_IDENTITY_CASE_IDS = [
  "g1-variant-row-create",
  "g1-variant-row-connect",
  "g1-variant-row-coc-found",
  "g1-variant-row-coc-missing",
  "g1-variant-row-upsert-found",
  "g1-variant-row-upsert-missing",
  "g1-variant-inverse-generated",
  "g1-variant-inverse-upsert-foreign",
  "g1-variant-junction-mixed-create-connect",
  "g1-variant-junction-coc-mixed",
  "g1-variant-junction-upsert-found",
  "g1-variant-junction-upsert-foreign-create",
  "g1-variant-junction-upsert-missing",
  "g1-variant-junction-connect-owned",
  "g1-compound-unique-filter-found",
  "g1-compound-unique-filter-missing",
  "g1-upsert-filter-created-identity",
  "g1-upsert-filter-unique-conflict",
  "g1-update-filter-missing-parent-source",
  "g1-literal-rebind-independent-arithmetic",
  "g1-captured-decimal-key-handoff",
] as const;

export const G2_KEY_CASE_IDS = [
  "g2-key-alt-locator",
  "g2-key-compound-final",
  "g2-key-arithmetic-final",
  "g2-key-null-final-refused",
  "g2-key-setnull-occupied-refused",
  "g2-key-null-old-empty",
  "g2-key-arithmetic-rollback",
] as const;

export const G2_SINGULAR_CASE_IDS = [
  "g2-child-disconnect-connect",
  "g2-parent-delete-create",
  "g2-parent-disconnect-connect",
  "g2-parent-connect-modify",
  "g2-child-create-modify",
  "g2-child-occupied-supply-modify",
  "g2-child-delete-connect",
  "g2-child-delete-connect-modify-refused",
  "g2-parent-delete-connect-refused",
  "g2-parent-create-modify-refused",
] as const;

export const G2_CAPTURED_KEY_CASE_IDS = [
  "g2-key-captured-missing-decoy",
  "g2-key-captured-replaced",
  "g2-key-captured-restored",
] as const;

export const G2_JUNCTION_CASE_IDS = [
  "g2-junction-singular-transfer",
  "g2-junction-supply-modify",
  "g2-junction-set-owned-refill",
  "g2-variant-junction-set-all",
  "g2-junction-disconnect-shared",
  "g2-junction-delete-shared",
  "g2-junction-exact-reconnect",
  "g2-junction-exact-set-refill",
  "g2-junction-key-reconnect",
  "g2-junction-key-transfer",
  "g2-variant-junction-empty-set",
  "g2-junction-inverse-delete-owner",
  "g2-junction-inverse-disconnect",
] as const;

export const G2_JUNCTION_IDENTITY_CASE_IDS = [
  "g2-junction-coc-captured-target-replaced",
  "g2-junction-coc-missing-create",
] as const;

export const G2_MEMBERSHIP_OWN_WRITE_CASE_IDS = [
  "g2-own-membership-connect",
  "g2-own-membership-disconnect",
  "g2-own-membership-later-connect",
  "g2-own-membership-shared-column",
] as const;

export const G2_MIXED_KEY_CASE_IDS = [
  "g2-key-junction-modify",
  "g2-key-junction-disconnect",
  "g2-key-adopt-coc-mixed",
  "g2-variant-key-transition",
] as const;

export const G2_VARIANT_REMOVAL_CASE_IDS = [
  "g2-variant-inverse-set-removal",
  "g2-variant-inverse-delete-owned",
  "g2-variant-inverse-delete-wrong-type",
  "g2-variant-direct-disconnect",
  "g2-variant-required-set-retain",
  "g2-variant-required-set-depart",
  "g2-variant-required-disconnect-refused",
] as const;

export const G2_SERIES_STALENESS_CASE_IDS = [
  "g2-series-captured-member-reparented",
  "g2-series-parent-reference-reused",
  "g2-series-filter-observation",
  "g2-series-captured-member-missing",
] as const;

export const G2_REQUIRED_CASE_IDS = [
  "g2-required-set-retain",
  "g2-required-set-depart",
  "g2-key-required-set",
  "g2-required-disconnect-refused",
] as const;

export const G2_OWN_WRITE_CASE_IDS = [
  "g2-own-coc-set-distinct",
  "g2-own-coc-set-same",
  "g2-own-delete-create",
  "g2-own-delete-update-refused",
  "g2-own-filter-write-refused",
  "g2-own-set-create",
  "g2-own-update-coc-refused",
  "g2-own-coc-found-filter-order",
  "g2-own-coc-missing-filter-order",
] as const;

export const G2_OCCUPIED_KEY_CASE_IDS = [
  "g2-nested-key-occupied-move-refused",
  "g2-nested-key-occupied-set-same",
  "g2-nested-key-occupied-increment-zero",
  "g2-nested-key-occupied-cascade",
] as const;

export const G2_SUPPLIER_CASE_IDS = [
  "g2-supplier-coc-found-modify",
  "g2-supplier-coc-missing-modify",
  "g2-supplier-modifier-unique-failure",
  "g2-supplier-wrapper-filter-miss",
  "g2-supplier-untaken-upsert",
] as const;

export const G2_LATTICE_CASE_IDS = [
  "g2-lattice-disconnect-delete",
  "g2-lattice-disconnect-update",
  "g2-lattice-disconnect-upsert",
  "g2-lattice-disconnect-coc",
  "g2-lattice-disconnect-connect",
  "g2-lattice-disconnect-create",
  "g2-lattice-delete-update",
  "g2-lattice-delete-upsert",
  "g2-lattice-delete-coc",
  "g2-lattice-delete-connect",
  "g2-lattice-delete-create",
  "g2-lattice-update-upsert",
  "g2-lattice-update-coc",
  "g2-lattice-update-connect",
  "g2-lattice-update-create",
  "g2-lattice-upsert-coc",
  "g2-lattice-upsert-connect",
  "g2-lattice-upsert-create",
  "g2-lattice-coc-connect",
  "g2-lattice-coc-create",
  "g2-lattice-connect-create",
  "g2-lattice-disconnect-connect-update",
  "g2-lattice-disconnect-coc-update",
  "g2-lattice-disconnect-create-update",
  "g2-lattice-delete-connect-update",
  "g2-lattice-delete-coc-update",
  "g2-lattice-delete-create-update",
  "g2-lattice-empty",
  "g2-lattice-inactive-false",
] as const;

export const G2_CONDITIONAL_UPSERT_CASE_IDS = [
  "g2-upsert-skip-replaced",
  "g2-upsert-skip-deleted",
  "g2-upsert-null-unknown",
  "g2-upsert-setwhere-skip",
  "g2-upsert-setwhere-match-replaced",
  "g2-upsert-conditions-match",
  "g2-upsert-conditions-missing-create",
] as const;

export const G2_SHARED_KEY_SUPPLIER_CASE_IDS = [
  "g2-shared-key-supplier-modify",
  "g2-shared-key-supplier-occupied",
] as const;

export const G25_CASE_IDS = [
  "g25-junction-coc-missing-reobserved",
  "g25-nested-upsert-member-lost",
  "g25-supplier-parent-fields",
] as const;

export const CS03_EXTENSION_CASE_IDS = [
  "cs03-extension-a",
  "cs03-extension-b",
  "cs03-extension-composition",
] as const;

export type ScenarioId =
  | "g1-generated-relations"
  | "g2-generated-transitions"
  | "cs03-peer-scope-root"
  | "cs03-peer-scope-nested"
  | "cs03-peer-scope-surrounding"
  | "cs03-peer-scope-static"
  | (typeof CS03_EXTENSION_CASE_IDS)[number]
  | (typeof G0_CASE_IDS)[number]
  | (typeof HARNESS_CASE_IDS)[number]
  | (typeof G1_CASE_IDS)[number]
  | (typeof G1_VARIANT_IDENTITY_CASE_IDS)[number]
  | (typeof G1_LIFETIME_CASE_IDS)[number]
  | (typeof G2_KEY_CASE_IDS)[number]
  | (typeof G2_SINGULAR_CASE_IDS)[number]
  | (typeof G2_CAPTURED_KEY_CASE_IDS)[number]
  | (typeof G2_JUNCTION_CASE_IDS)[number]
  | (typeof G2_JUNCTION_IDENTITY_CASE_IDS)[number]
  | (typeof G2_MEMBERSHIP_OWN_WRITE_CASE_IDS)[number]
  | (typeof G2_MIXED_KEY_CASE_IDS)[number]
  | (typeof G2_VARIANT_REMOVAL_CASE_IDS)[number]
  | (typeof G2_SERIES_STALENESS_CASE_IDS)[number]
  | (typeof G2_REQUIRED_CASE_IDS)[number]
  | (typeof G2_OWN_WRITE_CASE_IDS)[number]
  | (typeof G2_OCCUPIED_KEY_CASE_IDS)[number]
  | (typeof G2_LATTICE_CASE_IDS)[number]
  | (typeof G2_CONDITIONAL_UPSERT_CASE_IDS)[number]
  | (typeof G2_SHARED_KEY_SUPPLIER_CASE_IDS)[number]
  | (typeof G25_CASE_IDS)[number]
  | (typeof G2_SUPPLIER_CASE_IDS)[number];
