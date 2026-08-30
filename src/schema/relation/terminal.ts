// Shared immutable-terminal machinery: the construction-time refusal vocabulary
// and the source-independent target once-cell.
//
// Every structurally knowable fact about a declaration is decided HERE or in the
// factory/modifier that owns it, before the value enters trusted relation state.
// Facts that need the schema graph — is the settled return a registered model,
// which endpoint owns the foreign key, does the pair exist — belong to the
// full-schema relation resolver and are deliberately absent.

import { ValidationError } from "@errors";
import { isValidSchemaIdentifier } from "../identifier";
import type {
  JunctionReferentialAction,
  NonEmptyFieldTuple,
  ReferentialAction,
} from "./types";

/** The builder label carried by every construction-time refusal. */
export type RelationBuilder = "s.toOne" | "s.toMany" | "s.model";

/**
 * The one construction-time refusal. Structural input the factories and
 * modifiers can judge on their own never reaches the schema resolver as a
 * `SchemaValidationIssue`; it fails here, at the call the author wrote.
 */
export function refuseRelationInput(
  builder: RelationBuilder,
  path: string,
  message: string,
  cause?: Error
): never {
  throw new ValidationError(
    { kind: "schema-builder", builder, path },
    [{ path, message }],
    cause === undefined ? undefined : { cause }
  );
}

// =============================================================================
// PLAIN-RECORD READS
// =============================================================================

/**
 * A caller-supplied map is a variant declaration only when it is a plain
 * record: a hostile prototype would otherwise smuggle inherited entries past
 * own-key enumeration into schema truth.
 */
export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Own ENUMERABLE string keys — the declaration surface of a record. Symbol keys
 * and inherited entries are not declarations, and neither is an own key hidden
 * behind `enumerable: false`.
 */
export function declaredKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record);
}

/** Exactly these keys, in any order. */
export function hasExactKeys(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}

/**
 * Read one caller-owned property exactly once. Accessors are executable input:
 * when one throws, the declaration boundary owns the V4002 refusal and keeps a
 * normalized cause instead of leaking the caller's thrown value.
 */
export function readCallerProperty(
  builder: RelationBuilder,
  record: Record<string, unknown>,
  property: string,
  path: string
): unknown {
  try {
    return Reflect.get(record, property);
  } catch (thrown) {
    refuseRelationInput(
      builder,
      path,
      `Could not read relation input '${path}'`,
      normalizeThrown(
        thrown,
        `Reading relation input '${path}' threw a non-Error value`
      )
    );
  }
}

// =============================================================================
// MODIFIER TOKENS
// =============================================================================

/**
 * A relation name is a non-empty PAIRING LABEL, not a SQL identifier: an
 * explicit `.through(...)` lets `"Post tags/v2"` name a pair without pretending
 * the label is a database name.
 */
export function normalizeRelationName(
  builder: RelationBuilder,
  name: unknown
): string {
  if (typeof name !== "string" || name.length === 0) {
    refuseRelationInput(
      builder,
      "name",
      "A relation name must be a non-empty string"
    );
  }
  return name;
}

export function normalizeReferentialAction(
  path: string,
  action: unknown
): ReferentialAction {
  if (
    action === "cascade" ||
    action === "setNull" ||
    action === "restrict" ||
    action === "noAction"
  ) {
    return action;
  }
  refuseRelationInput(
    "s.toOne",
    path,
    "A referential action must be one of 'cascade', 'setNull', 'restrict' or 'noAction'"
  );
}

/** Junction actions exclude `setNull` at the type level and here. */
export function normalizeJunctionAction(
  path: string,
  action: unknown
): JunctionReferentialAction {
  if (action === "cascade" || action === "restrict" || action === "noAction") {
    return action;
  }
  refuseRelationInput(
    "s.toMany",
    path,
    "A junction referential action must be one of 'cascade', 'restrict' or 'noAction'; 'setNull' cannot null a membership-key member"
  );
}

