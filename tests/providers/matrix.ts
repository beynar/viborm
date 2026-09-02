import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractAssignment } from "@tests/contracts/contract";
import { DRIVER_CONTRACT_IDS } from "@tests/contracts/drivers/contract-ids";

type DriverContractName = keyof typeof DRIVER_CONTRACT_IDS;

export interface ProviderDefinition {
  readonly id: string;
  readonly sourceFiles: readonly string[];
  readonly availability:
    | "always"
    | "bun"
    | "docker-postgres"
    | "docker-mysql"
    | "neon-credentials"
    | "planetscale-credentials"
    | "workerd";
  readonly waiverReason: string;
}

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);

/**
 * Every suite belonging to one provider, read FROM DISK by filename prefix.
 *
 * These were hardcoded paths. When the heaviest provider suites were split so
 * each piece could typecheck under the 1280 MB shard heap, a hardcoded list
 * would still have named only the original file, and the contract census would
 * have stopped seeing the registrations that moved into the pieces. Deriving
 * them keeps the census honest as the estate is resharded.
 */
function providerSources(directory: string, prefix: string): string[] {
  const relative = `tests/providers/${directory}`;
  return readdirSync(resolve(repositoryRoot, relative))
    .filter(
      (file) =>
        file.endsWith(".test.ts") &&
        (file === `${prefix}.test.ts` || file.startsWith(`${prefix}-`))
    )
    .sort()
    .map((file) => `${relative}/${file}`);
}

export const PROVIDERS = [
  {
    id: "pglite",
    sourceFiles: providerSources("local", "pglite"),
    availability: "always",
    waiverReason:
      "The PGlite fixture does not provide the isolation or dialect feature required by this contract.",
  },
  {
    id: "sqlite3",
    sourceFiles: providerSources("local", "sqlite3"),
    availability: "always",
    waiverReason:
      "The SQLite3 fixture does not provide the isolation or dialect feature required by this contract.",
  },
  {
    id: "libsql",
    sourceFiles: providerSources("local", "libsql"),
    availability: "always",
    waiverReason:
      "The LibSQL fixture does not provide the isolation or dialect feature required by this contract.",
  },
  {
    id: "pg",
    sourceFiles: providerSources("docker", "pg"),
    availability: "docker-postgres",
    waiverReason:
      "The pg provider suite delegates this invariant to another PostgreSQL fixture or needs an unsupported fixture mode.",
  },
  {
    id: "postgres",
    sourceFiles: providerSources("docker", "postgres"),
    availability: "docker-postgres",
    waiverReason:
      "The postgres.js provider suite delegates this invariant to the canonical PostgreSQL fixture.",
  },
  {
    id: "mysql2",
    sourceFiles: providerSources("docker", "mysql2"),
    availability: "docker-mysql",
    waiverReason:
      "The MySQL fixture does not provide the dialect feature required by this contract.",
  },
  {
    id: "d1",
    sourceFiles: ["tests/providers/workers/d1.test.ts"],
    availability: "workerd",
    waiverReason:
      "The workerd fixture runs focused D1-specific provider witnesses, including fixed-decimal scalar/list exactness, but shared schema contracts still need migration-driven fixture setup.",
  },
  {
    id: "neon-http",
    sourceFiles: ["tests/providers/hosted/neon-http.test.ts"],
    availability: "always",
    waiverReason:
      "A deterministic SDK/fetch fixture proves the real Neon response decoder and typed fixed-decimal scalar/list materialization; PostgreSQL SQL semantics remain owned by the shared PostgreSQL contracts, while NEON_TEST_DATABASE_URL is only an optional connectivity leg.",
  },
  {
    id: "planetscale",
    sourceFiles: ["tests/providers/hosted/planetscale.test.ts"],
    availability: "planetscale-credentials",
    waiverReason:
      "The dedicated PlanetScale decimal leg runs only with URL, explicit namespace, and a pre-provisioned read-only marker fixture; the shared contract remains waived because D8 forbids its effectful VibORM DDL setup.",
  },
  {
    id: "bun-sql",
    sourceFiles: ["tests/providers/platform/bun-sql-runtime.test.ts"],
    availability: "bun",
    waiverReason:
      "The real Bun runtime probe proves fixed-decimal scalar/list transport, filter/order, arithmetic, and aggregates when PG_TEST_CONNECTION_STRING names the PostgreSQL substrate; the shared contract registration remains waived because the standalone probe owns its isolated schema lifecycle.",
  },
  {
    id: "bun-sqlite",
    sourceFiles: ["tests/providers/platform/bun-sqlite-runtime.test.ts"],
    availability: "bun",
    waiverReason:
      "The real Bun runtime probe proves fixed-decimal scalar/list transport, filter/order, arithmetic, and aggregates; the shared contract registration remains waived because Vitest cannot import bun:sqlite and the standalone probe owns its fixture lifecycle.",
  },
] as const satisfies readonly ProviderDefinition[];

