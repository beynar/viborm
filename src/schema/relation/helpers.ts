// Junction physical naming — table, side tokens, expanded columns, constraint
// names.
//
// Nothing here discovers a pair. The full-schema relation resolver decides which
// two slots share a junction and which single endpoint owns the overrides, then
// hands this owner the already-oriented facts. That is why no function below
// reads a relation object or a second endpoint's declaration.

import { isValidSchemaIdentifier } from "../identifier";
import type { JunctionReferentialAction } from "./types";

// =============================================================================
// DEFAULT NAMES
// =============================================================================

/**
 * Generate a junction table name from two model names
 * Names are sorted alphabetically and joined with underscore
 *
 * @example
 * generateJunctionTableName("post", "tag") // "post_tag"
 * generateJunctionTableName("user", "role") // "role_user"
 */
export function generateJunctionTableName(
  model1: string,
  model2: string
): string {
  const names = [model1.toLowerCase(), model2.toLowerCase()].sort();
  return `${names[0]}_${names[1]}`;
}

/**
 * Generate a junction column name from a model name
 *
 * @example
 * generateJunctionFieldName("post") // "postId"
 * generateJunctionFieldName("User") // "userId"
 */
export function generateJunctionFieldName(modelName: string): string {
  return `${modelName.toLowerCase()}Id`;
}

export interface JunctionFieldGroup {
  /** The declared side token, or its generated equivalent. */
  readonly token: string;
  /** Complete ordered junction columns for this endpoint's row key. */
  readonly fields: readonly string[];
}

export interface JunctionFieldGroups {
  readonly source: JunctionFieldGroup;
  readonly target: JunctionFieldGroup;
}

export type JunctionConstraintKind = "fkey" | "idx" | "key";

export class JunctionPhysicalNameError extends Error {
  readonly kind: "collision" | "invalidIdentifier";

  constructor(kind: "collision" | "invalidIdentifier", message: string) {
    super(message);
    this.name = "JunctionPhysicalNameError";
    this.kind = kind;
  }
}

/** Derive one portable junction constraint name from the side naming token. */
export function getJunctionConstraintName(
  table: string,
  side: JunctionFieldGroup,
  kind: JunctionConstraintKind
): string {
  const name = `${table}_${side.token}_${kind}`;
  if (!isValidSchemaIdentifier(name)) {
    throw new JunctionPhysicalNameError(
      "invalidIdentifier",
      `Generated junction ${kind} name '${name}' is not a valid SQL identifier.`
    );
  }
  return name;
}

/**
 * Expand the two side naming tokens over their complete row keys. The four
 * guards live HERE and only here — row-key emptiness per side, token identifier
 * validity, expanded field identifier validity, and the cross-side field
 * collision — so the ordinary pair path and the variant member path share one
 * refusal set.
 */
export function expandJunctionFieldGroups(
  sourceModelName: string,
  targetModelName: string,
  sourceToken: string,
  targetToken: string,
  sourceRowKeyFields: readonly string[],
  targetRowKeyFields: readonly string[]
): JunctionFieldGroups {
  if (sourceRowKeyFields.length === 0) {
    throw new Error(
      `Model '${sourceModelName}' has no primary key; a junction side requires a complete row key.`
    );
  }
  if (targetRowKeyFields.length === 0) {
    throw new Error(
      `Model '${targetModelName}' has no primary key; a junction side requires a complete row key.`
    );
  }
  for (const token of [sourceToken, targetToken]) {
    if (!isValidSchemaIdentifier(token)) {
      throw new JunctionPhysicalNameError(
        "invalidIdentifier",
        `Junction side prefix '${token}' is not a valid SQL identifier.`
      );
    }
  }
  const source = junctionFieldGroup(sourceToken, sourceRowKeyFields.length);
  const target = junctionFieldGroup(targetToken, targetRowKeyFields.length);
  const occupied = new Map<string, string>();
  for (const field of [...source.fields, ...target.fields]) {
    if (!isValidSchemaIdentifier(field)) {
      throw new JunctionPhysicalNameError(
        "invalidIdentifier",
        `Expanded junction field '${field}' is not a valid SQL identifier.`
      );
    }
    const portableName = field.toLowerCase();
    const previous = occupied.get(portableName);
    if (previous !== undefined) {
      throw new JunctionPhysicalNameError(
        "collision",
        `Junction fields '${previous}' and '${field}' collide after compound-prefix expansion.`
      );
    }
    occupied.set(portableName, field);
  }
  return { source, target };
}