/** One junction table name or side naming token. */
export function normalizeJunctionToken(path: string, token: unknown): string {
  if (!isValidSchemaIdentifier(token)) {
    refuseRelationInput(
      "s.toMany",
      path,
      `Junction '${path}' must be a valid schema identifier`
    );
  }
  return token;
}

/** A non-empty foreign-key tuple whose members are distinct. */
export function normalizeFieldTuple(
  builder: RelationBuilder,
  path: string,
  fields: readonly string[]
): NonEmptyFieldTuple {
  const [head, ...rest] = fields;
  if (head === undefined) {
    refuseRelationInput(
      builder,
      path,
      `'${path}' requires at least one field key`
    );
  }
  if (new Set(fields).size !== fields.length) {
    refuseRelationInput(
      builder,
      path,
      `'${path}' cannot repeat a field key in one foreign-key tuple`
    );
  }
  return [head, ...rest];
}

// =============================================================================
// TARGET SETTLEMENT
// =============================================================================

type SettledTarget =
  | { readonly settled: "value"; readonly value: unknown }
  | { readonly settled: "error"; readonly error: Error };

/**
 * The declaration-lifetime target cell.
 *
 * A raw getter stays lazy, but it is invoked at most ONCE per target: the first
 * resolution settles its return or one normalized `Error`, and every later
 * consumer — including a second schema graph reusing the same immutable
 * terminal — observes that same outcome. A resolver-local cache alone would let
 * a stateful getter give validation, migrations and the query engine different
 * declaration truth.
 *
 * Only settled outcomes live here. The resolver decides whether a return is a
 * registered model and attaches its own model/field path to any issue, so
 * contextual diagnostics are never cached on the shared terminal.
 */
export function createTargetSettlement(
  readGetter: (variantKey: string | undefined) => unknown
): (variantKey?: string) => unknown {
  const cells = new Map<string, SettledTarget>();
  return (variantKey?: string): unknown => {
    const cellKey = variantKey ?? "";
    let cell = cells.get(cellKey);
    if (cell === undefined) {
      cell = settleTargetOnce(readGetter, variantKey);
      cells.set(cellKey, cell);
    }
    if (cell.settled === "value") return cell.value;
    throw cell.error;
  };
}

function settleTargetOnce(
  readGetter: (variantKey: string | undefined) => unknown,
  variantKey: string | undefined
): SettledTarget {
  // READING the getter cannot fail: every `readGetter` handed to
  // {@link createTargetSettlement} is one property read over frozen
  // declaration state. INVOKING it can, and that is the one `try` below.
  const getter = readGetter(variantKey);
  // The read still may not produce one: a variant asked without a key or with
  // an unknown one has no entry, and a forged state can carry a non-function
  // target where the factories admit only a getter. Settling that as a failure
  // is what keeps every later consumer from re-reading a target that can never
  // resolve — and from reading `undefined` as a resolved one.
  if (typeof getter !== "function") {
    return {
      settled: "error",
      error: new Error("Relation target getter is not a function"),
    };
  }
  try {
    return { settled: "value", value: getter() };
  } catch (thrown) {
    return {
      settled: "error",
      error: normalizeThrown(
        thrown,
        "Relation target getter threw a non-Error value"
      ),
    };
  }
}

/**
 * One normalization, owned here: a thrown `Error` keeps its identity across
 * every consumer, and a non-Error throw becomes exactly one `Error` that every
 * consumer then shares.
 */
function normalizeThrown(thrown: unknown, nonErrorPrefix: string): Error {
  if (thrown instanceof Error) return thrown;
  let rendered: string;
  try {
    rendered = typeof thrown === "symbol" ? thrown.toString() : String(thrown);
  } catch {
    rendered = "<unrenderable non-Error value>";
  }
  return new Error(`${nonErrorPrefix}: ${rendered}`);
}
