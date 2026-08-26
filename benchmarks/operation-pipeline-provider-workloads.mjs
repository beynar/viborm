/** Cross-provider workloads assembled through the public operation seam. */

import {
  benchmarkOperation,
  preparedWitness,
  rawCarrierConsumer,
} from "./operation-pipeline-harness.mjs";
import { createProviderFixture } from "./operation-pipeline-provider-fixtures.mjs";
import {
  assertSemanticDigest,
  freezeRawResult,
} from "./operation-pipeline-semantics.mjs";

const wideSelection = Object.freeze(
  Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `field${String(index + 1).padStart(3, "0")}`,
      true,
    ])
  )
);

function makeOperation(client, providerShape) {
  if (providerShape.kind === "wide-scalar") {
    return client.wide.findMany({ select: { id: true, ...wideSelection } });
  }
  if (providerShape.kind === "fixed-nested") {
    return client.parent.findMany({
      select: {
        id: true,
        children: { select: { id: true, label: true } },
      },
      orderBy: { id: "asc" },
      take: providerShape.rows,
    });
  }
  if (providerShape.kind === "variant-nested") {
    return client.comment.findMany({
      select: {
        id: true,
        subject: {
          select: {
            article: { id: true, title: true },
            clip: { id: true, title: true },
          },
        },
      },
      orderBy: { id: "asc" },
      take: providerShape.rows,
    });
  }
  if (providerShape.kind === "relation-count") {
    return client.parent.findMany({
      select: { id: true, _count: { select: { children: true } } },
      orderBy: { id: "asc" },
      take: providerShape.rows,
    });
  }
  if (providerShape.kind === "count") return client.record.count();
  if (providerShape.kind === "aggregate") {
    return client.record.aggregate({
      _count: true,
      _sum: { score: true },
    });
  }
  if (providerShape.kind === "returning") {
    return client.record.update({
      where: { id: "provider_record_00000" },
      data: { score: 1 },
      select: { id: true, score: true },
    });
  }
  const selection =
    providerShape.kind === "identity" || providerShape.kind === "execution"
      ? { id: true }
      : {
          id: true,
          label: true,
          score: true,
          enabled: true,
          big: true,
          amount: true,
          recordedAt: true,
          status: true,
          metadata: true,
          optionalText: true,
          payload: true,
        };
  return client.record.findMany({
    select: selection,
    orderBy: { score: "asc" },
    take: providerShape.rows,
  });
}

function consumeRaw(raw, providerShape) {
  if (providerShape.kind === "count") {
    const count = raw.rows[0]?.["0viborm_aggregate:count"];
    if (!(typeof count === "number" || typeof count === "string")) {
      throw new Error("Expected the private count carrier");
    }
    return Number(count);
  }
  if (providerShape.kind === "aggregate") {
    const count = raw.rows[0]?.["0viborm_aggregate:count"];
    if (!(typeof count === "number" || typeof count === "string")) {
      throw new Error("Expected the private aggregate carrier");
    }
    return Number(count);
  }
  if (
    providerShape.kind === "fixed-nested" ||
    providerShape.kind === "variant-nested"
  ) {
    return rawCarrierConsumer("Provider record")(raw.rows);
  }
  const id = raw.rows[0]?.id;
  if (typeof id !== "string") throw new Error("Expected a raw result id");
  return raw.rows.length + id.charCodeAt(0);
}

