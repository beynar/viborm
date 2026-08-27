import type {
  ProviderCapability,
  TestLayer,
  TestTier,
} from "@tests/contracts/contract";

export interface TestInventoryRecord {
  readonly file: string;
  readonly owningLayer: TestLayer;
  readonly tier: TestTier;
  readonly boundary: "unit" | "types" | "contract" | "provider" | "package";
  readonly requiredCapabilities: readonly ProviderCapability[];
}

const unitOwners: ReadonlyArray<{ prefix: string; layer: TestLayer }> = [
  { prefix: "tests/unit/validation/", layer: "validation" },
  { prefix: "tests/unit/scalars/", layer: "scalars" },
  {
    prefix: "tests/unit/operation-schemas/",
    layer: "operation-schemas",
  },
  { prefix: "tests/unit/relations/", layer: "relations" },
  {
    prefix: "tests/unit/schema-validation/",
    layer: "schema-validation",
  },
  { prefix: "tests/unit/schema-json/", layer: "schema-json" },
  { prefix: "tests/unit/cache/", layer: "cache" },
  { prefix: "tests/unit/instrumentation/", layer: "instrumentation" },
  { prefix: "tests/unit/migrations/", layer: "migrations" },
];

const contractOwners: ReadonlyArray<{ prefix: string; layer: TestLayer }> = [
  { prefix: "tests/contracts/architecture/", layer: "query-engine" },
  { prefix: "tests/contracts/engine/", layer: "query-engine" },
  { prefix: "tests/contracts/adapters/", layer: "adapters" },
  { prefix: "tests/contracts/drivers/", layer: "drivers" },
  { prefix: "tests/contracts/public-client/", layer: "client" },
];

function typeLayer(file: string): TestLayer | undefined {
  const layerName = file.split("/")[2];
  switch (layerName) {
    case "validation":
    case "scalars":
    case "operation-schemas":
    case "relations":
    case "schema-validation":
    case "schema-json":
    case "query-engine":
    case "adapters":
    case "drivers":
    case "client":
    case "cache":
    case "instrumentation":
    case "migrations":
      return layerName;
    default:
      return undefined;
  }
}

export function classifyTestFile(
  file: string
): TestInventoryRecord | undefined {
  const tier: TestTier = file.includes(".core.") ? "core" : "extended";
  const unitOwner = unitOwners.find(({ prefix }) => file.startsWith(prefix));
  if (unitOwner) {
    return {
      file,
      owningLayer: unitOwner.layer,
      tier,
      boundary: "unit",
      requiredCapabilities: [],
    };
  }

  if (file.startsWith("tests/types/")) {
    const owningLayer = typeLayer(file);
    if (!owningLayer) return undefined;
    return {
      file,
      owningLayer,
      tier,
      boundary: "types",
      requiredCapabilities: [],
    };
  }

  const contractOwner = contractOwners.find(({ prefix }) =>
    file.startsWith(prefix)
  );
  if (contractOwner) {
    return {
      file,
      owningLayer: contractOwner.layer,
      tier,
      boundary: "contract",
      requiredCapabilities: [],
    };
  }

  if (file.startsWith("tests/providers/")) {
    return {
      file,
      owningLayer: "drivers",
      tier,
      boundary: "provider",
      requiredCapabilities: file.includes("/workers/")
        ? ["sql-execution", "atomic-batch"]
        : ["sql-execution"],
    };
  }

  if (file.startsWith("tests/package/")) {
    return {
      file,
      owningLayer: file.includes("otel") ? "instrumentation" : "client",
      tier,
      boundary: "package",
      requiredCapabilities: [],
    };
  }

  return undefined;
}
