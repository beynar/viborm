/** Cross-provider workloads assembled through the public operation seam. */

import {
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
const FIXED_DECIMAL_LIST_EXPECTED = Object.freeze(["1.125", "2.125", "-0.375"]);

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
  if (providerShape.kind === "fixed-decimal-arithmetic") {
    return client.record.update({
      where: { id: "provider_record_00000" },
      data: { amount: { multiply: "1" } },
      select: { id: true, amount: true },
    });
  }
  if (providerShape.kind === "fixed-decimal-aggregate") {
    return client.record.aggregate({
      _min: { amount: true },
      _max: { amount: true },
      _sum: { amount: true },
      _avg: { amount: true },
    });
  }
  if (providerShape.kind === "fixed-decimal-list") {
    return client.record.findMany({
      select: { id: true, amounts: true },
      orderBy: { id: "asc" },
      take: providerShape.rows,
    });
  }
  if (providerShape.kind === "fixed-decimal-row") {
    return client.record.findMany({
      select: { id: true, amount: true },
      orderBy: { id: "asc" },
      take: providerShape.rows,
    });
  }
  if (providerShape.kind === "fixed-decimal-floor") {
    return client.record.findMany({
      select: { amount: true },
      take: 1,
    });
  }
  if (providerShape.kind === "fixed-decimal-text-row") {
    return client.record.findMany({
      select: { id: true, amount: true },
      orderBy: { id: "asc" },
      take: providerShape.rows,
    });
  }
  const selection =
    providerShape.kind === "identity" || providerShape.kind === "execution"
      ? { id: true }
      : providerShape.kind === "fixed-decimal-scalar-control"
        ? {
            id: true,
            label: true,
            score: true,
            enabled: true,
            big: true,
            recordedAt: true,
            status: true,
            metadata: true,
            optionalText: true,
            payload: true,
          }
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

function decimalValue(value, Decimal, expected, verifyExact) {
  if (
    typeof Decimal !== "function" ||
    !(value instanceof Decimal) ||
    (verifyExact && expected !== undefined && !value.eq(expected))
  ) {
    throw new Error(
      expected === undefined
        ? "Expected a public Decimal value"
        : `Expected public Decimal value ${expected}`
    );
  }
  return value;
}

function aggregateCoefficient(rowCount) {
  const count = BigInt(rowCount);
  return ((count * (count + 1n)) / 2n) * 1000n + count * 125n;
}

function coefficientText(coefficient, scale = 3) {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

function consumeParsed(value, providerShape, Decimal, verifyExact = false) {
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
  if (providerShape.kind === "fixed-decimal-arithmetic") {
    if (typeof value?.id !== "string") {
      throw new Error("Expected one decimal arithmetic row");
    }
    const amount = decimalValue(value.amount, Decimal, "1.125", verifyExact);
    return value.id.charCodeAt(0) + amount.toNumber();
  }
  if (providerShape.kind === "fixed-decimal-aggregate") {
    const rowCount = providerShape.sourceRows;
    const minimum = decimalValue(
      value?._min?.amount,
      Decimal,
      "1.125",
      verifyExact
    );
    const maximum = decimalValue(
      value?._max?.amount,
      Decimal,
      verifyExact ? `${rowCount}.125` : undefined,
      verifyExact
    );
    const sum = decimalValue(
      value?._sum?.amount,
      Decimal,
      verifyExact ? coefficientText(aggregateCoefficient(rowCount)) : undefined,
      verifyExact
    );
    const average = decimalValue(
      value?._avg?.amount,
      Decimal,
      verifyExact
        ? coefficientText(aggregateCoefficient(rowCount) / BigInt(rowCount))
        : undefined,
      verifyExact
    );
    return (
      minimum.toNumber() +
      maximum.toNumber() +
      sum.toNumber() +
      average.toNumber()
    );
  }
  const rows = value;
  const first = rows[0];
  if (!first) return 0;
  if (providerShape.kind === "fixed-decimal-row") {
    const last = rows.at(-1);
    if (!last) throw new Error("Expected the final decimal row");
    const firstAmount = decimalValue(first.amount, Decimal);
    const lastAmount = decimalValue(last.amount, Decimal);
    if (verifyExact) {
      for (let index = 0; index < rows.length; index++) {
        decimalValue(rows[index].amount, Decimal, `${index + 1}.125`, true);
      }
    }
    return rows.length + firstAmount.toNumber() + lastAmount.toNumber();
  }
  if (providerShape.kind === "fixed-decimal-text-row") {
    const last = rows.at(-1);
    if (typeof first.amount !== "string" || typeof last?.amount !== "string") {
      throw new Error("Expected exact text control values");
    }
    if (verifyExact) {
      for (let index = 0; index < rows.length; index++) {
        if (rows[index].amount !== `${index + 1}.125`) {
          throw new Error(`Expected exact text control value ${index + 1}.125`);
        }
      }
    }
    return rows.length + first.amount.length + last.amount.length;
  }
  if (providerShape.kind === "fixed-decimal-list") {
    if (!Array.isArray(first.amounts) || first.amounts.length !== 3) {
      throw new Error("Expected one public fixed-decimal list");
    }
    let checksum = rows.length;
    for (let index = 0; index < FIXED_DECIMAL_LIST_EXPECTED.length; index++) {
      checksum += decimalValue(
        first.amounts[index],
        Decimal,
        FIXED_DECIMAL_LIST_EXPECTED[index],
        verifyExact
      ).toNumber();
    }
    return checksum;
  }
  if (providerShape.kind === "mixed-scalar") {
    if (
      typeof first.enabled !== "boolean" ||
      typeof first.score !== "number" ||
      typeof first.big !== "bigint" ||
      typeof Decimal !== "function" ||
      !(first.amount instanceof Decimal) ||
      (verifyExact && !first.amount.eq("1.125")) ||
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
  if (providerShape.kind === "fixed-decimal-scalar-control") {
    if (
      typeof first.enabled !== "boolean" ||
      typeof first.score !== "number" ||
      typeof first.big !== "bigint" ||
      !(first.recordedAt instanceof Date) ||
      !["active", "inactive"].includes(first.status) ||
      first.metadata === null ||
      typeof first.metadata !== "object" ||
      !(
        first.optionalText === null || typeof first.optionalText === "string"
      ) ||
      !(first.payload instanceof Uint8Array) ||
      Object.hasOwn(first, "amount")
    ) {
      throw new Error("Expected the non-decimal scalar control result types");
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

/** Retain the exact public graph whose semantic checksum the timed arm consumes. */
export function consumeAndRetainFixedDecimalResult(
  value,
  providerShape,
  Decimal,
  retain
) {
  const checksum = consumeParsed(value, providerShape, Decimal);
  retain(value);
  return checksum;
}

/** Build and retain the actual ORM-result Decimal family used by the floor. */
export function constructAndRetainFixedDecimalFloor(
  canonicalValues,
  ResultDecimal,
  retain
) {
  let first;
  let last;
  for (const canonicalValue of canonicalValues) {
    const value = new ResultDecimal(canonicalValue);
    retain(value);
    first ??= value;
    last = value;
  }
  if (!(first && last)) throw new Error("Expected Decimal floor values");
  return canonicalValues.length + first.toNumber() + last.toNumber();
}

/** Keep every timed constructor result live through the floor checksum. */
export function constructFixedDecimalFloorValues(
  canonicalValues,
  ResultDecimal,
  values
) {
  if (values.length !== canonicalValues.length) {
    throw new Error("Decimal floor sink does not match its value count");
  }
  for (let index = 0; index < canonicalValues.length; index++) {
    values[index] = new ResultDecimal(canonicalValues[index]);
  }
  return values;
}

export function retainsFixedDecimalResult(providerShape) {
  return (
    providerShape.kind === "fixed-decimal-row" ||
    providerShape.kind === "fixed-decimal-text-row" ||
    providerShape.kind === "fixed-decimal-arithmetic" ||
    providerShape.kind === "fixed-decimal-aggregate" ||
    providerShape.kind === "fixed-decimal-list"
  );
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

  if (providerShape.kind === "fixed-decimal-floor") {
    const materialized = decimalValue(
      (await makeOperation(fixture.client, providerShape))[0]?.amount,
      fixture.Decimal,
      "1.125",
      true
    );
    const comparedMaterialized = decimalValue(
      (await makeOperation(semanticFixture.client, providerShape))[0]?.amount,
      semanticFixture.Decimal,
      "1.125",
      true
    );
    const ResultDecimal = Reflect.get(materialized, "constructor");
    const ComparedResultDecimal = Reflect.get(
      comparedMaterialized,
      "constructor"
    );
    if (
      typeof ResultDecimal !== "function" ||
      typeof ComparedResultDecimal !== "function"
    ) {
      throw new Error("Expected a constructible ORM result Decimal");
    }
    const canonicalValues = Object.freeze(
      Array.from(
        { length: providerShape.rows },
        (_, index) => `${index + 1}.125`
      )
    );
    const expectedValues = canonicalValues.map(
      (value) => new ResultDecimal(value)
    );
    const comparedValues = canonicalValues.map(
      (value) => new ComparedResultDecimal(value)
    );
    const exactDigest = assertSemanticDigest(
      `${providerName} ORM result Decimal constructor floor`,
      expectedValues,
      comparedValues
    );
    for (let index = 0; index < canonicalValues.length; index++) {
      if (
        !(
          expectedValues[index] instanceof fixture.Decimal &&
          expectedValues[index].eq(canonicalValues[index])
        )
      ) {
        throw new Error("Expected an exact public Decimal constructor value");
      }
    }
    const constructedValues = new Array(canonicalValues.length);
    const construct = () => {
      const values = constructFixedDecimalFloorValues(
        canonicalValues,
        ResultDecimal,
        constructedValues
      );
      const first = values[0];
      const last = values.at(-1);
      if (!(first && last)) throw new Error("Expected Decimal floor values");
      return canonicalValues.length + first.toNumber() + last.toNumber();
    };
    fixture.responseBytes?.reset();
    return {
      fixture,
      semanticFixture,
      harness: {
        witness: publicOnlyWitness(providerName, workloadName, {
          ...providerShape,
          seam: "orm-result-decimal-construction",
        }),
        semanticDigest: exactDigest,
        responseBytes: fixture.responseBytes,
        "decimal-construct": construct,
        fixedDecimalRetained: (retain) =>
          constructAndRetainFixedDecimalFloor(
            canonicalValues,
            ResultDecimal,
            retain
          ),
      },
    };
  }

  const fixedDecimalRetained =
    stage === "full" && retainsFixedDecimalResult(providerShape)
      ? async (retain) => {
          const value = await makeOperation(fixture.client, providerShape);
          return consumeAndRetainFixedDecimalResult(
            value,
            providerShape,
            fixture.Decimal,
            retain
          );
        }
      : undefined;

  const preparedOperation = makeOperation(fixture.client, providerShape);
  const preparedCapability = fixture.readBenchmarkOperation(preparedOperation);
  if (!preparedCapability) {
    throw new Error("Expected a target-checkout VibORM benchmark operation");
  }
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
    consumeParsed(fixtureSemantic, providerShape, fixture.Decimal, true);
    consumeParsed(fullSemantic, providerShape, semanticFixture.Decimal, true);
    fixture.responseBytes?.reset();
    return {
      fixture,
      semanticFixture,
      harness: {
        witness: publicOnlyWitness(providerName, workloadName, providerShape),
        semanticDigest,
        responseBytes: fixture.responseBytes,
        ...(fixedDecimalRetained === undefined ? {} : { fixedDecimalRetained }),
        full: async () =>
          consumeParsed(
            await makeOperation(fixture.client, providerShape),
            providerShape,
            fixture.Decimal
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
  consumeParsed(parsedFixture, providerShape, fixture.Decimal, true);
  consumeParsed(fullSemantic, providerShape, semanticFixture.Decimal, true);
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
    ...(fixedDecimalRetained === undefined ? {} : { fixedDecimalRetained }),
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
      consumeParsed(
        preparedCapability.parseResult(rawFixture),
        providerShape,
        fixture.Decimal
      ),
    "provider-parse": async () => {
      const raw = await fixture.driver.execute(
        providerClient,
        prepared.sql,
        prepared.params ?? [],
        { operation: "findMany" }
      );
      return consumeParsed(
        preparedCapability.parseResult(raw),
        providerShape,
        fixture.Decimal
      );
    },
    full: async () =>
      consumeParsed(
        await makeOperation(fixture.client, providerShape),
        providerShape,
        fixture.Decimal
      ),
  };
  return { fixture, semanticFixture, harness };
}
