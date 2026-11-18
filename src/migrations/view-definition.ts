/**
 * The definition of one declared view, for the snapshot the serializer
 * writes: its body compiled from the declared query, its identity, and what
 * it reads.
 *
 * The identity is what was DECLARED and what a client will DECODE, never the
 * body's text: the declared query, the table it reads, the decoder shape of a
 * view row (a JSON column holds a positional document, so a view written for
 * another shape would decode wrong in silence), and the relations of the
 * tables the body reads (a relation moved between two columns that both stay
 * changes the body and no column). An engine change that respells a read
 * therefore plans no migration. {@link VIEW_REVISION} is the lever for the
 * other case: a release whose bodies must all be written again raises it.
 *
 * A change to a table a view reads needs no place here: the program replaces
 * the view around it (`withViewReplacements`, `view.ts`).
 */

import { inlineLiterals } from "../adapters/inline-literals";
import { MigrationError, VibORMErrorCode } from "../errors";
import { viewBody } from "../query-engine/raptor3/view-body";
import { jsonNullKindOf } from "../schema/json-null";
import { type AnyModel, Model } from "../schema/model";
import type { ResolvedRelationIndex } from "../schema/validation/relation-resolution";
import { viewFacts } from "../schema/view/facts";
import { createResolvedSchemaRegistry } from "../validation/builder";
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

/** The operation schemas of a schema, built once per resolved index. */
const registries = new WeakMap<
  ResolvedRelationIndex,
  ReturnType<typeof createResolvedSchemaRegistry>
>();

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A declared query's values as identity data: what JSON has no spelling for
 * is tagged, so two different values never hash as one.
 */
function queryValue(this: unknown, key: string, value: unknown): unknown {
  // `JSON.stringify` hands a Date over as its `toJSON` text: read the holder.
  const held = (this as Record<string, unknown>)[key];
  if (held instanceof Date) return { $date: held.toISOString() };
  if (typeof held === "bigint") return { $bigint: held.toString() };
  if (held instanceof Uint8Array) return { $bytes: hex(held) };
  const jsonNull = jsonNullKindOf(held);
  return jsonNull === undefined ? value : { $jsonNull: jsonNull };
}

/**
 * A resolved relation as identity data: a model is its table, and what a
 * relation or a scalar object holds beside its resolved facts is left out.
 */
function relationValue(_key: string, value: unknown): unknown {
  if (value instanceof Model) return { $table: value["~"].names.sql };
  return typeof value === "object" && value !== null && "~" in value
    ? undefined
    : value;
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
  if (dialect !== "postgresql" && dialect !== "mysql" && dialect !== "sqlite")
    throw new MigrationError(
      `The view "${view["~"].names.ts}" cannot be migrated: VibORM creates no view on ${dialect === "surrealql" ? "SurrealDB yet; views arrive there with materialized views" : dialect}.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { feature: "view", dialect } }
    );
  let registry = registries.get(relations);
  if (registry === undefined) {
    registry = createResolvedSchemaRegistry(models, relations);
    registries.set(relations, registry);
  }
  // PostgreSQL names every relation by its schema (a migration sets no
  // search path); a MySQL artifact is relative to the database its session
  // selects, and SQLite has no namespace.
  const body = viewBody(
    {
      schema: models,
      resolved: { index: relations, registry },
      dialect,
      ...(dialect === "postgresql" && migrationDriver.namespace !== undefined
        ? { namespace: migrationDriver.namespace }
        : {}),
    },
    view
  );
  const name = view["~"].names.sql;
  const dependsOn = [...new Set(body.reads)]
    .filter((read) => read !== name)
    .sort();
  const read = new Set(dependsOn);
  const facts = viewFacts(view)!;
  const identity = JSON.stringify(
    {
      revision: VIEW_REVISION,
      source: facts.source["~"].names.sql,
      query: JSON.parse(JSON.stringify(facts.query, queryValue)),
      shape: body.shape,
      relations: Object.values(models)
        .filter((model) => read.has(model["~"].names.sql ?? ""))
        .map((model) => [
          model["~"].names.sql,
          [...(relations.get(model) ?? [])],
        ])
        .sort(([left], [right]) => (left! < right! ? -1 : 1)),
    },
    relationValue
  );
  return {
    sql: inlineLiterals(dialect, body.statement),
    hash: domainHash(HASH_DOMAIN.view, utf8Bytes(identity)).slice(0, 40),
    dependsOn,
  };
}