/** Canonical physical side order shared by snapshots and bound membership. */
export function junctionSourceSideIsFirst(
  sourceModelName: string,
  sourceFields: readonly string[],
  targetModelName: string,
  targetFields: readonly string[]
): boolean {
  const sourceModel = sourceModelName.toLowerCase();
  const targetModel = targetModelName.toLowerCase();
  if (sourceModel !== targetModel) return sourceModel < targetModel;
  return sourceFields.join("\0") <= targetFields.join("\0");
}

function junctionFieldGroup(
  token: string,
  rowKeyArity: number
): JunctionFieldGroup {
  return {
    token,
    fields:
      rowKeyArity === 1
        ? [token]
        : Array.from(
            { length: rowKeyArity },
            (_, index) => `${token}_${index + 1}`
          ),
  };
}

// =============================================================================
// ORDINARY PAIR NAMES
// =============================================================================

/**
 * One resolved ordinary junction pair, oriented source → target by the caller.
 * `overrides` are the SINGLE owning endpoint's, already mirrored into this
 * orientation; a pair whose two endpoints both configure the junction never
 * reaches here.
 */
export interface OrdinaryJunctionNameInput {
  readonly sourceModelName: string;
  readonly targetModelName: string;
  /** Field keys of the two paired slots — the self-junction token defaults. */
  readonly sourceField: string;
  readonly targetField: string;
  readonly sourceRowKeyIsCompound: boolean;
  readonly targetRowKeyIsCompound: boolean;
  /** The agreed relation-name claim, which suffixes a generated table name. */
  readonly pairName: string | undefined;
  readonly overrides: JunctionOverrideView | undefined;
}

/**
 * One endpoint's declared junction overrides, seen from the SOURCE side of the
 * resolved pair. The declaration type refuses an empty object; this resolved
 * view does not, because mirroring the owner's facts onto the other side is a
 * derivation, not a declaration.
 */
export interface JunctionOverrideView {
  readonly table?: string;
  readonly source?: string;
  readonly target?: string;
  readonly onDelete?: JunctionReferentialAction;
  readonly onUpdate?: JunctionReferentialAction;
}

export interface OrdinaryJunctionNames {
  readonly table: string;
  readonly sourceToken: string;
  readonly targetToken: string;
}

/**
 * The ONE owner of an ordinary junction's default names.
 *
 * A self junction takes its side tokens from the two FIELD keys, because the
 * model name is the same on both sides and cannot separate them. A non-self
 * junction keeps the model-name derivation its stored bytes were generated
 * from. A compound row key turns the token into a positional prefix, so it
 * drops the scalar `Id` suffix.
 */
export function resolveOrdinaryJunctionNames(
  input: OrdinaryJunctionNameInput
): OrdinaryJunctionNames {
  const overrides = input.overrides;
  const isSelf = input.sourceModelName === input.targetModelName;
  const base = generateJunctionTableName(
    input.sourceModelName,
    input.targetModelName
  );
  return {
    table:
      overrides?.table ?? (input.pairName ? `${base}_${input.pairName}` : base),
    sourceToken:
      overrides?.source ??
      defaultSideToken(
        isSelf,
        input.sourceField,
        input.sourceModelName,
        input.sourceRowKeyIsCompound
      ),
    targetToken:
      overrides?.target ??
      defaultSideToken(
        isSelf,
        input.targetField,
        input.targetModelName,
        input.targetRowKeyIsCompound
      ),
  };
}

function defaultSideToken(
  isSelf: boolean,
  field: string,
  modelName: string,
  isCompound: boolean
): string {
  if (isSelf) return isCompound ? field : `${field}Id`;
  return isCompound
    ? modelName.toLowerCase()
    : generateJunctionFieldName(modelName);
}
