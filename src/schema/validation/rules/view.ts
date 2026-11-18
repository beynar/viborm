// View rules (W001-W004): a view is its read of its source, and nothing else.

import type { Model } from "../../model";
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
 * defines it can be compiled. W002: every scalar and key of a view is its
 * source's own, and it takes no index and no omission: `.extends()`, `.id()`,
 * `.unique()`, `.index()`, `.rawIndex()`, `.withoutRowid()` and `.omit()`
 * state what a view cannot hold (a column a view should not return is one its
 * query does not project). W003: a view declares no relation. W004: a JSON
 * column takes its selection's name, which no scalar's column may share.
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
  const refused: [code: string, what: string][] = [];
  if (!ctx.modelToName.has(facts.source))
    refused.push(["W001", "reads a model outside this schema"]);
  if (
    !(
      sameMembers(state.scalars, source.scalars) &&
      sameMembers(state.compoundId, source.compoundId) &&
      sameMembers(state.compoundUniques, source.compoundUniques)
    ) ||
    state.indexes.length > 0 ||
    view["~"].rawIndexes.length > 0 ||
    view["~"].withoutRowid ||
    state.omit
  )
    refused.push([
      "W002",
      "declares a field, a key, an index or an omission beside its query",
    ]);
  if (Object.keys(state.relations).length > 0)
    refused.push(["W003", "declares a relation, which a view cannot hold"]);
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
  return refused.map(([code, what]) => ({
    code,
    message: `View '${model}' ${what}`,
    severity: "error",
    model,
  }));
}