export type ProviderId = (typeof PROVIDERS)[number]["id"];

const PROVIDER_RUNS = {
  pglite: [
    "batchPrimaryKeyDataflowContract",
    "batchRefSmokeContract",
    "blobFilterContract",
    "bulkWriteLimitContract",
    "clientRawContract",
    "compoundKeyContract",
    "countAggregateWindowContract",
    "createManyReturnFoldContract",
    "cursorPaginationContract",
    "decimalExactnessContract",
    "distinctSkipWindowContract",
    "fieldReferenceContract",
    "fkIndexContract",
    "fkIndexPlanContract",
    "fkIndexUpgradeContract",
    "forwardFkOrderingContract",
    "fullScalarRoundtripContract",
    "implicitReturningContract",
    "jsonNullSentinelContract",
    "likeEscapeContract",
    "listJsonFilterContract",
    "manyToManyContract",
    "mappedIndexContract",
    "nestedOrderByContract",
    "nestedPaginationContract",
    "nestedWriteAdvancedContract",
    "nestedWriteContract",
    "nestedWriteJsonEnvelopeContract",
    "omitContract",
    "optionalRelationParityContract",
    "orderingArrayCreateContract",
    "orderingPlanContract",
    "partialIndexCoverageContract",
    "partialIndexPredicateChurnContract",
    "polymorphicCollectionReadContract",
    "polymorphicCollectionWriteContract",
    "polymorphicRelationContract",
    "prismaParityContract",
    "readPathRegressionContract",
    "relationFilterMutationContract",
    "relationReadAggregateContract",
    "scalarRoundtripContract",
    "upsertAtomicityContract",
    "vectorContract",
  ],
  sqlite3: [
    "batchPrimaryKeyDataflowContract",
    "batchRefSmokeContract",
    "blobFilterContract",
    "bulkWriteLimitContract",
    "clientRawContract",
    "compoundJunctionContract",
    "compoundKeyContract",
    "countAggregateWindowContract",
    "createManyReturnFoldContract",
    "cursorPaginationContract",
    "decimalExactnessContract",
    "distinctSkipWindowContract",
    "fieldReferenceContract",
    "fkIndexContract",
    "fkIndexPlanContract",
    "fkIndexUpgradeContract",
    "forwardFkOrderingContract",
    "fullScalarRoundtripContract",
    "geoPointBatchContract",
    "geoPointContract",
    "implicitReturningContract",
    "jsonNullSentinelContract",
    "likeEscapeContract",
    "listJsonFilterContract",
    "manyToManyContract",
    "mappedIndexContract",
    "nestedOrderByContract",
    "nestedPaginationContract",
    "nestedWriteAdvancedContract",
    "nestedWriteContract",
    "nestedWriteJsonEnvelopeContract",
    "omitContract",
    "optionalRelationParityContract",
    "orderingArrayCreateContract",
    "orderingPlanContract",
    "partialIndexContract",
    "partialIndexCoverageContract",
    "polymorphicCollectionReadContract",
    "polymorphicCollectionWriteContract",
    "polymorphicMemberJunctionContract",
    "polymorphicRelationContract",
    "prismaParityContract",
    "readPathRegressionContract",
    "relationFilterMutationContract",
    "relationReadAggregateContract",
    "scalarRoundtripContract",
    "upsertAtomicityContract",
  ],
  libsql: [
    "batchPrimaryKeyDataflowContract",
    "blobFilterContract",
    "bulkWriteLimitContract",
    "clientRawContract",
    "compoundKeyContract",
    "countAggregateWindowContract",
    "createManyReturnFoldContract",
    "cursorPaginationContract",
    "decimalExactnessContract",
    "distinctSkipWindowContract",
    "fieldReferenceContract",
    "fkIndexContract",
    "fkIndexUpgradeContract",
    "forwardFkOrderingContract",
    "fullScalarRoundtripContract",
    "geoPointBatchContract",
    "geoPointContract",
    "implicitReturningContract",
    "jsonNullSentinelContract",
    "likeEscapeContract",
    "listJsonFilterContract",
    "manyToManyContract",
    "mappedIndexContract",
    "nestedOrderByContract",
    "nestedPaginationContract",
    "nestedWriteAdvancedContract",
    "nestedWriteContract",
    "omitContract",
    "optionalRelationParityContract",
    "orderingArrayCreateContract",
    "partialIndexContract",
    "partialIndexCoverageContract",
    "polymorphicRelationContract",
    "prismaParityContract",
    "readPathRegressionContract",
    "relationFilterMutationContract",
    "relationReadAggregateContract",
    "scalarRoundtripContract",
    "upsertAtomicityContract",
  ],
  pg: [
    "batchPrimaryKeyDataflowContract",
    "blobFilterContract",
    "bulkWriteLimitContract",
    "clientRawContract",
    "compoundJunctionContract",
    "createManyReturnFoldContract",
    "decimalExactnessContract",
    "fieldReferenceContract",
    "fkIndexContract",
    "forwardFkOrderingContract",
    "fullScalarRoundtripContract",
    "geoPointContract",
    "geoPointMigrationLifecycleContract",
    "geoPointPostgresIndexContract",
    "jsonNullSentinelContract",
    "listJsonFilterContract",
    "m2mDeleteManyStalenessContract",
    "mappedIndexContract",
    "nestedOrderByContract",
    "nestedWriteAdvancedContract",
    "nestedWriteConcurrencyContract",
    "nestedWriteContract",
    "omitContract",
    "partialIndexPredicateChurnContract",
    "polymorphicCollectionReadContract",
    "polymorphicCollectionWriteContract",
    "polymorphicMemberJunctionContract",
    "polymorphicRelationContract",
    "rawArrayTransactionContract",
    "relationReadAggregateContract",
    "scalarRoundtripContract",
    "upsertAtomicityContract",
    "vectorContract",
  ],
  postgres: [
    "blobFilterContract",
    "bulkWriteLimitContract",
    "clientRawContract",
    "decimalExactnessContract",
    "fieldReferenceContract",
    "fullScalarRoundtripContract",
    "geoPointContract",
    "geoPointPostgresIndexContract",
    "listJsonFilterContract",
    "nestedOrderByContract",
    "nestedWriteAdvancedContract",
    "nestedWriteContract",
    "omitContract",
    "relationReadAggregateContract",
    "scalarRoundtripContract",
    "vectorContract",
  ],
  mysql2: [
    "blobFilterContract",
    "bulkWriteLimitContract",
    "clientRawContract",
    "compoundJunctionContract",
    "compoundKeyContract",
    "countAggregateWindowContract",
    "createManyReturnFoldContract",
    "cursorPaginationContract",
    "decimalExactnessContract",
    "distinctSkipWindowContract",
    "fieldReferenceContract",
    "fkIndexContract",
    "forwardFkOrderingContract",
    "fullScalarRoundtripContract",
    "geoPointContract",
    "geoPointMigrationLifecycleContract",
    "implicitReturningContract",
    "jsonNullSentinelContract",
    "likeEscapeContract",
    "listJsonFilterContract",
    "manyToManyContract",
    "mappedIndexContract",
    "nestedOrderByContract",
    "nestedWriteAdvancedContract",
    "nestedWriteConcurrencyContract",
    "nestedWriteContract",
    "nonReturningMutationAtomicityContract",
    "omitContract",
    "optionalRelationParityContract",
    "orderingArrayCreateContract",
    "partialIndexRefusalContract",
    "polymorphicCollectionReadContract",
    "polymorphicCollectionWriteContract",
    "polymorphicMemberJunctionContract",
    "polymorphicRelationContract",
    "prismaParityContract",
    "rawArrayTransactionContract",
    "readPathRegressionContract",
    "relationFilterMutationContract",
    "relationReadAggregateContract",
    "scalarRoundtripContract",
    "upsertAtomicityContract",
  ],
  d1: ["geoPointBatchContract", "geoPointContract"],
  "neon-http": [],
  planetscale: [],
  "bun-sql": [],
  "bun-sqlite": [],
} as const satisfies Record<ProviderId, readonly DriverContractName[]>;

function runAssignment(
  contractId: string,
  providerId: ProviderId
): ContractAssignment {
  return { contractId, providerId, decision: "run" };
}

function waivedAssignment(
  contractId: string,
  providerId: ProviderId,
  reason: string
): ContractAssignment {
  return { contractId, providerId, decision: "waive", reason };
}

export const CONTRACT_ASSIGNMENTS: readonly ContractAssignment[] =
  PROVIDERS.flatMap((provider) => {
    const runContracts = new Set(
      PROVIDER_RUNS[provider.id].map(
        (contractName) => DRIVER_CONTRACT_IDS[contractName]
      )
    );
    return Object.values(DRIVER_CONTRACT_IDS).map((contractId) =>
      runContracts.has(contractId)
        ? runAssignment(contractId, provider.id)
        : waivedAssignment(contractId, provider.id, provider.waiverReason)
    );
  });
