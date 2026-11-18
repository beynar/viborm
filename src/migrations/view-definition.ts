/**
 * The definition of one declared view, for the snapshot the serializer
 * writes: its body compiled from the declared query, its identity, and what
 * it reads.
 *
 * The identity is what was DECLARED and what a client will DECODE, never the
 * body's text: the declared query, the table it reads, the decoder shape of a
 * view row (a JSON column holds a positional document, so a view written for
 * another shape would decode wrong in silence), and the relations the query
 * crosses, as resolved (a relation moved between two columns that both stay
 * changes the body and no column). An engine change that respells a read
 * therefore plans no migration. {@link VIEW_REVISION} is the lever for the
 * other case: a release whose bodies must all be written again raises it.
 *
 * What a body takes from a TABLE it reads is not here: its name, its columns
 * and its primary key (the order a body breaks ties by). A program that
 * changes one of those replaces the view around the change
 * (`withViewReplacements`, `view.ts`), which is the other half of this rule.
 */

import { inlineLiterals } from "../adapters/inline-literals";
import { MigrationError, VibORMErrorCode } from "../errors";
import { viewBody } from "../query-engine/raptor3/view-body";
import { fieldRefPayload, isFieldRef } from "../schema/field-ref";
import { jsonNullKindOf } from "../schema/json-null";
import { type AnyModel, Model } from "../schema/model";
import { emptyRecord, put } from "../schema/record";
import type { AnyRelation } from "../schema/relation";
import type { ResolvedRelationIndex } from "../schema/validation/relation-resolution";
import { viewIsItsRead } from "../schema/validation/rules/view";
import type { ValidationContext } from "../schema/validation/types";
import { viewFacts } from "../schema/view/facts";
import { createResolvedSchemaRegistry } from "../validation/builder";
import { isRecord } from "../validation/value-guards";
import type { MigrationDriver } from "./drivers/base";
import { domainHash, HASH_DOMAIN, utf8Bytes } from "./identity";

export interface ViewDefinition {
  /** Parameter-free SELECT in the driver's dialect: the view's body, without the wrapper and marker. */
  readonly sql: string;
  /** The view's identity: 40 lowercase hex characters. */
  readonly hash: string;
  /** Physical names of the tables and views the body reads, sorted, each once. */
  readonly dependsOn: readonly string[];
}

/** What the serializer holds when it asks for a view's definition. */
export interface ViewDefinitionContext {
  /** The schema's models and views, by key, hydrated. */
  readonly models: Readonly<Record<string, AnyModel>>;
  /** The resolved relation index the snapshot is serialized over. */
  readonly relations: ResolvedRelationIndex;
  /** The migration driver the snapshot is for (its dialect, target and namespace). */
  readonly migrationDriver: MigrationDriver;
}

/** Raised by a release that must write every view body again. */
const VIEW_REVISION = 1;

/** What every view of one schema is defined over, built once per resolved index. */
interface SchemaFacts {
  readonly registry: ReturnType<typeof createResolvedSchemaRegistry>;
  readonly validation: ValidationContext;
}
const schemas = new WeakMap<ResolvedRelationIndex, SchemaFacts>();

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** What an operand callback is answered for a field it asks for, while a view's identity is read. */
class AskedField {
  readonly field: string;
  constructor(field: string) {
    this.field = field;
  }
}

/** The context an operand callback is called with here: each field answers its own name. */
const ASKED = {
  fields: new Proxy({}, { get: (_, field) => new AskedField(String(field)) }),
};

const tagged = (tag: string, payload: unknown): Record<string, unknown> => {
  const record = emptyRecord<unknown>();
  put(record, tag, payload);
  return record;
};

/**
 * A declared query as identity data, without loss: two queries that differ
 * never read as one. What JSON has no spelling for is tagged, a record that
 * would read as a tag (one key, beginning with `$`, as in a schema document)
 * is wrapped in `$raw`, and a column named in place of a
 * value, by a field reference or by the callback that hands one out, is
 * `$field`. A callback is asked what it answers: by the time an identity is
 * read the body is compiled, so it answers a reference, an SQL fragment or
 * any other answer having been refused there. A reference compares two
 * columns of one row, so its field's name says all of it.
 */
function identityValue(value: unknown): unknown {
  const jsonNull = jsonNullKindOf(value);
  if (jsonNull !== undefined) return tagged("$jsonNull", jsonNull);
  if (typeof value === "bigint") return tagged("$bigint", value.toString());
  if (typeof value === "number" && !Number.isFinite(value))
    return tagged("$number", String(value));
  if (typeof value === "function") return identityValue(value(ASKED));
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return tagged("$date", String(value.getTime()));
  if (value instanceof Uint8Array) return tagged("$bytes", hex(value));
  if (value instanceof AskedField) return tagged("$field", value.field);
  if (isFieldRef(value)) return tagged("$field", fieldRefPayload(value).field);
  if (Array.isArray(value)) return value.map(identityValue);
  // A value that states itself as JSON (a Decimal) is that statement, apart
  // from the plain value it would otherwise be taken for.
  if ("toJSON" in value && typeof value.toJSON === "function")
    return tagged("$json", identityValue(value.toJSON()));
  const record = emptyRecord<unknown>();
  for (const [key, member] of Object.entries(value))
    if (member !== undefined) put(record, key, identityValue(member));
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0]!.startsWith("$")
    ? tagged("$raw", record)
    : record;
}

