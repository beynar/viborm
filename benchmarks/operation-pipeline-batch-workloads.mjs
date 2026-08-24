/** Atomic batch and implicit-returning bulk workload construction. */

import {
  batchWitness,
  consumeScalarRows,
  prepareOperationPlan,
  witnessChecksum,
} from "./operation-pipeline-harness.mjs";
import {
  assertSemanticDigest,
  freezeRawResults,
} from "./operation-pipeline-semantics.mjs";

export async function buildBatchWorkload(name, fixture, fullFixture) {
  const { client } = fixture;
  const sequences = new WeakMap();
  const nextSequence = (targetClient) => {
    const current = sequences.get(targetClient) ?? 0;
    sequences.set(targetClient, current + 1);
    return current;
  };
  if (name.startsWith("atomic-batch-")) {
    return createAtomicBatchHarness(
      fixture,
      fullFixture,
      Number(name.slice(13))
    );
  }
  if (name === "bulk-create-returning-100") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.user.createMany({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: `bulk_create_${current}_${index}`,
          name: `Bulk ${index}`,
          email: `bulk_${current}_${index}@example.com`,
          age: index,
        })),
        select: { id: true, age: true },
      });
    };
    return createPreparedBatchHarness(
      fixture,
      fullFixture,
      makeOperation,
      (rows) => consumeScalarRows(rows, "age")
    );
  }
  if (name === "bulk-update-returning-100") {
    const ids = Array.from({ length: 100 }, (_, index) => `user_${index}`);
    const makeOperation = (targetClient = client) =>
      targetClient.user.updateMany({
        where: { id: { in: ids } },
        data: { age: { increment: 1 } },
        select: { id: true, age: true },
      });
    return createPreparedBatchHarness(
      fixture,
      fullFixture,
      makeOperation,
      (rows) => consumeScalarRows(rows, "age")
    );
  }
  if (name === "variant-row-storage-create-many-100") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.comment.createMany({
        data: Array.from({ length: 100 }, (_, index) => {
          const type = index % 2 === 0 ? "article" : "clip";
          return {
            id: `bulk_variant_${current}_${index}`,
            body: `Bulk variant ${index}`,
            subject: {
              connect: { type, where: { id: `${type}_${index}` } },
            },
          };
        }),
      });
    };
    return createVariantRowStorageHarness(fixture, fullFixture, makeOperation);
  }
  return undefined;
}

async function createVariantRowStorageHarness(
  fixture,
  fullFixture,
  makeOperation
) {
  const readPostState = (targetClient) =>
    targetClient.comment.findMany({
      where: { id: { startsWith: "bulk_variant_0_" } },
      select: {
        id: true,
        body: true,
        subject: {
          article: { select: { id: true, title: true } },
          clip: { select: { id: true, title: true } },
        },
      },
      orderBy: { id: "asc" },
      take: 100,
    });
  const validatePostState = (rows) => {
    if (rows.length !== 100) {
      throw new Error(
        "Variant row-storage createMany did not persist 100 rows"
      );
    }
    for (const row of rows) {
      const index = Number(row.id.slice("bulk_variant_0_".length));
      const type = index % 2 === 0 ? "article" : "clip";
      if (row.subject?.data?.id !== `${type}_${index}`) {
        throw new Error(
          "Variant row-storage createMany did not persist its per-row target"
        );
      }
    }
  };
  const semanticValue = await makeOperation(fixture.client);
  const semanticPostState = await readPostState(fixture.client);
  validatePostState(semanticPostState);
  const fullValue = await makeOperation(fullFixture.client);
  const fullPostState = await readPostState(fullFixture.client);
  validatePostState(fullPostState);
  return {
    witness: {
      statementCount: null,
      statements: [],
      unavailable:
        "The public preparation seams decline this relation-bearing createMany operation.",
    },
    semanticDigest: assertSemanticDigest(
      "variant row-storage createMany result and post-state across fresh fixtures",
      { result: semanticValue, postState: semanticPostState },
      { result: fullValue, postState: fullPostState }
    ),
    full: async () => {
      const value = await makeOperation(fixture.client);
      if (typeof value.count !== "number") {
        throw new Error("Expected a createMany count");
      }
      return value.count;
    },
  };
}

async function createPreparedBatchHarness(
  fixture,
  fullFixture,
  makeOperation,
  parsedConsumer
) {
  const fixtureOperation = makeOperation(fixture.client);
  const fixturePlan = await prepareOperationPlan(
    fixtureOperation,
    fixture.driver
  );
  const rawFixture = freezeRawResults(
    await fixture.driver._executeBatch(fixturePlan.queries)
  );
  const parsedFixture = fixturePlan.parseResult(rawFixture);
  parsedConsumer(parsedFixture);
  const fullSemantic = await makeOperation(fullFixture.client);
  parsedConsumer(fullSemantic);
  const digest = assertSemanticDigest(
    "prepared batch versus public full",
    parsedFixture,
    fullSemantic
  );
  const witness = batchWitness(fixturePlan.queries);
  return {
    witness,
    semanticDigest: digest,
    prepare: async () => {
      const plan = await prepareOperationPlan(makeOperation(), fixture.driver);
      return witnessChecksum(batchWitness(plan.queries));
    },
    parse: () => parsedConsumer(fixturePlan.parseResult(rawFixture)),
    full: async () => parsedConsumer(await makeOperation()),
  };
}

async function createAtomicBatchHarness(fixture, fullFixture, count) {
  if (fixture.driver.supportsTransactions || !fixture.driver.supportsBatch) {
    throw new Error("Atomic workload requires the forced batch-only substrate");
  }
  const makeOperations = (targetClient = fixture.client) =>
    Array.from({ length: count }, (_, index) =>
      targetClient.user.findUnique({
        where: { id: `user_${index % 1000}` },
        select: { id: true, age: true },
      })
    );
  const prepareEntries = () =>
    makeOperations().map((operation) => {
      const prepared = operation.prepare();
      if (!prepared)
        throw new Error("Atomic read batch member did not prepare");
      return { operation, prepared };
    });
  const entries = prepareEntries();
  const queries = entries.map((entry) => entry.prepared);
  const witness = batchWitness(queries);
  const consumeRows = (rows) => {
    let checksum = rows.length;
    for (const row of rows) {
      if (!row) continue;
      const age = row.age;
      if (typeof age !== "number") {
        throw new Error("Expected an age from each atomic batch member");
      }
      checksum += age;
    }
    return checksum;
  };
  const semanticRaw = await fixture.driver._executeBatch(queries);
  const semanticRows = entries.map((entry, index) =>
    entry.operation.parseResult(semanticRaw[index])
  );
  consumeRows(semanticRows);
  const fullSemantic = await fullFixture.client.$transaction(
    makeOperations(fullFixture.client)
  );
  consumeRows(fullSemantic);
  const digest = assertSemanticDigest(
    "prepared atomic batch versus public full",
    semanticRows,
    fullSemantic
  );
  return {
    witness,
    semanticDigest: digest,
    prepare: () =>
      witnessChecksum(
        batchWitness(prepareEntries().map((entry) => entry.prepared))
      ),
    execute: async () => {
      const raw = await fixture.driver._executeBatch(queries);
      return consumeRows(raw.map((entry) => entry.rows[0]));
    },
    full: async () =>
      consumeRows(await fixture.client.$transaction(makeOperations())),
  };
}
