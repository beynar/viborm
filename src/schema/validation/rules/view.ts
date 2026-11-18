// View rules (W001-W003): a view is its read of its source, and nothing else.

import type { Model } from "../../model";
import { viewFacts } from "../../view/facts";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
} from "../types";

/** The members of `declared` that are not `source`'s own, under the same name. */
function foreignMembers(
  declared: Record<string, unknown> | undefined,
  source: Record<string, unknown> | undefined
): string[] {
  return Object.keys(declared ?? {}).filter(
    (name) => declared?.[name] !== source?.[name]
  );
}

/**
 * W001: a view's source is a model of the same schema, so the read that
 * defines it can be compiled. W002: every scalar and key of a view is its
 * source's own, and it takes no index: `.extends()`, `.id()`, `.unique()`,
 * `.index()`, `.rawIndex()` and `.withoutRowid()` state what a view cannot
 * hold. W003: a view declares no relation.
 */
export function viewIsItsRead(
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const facts = viewFacts(model);
  if (!facts) return [];
  const issues: SchemaValidationIssue[] = [];
  const state = model["~"].state;
  const source = facts.source["~"].state;
  if (!ctx.modelToName.has(facts.source)) {
    issues.push({
      code: "W001",
      message: `View '${name}' reads a model this schema does not hold; add its source to the schema`,
      severity: "error",
      model: name,
    });
  }
  const added = [
    ...foreignMembers(state.scalars, source.scalars),
    ...foreignMembers(state.compoundId, source.compoundId),
    ...foreignMembers(state.compoundUniques, source.compoundUniques),
  ];
  const indexed =
    state.indexes.length > 0 ||
    model["~"].rawIndexes.length > 0 ||
    model["~"].withoutRowid;
  if (added.length > 0 || indexed) {
    issues.push({
      code: "W002",
      message: `View '${name}' declares ${added.length > 0 ? `'${added.join("', '")}'` : "an index"} beside its query; a view holds the fields and keys its query projects from its source, and no index`,
      severity: "error",
      model: name,
    });
  }
  for (const relation of Object.keys(state.relations)) {
    issues.push({
      code: "W003",
      message: `View '${name}' declares the relation '${relation}'; a relation to or from a view is not supported`,
      severity: "error",
      model: name,
      relation,
    });
  }
  return issues;
}
