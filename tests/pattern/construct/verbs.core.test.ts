/**
 * `Row.verb` and the failure text it selects, over the WHOLE corpus: every
 * row a verb plan created is stamped with that verb, the root (and its arms)
 * with the operation, and the target-premise failure a verb's stamp selects
 * is byte-identical to today's message catalog.
 */
import type { Model } from "@schema/model";
import {
  constructPattern,
  type WriteOperation,
} from "@src/query-engine/pattern/construct";
import {
  targetNotFoundFailure,
  VERB_ORDER,
} from "@src/query-engine/pattern/sugar";
import {
  relationTargetNotFound,
  upsertTargetNotFoundForParent,
} from "@src/query-engine/write-engine/messages";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import { isInvalidPayload, payloads } from "@tests/pattern/corpus/payloads";
import { schemas } from "@tests/pattern/corpus/schemas";
import { engineFor, planningDriver } from "@tests/pattern/harness/dump";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const WRITE_OPERATIONS = new Set<string>([
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "createManyAndReturn",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
  "deleteManyAndReturn",
]);

/** Every verb key spelled anywhere in a payload's args. */
function spelledVerbs(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) spelledVerbs(item, into);
    return into;
  }
  if (typeof value !== "object" || value === null) return into;
  for (const [key, inner] of Object.entries(value)) {
    if ((VERB_ORDER as readonly string[]).includes(key)) into.add(key);
    spelledVerbs(inner, into);
  }
  return into;
}

const corpus = payloads.filter(
  (p) => WRITE_OPERATIONS.has(p.operation) && !isInvalidPayload(p)
);

describe("Row.verb over the corpus", () => {
  test.each(corpus.map((p) => [p.name, p] as const))("%s", (_name, payload) => {
    const schema = schemas[payload.schema] as Record<string, Model<any>>;
    const model = schema[payload.model] as Model<any>;
    const registry = createSchemaRegistry(schema);
    const args = parseValidated(
      Reflect.get(registry.getModelSchemas(model).args, payload.operation),
      payload.args,
      payload.operation as never,
      ""
    ) as Record<string, unknown>;
    const engine = engineFor(
      schema,
      planningDriver("postgresql", "transaction")
    );
    const { pattern } = constructPattern({
      index: engine.relations,
      model,
      operation: payload.operation as WriteOperation,
      validatedArgs: args,
    });
    const spelled = spelledVerbs(payload.args, new Set());
    for (const row of pattern.rows) {
      expect(row.verb).toBeDefined();
      if (row.id === pattern.root) {
        expect(row.verb).toBe(payload.operation);
        continue;
      }
      // A root arm (upsert's fresh row, createMany's rows) is the operation;
      // every other row was created by a verb the payload spelled.
      if (row.verb === payload.operation) continue;
      expect(spelled.has(row.verb!)).toBe(true);
    }
  });
});

describe("the failure a verb's stamp selects", () => {
  test.each([
    "connect",
    "set",
    "update",
    "delete",
    "disconnect",
  ] as const)("%s is today's relationTargetNotFound text", (verb) => {
    expect(targetNotFoundFailure(verb, "teams")).toBe(
      relationTargetNotFound({ name: "teams" } as never, verb)
    );
  });

  test("upsert is today's found-uncorrelated text", () => {
    expect(targetNotFoundFailure("upsert", "teams")).toBe(
      upsertTargetNotFoundForParent("teams")
    );
  });

  test("the verbs that tolerate an empty match select no failure", () => {
    for (const verb of [
      "connectOrCreate",
      "create",
      "createMany",
      "updateMany",
      "deleteMany",
      "update-root",
      undefined,
    ]) {
      expect(targetNotFoundFailure(verb, "teams")).toBeUndefined();
    }
  });

  test("the five spellings, verbatim", () => {
    expect(targetNotFoundFailure("connect", "teams")).toBe(
      "Cannot connect relation 'teams': target record was not found."
    );
    expect(targetNotFoundFailure("set", "teams")).toBe(
      "Cannot set relation 'teams': target record was not found."
    );
    expect(targetNotFoundFailure("disconnect", "teams")).toBe(
      "Cannot disconnect relation 'teams': target record was not found for this parent."
    );
    expect(targetNotFoundFailure("delete", "teams")).toBe(
      "Cannot delete relation 'teams': target record was not found for this parent."
    );
    expect(targetNotFoundFailure("update", "teams")).toBe(
      "Cannot update relation 'teams': target record was not found for this parent."
    );
    expect(targetNotFoundFailure("upsert", "teams")).toBe(
      "Cannot upsert relation 'teams': target record was not found for this parent."
    );
  });
});
