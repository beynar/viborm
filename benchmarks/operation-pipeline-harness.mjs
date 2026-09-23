/** Shared stage mechanics and semantic consumers for workload families. */

import assert from "node:assert/strict";
import { readBenchmarkOperation } from "../dist/internal/benchmark-operation.mjs";
import {
  assertSemanticDigest,
  freezeRawResult,
} from "./operation-pipeline-semantics.mjs";

export function benchmarkOperation(operation) {
  const capability = readBenchmarkOperation(operation);
  if (!capability) throw new Error("Expected a VibORM benchmark operation");
  return capability;
}

/** Untimed, fixture-owned evidence. Restore the stock execution surface before timing. */
export async function observeBenchmarkContract(
  fixture,
  invoke,
  verify,
  afterStatement
) {
  assert.equal(typeof fixture.readRawState, "function");
  const initial = await fixture.readRawState();
  const defaultStart = fixture.defaults.length;
  fixture.observeDefaults(true);
  const statements = [];
  const reachedCuts = [];
  let observationFailure;
  const driver = fixture.driver;
  const originals = ["execute", "executeRaw"].map((method) => ({
    method,
    descriptor: Object.getOwnPropertyDescriptor(driver, method),
    execute: driver[method],
  }));
  for (const original of originals) {
    Object.defineProperty(driver, original.method, {
      configurable: true,
      value: async function (client, sql, params, ...rest) {
        statements.push({ sql, params: structuredClone(params ?? []) });
        const response = await original.execute.call(
          this,
          client,
          sql,
          params,
          ...rest
        );
        try {
          const cuts =
            afterStatement?.(
              client,
              response.rows,
              fixture.defaults.slice(defaultStart)
            ) ?? [];
          for (const cut of cuts) {
            if (!reachedCuts.includes(cut)) reachedCuts.push(cut);
          }
        } catch (failure) {
          observationFailure = failure;
          throw failure;
        }
        return response;
      },
    });
  }
  let value;
  try {
    value = await invoke();
  } finally {
    fixture.observeDefaults(false);
    for (const { method, descriptor } of originals) {
      if (descriptor) Object.defineProperty(driver, method, descriptor);
      else delete driver[method];
    }
  }
  if (observationFailure !== undefined) throw observationFailure;
  const observation = {
    outcome: { kind: "success", value },
    initial,
    final: await fixture.readRawState(),
    defaults: fixture.defaults.slice(defaultStart),
    reachedCuts,
  };
  verify(observation);
  assert(
    statements.length > 0,
    "contract invocation dispatched no provider statements"
  );
  return {
    contractObservation: observation,
    witness: {
      statementCount: statements.length,
      roundTripCount: statements.length,
      statements,
    },
  };
}

export function consumeScalarRows(rows, key) {
  const first = rows[0];
  if (!first) return 0;
  const value = first[key];
  if (typeof value === "number") return rows.length + value;
  if (typeof value === "string") return rows.length + value.charCodeAt(0);
  throw new Error(`Expected scalar ${key} in the measured result`);
}

/**
 * The relation carrier as TEXT, whatever the provider handed back.
 *
 * SQLite returns a JSON relation payload as a string; PostgreSQL and MySQL
 * decode `json`/`jsonb` in the provider itself and hand back an object. The
 * marker being looked for is the same nested scalar either way, so the string
 * branch is unchanged and a decoded carrier is read through its own text.
 */
function carrierText(value) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return undefined;
}

export function rawCarrierConsumer(marker) {
  return (rows) => {
    const first = rows[0];
    if (!first) return 0;
    for (const value of Object.values(first)) {
      const text = carrierText(value);
      if (text?.includes(marker)) {
        const offset = text.indexOf(marker);
        return rows.length + text.charCodeAt(offset + marker.length);
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
  const capability = benchmarkOperation(operation);
  const single = capability.prepare();
  if (single) {
    return {
      queries: [single],
      parseResult: (results) => capability.parseResult(results[0]),
    };
  }
  const batch = await capability.prepareBatch(driver);
  if (batch) return batch;
  const statement = operation.buildStatement();
  if (!statement) {
    throw new Error("Operation exposed no executable preparation seam");
  }
  const prepared = driver._prepare(statement);
  return {
    queries: [prepared],
    parseResult: (results) => capability.parseResult(results[0]),
  };
}

export async function createReadHarness(
  fixture,
  semanticFixture,
  makeOperation,
  parsedConsumer,
  rawConsumer,
  workloadShape,
  verifyContract
) {
  const preparedOperation = makeOperation();
  const preparedCapability = benchmarkOperation(preparedOperation);
  const prepared = preparedCapability.prepare();
  if (!prepared) throw new Error("Read workload did not prepare one statement");
  const rawFixture = freezeRawResult(
    await fixture.driver._executeRaw(prepared.sql, prepared.params)
  );
  const parsedFixture = preparedCapability.parseResult(rawFixture);
  parsedConsumer(parsedFixture);
  rawConsumer(rawFixture.rows);
  const contract = verifyContract
    ? await observeBenchmarkContract(
        semanticFixture,
        () => makeOperation(semanticFixture.client),
        verifyContract
      )
    : undefined;
  const fullSemantic = contract
    ? contract.contractObservation.outcome.value
    : await makeOperation(semanticFixture.client);
  parsedConsumer(fullSemantic);
  const digest = assertSemanticDigest(
    "read prepared/raw versus public full",
    parsedFixture,
    fullSemantic
  );
  return {
    witness: preparedWitness(prepared, workloadShape),
    semanticDigest: digest,
    ...contract,
    "cold-prepare": () => {
      const operation = makeOperation(fixture.createColdClient());
      const query = benchmarkOperation(operation).prepare();
      if (!query) throw new Error("Cold read stopped preparing one statement");
      return query.sql.length + (query.params?.length ?? 0);
    },
    prepare: () => {
      const operation = makeOperation();
      const query = benchmarkOperation(operation).prepare();
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
    parse: () => parsedConsumer(preparedCapability.parseResult(rawFixture)),
    "raw-parse": async () => {
      const raw = await fixture.driver._executeRaw(
        prepared.sql,
        prepared.params
      );
      return parsedConsumer(preparedCapability.parseResult(raw));
    },
    full: async () => parsedConsumer(await makeOperation()),
  };
}