/**
 * A resolved relation as identity data: a model is its table, and what a
 * relation or a scalar object holds beside its resolved facts is left out.
 * Schema objects only: the declared query is written apart, by
 * `identityValue`, so that no value of it is read as one.
 */
function relationValue(_key: string, value: unknown): unknown {
  if (value instanceof Model) return { $table: value["~"].names.sql };
  return typeof value === "object" && value !== null && "~" in value
    ? undefined
    : value;
}

/**
 * The relations `value`, a part of a view's query read at `model`, crosses:
 * each key that names a relation of the model it is read at, then what its
 * own value crosses at the relation's target. A key that names a scalar holds
 * a value, whatever is in it; any other key is a clause or an operator of the
 * same model. `_count: true` counts every to-many relation.
 */
function crossedRelations(
  model: AnyModel,
  value: unknown,
  relations: ResolvedRelationIndex,
  crossed: Map<string, unknown>
): void {
  if (Array.isArray(value)) {
    for (const member of value)
      crossedRelations(model, member, relations, crossed);
    return;
  }
  if (!isRecord(value)) return;
  const slots = relations.get(model);
  const state = model["~"].state;
  const cross = (field: string, member: unknown): void => {
    const slot = slots?.get(field);
    if (slot === undefined) return;
    crossed.set(`${model["~"].names.sql}.${field}`, slot);
    const { edge } = slot;
    // Where the relation leads: the other end of a pair (both ends of a self
    // relation are this model), or every model a variant slot may hold, and
    // its carrier from the other side.
    const targets =
      "endpoints" in edge
        ? edge.endpoints.map(({ source }) => source)
        : [
            edge.carrier.source,
            ...edge.members.flatMap((variant) =>
              "targetModel" in variant
                ? [variant.targetModel]
                : [variant.topology.source.model, variant.topology.target.model]
            ),
          ];
    const self = targets.every((target) => target === model);
    for (const target of new Set(targets))
      if (self || target !== model)
        crossedRelations(target, member, relations, crossed);
  };
  for (const [key, member] of Object.entries(value)) {
    if (key in state.scalars) continue;
    if (key === "_count" && member === true) {
      for (const [field, relation] of Object.entries(
        state.relations as Record<string, AnyRelation>
      ))
        if (relation["~"].state.cardinality === "many") cross(field, undefined);
    } else if (slots?.has(key)) cross(key, member);
    else crossedRelations(model, member, relations, crossed);
  }
}

/**
 * The definition of `view` for `context.migrationDriver`'s dialect: its body
 * written without parameters, what it reads, and its identity.
 */
export function viewDefinition(
  view: AnyModel,
  context: ViewDefinitionContext
): ViewDefinition {
  const { models, relations, migrationDriver } = context;
  const { dialect } = migrationDriver;
  const writer = migrationDriver.viewWriter();
  if (writer === undefined)
    throw new MigrationError(
      `The view "${view["~"].names.ts}" cannot be migrated: VibORM creates no view on ${dialect === "surrealql" ? "SurrealDB yet; views arrive there with materialized views" : dialect}.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { feature: "view", dialect } }
    );
  let schema = schemas.get(relations);
  if (schema === undefined) {
    schema = {
      registry: createResolvedSchemaRegistry(models, relations),
      validation: {
        modelToName: new Map(
          Object.entries(models).map(([key, model]) => [model, key])
        ),
        tableToModels: new Map(),
      },
    };
    schemas.set(relations, schema);
  }
  // The view rules, whether or not the migration skipped its advice: a view
  // exists only where a migration created it, so this is where they bind.
  const issues = viewIsItsRead(
    new Map(Object.entries(models)),
    view["~"].names.ts ?? "",
    view,
    schema.validation
  );
  if (issues.length > 0)
    throw new MigrationError(
      issues.map(({ code, message }) => `${message} (${code})`).join("; "),
      VibORMErrorCode.INVALID_INPUT,
      { meta: { feature: "view", model: view["~"].names.ts } }
    );
  const body = viewBody(
    {
      schema: models,
      resolved: { index: relations, registry: schema.registry },
      adapter: writer.adapter,
    },
    view
  );
  const name = view["~"].names.sql;
  const dependsOn = [...new Set(body.reads)]
    .filter((read) => read !== name)
    .sort();
  const facts = viewFacts(view)!;
  const crossed = new Map<string, unknown>();
  crossedRelations(facts.source, facts.query, relations, crossed);
  const identity = JSON.stringify(
    {
      revision: VIEW_REVISION,
      source: facts.source["~"].names.sql,
      query: JSON.stringify(identityValue(facts.query)),
      shape: body.shape,
      relations: [...crossed].sort(([left], [right]) =>
        left < right ? -1 : 1
      ),
    },
    relationValue
  );
  return {
    sql: inlineLiterals(writer.dialect, body.statement),
    hash: domainHash(HASH_DOMAIN.view, utf8Bytes(identity)).slice(0, 40),
    dependsOn,
  };
}
