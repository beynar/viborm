import type { Dialect } from "@src/drivers";

export const TEST_LAYERS = [
  "validation",
  "scalars",
  "operation-schemas",
  "relations",
  "schema-validation",
  "schema-json",
  "query-engine",
  "adapters",
  "drivers",
  "client",
  "cache",
  "instrumentation",
  "migrations",
] as const;

export type TestLayer = (typeof TEST_LAYERS)[number];
export type TestTier = "core" | "extended";
export type ProviderCapability =
  | "sql-execution"
  | "transactions"
  | "atomic-batch"
  | "returning"
  | "ddl"
  | "vector";

export interface ContractDefinition<TFixture> {
  readonly id: string;
  readonly owningLayer: TestLayer;
  readonly tier: TestTier;
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly register: (fixture: TFixture) => void;
}

export function defineContract<
  const TDefinition extends ContractDefinition<never>,
>(definition: TDefinition): TDefinition {
  return definition;
}

export type ProviderAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface ProviderFixture<TDriver> {
  readonly id: string;
  readonly dialect: Dialect;
  readonly runtime: "node" | "bun" | "workerd" | "hosted-http";
  readonly capabilities: ReadonlySet<ProviderCapability>;
  readonly availability: () =>
    | ProviderAvailability
    | Promise<ProviderAvailability>;
  readonly createDriver: () => TDriver | Promise<TDriver>;
  readonly setup?: (driver: TDriver) => void | Promise<void>;
  readonly reset?: (driver: TDriver) => void | Promise<void>;
  readonly dispose: (driver: TDriver) => void | Promise<void>;
}

export interface ContractAssignment {
  readonly contractId: string;
  readonly providerId: string;
  readonly decision: "run" | "waive";
  readonly reason?: string;
}