function consumeParsed(value, providerShape) {
  if (providerShape.kind === "count") {
    if (typeof value !== "number") throw new Error("Expected a public count");
    return value;
  }
  if (providerShape.kind === "aggregate") {
    const count = value?._count;
    const sum = value?._sum?.score;
    if (typeof count !== "number" || typeof sum !== "number") {
      throw new Error("Expected a public count and integer sum");
    }
    return count + sum;
  }
  if (providerShape.kind === "returning") {
    if (typeof value?.id !== "string" || typeof value?.score !== "number") {
      throw new Error("Expected one public returning row");
    }
    return value.id.charCodeAt(0) + value.score;
  }
  const rows = value;
  const first = rows[0];
  if (!first) return 0;
  if (providerShape.kind === "mixed-scalar") {
    if (
      typeof first.enabled !== "boolean" ||
      typeof first.score !== "number" ||
      typeof first.big !== "bigint" ||
      typeof first.amount !== "string" ||
      !(first.recordedAt instanceof Date) ||
      !["active", "inactive"].includes(first.status) ||
      first.metadata === null ||
      typeof first.metadata !== "object" ||
      !(
        first.optionalText === null || typeof first.optionalText === "string"
      ) ||
      !(first.payload instanceof Uint8Array)
    ) {
      throw new Error("Expected all mixed scalar result types");
    }
    return rows.length + first.score + Number(first.big % 97n);
  }
  if (providerShape.kind === "wide-scalar") {
    if (typeof first.field100 !== "string") {
      throw new Error("Expected the hundredth selected scalar");
    }
    return first.field100.length;
  }
  if (providerShape.kind === "fixed-nested") {
    const label = first.children?.[0]?.label;
    if (typeof label !== "string") {
      throw new Error("Expected one fixed nested child");
    }
    return rows.length + label.charCodeAt(0);
  }
  if (providerShape.kind === "variant-nested") {
    const title = first.subject?.data?.title;
    if (typeof title !== "string") {
      throw new Error("Expected one variant nested subject");
    }
    return rows.length + title.charCodeAt(0);
  }
  if (providerShape.kind === "relation-count") {
    const count = first._count?.children;
    if (typeof count !== "number") {
      throw new Error("Expected one public relation count");
    }
    return rows.length + count;
  }
  if (typeof first.id !== "string") throw new Error("Expected a public id");
  return rows.length + first.id.charCodeAt(0);
}

function publicOnlyWitness(providerName, workloadName, providerShape) {
  return {
    statementCount: 0,
    statements: [],
    workloadShape: {
      provider: providerName,
      workload: workloadName,
      providerShape,
      seam: "public-operation-only",
    },
  };
}

function executionFormSkip(driver, stage) {
  if (stage === "transaction" && !driver.supportsTransactions) {
    return `${driver.driverName} does not support callback transactions.`;
  }
  if (
    stage === "fallback-batch" &&
    !(driver.supportsTransactions && !driver.supportsBatch)
  ) {
    return `${driver.driverName} does not use transaction-backed batch fallback.`;
  }
  if (stage === "native-batch" && !driver.supportsBatch) {
    return `${driver.driverName} does not support native atomic batch execution.`;
  }
  return undefined;
}

function createExecutionHarness(
  workloadName,
  providerName,
  fixture,
  semanticFixture,
  prepared,
  statement,
  providerClient,
  stage,
  semanticDigest
) {
  const skipReason = executionFormSkip(fixture.driver, stage);
  if (skipReason) return { skipReason };
  const query = { sql: prepared.sql, params: prepared.params ?? [] };
  const consume = (raw) => consumeRaw(raw, { kind: "execution" });
  const harness = {
    witness: preparedWitness(prepared, {
      provider: providerName,
      workload: workloadName,
      kind: "execution-forms",
    }),
    semanticDigest,
    responseBytes: fixture.responseBytes,
    direct: async () =>
      consume(
        await fixture.driver.execute(providerClient, query.sql, query.params, {
          operation: "findMany",
        })
      ),
    prepared: async () =>
      consume(
        await fixture.driver._execute(statement, { operation: "findMany" })
      ),
    transaction: async () =>
      fixture.driver.withTransaction(async (transactionDriver) =>
        consume(
          await transactionDriver._execute(statement, {
            operation: "findMany",
          })
        )
      ),
    "fallback-batch": async () =>
      consume(
        (
          await fixture.driver._executeBatch([query], undefined, {
            operation: "findMany",
          })
        )[0]
      ),
    "native-batch": async () =>
      consume(
        (
          await fixture.driver._executeBatch([query], undefined, {
            operation: "findMany",
          })
        )[0]
      ),
  };
  return { fixture, semanticFixture, harness };
}

