// A declared model as a junction: which of its to-one relations each side reads,
// and the facts that make a `connect` through it writable.
//
// The relation-topology gate is the only caller. It settles the thunk, publishes
// each side's foreign key, and hands this subowner the settled references; every
// consumer past the gate reads the one `ResolvedJunctionTopology` it publishes.

import {
  findReferenceableKey,
  getModelKeyCatalog,
  type Model,
} from "../../model";
import type { Scalar } from "../../scalars/base";
import type { ResolvedStoredReference } from "../relation-resolution";
import type { SchemaValidationIssue } from "../types";

/** Where each refusal points, and the slot whose `.through()` it answers. */
export interface JunctionModelContext {
  readonly model: Model<any>;
  readonly modelName: string;
  /** `team.parents`: the slot that declared the model. */
  readonly declaredAt: string;
  readonly holderName: string;
  readonly holderField: string;
}

export function junctionIssue(
  code: string,
  context: Pick<JunctionModelContext, "holderName" | "holderField">,
  message: string,
  repair: string
): SchemaValidationIssue {
  return {
    code,
    message,
    severity: "error",
    model: context.holderName,
    relation: context.holderField,
    repair,
  };
}

/** One candidate relation of the junction model, settled by the gate. */
export interface JunctionSideCandidate {
  readonly field: string;
  readonly target: Model<any>;
}

/**
 * The relation one side reads: the one it names, else the only candidate aimed
 * at its model. `undefined` once a refusal is reported.
 *
 * A self relation has two candidates by construction and no way to tell which
 * is which, so it states both, whatever the count of candidates.
 */
export function chooseJunctionSide(input: {
  readonly context: JunctionModelContext;
  readonly side: "source" | "target";
  readonly named: string | undefined;
  readonly endpointModel: Model<any>;
  readonly endpointName: string;
  readonly selfRelation: boolean;
  readonly candidates: readonly JunctionSideCandidate[];
  readonly issues: SchemaValidationIssue[];
}): string | undefined {
  const { context, side, named, candidates, issues } = input;
  if (named !== undefined) return named;
  if (input.selfRelation) {
    issues.push(
      junctionIssue(
        "JT006",
        context,
        `'${context.declaredAt}' is a self relation through '${context.modelName}', so it must state .${side}(...): two to-one relations aim at '${input.endpointName}' and nothing tells them apart`,
        `Name the to-one relations of '${context.modelName}' with .source(...) and .target(...)`
      )
    );
    return undefined;
  }
  const aimed = candidates.filter(
    (candidate) => candidate.target === input.endpointModel
  );
  const [only] = aimed;
  if (only && aimed.length === 1) return only.field;
  issues.push(
    junctionIssue(
      "JT006",
      context,
      `'${context.declaredAt}' cannot choose its ${side} side: '${context.modelName}' has ${aimed.length} to-one relations aimed at '${input.endpointName}', and exactly one is required`,
      `Name the relation with .${side}(...)`
    )
  );
  return undefined;
}

/** A side's stored reference, read in the junction model's own columns. */
export interface JunctionSideFacts {
  readonly relation: string;
  readonly endpointModel: Model<any>;
  readonly endpointName: string;
  readonly reference: ResolvedStoredReference;
}

/**
 * The model's key over the pair: the conflict target of a link.
 *
 * A key may hold only the two sides' columns, or it could not be spelled from
 * what a `connect` knows, and must hold every column one side alone contributes,
 * or two different pairs would conflict and `DO NOTHING` would silently drop
 * the second. It may omit a column the sides SHARE only where that column
 * follows from a side's remaining fields (`organizationId` from a globally
 * unique `id`): where it does not, the same pair under two values of that column
 * are two links the key would merge.
 */
function pairKey(
  model: Model<any>,
  source: JunctionSideFacts,
  target: JunctionSideFacts
): readonly string[] | undefined {
  const ofSide = (side: JunctionSideFacts) =>
    side.reference.members.map((member) => member.foreignField);
  const sourceFields = ofSide(source);
  const targetFields = ofSide(target);
  const union = new Set([...sourceFields, ...targetFields]);
  const shared = sourceFields.filter((field) => targetFields.includes(field));
  const follows = (omitted: readonly string[], side: JunctionSideFacts) =>
    findReferenceableKey(
      side.endpointModel,
      side.reference.members
        .filter((member) => !omitted.includes(member.foreignField))
        .map((member) => member.referencedField)
    ) !== undefined;
  return getModelKeyCatalog(model).referenceableKeys.find((key) => {
    if (!key.every((field) => union.has(field))) return false;
    const omitted = [...union].filter((field) => !key.includes(field));
    if (!omitted.every((field) => shared.includes(field))) return false;
    return (
      omitted.length === 0 ||
      follows(omitted, source) ||
      follows(omitted, target)
    );
  });
}

/** The physical key a link conflicts on, or the refusals that leave it none. */
export function checkJunctionModel(input: {
  readonly context: JunctionModelContext;
  readonly source: JunctionSideFacts;
  readonly target: JunctionSideFacts;
  readonly issues: SchemaValidationIssue[];
}): readonly string[] | undefined {
  const { context, source, target, issues } = input;
  const { model, modelName, declaredAt } = context;
  const scalars: Record<string, Scalar> = model["~"].state.scalars;

  // A shared column whose two sides reference different types is already
  // refused by the stored-reference check of whichever side it disagrees with
  // (FK003) or by the identifier domains, so it has no check of its own here. A
  // required column the link cannot fill is no fact of the schema: a write that
  // states it through `$through` links it, and one that does not is refused.
  const key = pairKey(model, source, target);
  if (!key) {
    issues.push(
      junctionIssue(
        "JT008",
        context,
        `'${modelName}' has no primary key or unique over the two sides of '${declaredAt}', so a repeated connect would not be idempotent`,
        `Declare .id([...]) or .unique([...]) on '${modelName}' over both sides' columns`
      )
    );
    return undefined;
  }
  return key.map((field) => scalars[field]!["~"].state.columnName ?? field);
}
