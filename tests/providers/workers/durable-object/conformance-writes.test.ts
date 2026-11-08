/**
 * The driver contracts sqlite3 runs, registered against the Durable Object
 * driver: nested writes, junctions, upserts, bulk writes, JSON, raw array
 * transactions. Each test runs in a fresh object (`harness.ts`).
 */
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { rawArrayTransactionContract } from "@tests/contracts/drivers/behaviors/raw-array-transaction-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { durableObjectDriver } from "./harness";

const fixture = {
  driverName: "Durable Object",
  createDriver: durableObjectDriver,
};

nestedWriteContract.register(fixture);
nestedWriteAdvancedContract.register(fixture);
nestedWriteJsonEnvelopeContract.register(fixture);
compoundKeyContract.register(fixture);
compoundJunctionContract.register(fixture);
polymorphicMemberJunctionContract.register(fixture);
manyToManyContract.register(fixture);
prismaParityContract.register(fixture);
optionalRelationParityContract.register(fixture);
upsertAtomicityContract.register(fixture);
relationFilterMutationContract.register(fixture);
orderingArrayCreateContract.register(fixture);
implicitReturningContract.register(fixture);
createManyReturnFoldContract.register(fixture);
bulkWriteLimitContract.register(fixture);
listJsonFilterContract.register(fixture);
jsonNullSentinelContract.register(fixture);
rawArrayTransactionContract.register({
  name: fixture.driverName,
  createDriver: durableObjectDriver,
});
