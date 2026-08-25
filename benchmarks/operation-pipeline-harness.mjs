/** Shared stage mechanics and semantic consumers for workload families. */

import {
  assertSemanticDigest,
  freezeRawResult,
} from "./operation-pipeline-semantics.mjs";

export function consumeScalarRows(rows, key) {
  const first = rows[0];
  if (!first) return 0;
  const value = first[key];
  if (typeof value === "number") return rows.length + value;
  if (typeof value === "string") return rows.length + value.charCodeAt(0);
  throw new Error(`Expected scalar ${key} in the measured result`);
}

export function rawCarrierConsumer(marker) {
  return (rows) => {
    const first = rows[0];
    if (!first) return 0;
    for (const value of Object.values(first)) {
      if (typeof value === "string" && value.includes(marker)) {
        const offset = value.indexOf(marker);
        return rows.length + value.charCodeAt(offset + marker.length);
      }
    }
    throw new Error(
      `Expected nested scalar marker ${marker} in the raw carrier`
    );
  };
}

export function consumeFixedSingularRelation(rows) {
  const first = rows[0];
  const name = first?.author?.name;
  if (typeof name !== "string") {
    throw new Error("Expected an ordinary nested author scalar");
  }
  return rows.length + first.id.charCodeAt(0) + name.charCodeAt(5);
}

export function consumeFixedCollectionRelation(rows) {
  const first = rows[0];
  const title = first?.posts?.[0]?.title;
  if (typeof title !== "string") {
    throw new Error("Expected a fixed-target nested collection scalar");
  }
  return rows.length + first.id.charCodeAt(0) + title.charCodeAt(0);
}

export function consumeVariantSingularRelation(rows) {
  const first = rows[0];
  const title = first?.subject?.data?.title;
  if (typeof title !== "string") {
    throw new Error("Expected a variant-target nested title scalar");
  }
  return rows.length + first.id.charCodeAt(0) + title.charCodeAt(0);
}

export function consumeVariantCollectionRelation(rows) {
  const first = rows[0];
  const title = first?.items?.[0]?.data?.title;
  if (typeof title !== "string") {
    throw new Error("Expected a variant-target nested collection scalar");
  }
  return rows.length + first.id.charCodeAt(0) + title.charCodeAt(0);
}

export function consumeFixedSingularJunction(rows) {
  const first = rows[0];
  const shelfId = first?.shelf?.id;
  if (typeof shelfId !== "string") {
    throw new Error("Expected a fixed-target singular junction scalar");
  }
  return rows.length + first.id.charCodeAt(0) + shelfId.charCodeAt(0);
}

export function consumeFixedCollectionJunction(rows) {
  const first = rows[0];
  const shelfId = first?.shelves?.[0]?.id;
  if (typeof shelfId !== "string") {
    throw new Error("Expected a fixed-target collection junction scalar");
  }
  return rows.length + first.id.charCodeAt(0) + shelfId.charCodeAt(0);
}

export function preparedWitness(prepared, workloadShape) {
  return {
    statementCount: 1,
    statements: [{ sql: prepared.sql, params: prepared.params ?? [] }],
    ...(workloadShape === undefined ? {} : { workloadShape }),
  };
}

export function batchWitness(queries) {
  return {
    statementCount: queries.length,
    statements: queries.map((query) => ({
      sql: query.sql,
      params: query.params ?? [],
    })),
  };
}

export function witnessChecksum(witness) {
  let checksum = witness.statementCount;
  for (const statement of witness.statements) {
    checksum += statement.sql.length + statement.params.length;
  }
  return checksum;
}

export async function prepareOperationPlan(operation, driver) {
  const single = operation.prepare();
  if (single) {
    return {
      queries: [single],
      parseResult: (results) => operation.parseResult(results[0]),
    };
  }
  const batch = await operation.prepareBatch(driver);
  if (batch) return batch;
  const statement = operation.buildStatement();
  if (!statement) {
    throw new Error("Operation exposed no executable preparation seam");
  }
  const prepared = driver._prepare(statement);
  return {
    queries: [prepared],
    parseResult: (results) => operation.parseResult(results[0]),
  };
}

export async function createReadHarness(
  fixture,
  semanticFixture,
  makeOperation,
  parsedConsumer,
  rawConsumer,
  workloadShape
) {
  const preparedOperation = makeOperation();
  const prepared = preparedOperation.prepare();
  if (!prepared) throw new Error("Read workload did not prepare one statement");
  const rawFixture = freezeRawResult(
    await fixture.driver._executeRaw(prepared.sql, prepared.params)
  );
  const parsedFixture = preparedOperation.parseResult(rawFixture);
  parsedConsumer(parsedFixture);
  rawConsumer(rawFixture.rows);
  const fullSemantic = await makeOperation(semanticFixture.client);
  parsedConsumer(fullSemantic);
  const digest = assertSemanticDigest(
    "read prepared/raw versus public full",
    parsedFixture,
    fullSemantic
  );
  return {
    witness: preparedWitness(prepared, workloadShape),
    semanticDigest: digest,
    prepare: () => {
      const query = makeOperation().prepare();
      if (!query)
        throw new Error("Read workload stopped preparing one statement");
      return query.sql.length + (query.params?.length ?? 0);
    },
    execute: async () => {
      const raw = await fixture.driver._executeRaw(
        prepared.sql,
        prepared.params
      );
      return rawConsumer(raw.rows);
    },
    parse: () => parsedConsumer(preparedOperation.parseResult(rawFixture)),
    "raw-parse": async () => {
      const raw = await fixture.driver._executeRaw(
        prepared.sql,
        prepared.params
      );
      return parsedConsumer(preparedOperation.parseResult(raw));
    },
    full: async () => parsedConsumer(await makeOperation()),
  };
}