export async function createProviderWorkloadHarness(
  workloadName,
  providerName,
  targetDirectory,
  providerShape,
  stage
) {
  const fixture = await createProviderFixture(
    providerName,
    targetDirectory,
    providerShape
  );
  if (fixture.skipReason) return { skipReason: fixture.skipReason };
  const semanticFixture = await createProviderFixture(
    providerName,
    targetDirectory,
    providerShape
  );
  if (semanticFixture.skipReason) {
    await fixture.driver.disconnect();
    return { skipReason: semanticFixture.skipReason };
  }
  fixture.responseBytes?.activate?.();

  const preparedOperation = makeOperation(fixture.client, providerShape);
  const preparedCapability = benchmarkOperation(preparedOperation);
  const prepared = preparedCapability.prepare();
  const statement = preparedOperation.buildStatement();
  const fullSemantic = await makeOperation(
    semanticFixture.client,
    providerShape
  );

  if (!(prepared && statement)) {
    if (stage !== "full") {
      await fixture.driver.disconnect();
      await semanticFixture.driver.disconnect();
      return {
        skipReason: `${providerName} exposes no honest single-statement ${stage} seam for ${providerShape.kind}.`,
      };
    }
    const fixtureSemantic = await makeOperation(fixture.client, providerShape);
    const semanticDigest = assertSemanticDigest(
      `${providerName} public operation pair`,
      fixtureSemantic,
      fullSemantic
    );
    fixture.responseBytes?.reset();
    return {
      fixture,
      semanticFixture,
      harness: {
        witness: publicOnlyWitness(providerName, workloadName, providerShape),
        semanticDigest,
        responseBytes: fixture.responseBytes,
        full: async () =>
          consumeParsed(
            await makeOperation(fixture.client, providerShape),
            providerShape
          ),
      },
    };
  }

  await fixture.driver._connect({ operation: "findMany" });
  const providerClient = fixture.driver.client;
  if (!providerClient) throw new Error("Provider client was not initialized");
  const rawFixture = freezeRawResult(
    await fixture.driver.execute(
      providerClient,
      prepared.sql,
      prepared.params ?? [],
      { operation: "findMany" }
    )
  );
  const parsedFixture = preparedCapability.parseResult(rawFixture);
  consumeParsed(parsedFixture, providerShape);
  consumeParsed(fullSemantic, providerShape);
  const semanticDigest = assertSemanticDigest(
    `${providerName} provider parse versus public operation`,
    parsedFixture,
    fullSemantic
  );
  fixture.responseBytes?.reset();

  if (providerShape.kind === "execution") {
    return createExecutionHarness(
      workloadName,
      providerName,
      fixture,
      semanticFixture,
      prepared,
      statement,
      providerClient,
      stage,
      semanticDigest
    );
  }

  const harness = {
    witness: preparedWitness(prepared, {
      provider: providerName,
      workload: workloadName,
      providerShape,
    }),
    semanticDigest,
    responseBytes: fixture.responseBytes,
    "provider-execute": async () =>
      consumeRaw(
        await fixture.driver.execute(
          providerClient,
          prepared.sql,
          prepared.params ?? [],
          { operation: "findMany" }
        ),
        providerShape
      ),
    "driver-wrapper": async () =>
      consumeRaw(
        await fixture.driver._execute(statement, { operation: "findMany" }),
        providerShape
      ),
    "unowned-parse": () =>
      consumeParsed(preparedCapability.parseResult(rawFixture), providerShape),
    "provider-parse": async () => {
      const raw = await fixture.driver.execute(
        providerClient,
        prepared.sql,
        prepared.params ?? [],
        { operation: "findMany" }
      );
      return consumeParsed(preparedCapability.parseResult(raw), providerShape);
    },
    full: async () =>
      consumeParsed(
        await makeOperation(fixture.client, providerShape),
        providerShape
      ),
  };
  return { fixture, semanticFixture, harness };
}
