// View rules (W001-W004): a view is its read of its source, and nothing else.

import { MAX_SCHEMA_IDENTIFIER_BYTES } from "../../identifier";
import type { Model } from "../../model";
import type { AnyRelation } from "../../relation";
import type { Scalar } from "../../scalars/base";
import { viewFacts } from "../../view/facts";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
} from "../types";

/** Whether every member of `declared` is `source`'s own, under the same name. */
function sameMembers(
  declared: Record<string, unknown> | undefined,
  source: Record<string, unknown> | undefined
): boolean {
  return Object.keys(declared ?? {}).every(
    (name) => declared?.[name] === source?.[name]
  );
}

/**
 * W001: a view's source is a model of the same schema, so the read that
 * defines it can be compiled. W002: every scalar and key of a view is the
 * one its query derives (its source's own, or an aggregated view's column
 * and key), and it takes no raw index and no omission: `.extends()` with a
 * scalar, `.id()`, `.unique()`, `.rawIndex()`, `.withoutRowid()` and
 * `.omit()` state what a view cannot hold (a column a view should not return
 * is one its query does not project). Only a materialized view takes
 * `.index()`, on its scalar columns and never unique: a JSON column has no
 * order, and a unique index would be a key its query does not show (that an
 * index names a field of the view at all is I001's). W003: a view's
 * relations are its source's, which it inherits where it keeps their key
 * columns: `.extends()` declares none. W004: a JSON column takes its
 * selection's name, which no scalar's column may share, and two columns of
 * an aggregated view take two names, each one a column's name can be: an
 * aggregate's prefix on a field name already at the limit is longer.
 *
 * W002 is the one owner of what a view cannot hold, and it reads each such
 * fact by name. `view-declaration.core.test.ts` lists every method and every
 * fact of a model with its answer for a view, so one added to `Model` is
 * classified, and read here if refused, before it can be declared on a view.
 *
 * Advice like every model rule, and the one rule a migration of a view always
 * runs (`viewDefinition`): a view exists only where a migration created it,
 * so a client is built without it.
 */
export function viewIsItsRead(
  _schema: Schema,
  model: string,
  view: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const facts = viewFacts(view);
  if (!facts) return [];
  const state = view["~"].state;
  const source = facts.source["~"].state;
  // What the query derives: the source's own scalars and keys, or the
  // columns and key an aggregated view derives of them.
  const derived = facts.aggregated ?? source;
  const refused: [code: string, what: string][] = [];
  if (!ctx.modelToName.has(facts.source))
    refused.push(["W001", "reads a model outside this schema"]);
  if (
    !(
      sameMembers(state.scalars, derived.scalars) &&
      // The source's own scalar, and one the query projects: any other
      // names a column the view does not have.
      Object.keys(state.scalars).every((name) =>
        facts.columns.includes(name)
      ) &&
      sameMembers(state.compoundId, derived.compoundId) &&
      sameMembers(
        state.compoundUniques,
        facts.aggregated ? undefined : source.compoundUniques
      )
    ) ||
    view["~"].rawIndexes.length > 0 ||
    view["~"].withoutRowid ||
    state.omit
  )
    refused.push([
      "W002",
      "declares a field, a key, a raw index or an omission beside its query",
    ]);
  if (state.indexes.length > 0 && !facts.materialized)
    refused.push([
      "W002",
      "declares an index, and only a materialized view stores rows to index: declare it .materialized()",
    ]);
  // A unique index is a key (`keys.ts`): one more than the query shows, which
  // only PostgreSQL would hold the view's rows to.
  if (state.indexes.some((index) => index.options.unique))
    refused.push([
      "W002",
      "declares a unique index: a view's keys are the keys of its source that it projects, and nothing else says its rows are unique",
    ]);
  const indexedDocument = state.indexes
    .flatMap((index) => index.fields)
    .find((field) => facts.documents.includes(field));
  if (indexedDocument !== undefined)
    refused.push([
      "W002",
      `indexes its JSON column '${indexedDocument}': a document has no order an index could keep`,
    ]);
  if (!sameMembers(state.relations, source.relations))
    refused.push([
      "W003",
      "declares a relation, where a view inherits its source's",
    ]);
  const columns = new Set(
    Object.entries(state.scalars as Record<string, Scalar>).map(
      ([field, scalar]) => scalar["~"].state.columnName ?? field
    )
  );
  const twice = facts.documents.find((document) => columns.has(document));
  if (twice !== undefined)
    refused.push([
      "W004",
      `selects '${twice}' and a field stored in a column of that name: two columns of one name`,
    ]);
  const repeated = facts.columns.find(
    (column, at) => facts.columns.indexOf(column) !== at
  );
  if (repeated !== undefined)
    refused.push([
      "W004",
      `holds two columns named '${repeated}', a grouped field's and an aggregate's or two aggregates': two columns of one name`,
    ]);
  // The one column a view lists without a scalar: one whose name its
  // derivation found longer than a column's (`deriveAggregatedState`).
  const unnamed = facts.columns.find((column) => !(column in derived.scalars));
  if (unnamed !== undefined) {
    const origin = facts.aggregated?.origins[unnamed];
    refused.push([
      "W004",
      `names the ${origin?.aggregate} of '${origin?.field}' '${unnamed}': a column's name takes at most ${MAX_SCHEMA_IDENTIFIER_BYTES} bytes`,
    ]);
  }
  return refused.map(([code, what]) => ({
    code,
    message: `View '${model}' ${what}`,
    severity: "error",
    model,
  }));
}

/**
 * W006, advice only: a view kept by triggers (`refresh: "auto"`) computes a
 * group again at each write to its source, reading the source's rows of
 * that group; where no index of the source begins with the grouped fields
 * (its key, a unique, a declared total index or a foreign key's, which
 * migrations index), each write reads the whole table.
 */
export function autoViewIndexed(
  _schema: Schema,
  model: string,
  view: Model<any>,
  _ctx: ValidationContext
): SchemaValidationIssue[] {
  const facts = viewFacts(view);
  if (facts?.refresh !== "auto" || facts.aggregated === undefined) return [];
  const { by } = facts.aggregated;
  const state = facts.source["~"].state;
  const scalars: Record<string, Scalar> = state.scalars;
  const keys = (record: Record<string, { entries?: object }> | undefined) =>
    Object.values(record ?? {}).map((key) => Object.keys(key.entries ?? {}));
  const relations: Record<string, AnyRelation> = state.relations;
  const leading: (readonly string[])[] = [
    Object.keys(scalars).filter((field) => scalars[field]!["~"].state.isId),
    ...Object.keys(scalars)
      .filter((field) => scalars[field]!["~"].state.isUnique)
      .map((field) => [field]),
    ...keys(state.compoundId),
    ...keys(state.compoundUniques),
    ...state.indexes
      .filter((index) => !index.options.where)
      .map((index) => index.fields),
    ...Object.values(relations).map(
      (relation) => relation["~"].state.foreignKey?.fields ?? []
    ),
  ];
  const covered = leading.some(
    (fields) =>
      fields.length >= by.length &&
      by.every((field) => fields.slice(0, by.length).includes(field))
  );
  if (covered) return [];
  return [
    {
      code: "W006",
      message: `View '${model}' is kept by triggers and groups its source by ${by.map((field) => `'${field}'`).join(", ")}, which no index of its source begins with: each write to the source reads all its rows`,
      repair: `Index them on the source: .index(${JSON.stringify(by)})`,
      severity: "warning",
      model,
    },
  ];
}
