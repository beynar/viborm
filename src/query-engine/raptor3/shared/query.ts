import { assembleAdapterSelect } from "@adapters/adapter-internals";
import type { DatabaseAdapter, EngineFacts } from "@adapters/database-adapter";
import type { DriverResultParser } from "@drivers/exports";
import type { Dialect } from "@drivers/types";
import {
  QueryEngineError,
  TransactionError,
  UnsupportedOperationError,
  ValidationError,
  VibORMError,
} from "@errors";
import type { PreparedDomain } from "@extensions/row-domain";
import {
  DISTANCE_SELECTED_TWICE,
  selectedArm,
} from "@query-engine/result/result-shape";
import {
  EMPTY_ROW_RESULT_KEY,
  gateResultKey,
  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
} from "@query-engine/result-aliases";
import { fieldRefPayload, formatFieldRef, isFieldRef } from "@schema/field-ref";
import { jsonNullKindOf } from "@schema/json-null";
import {
  type AnyModel,
  findAddressableKey,
  getModelKeyCatalog,
  type OrderedModelKey,
} from "@schema/model";
import { slotMayBeEmpty } from "@schema/relation/clearability";
import type { Scalar } from "@schema/scalars/base";
import type { ScalarState } from "@schema/scalars/common";
import type { NativeTypeDeclaration } from "@schema/scalars/native-types";
import type {
  ResolvedSlot,
  ResolvedVariantEdge,
} from "@schema/validation/relation-resolution";
import { Sql, sql } from "@sql";
import { projectableScalarNames } from "@validation/model/core/projection";
import { normalizeBinaryValue } from "@validation/primitives/binary-shapes";
import {
  type DateTimePhysicalForm,
  decodePhysicalDateTime,
  decodeProviderTimestamp,
} from "@validation/primitives/datetime-physical-codec";
import {
  isDateTimeClock,
  isDateTimeInstant,
} from "@validation/primitives/datetime-values";
import { validateGeoPoint } from "@validation/primitives/geo-point-codec";
import {
  carriesRepeatedKey,
  DEFAULT_MAX_OCCURRENCES,
  type NormalizedRecurrence,
} from "@validation/relations/recurrence";
import type { SqlSlot } from "../../../sql/slot";
import type { Operation } from "../../types";
import {
  type DecimalDescriptor,
  decodeDecimalList,
  decodeDecimalScalar,
  exactDecimalDomain,
  sameDecimalDomain,
} from "./decimal";
import {
  decodeIdentifier,
  type IdentifierColumn,
  identifierColumn,
  incomparableIdentifiers,
} from "./identifier";
import type { ModelSql } from "./insert-value";
import {
  type CallScope,
  type CallValues,
  Condition,
  Existence,
  OuterColumn,
  Parameter,
  type RowJudgement,
  type RowPurpose,
} from "./row-scope";
import {
  type Arguments,
  type EngineSchema,
  entries,
  type Input,
  memo,
  type QueryViews,
  type ReadOperation,
  record,
} from "./schema";
import {
  bindMembership,
  type Membership,
  type PhysicalField,
  physicalField,
} from "./storage";
import { listed, nameOf, same, scalarsOf, tableOf } from "./terms";

/** `Object.freeze`, named once for what an extension states and shares. */
export const freeze = Object.freeze;

export type Leaf = {
  kind: "scalar";
  type: string;
  nullable: boolean;
  /**
   * The DECLARING scalar, for consumers that compile a value codec from it.
   *
   * The fields beside it are a projection of this object's state, which SQL
   * lowering and row decoding read; a codec owner such as
   * a result value codec is addressed by the object itself and must
   * never re-dispatch on `type`, which would be a second scalar-meaning
   * authority (g4/unit03/note.md FU.6 B-1c). Absent on the leaves no declared
   * scalar produces — `_count`, `exist`, a non-decimal `_avg`, `_distance` —
   * whose meaning is the aggregate's, not a column's.
   */
  scalar?: Scalar;
  /** A list column: the container decodes once, then each member as `type`. */
  list?: boolean;
  decimal?: DecimalDescriptor;
  /**
   * A `_sum` answering outside the field's domain: a decimal keeps the field
   * scale and drops its precision, a bigint may leave the int64 range, a
   * number may be `±Infinity`, and an int past 2^53 is the nearest double, as
   * a number sum is; `splitSum` states which travel as two parts.
   */
  widened?: boolean;
  /** The declared physical timestamp spelling of this column. */
  dateTime?: DateTimePhysicalForm;
  /**
   * The column's identifier domain and what it physically holds, resolved
   * once per (adapter, model, field) — a foreign key's DERIVED domain and a
   * private carrier column's referenced key included (`identifier.ts`).
   */
  id?: IdentifierColumn;
  enumValues?: ReadonlySet<string>;
  dimension?: number;
};
export type ProjectionShape =
  | {
      kind: "object";
      /**
       * `false` where the statement ALWAYS builds this document and says so —
       * a relation `_count` carrier. A provider `null` there is a malformed
       * row, not an absent relation. Left unset (nullable) everywhere a row
       * may genuinely be absent: a to-one relation, a variant arm. An
       * aggregate carrier (`_count`/`_sum`/`_avg`/`_min`/`_max` of
       * `aggregate`/`groupBy`) is always built too but is left unset, so a
       * provider `null` there publishes `null`: a compatibility answer
       * `tests/raptor3/result-decoder.test.ts` pins, not a stated contract.
       */
      nullable?: boolean;
      fields: Record<string, ProjectionShape | Leaf>;
      /**
       * Read-gated members (K5): each is present only where its gate, one of
       * `gates`, reads true; where it reads false the member is left out, or,
       * when the caller named it, the read fails at `refused`.
       */
      gated?: Readonly<Record<string, GatedMember>>;
      /** The boolean members the row carries for `gated`, never published. */
      gates?: readonly string[];
    }
  | CollectionShape
  | {
      kind: "variants";
      /** The public slot, for the refusal that names it. */
      relation: string;
      many: false;
      arms: Record<string, ProjectionShape>;
    }
  | {
      kind: "variants";
      relation: string;
      /** A junction-carried slot: each arm is a collection of its rows. */
      many: true;
      arms: Record<string, CollectionShape>;
    }
  | {
      kind: "recursive";
      relation: string;
      many: boolean;
      optional: boolean;
      recurrence: NormalizedRecurrence;
      row: ProjectionShape;
      identity: readonly Leaf[];
    };
export type Shape = ProjectionShape;
/** One read-gated member of a document: its gate, and the path a caller named it at. */
export interface GatedMember {
  readonly gate: string;
  readonly refused?: string;
}
/** A to-many relation's rows. */
type CollectionShape = {
  kind: "collection";
  /** A negative `take` runs a reversed window; the decoder restores it. */
  reversed?: boolean;
  row: ProjectionShape;
};
/**
 * A physical value's provider continuation ({@link Queries.fieldReader}),
 * bound to one execution's driver and adapter.
 */
type FieldReader = (value: unknown) => unknown;
/**
 * One placement of the projection language, compiled for one decoded batch
 * ({@link Queries.compileReader}): it reads the provider's value there and
 * answers the public one.
 */
export type Reader = (value: unknown) => unknown;
type RelationProjectionArguments = Pick<
  Partial<Arguments>,
  "orderBy" | "take" | "skip" | "cursor" | "distinct"
> & {
  readonly selector?: Pick<PreparedSelector, "model" | "predicate">;
};
/** The link row columns one relation node reads: `$through`. */
interface PreparedLinkRow {
  readonly model: AnyModel;
  readonly fields: readonly string[];
  readonly shape: Extract<ProjectionShape, { kind: "object" }>;
}
export interface PreparedRelationProjection {
  readonly edge: Membership;
  readonly linkRow?: PreparedLinkRow;
  /** A nested `where`'s `$through`, tested on the link this page joins. */
  readonly linkWhere?: Pick<PreparedSelector, "model" | "predicate">;
  readonly arguments: RelationProjectionArguments;
  readonly projection: PreparedProjection;
  readonly recurrence?: NormalizedRecurrence;
}
/** One counted slot: its memberships, and the filter that narrows them. */
export type PreparedCount = {
  readonly relation: string;
  /** Every membership the slot counts: one edge, or every variant arm. */
  readonly edges: readonly Membership[];
  readonly selector?: Pick<PreparedSelector, "model" | "predicate">;
  /** A tagged `isNot` counts the arm's members the selector does NOT match. */
  readonly negated?: true;
};
export type PreparedProjectionField =
  | { readonly kind: "scalar"; readonly name: string }
  | {
      /**
       * The sentinel column of an EMPTY default projection. A model whose
       * every scalar is omitted still has rows, and `SELECT  FROM …` is a
       * syntax error, so one constant column carries the row's existence. It
       * is not in the decoder's shape, so the caller reads `{}`.
       */
      readonly kind: "sentinel";
      readonly name: string;
    }
  | {
      readonly kind: "counts";
      readonly name: string;
      readonly counts: readonly PreparedCount[];
    }
  | {
      /**
       * A declared projection key (K5): per row, whether each named
       * predicate holds beside the layer's `read`, or, `ordered`, the last
       * name that does.
       */
      readonly kind: "evidence";
      readonly name: string;
      readonly evidence: DeclaredEvidence;
      readonly names: readonly (readonly [string, Input])[];
    }
  | {
      /** A read-gated member's gate (K5): a boolean the decoder reads. */
      readonly kind: "gate";
      readonly name: string;
      readonly gate: FieldGate;
    }
  | {
      readonly kind: "distance";
      readonly name: string;
      readonly field: string;
      readonly specification: Input;
    }
  | ({
      readonly kind: "relation";
      readonly name: string;
    } & PreparedRelationProjection)
  | {
      readonly kind: "variants";
      readonly name: string;
      readonly many: boolean;
      readonly arms: readonly ({
        readonly variant: string;
      } & PreparedRelationProjection)[];
      /**
       * Every CONFIGURED member of a junction-carried slot, selected or not:
       * the subjects of the integrity probe (Arnaud's D-26). `only` selects
       * what is READ, never what is TRUE, so this list is not the arms'.
       */
      readonly memberships: readonly {
        readonly variant: string;
        readonly edge: Extract<Membership, { kind: "junction" }>;
      }[];
    };
export interface PreparedProjection {
  readonly model: AnyModel;
  readonly fields: readonly PreparedProjectionField[];
  readonly shape: Extract<ProjectionShape, { kind: "object" }>;
}

/**
 * May this prepared projection ride a mutation's `RETURNING`?
 *
 * The projection owner answers, because the answer is a property of how each
 * field LOWERS: a scalar is a column of the mutated row, while a relation
 * carrier, a variant slot and a `_count` all read OTHER rows through a
 * correlated subquery, which no `RETURNING` carries. A physical owner asking
 * "does this name a relation?" was the same question answered a second time.
 *
 * This is the RELOCATION of that one kind-test into the module that owns the
 * kinds — not a new per-field fact and not a wider rule. A `_distance` is an
 * expression over the mutated row's own columns and could ride a `RETURNING`,
 * but no provider in the qualified set declares the distance tier, so nothing
 * can witness that arm; it stays outside the gate until one can.
 */
export function returningSafeProjection(
  projection: PreparedProjection
): boolean {
  return projection.fields.every(
    (field) => field.kind === "scalar" || field.kind === "sentinel"
  );
}
/**
 * May decoding this projection REFUSE a row its statement already answered?
 * A read-gated member (`GatedFieldRefusal`), a recursive relation (its output
 * budget, a rejected cycle) and a variant slot (its integrity probe) each
 * raise while decoding, after the statement. A write that answers its
 * projection in its own statement (`OperationContext.answersInStatement`)
 * could not roll back under such a refusal, so this owner says which do. A
 * malformed provider result is not counted: it is no refusal of the row.
 */
export function refusesWhileDecoding(projection: PreparedProjection): boolean {
  return projection.fields.some(
    (field) =>
      field.kind === "gate" ||
      field.kind === "variants" ||
      (field.kind === "relation" &&
        (field.recurrence !== undefined ||
          refusesWhileDecoding(field.projection)))
  );
}
export interface Query {
  sql: Sql;
  shape: Shape;
  expectedRows?: {
    readonly count: number;
    readonly missing: Error;
  };
}
/** What a {@link Queries.select} takes beyond its arguments. */
export interface SelectControls {
  forUpdate?: boolean;
  identity?: Input;
  projection?: PreparedProjection;
  selector?: Pick<PreparedSelector, "model" | "predicate">;
  /** Rows this selector does not take, NULL read as not taken. */
  unless?: Pick<PreparedSelector, "model" | "predicate">;
  /** The rows the read takes: its selector and cursor anchor under it. */
  purpose?: RowPurpose;
  /**
   * The relation the root row is read FROM in place of the model's table: a
   * `WITH` member of the same statement carrying the table's columns (a
   * write's `RETURNING *`, `OperationContext`'s projection over its own write).
   */
  source?: string;
}
/**
 * What writes a read in a database's language. {@link Queries} is the SQL one;
 * a driver supplies another through `driver.backend`. It takes the admitted
 * arguments and answers one statement with its shape, and decoding stays shared.
 */
export interface ReadBackend {
  read(model: AnyModel, operation: ReadOperation, args: Arguments): Read;
}
/** One statement plus the operation's own cardinality and public shape. */
export interface Read {
  readonly query: Query;
  /**
   * Does this verb publish ONE value rather than the row set? Stated here, by
   * the owner that decides the cardinality, so no consumer re-derives it.
   */
  readonly single: boolean;
  /**
   * The PUBLIC value's own shape — which is not always the row shape
   * `query.shape` decodes: `count` publishes a number and `exist` a boolean
   * over a row of `{_count}`, and `findMany`/`groupBy` publish the set of rows.
   */
  readonly value: ProjectionShape | Leaf;
  result(rows: Input[]): unknown;
}
/**
 * What a write asks of a selector before it trusts what it knows of a row:
 * the row's own fields the selector reads, the values every row it takes
 * holds, and the relations it reads other rows through.
 */
export interface SelectorFacts {
  fields: Set<string>;
  /**
   * The literal equalities the selector's own conjunction states: what every
   * row it takes holds. An equality under an `OR` or a `NOT`, or inside a
   * relation's body, is none.
   */
  equals: Map<string, unknown>;
  /**
   * The admitted unique selector's DISCRIMINATOR pins: the literal equality of
   * every `key: true` prepared column, which is exactly what the shipped
   * `partitionWhereUnique` files under `entries`
   * (`write-engine/shared.ts:154-166`). An extended `where`'s filter half and
   * every entry of a selector admitted as a filter are absent by
   * construction: they are `equals` and not a pin.
   */
  keys: Map<string, unknown>;
  exact: boolean;
  /** The models, and the junction tables, whose rows the selector reads besides its own row. */
  reads: Set<AnyModel | string>;
}
/** Expressions compared as one: a row value, or the expression itself alone. */
export function rowValue(items: Sql[]): Sql {
  return items.length === 1 ? items[0]! : sql`(${listed(items)})`;
}
/** Every column of `query`, read through a derived table named `alias`. */
export function throughDerived(
  adapter: DatabaseAdapter,
  query: Sql,
  alias: string
): Sql {
  return assembleAdapterSelect(adapter, {
    columns: sql.raw("*"),
    from: adapter.subqueries.correlate(query, alias),
  });
}
export function newSelectorFacts(exact = true): SelectorFacts {
  return {
    fields: new Set(),
    equals: new Map(),
    keys: new Map(),
    exact,
    reads: new Set(),
  };
}
/**
 * The facts of what `facts`' selector holds apart: an arm of an `OR` or a
 * `NOT` (`own`: it reads the same row's fields), a relation's body. It reads
 * what the selector reads and pins nothing of the selector's row.
 */
const apart = (facts: SelectorFacts, own = false): SelectorFacts => ({
  ...newSelectorFacts(false),
  reads: facts.reads,
  ...(own && { fields: facts.fields }),
});
export type PreparedScalar = {
  readonly model: AnyModel;
  readonly field: string;
  readonly physical: PhysicalField;
};
export type PreparedOperand =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "field";
      readonly scalar: PreparedScalar;
      /** An enclosing row's column: how many relation bodies above (`$row`). */
      readonly up?: number;
    }
  /**
   * A call value of a domain predicate, read at lowering; `spread` when it is
   * a whole `in`/`notIn` list, one value operand per member once read.
   */
  | {
      readonly kind: "parameter";
      readonly parameter: Parameter;
      readonly spread?: true;
    }
  | {
      readonly kind: "sql";
      readonly strings: readonly string[];
      readonly operands: readonly Extract<
        PreparedOperand,
        { kind: "value" | "field" }
      >[];
    };
/** An operand as lowering reads it: every parameter's value read. */
export type BoundOperand = Exclude<PreparedOperand, { kind: "parameter" }>;
/**
 * What a prepared operator compares. A physical column, a JSON value addressed
 * inside one, and an aggregate over a column are three targets of the SAME
 * operator vocabulary — `where` and `having` never interpret operators twice.
 */
/** A scalar column's declared state, as the lowering reads it. */
export type ScalarStateOf = PreparedScalar["physical"]["scalar"]["~"]["state"];
export type PreparedTarget =
  | {
      readonly kind: "column";
      readonly scalar: PreparedScalar;
      readonly path?: readonly string[];
      /**
       * The column is addressed as a member of a unique `where`'s DISCRIMINATOR
       * rather than as a filter, so the comparison is the CONSTRAINT's, not the
       * engine's text contract: it names the row the provider's own unique
       * index holds under this value.
       *
       * A byte-exact conjunct here would ask a stricter question than the index
       * that answers it — on a case-insensitive collation a probe could report
       * a key free and the very next INSERT be rejected for duplicating it —
       * so the shipped engine spells exactly this half with the dialect's plain
       * equality (`buildUniqueEquality`, `builders/where-unique-builder.ts:213`)
       * and leaves the extended `where`'s filter half to `buildWhere`.
       */
      readonly key?: true;
    }
  | {
      readonly kind: "aggregate";
      readonly aggregate: Aggregate;
      readonly scalar?: PreparedScalar;
    };
/**
 * A recursive relation filter's range ({@link PreparedPredicate}), and
 * whether its author stated it selective ({@link NormalizedRecurrence}).
 */
export type Closure = {
  readonly depth: number | false;
  readonly self: boolean;
  readonly selective?: true;
};
/** A row read through columns a walk or a key set carries, by field. */
export type CarriedRow = (field: string) => Sql;
export type PreparedPredicate =
  | {
      readonly kind: "and" | "or";
      readonly predicates: readonly PreparedPredicate[];
    }
  | { readonly kind: "not"; readonly predicate: PreparedPredicate }
  | { readonly kind: "always"; readonly value: boolean }
  /** A test of a call value that reads no column. */
  | { readonly kind: "condition"; readonly condition: Condition }
  | {
      /**
       * Whether some row of `model` the call may see holds `predicate` (any
       * row without one): reads no column of the row it judges, so it is
       * the same everywhere in a statement (`$exists`).
       */
      readonly kind: "exists";
      readonly model: AnyModel;
      readonly predicate?: PreparedPredicate;
    }
  | {
      /**
       * One layer's domain predicate for `model`, the unit R6 judges: what
       * made it says what it is for a call (`resolve`: `undefined` where the
       * call drops it), over the row read under `alias` where one is given.
       * While it lowers, its relation reads take every other layer at its
       * default and never this one (R5).
       */
      readonly kind: "layer";
      readonly layer: number;
      readonly model: string;
      readonly predicate: PreparedPredicate;
      readonly resolve: (
        queries: Queries,
        alias?: string
      ) => PreparedPredicate | undefined;
    }
  | {
      readonly kind: "operation";
      readonly operator: string;
      readonly target: PreparedTarget;
      readonly operand?: PreparedOperand;
      readonly operands?: readonly PreparedOperand[];
      readonly value?: unknown;
      readonly insensitive?: boolean;
      /**
       * Set on a bounded GeoPoint `distance` filter in POSITIVE polarity: the
       * comparison implies the bounding box of its smallest finite upper
       * bound, so the box is a conjunct the provider can answer from the
       * spatial index. Under a negation the box would be part of what is
       * negated, which is why polarity is a preparation fact and not a
       * lowering guess.
       */
      readonly probe?: true;
    }
  | {
      readonly kind: "relation";
      readonly edge: Membership;
      readonly quantifier: string;
      readonly predicate?: PreparedPredicate;
      /**
       * The relation is correlated by membership alone: the predicate states
       * which members count itself, so the lowering `Queries`' domain never
       * joins it (a premise that names its own visibility).
       */
      readonly unscoped?: true;
      /**
       * The quantifier ranges over the edge's CLOSURE from the parent row: the
       * rows 1..`depth` hops away (every hop when `depth` is false), and the
       * parent itself when `self` holds. The cycle policy is deliberately not
       * carried: a set does not depend on the paths that reach it.
       */
      readonly closure?: Closure;
      /**
       * `$through`: what the link row joining each target must hold, tested
       * with the target's own conditions on that one link. A model's scalars
       * only, so it reads no other row and no bound ever narrows it.
       */
      readonly link?: PreparedPredicate;
      readonly linkFields?: readonly string[];
    }
  | {
      /** The first `limit` rows of `selector` in key order ({@link Queries.window}). */
      readonly kind: "window";
      readonly selector: PreparedSelector;
      readonly limit: number;
    };
export type OperationPredicate = Extract<
  PreparedPredicate,
  { kind: "operation" }
>;
/** An operation as lowering reads it ({@link Queries.lowerOperation}). */
export type BoundOperation = Omit<
  OperationPredicate,
  "operand" | "operands"
> & {
  readonly operand?: BoundOperand;
  readonly operands?: readonly BoundOperand[];
};
/**
 * A conjunction of nothing states nothing; every other prepared predicate is a
 * condition. This is the one reading of "this arm built no condition" that the
 * shipped builders express by answering `undefined`
 * (`builders/where-builder.ts:217-308`, `operations/groupby-having.ts:77-173`).
 */
export function states(predicate: PreparedPredicate): boolean {
  if (predicate.kind === "layer") return states(predicate.predicate);
  return predicate.kind !== "and" || predicate.predicates.some(states);
}
/**
 * An `OR` whose every arm is one value equality on the same plain column, as
 * that column's `in` (platform-15): the same three-valued answer, so a long
 * chain binds as the one list `in` binds instead of one arm per expression
 * level. A JSON, list, point or vector column compares by its own rules, a
 * folded or referenced operand is not a member, and `null` is `IS NULL`.
 */
function sameColumnIn(
  arms: readonly PreparedPredicate[]
): PreparedPredicate | undefined {
  const operands: PreparedOperand[] = [];
  let target: Extract<PreparedTarget, { kind: "column" }> | undefined;
  for (let arm of arms) {
    while (arm.kind === "and" && arm.predicates.length === 1)
      arm = arm.predicates[0]!;
    const operand = arm.kind === "operation" ? arm.operand : undefined;
    if (
      arm.kind !== "operation" ||
      arm.operator !== "equals" ||
      arm.insensitive ||
      arm.target.kind !== "column" ||
      arm.target.path ||
      operand?.kind !== "value" ||
      operand.value === null ||
      operand.value instanceof Sql ||
      (target &&
        (arm.target.scalar.model !== target.scalar.model ||
          arm.target.scalar.field !== target.scalar.field ||
          arm.target.key !== target.key))
    )
      return;
    target ??= arm.target;
    operands.push(operand);
  }
  const state = target?.scalar.physical.state;
  if (
    !target ||
    state?.array === true ||
    state?.type === "json" ||
    state?.type === "point" ||
    state?.type === "vector"
  )
    return;
  return {
    kind: "operation",
    operator: "in",
    target,
    operands,
    insensitive: false,
  };
}
type RelationPredicate = Extract<PreparedPredicate, { kind: "relation" }>;
/** One row a predicate being lowered reads ({@link Queries}' `#frames`). */
export interface LoweringFrame {
  readonly alias: string | undefined;
  escaped: boolean;
  joins?: Sql[] | undefined;
}
/**
 * The quantifiers one connective merges over the same relation: `EXISTS` is
 * two-valued and `EXISTS (… WHERE A) OR EXISTS (… WHERE B)` holds exactly
 * where some member makes `A` or `B` TRUE, which is `EXISTS (… WHERE (A OR
 * B))`, whatever `A` and `B` answer for a member (NULL included), for an
 * empty set (both false) and for a NULL key (no member). So `some A OR some
 * B` is `some (A OR B)`, `is` likewise, and, negated, `none A AND none B` is
 * `none (A OR B)`, `isNot` likewise. `every` and a body-less `is`/`isNot`
 * (the presence test) are not here.
 */
const MERGED_QUANTIFIERS = {
  or: new Set(["some", "is"]),
  and: new Set(["none", "isNot"]),
} as const;
/** The arms of a `kind` connective, through nested ones and one-member `and`s. */
function connectiveArms(
  kind: "and" | "or",
  arms: readonly PreparedPredicate[],
  into: PreparedPredicate[]
): PreparedPredicate[] {
  for (let arm of arms) {
    while (arm.kind === "and" && arm.predicates.length === 1)
      arm = arm.predicates[0]!;
    if (arm.kind === kind) connectiveArms(kind, arm.predicates, into);
    else into.push(arm);
  }
  return into;
}
/** Do two quantifiers range over the same rows: edge, quantifier, scope, walk? */
function sameRange(left: RelationPredicate, right: RelationPredicate): boolean {
  return (
    // A body is merged over one range; a link condition belongs to its own.
    left.link === undefined &&
    right.link === undefined &&
    left.edge === right.edge &&
    left.quantifier === right.quantifier &&
    left.unscoped === right.unscoped &&
    (left.closure === undefined
      ? right.closure === undefined
      : right.closure !== undefined &&
        left.closure.depth === right.closure.depth &&
        left.closure.self === right.closure.self)
  );
}
/**
 * The arms of a `kind` connective with every group of quantifiers over the
 * same range ({@link MERGED_QUANTIFIERS}) merged into the first of them, its
 * body the disjunction of theirs in their order; `undefined` where no two
 * merge, so a connective with nothing to merge keeps its own structure. The
 * merged relation states one subquery (and one recursive walk) where each
 * arm stated its own: an acceptance rule's three ancestor walks per
 * document level become two.
 */
export function mergeQuantifiers(
  kind: "and" | "or",
  arms: readonly PreparedPredicate[]
): PreparedPredicate[] | undefined {
  const quantifiers: ReadonlySet<string> = MERGED_QUANTIFIERS[kind];
  let candidates = 0;
  for (const arm of arms) candidates += quantifiedArms(arm, kind, quantifiers);
  if (candidates < 2) return;
  const merged: PreparedPredicate[] = [];
  const groups: {
    readonly at: number;
    readonly head: RelationPredicate;
    readonly bodies: PreparedPredicate[];
    /** A merged walk's seeds are every arm's: few only where each is. */
    selective: boolean;
  }[] = [];
  for (const arm of connectiveArms(kind, arms, [])) {
    if (
      arm.kind === "relation" &&
      arm.predicate !== undefined &&
      quantifiers.has(arm.quantifier)
    ) {
      const group = groups.find(({ head }) => sameRange(head, arm));
      if (group) {
        group.bodies.push(arm.predicate);
        group.selective &&= arm.closure?.selective === true;
        continue;
      }
      groups.push({
        at: merged.length,
        head: arm,
        bodies: [arm.predicate],
        selective: arm.closure?.selective === true,
      });
    }
    merged.push(arm);
  }
  let changed = false;
  for (const { at, head, bodies, selective } of groups) {
    if (bodies.length === 1) continue;
    changed = true;
    const { closure } = head;
    merged[at] = {
      ...head,
      predicate: disjunction(bodies),
      ...(closure?.selective &&
        !selective && {
          closure: { depth: closure.depth, self: closure.self },
        }),
    };
  }
  return changed ? merged : undefined;
}
/** How many arms of a `kind` connective `arm` holds that may merge. */
function quantifiedArms(
  arm: PreparedPredicate,
  kind: "and" | "or",
  quantifiers: ReadonlySet<string>
): number {
  if (arm.kind === "relation")
    return arm.predicate !== undefined && quantifiers.has(arm.quantifier)
      ? 1
      : 0;
  if (arm.kind !== kind && !(arm.kind === "and" && arm.predicates.length === 1))
    return 0;
  let count = 0;
  for (const member of arm.predicates)
    count += quantifiedArms(member, kind, quantifiers);
  return count;
}
/** `predicates` AND-ed, as they stand. */
export const conjunction = (
  predicates: readonly PreparedPredicate[]
): PreparedPredicate => ({ kind: "and", predicates });
/**
 * `arms` OR-ed: one column's `in` ({@link sameColumnIn}), the quantifiers
 * over one relation merged ({@link mergeQuantifiers}), or the `or` itself.
 */
function disjunction(arms: readonly PreparedPredicate[]): PreparedPredicate {
  const sameColumn = sameColumnIn(arms);
  if (sameColumn) return sameColumn;
  const merged = mergeQuantifiers("or", arms);
  if (merged === undefined) return { kind: "or", predicates: arms };
  return merged.length === 1 ? merged[0]! : { kind: "or", predicates: merged };
}
/** Does the predicate read another row: a relation subquery anywhere in it? */
export function readsRelation(predicate: PreparedPredicate): boolean {
  switch (predicate.kind) {
    case "relation":
    case "exists":
      return true;
    case "and":
    case "or":
      return predicate.predicates.some(readsRelation);
    case "not":
    case "layer":
      return readsRelation(predicate.predicate);
    default:
      return false;
  }
}
/**
 * The smallest FINITE upper bound a distance filter states, or `undefined`
 * when it states none. A bound of zero or less bounds nothing worth probing:
 * the box degenerates to the point itself.
 */
export function distanceUpperBound(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { lt, lte } = value as { lt?: unknown; lte?: unknown };
  const bounds = [lt, lte].filter(
    (bound): bound is number => typeof bound === "number" && bound > 0
  );
  return bounds.length === 0 ? undefined : Math.min(...bounds);
}
/**
 * A membership the parent claims whose row is gone.
 *
 * The statement answers a claimed arm with a document and an unclaimed one
 * with `null`, so an EMPTY document is the claim without the row. The test is
 * the arm's own selected keys — a shape that requests fields and receives none
 * — and never a private carrier column (Arnaud's D-19).
 */
function orphanedArm(carrier: unknown, arm: ProjectionShape): boolean {
  if (arm.kind !== "object" || carrier === null || carrier === undefined)
    return false;
  const document = providerJson(carrier);
  if (typeof document !== "object" || document === null) return false;
  return (
    Object.keys(document).length === 0 && Object.keys(arm.fields).length > 0
  );
}
/**
 * A structured value — a document, a collection, a variant slot, a recursive
 * carrier, or a vector or point scalar — as the provider handed it: a driver
 * that does not parse JSON itself hands back the value's TEXT, which is parsed
 * here once, and any other value is already the parsed structure.
 */
export function providerJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
/**
 * The ONE reading of a provider DOCUMENT, whatever carries it: a root row, a
 * relation, `_count` or aggregate carrier, a collection row, a variant slot,
 * its integrity entry and each of its arms, a recursive node row, the
 * recursive carrier and each of its node and edge entries. A document is an
 * object that is not an array, and its members are then read by {@link own}.
 * `null` is answered as itself, because only the placement knows whether its
 * shape permits it; anything else is no document (`undefined`), which the
 * placement refuses in its own registered sentence. The one placement that
 * may be ABSENT is the integrity entry, which a slot without junction
 * memberships does not carry; a present one is refused like any other.
 */
export function providerDocument(value: unknown): Input | null | undefined {
  if (value === null) return null;
  return typeof value === "object" && !Array.isArray(value)
    ? record(value)
    : undefined;
}
/**
 * One member of a provider document, read with OWN-key semantics. An omitted
 * field is absent, whatever `Object.prototype` happens to carry under that
 * name.
 */
export function own(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}
/**
 * The ONE cursor-eligibility sentence, raised from the order walker for a key
 * whose lowering would consult a provider capability, and from
 * {@link Queries.page} for every other non-scalar key.
 */
export const CURSOR_ORDER_REFUSAL =
  "Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported.";
/** A disjunction of nothing is FALSE; it is the one predicate that says so. */
export const VACUOUS_FALSE: PreparedPredicate = {
  kind: "always",
  value: false,
};
/** One normalized sort key; `field` marks a direct scalar a cursor can use. */
export interface OrderTerm {
  readonly expression: Sql;
  readonly descending: boolean;
  /**
   * The placement the caller spelled. Unspelled is not a placement: the bare
   * direction names the provider's own default, and only a windowed read —
   * whose cursor predicate must read the same total order — states one.
   */
  readonly nulls?: "first" | "last";
  /**
   * Set when `nulls` belongs to the expression instead of to the caller: a
   * reversed window flips the caller's placement and leaves this one alone,
   * because the shipped engine reverses the input `sort` only
   * (`operations/find-pagination.ts:131-151`) and `buildDistanceOrder` then
   * re-emits `nullsLast(distance, …)` (`builders/sort-order-builder.ts:36-45`).
   */
  readonly expressionNulls?: true;
  readonly nullable: boolean;
  readonly field?: string;
}
/**
 * One page's to-one order joins: the LEFT JOIN each relation path takes, in
 * the order their ON clauses need, keyed by the parent alias and the field so
 * every term on one path reads one joined row.
 */
export interface OrderJoins {
  readonly aliases: Map<string, string>;
  readonly joins: Sql[];
}
export interface PreparedSelector {
  readonly model: AnyModel;
  readonly facts: SelectorFacts;
  readonly uniqueKey?: OrderedModelKey;
  readonly uniqueValues?: ReadonlyMap<string, unknown>;
  readonly predicate?: PreparedPredicate;
  /**
   * A row domain narrowed this selector ({@link Queries.candidates}): it
   * states more than its unique key, so a consumer that would trust the key
   * alone to name the row must not.
   */
  readonly scoped?: true;
}
/** The decoder identifies the invalid value; its operation owns public errors. */
export class InvalidScalarResult extends TypeError {
  readonly scalarType: string;
  readonly reason: string;
  constructor(scalarType: string, reason: string) {
    super(`Invalid provider ${scalarType === "int" ? "integer" : scalarType}`);
    this.scalarType = scalarType;
    this.reason = reason;
  }
}

/**
 * A recursive projection decoded more occurrences under one outer row than
 * its budget (`recurse.maxOccurrences`). The decoder knows the slot; as for
 * {@link InvalidScalarResult}, its operation owns the public error.
 */
export class RecursiveOutputOverBudget extends RangeError {
  readonly relation: string;
  readonly limit: number;
  constructor(relation: string, limit: number) {
    super(`Recursive relation '${relation}' exceeds ${limit} occurrences`);
    this.relation = relation;
    this.limit = limit;
  }
  /** The result-size refusal of `operation`, which ran the projection. */
  refusal(operation: Operation, model: string): UnsupportedOperationError {
    return new UnsupportedOperationError(
      `'${operation}' would return more than ${this.limit} occurrences of recursive relation '${this.relation}' under one row, its output budget; raise recurse.maxOccurrences, lower recurse.depth or filter the relation.`,
      {
        meta: {
          model,
          operation,
          relation: this.relation,
          feature: "recursive output budget",
        },
      }
    );
  }
}

/**
 * A row the read returned lacks the gate of a field the caller named (K5,
 * OD-5): raised while decoding, after the statement and before any result.
 * Like {@link InvalidScalarResult}, its operation owns the public error.
 */
export class GatedFieldRefusal extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`The selected field at '${path}' is not readable on a returned row`);
    this.path = path;
  }
  /** The `ValidationError` of `operation`, at the path the caller named. */
  refusal(operation: Operation, model: string): ValidationError {
    return new ValidationError(
      operation,
      [{ path: this.path, message: "is not readable on a returned row" }],
      { meta: { model } }
    );
  }
}

/** The public output name of a `_distance` projection, stated once. */
const DISTANCE_FIELD = "_distance";
/**
 * The private recursive carrier's member names, stated once: the one wire
 * vocabulary the recursive lowering writes and `decodeRecursiveCarrier` reads.
 */
export const RECURSIVE_CARRIER = {
  root: "__rq_root",
  nodes: "__rq_nodes",
  edges: "__rq_edges",
  key: "__rq_key",
  row: "__rq_row",
  parent: "__rq_parent",
  child: "__rq_child",
  depth: "__rq_depth",
};
export const AGGREGATES = ["_count", "_avg", "_sum", "_min", "_max"] as const;
/**
 * The aggregate vocabulary as a TYPE, so the lowering switch over it is
 * exhaustive by construction rather than by a sentence (N4, plan §4).
 * {@link isAggregate} is the ONE narrowing of a payload key into it — the same
 * set admission enumerates (`validation/model/args/aggregate.ts`), never a
 * second one.
 */
export type Aggregate = (typeof AGGREGATES)[number];
const AGGREGATE_NAMES: ReadonlySet<string> = new Set(AGGREGATES);
export function isAggregate(name: string): name is Aggregate {
  return AGGREGATE_NAMES.has(name);
}
export const BOOLEAN_LEAF: Leaf = {
  kind: "scalar",
  type: "boolean",
  nullable: false,
};
export const COUNT_LEAF: Leaf = {
  kind: "scalar",
  type: "int",
  nullable: false,
};
const QUANTIFIERS: ReadonlySet<string> = new Set([
  "is",
  "isNot",
  "some",
  "every",
  "none",
]);
const FILTER_OPERATORS: ReadonlySet<string> = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
  "path",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "array_contains",
  "array_starts_with",
  "array_ends_with",
  "within",
  "distance",
]);

/**
 * Whether an admitted object addresses operators rather than being one whole
 * value. Only the two scalars whose own values ARE objects can be ambiguous.
 */
function addressesOperators(
  state: ScalarState | undefined,
  value: Input
): boolean {
  if (!isOperatorRecord(value)) return false;
  if (state?.type !== "json" && state?.type !== "point") return true;
  return Object.keys(value).some((key) => FILTER_OPERATORS.has(key));
}

const ARITHMETIC_UPDATES = [
  "increment",
  "decrement",
  "multiply",
  "divide",
] as const;
const LIST_UPDATES = ["push", "unshift"] as const;

/** One admitted scalar update payload, interpreted once and lowered twice. */
export type PreparedUpdate =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "arithmetic";
      readonly operator: (typeof ARITHMETIC_UPDATES)[number];
      readonly by: unknown;
    }
  | {
      readonly kind: "list";
      readonly operator: (typeof LIST_UPDATES)[number];
      readonly members: readonly unknown[];
    };

/** A plain admitted record, as opposed to one whole value of an object domain. */
function isOperatorRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The ONE answer to "does this admitted scalar payload name a whole value?",
 * boxed so `undefined` can mean "it names an operator instead".
 *
 * An admitted operator record owns its keys; a `Uint8Array`, `Decimal` or
 * `Date` inherits methods with the same names and is one whole value in EVERY
 * domain, as is a `Sql` fragment. Both consumers read this one answer —
 * {@link Queries.updateValue}'s payload interpreter, which needs to know when
 * the payload is NOT whole, and `commands/assignments.ts`'s symbolic final
 * field, which only needs the value — so the two can never disagree about what
 * `set` names.
 */
export function wholeValue(
  value: unknown
): { readonly value: unknown } | undefined {
  if (value instanceof Sql || value === null || typeof value !== "object")
    return { value };
  if (!isOperatorRecord(value)) return { value };
  return Object.hasOwn(value, "set") ? { value: record(value).set } : undefined;
}

/**
 * The ONE interpreter of an admitted scalar update payload.
 *
 * It answers WHICH operator the caller spelled and WHAT its operand is, and
 * nothing about SQL. Two lowerings consume that one answer — the provider's
 * own `SET` assignment ({@link Queries.updateAssignment}) and the same
 * operator named over an already-known value ({@link Queries.updateValue}) —
 * so an operator can never be admitted in one spelling and refused in the
 * other.
 */
export function readUpdate(value: unknown): PreparedUpdate {
  const whole = wholeValue(value);
  if (whole) return { kind: "value", value: whole.value };
  const operation = record(value);
  for (const operator of ARITHMETIC_UPDATES)
    if (Object.hasOwn(operation, operator))
      return { kind: "arithmetic", operator, by: operation[operator] };
  for (const operator of LIST_UPDATES)
    if (Object.hasOwn(operation, operator)) {
      const members = operation[operator];
      return {
        kind: "list",
        operator,
        members: Array.isArray(members) ? members : [members],
      };
    }
  // The shipped engine's own last word on an admitted payload that names no
  // operator (`builders/set-builder.ts:217-219`), identity included: the one
  // reachable shape is an empty record, and it is refused here, before any
  // statement of the update is built.
  throw new QueryEngineError(
    `Unknown update operation: ${Object.keys(operation).join(", ")}`
  );
}

/** Query scopes and output shapes share no record-identity requirement. */
/**
 * A temporal operand's WIRE form: what the ADMISSION boundary makes of it.
 *
 * A payload's instant crossed `validation/primitives/iso.ts` before it reached
 * this engine — `Date` in, ISO spelling out — and a value the engine DECODED
 * is the `Date` of that same instant, which is bound BACK whenever an
 * identity, a membership or a premise is built from a row the engine read: a
 * `dateTime` or `date` key captured on a transport without RETURNING answers
 * `UPDATE … WHERE ("id" = ? OR "id" = ?)`, and no driver binds a `Date`
 * ("SQLite3 can only bind numbers, strings, bigints, buffers, and null"). So a
 * captured instant crosses the same boundary the payload did, which spells a
 * `Date` as `Date.prototype.toISOString` produces it (`iso.ts:75`).
 *
 * That spelling addresses the row wherever the column's stored form is
 * INSTANT-valued — SQLite INTEGER/REAL, the PostgreSQL and MySQL timestamp
 * types — and wherever the payload's own spelling was that one. A TEXT-stored
 * `dateTime` admits MORE than one spelling of one instant: the same boundary
 * admits a valid ISO STRING unchanged (`ok(value)`, `iso.ts:94`) and the
 * SQLite adapter keeps that string byte for byte
 * (`sqlite-adapter.ts:288-296`), so a key written `2020-03-01T10:00:00Z` or
 * with a `+02:00` offset is stored as those bytes and `…:00.000Z` names no
 * row of its own. Nothing here re-spells it: a capture of such a column never
 * decodes to a `Date` at all, because the row decoder keeps the PROVIDER's
 * spelling for an INTERNAL read and materializes the `Date` only for a public
 * one ({@link Queries.decodeScalar}, the split the decimal arm beside it
 * already takes). A string reaches this function only to pass through, so the
 * captured identity binds the stored bytes and the spelling still has exactly
 * one owner (FC-02B, which repaired `g4/release/n5/note.md` §6's residual).
 * Every other value passes through untouched. The other captured domains bind
 * as they are — measured: `bigint`, `decimal` and `time` are already
 * provider-bindable, and `blob`, `json`, `point` and `vector` can be neither a
 * key nor a unique, so no identity carries one.
 */
export function admittedTemporal(
  value: unknown,
  admit: (value: unknown) => { value: string } | { issues: unknown }
): unknown {
  if (!(value instanceof Date)) return value;
  const admitted = admit(value);
  return "value" in admitted ? admitted.value : value;
}

/**
 * The selection a query that writes no `select` asks for: every scalar the
 * default projection's one owner (`projectableScalarNames`) keeps.
 */
function defaultSelection(model: AnyModel): Record<string, true> {
  const selection: Record<string, true> = {};
  for (const field of projectableScalarNames(model)) selection[field] = true;
  return selection;
}

export function rowSet(query: Query): ProjectionShape {
  return { kind: "collection", row: query.shape };
}

export function firstRow(rows: Input[]): Input | null {
  return rows[0] ?? null;
}

/**
 * The vector distance an index may serve approximately (`approximate: true`),
 * where a read lets it: a root `findMany`/`findFirst` whose FIRST order term is
 * that distance, nearest first, reading the first `take > 0` rows with no
 * cursor, skip or distinct. An index answers exactly that question and nothing
 * else, so everywhere else — a nested window, an aggregate, a count — the flag
 * names nothing and the read is exact. Every backend reads this one answer.
 */
export function approximateOrder(
  operation: ReadOperation,
  args: Partial<Arguments>
):
  | { readonly field: string; readonly distance: Input; readonly take: number }
  | undefined {
  let take: number | undefined;
  if (operation === "findMany") take = args.take;
  else if (operation === "findFirst") take = args.take ?? 1;
  if (
    !(take !== undefined && take > 0) ||
    args.cursor !== undefined ||
    args.skip ||
    args.distinct?.length
  )
    return undefined;
  const first = entries(args.orderBy)[0] ?? {};
  const field = Object.keys(first).find((key) => first[key] !== undefined);
  if (field === undefined) return undefined;
  const distance = record(record(first[field])._distance);
  return distance?.approximate === true && distance.sort !== "desc"
    ? { field, distance, take }
    : undefined;
}

export function aggregateRow(rows: Input[]): Input {
  return rows[0] ?? {};
}

export function rowIdentity(rows: Input[]): Input[] {
  return rows;
}

export function reversedRows(rows: Input[]): Input[] {
  return rows.reverse();
}

/** A filter read's controls: it takes the root domain's rows. */
export const ROOT_CANDIDATES = { purpose: "root" as const };

/**
 * One relation filter body a statement lowers ({@link Queries.relationExists}):
 * its key set's name and query, and each place it was lowered at, with the
 * two texts that place settles to.
 */
export interface SharedBody {
  readonly name: string;
  readonly query: Sql;
  /**
   * Read once per outer row through its key columns (a relation body), not
   * once per statement (an `$exists` body): where it reads no other shared
   * body, the adapter keeps such a member inlined where a repeated member
   * would otherwise be materialized.
   */
  readonly correlated: boolean;
  /**
   * A walk's reaching set ({@link Queries.sharedWalk}): two terms, computed
   * once by every database, so it states no form.
   */
  readonly recursive?: true;
  /**
   * A walk some place states selective ({@link NormalizedRecurrence}): the
   * same walk is the same rows wherever it is read.
   */
  selective?: true;
  readonly slots: {
    readonly slot: SqlSlot;
    readonly inline: Sql;
    readonly use: Sql;
    /** No columns for an `$exists`, which reads no row's. */
    readonly test: SetTest;
    /** A walk's: the relation body it is lowered in, if any. */
    readonly within?: Enclosing;
  }[];
}
/**
 * The relation body a walk is lowered in, once the statement knows whether
 * that body is shared (`body`): a selective walk read only inside sets
 * computed over their whole tables is computed as a set too
 * ({@link sharingBodies}).
 */
export interface Enclosing {
  body?: SharedBody;
}
/**
 * The row columns a placed body's use compares with its key set's `k`
 * columns, in their order, and whether the test holds where they are in the
 * set (`EXISTS`) or where they are not (`NOT EXISTS`).
 */
interface SetTest {
  readonly alias: string;
  readonly columns: readonly string[];
  readonly holds: boolean;
}
/**
 * A statement's relation bodies, by {@link sharedKey}, in lowering order,
 * and the slots after each alias's `FROM` item where it may join the key
 * sets it is tested against ({@link Queries.sharingBodies}).
 */
export interface SharedBodies {
  readonly byKey: Map<string, SharedBody>;
  readonly order: SharedBody[];
  readonly attach: Map<string, SqlSlot[]>;
  /**
   * The statement's root read, where it joins its key sets: its alias, and
   * its projection and `WHERE`, each place of which reads what it joins.
   */
  root?: { readonly alias: string; readonly scope: Sql };
}
/** One place a shared body was lowered at ({@link SharedBody}). */
export type PlacedBody = SharedBody["slots"][number];
/** The places one alias tests key sets on the same columns, and the sets. */
export interface TestedColumns {
  readonly test: SetTest;
  readonly bodies: SharedBody[];
  readonly placed: [SharedBody, PlacedBody][];
}
/**
 * Key sets one member flags for the groups that join it, and the relations
 * joining it saves ({@link Queries.flagging}).
 */
export interface FlagPlan {
  readonly sets: readonly SharedBody[];
  readonly groups: readonly TestedColumns[];
  readonly saves: number;
}
/** The flag members a statement joins, of those that save relations. */
export type FlagChoice = (plans: readonly FlagPlan[]) => readonly FlagPlan[];
/** A `WITH` member of key sets' flags ({@link Queries.flagging}). */
export interface FlagMember {
  readonly name: string;
  readonly query: Sql;
  readonly inlined: boolean;
}
/** How a relation filter tests its subquery, and whether that is `EXISTS`. */
export interface Quantified {
  readonly of: (query: Sql) => Sql;
  readonly holds: boolean;
}
/** `"`, `_` or `` ` ``: a character an alias token sits between. */
const aliasEdge = (code: number) => code === 34 || code === 95 || code === 96;
/**
 * `text` with each alias the per-statement counter minted renumbered in
 * order of first appearance (`renumbered` carries the order across a body's
 * runs). An alias token is `q<digits>` inside an identifier: quoted `"q1"`
 * (PostgreSQL, SQLite) or `` `q1` `` (MySQL), or within a derived name
 * (`__q1_recursive`), so between two of {@link aliasEdge}'s characters. A
 * scan, not a regular expression: keying is most of what sharing costs.
 */
function renumberAliases(
  text: string,
  renumbered: Map<string, number>
): string {
  let out = "";
  let from = 0;
  let at = text.indexOf("q");
  while (at !== -1) {
    let next = at + 1;
    if (aliasEdge(text.charCodeAt(at - 1))) {
      let end = next;
      let code = text.charCodeAt(end);
      while (code >= 48 && code <= 57) code = text.charCodeAt(++end);
      if (end > next && aliasEdge(code)) {
        const minted = text.slice(next, end);
        let local = renumbered.get(minted);
        if (local === undefined) {
          local = renumbered.size;
          renumbered.set(minted, local);
        }
        out += `${text.slice(from, next)}${local}`;
        from = end;
      }
      next = end;
    }
    at = text.indexOf("q", next);
  }
  return from === 0 ? text : out + text.slice(from);
}
/**
 * A caller's `Sql` operand as lowered, parenthesized ({@link Queries.value}):
 * text the engine did not write, so nothing in it is an alias of the
 * engine's, whatever it spells ({@link sharedKey}).
 */
class CallerText extends Sql {}
const isCallerText = (fragment: Sql): boolean => fragment instanceof CallerText;
export const callerText = (fragment: Sql): Sql =>
  new CallerText(["(", ")"], [fragment]);
const valueIds = new WeakMap<object, number>();
let nextValueId = 0;
/** A bound value as a key: a primitive by value, a `Date` by its instant, a list by its members, anything else by identity. */
function valueKey(value: unknown): string {
  if (value instanceof Date) return `d${value.getTime()}`;
  if (Array.isArray(value)) return `a${JSON.stringify(value.map(valueKey))}`;
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return `${typeof value}:${String(value)}`;
  return `o${memo(valueIds, value, () => nextValueId++)}`;
}
/**
 * Two bodies are one where their texts are equal once their aliases are
 * renumbered in order of appearance, and their values are equal: the same
 * rows of the same table under the same conditions. A body holding another
 * reads it provisionally, by its key set's name, which equal bodies share.
 * Only the engine's own text holds its aliases: a caller's `Sql` operand
 * ({@link CallerText}) is compared as written, so `'_q1_'` and `'_q2_'` stay
 * two bodies (ENG-4, review 2). Its runs are found on the fragment tree,
 * which no lowering flattens before its statement settles ({@link SqlSlot}).
 */
/** The places a statement reads a shared member unaliased, `FROM "<name>"`. */
const memberReads = new WeakSet<Sql>();
/** `name`'s member read unaliased, as a `FROM` item ({@link relations}). */
export function memberRead(a: DatabaseAdapter, name: string): Sql {
  const read = sql`${a.identifiers.escape(name)}`;
  memberReads.add(read);
  return read;
}
/**
 * How many relations `statement` references as PlanetScale's Neki counts
 * them (it refuses over 256): each `FROM` item, a table, a reference to a
 * `WITH` member or a derived table, wherever it is, a member's own counted
 * once, used or not. Every item the engine writes is either aliased by the
 * statement's counter, `"q<n>"` where it is defined (followed by anything
 * but the `.` of a column it qualifies), or one of its {@link memberReads}.
 * A caller's `Sql` operand is not counted. `visit` sees every fragment
 * read.
 */
export function relations(
  statement: Sql,
  visit?: (fragment: Sql) => void
): number {
  let count = 0;
  const { runs } = Sql.peekRuns(statement, (fragment) => {
    if (memberReads.has(fragment)) count++;
    visit?.(fragment);
    return isCallerText(fragment);
  });
  let text = "";
  for (const run of runs) text += run.opaque ? " " : run.text;
  let at = text.indexOf("q");
  while (at !== -1) {
    const quote = text.charCodeAt(at - 1);
    let end = at + 1;
    while (text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
    if (
      (quote === 34 || quote === 96) &&
      end > at + 1 &&
      text.charCodeAt(end) === quote &&
      text.charCodeAt(end + 1) !== 46
    )
      count++;
    at = text.indexOf("q", end);
  }
  return count;
}
export function sharedKey(query: Sql): string {
  const { runs, values } = Sql.peekRuns(query, isCallerText);
  const renumbered = new Map<string, number>();
  // SQL text and bound strings may contain any delimiter: each part is
  // length-prefixed (a caller's run marked `!`), after the count of runs,
  // so the tuple boundaries, array members included, survive in the key.
  let key = `${runs.length}|`;
  for (const { text, opaque } of runs) {
    const part = opaque ? text : renumberAliases(text, renumbered);
    key += `${opaque ? "!" : ""}${part.length}:${part}`;
  }
  for (const value of values) {
    const part = valueKey(value);
    key += `${part.length}:${part}`;
  }
  return key;
}

/**
 * Textual alias renumbering cannot distinguish a physical name from an
 * alias. Such schemas keep their relation bodies inline: an optimization
 * must never rename a column, table, junction or namespace in its identity.
 * An alias is `q<n>` between quotes or underscores
 * ({@link renumberAliases}), so only a name that is one, or holds one at an
 * end or between underscores, resembles it; `seq1` or `freq2` do not. A name
 * holds no quote (`isValidSchemaIdentifier`).
 */
const aliasLikeSchemas = new WeakMap<EngineSchema, boolean>();
const ALIAS_LIKE_NAME = /(?:^|_)q\d+(?:_|$)/;
const resemblesAlias = (name: string) => ALIAS_LIKE_NAME.test(name);
function hasAliasLikeNames(schema: EngineSchema): boolean {
  // Physical names are immutable for the schema lifetime, shared by every
  // bound view. Scan them once, not for each operation's Queries.
  return memo(aliasLikeSchemas, schema, () => {
    for (const [model, slots] of schema.index) {
      if (resemblesAlias(tableOf(model))) return true;
      for (const field of schema.storedFields(model))
        if (resemblesAlias(physicalField(schema, model, field).name))
          return true;
      for (const { edge } of slots.values()) {
        const junctions =
          edge.kind === "junction"
            ? [edge.topology]
            : edge.kind === "variantJunctionCarrier"
              ? edge.members.map((member) => member.topology)
              : [];
        for (const junction of junctions) {
          if (resemblesAlias(junction.table)) return true;
          for (const side of [junction.source, junction.target])
            if (
              side.members.some((member) =>
                resemblesAlias(member.junctionField)
              )
            )
              return true;
        }
      }
    }
    return false;
  });
}
/** The scalar types a value of which has one spelling: two texts that differ are two values. */
const SPELLED_ONCE: ReadonlySet<string> = new Set([
  "string",
  "enum",
  "boolean",
  "int",
  "bigint",
]);
/** No layer is lowering. */
export const NO_LAYERS: readonly number[] = [];
/** A projection that carries no gate member (K5). */
export const NO_GATES: readonly string[] = [];
export const isParameterOperand = (operand: PreparedOperand): boolean =>
  operand.kind === "parameter";

/** One layer's projection key on a model (K5), with the layer's `read`. */
export interface DeclaredEvidence {
  readonly layer: number;
  readonly read: Input;
  readonly names: readonly (readonly [string, Input])[];
  readonly ordered: boolean;
}
/**
 * What a read-gated field's row must hold, per layer gating it: the layer's
 * `read` and the field's predicate there.
 */
export type FieldGate = readonly (readonly [number, Input, Input])[];
/** A model's projection keys and read-gated fields under one domain (K5). */
export interface ProjectedFacts {
  readonly keys: ReadonlyMap<string, DeclaredEvidence>;
  readonly gates: ReadonlyMap<string, FieldGate>;
}
/**
 * The selections a caller wrote, and the read-gated fields each names (K5):
 * admission marks them by identity, as `omit` and `include` desugar every
 * node into a `select` naming every scalar. A field a selection does not mark
 * is projected where its gate holds and left out elsewhere.
 */
export const namedGatedFields = new WeakMap<object, ReadonlySet<string>>();

export const NO_RELATIONS: readonly string[] = [];
/** A relation node or body without its `$through`, which belongs to the link. */
function withoutLinkKey(map: Input): Input {
  const { $through: _taken, ...rest } = map;
  return rest;
}

/** Generated boolean sets must not inherit a provider's linear expression depth. */
export function balancedOr<T>(
  items: readonly T[],
  join: (items: readonly T[]) => T
): T {
  const build = (start: number, end: number): T => {
    if (end - start < 2) return end === start ? join([]) : items[start]!;
    const middle = start + Math.floor((end - start) / 2);
    return join([build(start, middle), build(middle, end)]);
  };
  return build(0, items.length);
}

export abstract class Queries {
  readonly schema: EngineSchema;
  readonly adapter: EngineFacts;
  readonly #views: QueryViews;
  /**
   * The DRIVER's own representation rules (D-17). Scalar meaning is owned by
   * the existing codecs, but "what shape does THIS transport hand back?" is
   * owned by the driver and the adapter — SQLite stores `json` as TEXT and
   * booleans as 0/1, MySQL hands back naive wall-clock datetimes — and that
   * chain is declared, implemented by every adapter and driver, and was
   * reached by nothing. The decoder asks it once per row value, at the row
   * boundary, and never for a value a JSON window already decoded.
   */
  protected readonly result: DriverResultParser | undefined;
  /**
   * The row domain this `Queries` reads under: every to-many relation it
   * correlates, and every root read or lookup that names a purpose. Absent on
   * every path of a client without `rows`.
   */
  readonly domain: PreparedDomain | undefined;
  /** The call whose values the domain's parameters read. */
  readonly #call: CallScope | undefined;
  /**
   * The layers whose predicates are lowering here, outermost first: inside
   * one, a relation read takes every other layer at its default (R5). On this
   * `Queries`, so the statement keeps its one alias counter.
   */
  protected excluded: number[] | undefined;
  protected readonly sharesBodies: boolean;
  constructor(
    schema: EngineSchema,
    adapter: EngineFacts,
    result?: DriverResultParser,
    domain?: PreparedDomain,
    call?: CallScope
  ) {
    this.schema = schema;
    this.adapter = adapter;
    this.#views = schema.queryViews(adapter);
    this.result = result;
    this.domain = domain;
    this.#call = call;
    this.sharesBodies =
      adapter.capabilities.sharesRelationBodies === true &&
      !resemblesAlias(adapter.namespace ?? "") &&
      !hasAliasLikeNames(schema);
  }
  /**
   * The order the call's extensions give `model`'s reads when the caller
   * states none (the `order` capability), else `undefined`.
   */
  protected defaultOrder(model: AnyModel): Arguments["orderBy"] {
    return this.domain?.rows.order?.get(nameOf(model)) as
      | Arguments["orderBy"]
      | undefined;
  }
  abstract under(domain: PreparedDomain, call?: CallScope): Queries;
  /**
   * The domain predicate a lowering-time read takes for `model`: the call's
   * own outside every layer, under `judgement` for a write; inside one, the
   * defaults' without the layers lowering, which a layer's traversal only
   * reads.
   */
  protected scope(
    model: AnyModel,
    purpose: RowPurpose,
    judgement?: RowJudgement
  ): PreparedSelector | undefined {
    const excluded = this.excluded;
    return excluded === undefined || excluded.length === 0
      ? this.domain?.selector(model, purpose, NO_LAYERS, judgement)
      : this.domain?.defaults.selector(model, purpose, excluded);
  }
  /**
   * The domain predicate a read lowering here takes for `model` and
   * `purpose`; `undefined` where it states none, or the call drops all it
   * states (R6), so the statement is the one without a domain.
   */
  domainOf(
    model: AnyModel,
    purpose: RowPurpose,
    judgement?: RowJudgement
  ): PreparedSelector | undefined {
    const scope = this.scope(model, purpose, judgement);
    return scope && !this.#drops(scope.predicate) ? scope : undefined;
  }
  get values(): CallValues | undefined {
    return this.#call?.rows.values;
  }
  #instantOf: (() => Date) | undefined;
  /**
   * The call's one instant: a domain that reads it lowers for its call. Made
   * when first read, so a `Queries` whose domain reads no value makes none.
   */
  get instant(): () => Date {
    return (this.#instantOf ??= () => this.#call!.instant());
  }
  /**
   * The ONE provider continuation for a physical value of `type`, bound to
   * THIS execution's driver and adapter: the driver first (it owns the
   * transport's own spellings), then the adapter (it owns the dialect's), then
   * the engine's strict codec, which is the caller of the reader this returns.
   *
   * The driver's `next(value, type)` hands the adapter its value only: the
   * adapter is always asked about the leaf's own `type`. The adapter's `next()`
   * — or `next(undefined)` — answers the value the ADAPTER was handed, which is
   * the driver's transformed one, and either leg may answer without calling
   * `next` at all.
   *
   * A provider that raises the library's own error has already said what went
   * wrong, and that error reaches the caller intact; only a FOREIGN throw is
   * reported as a malformed scalar.
   *
   * The reader holds a driver's parser, so it belongs to the execution that
   * built this `Queries`, never to a shared leaf or projection: a borrowed
   * transaction may bind a different driver to the same prepared shape.
   */
  private fieldReader(type: string): FieldReader {
    const adapter = this.adapter.result;
    const adapterLeg = (input: unknown): unknown =>
      adapter.parseField(input, type, (transformed?: unknown) =>
        transformed === undefined ? input : transformed
      );
    const driverParse = this.result?.parseField;
    return (value) => {
      try {
        return driverParse
          ? driverParse(value, type, adapterLeg)
          : adapterLeg(value);
      } catch (error) {
        if (
          error instanceof InvalidScalarResult ||
          error instanceof VibORMError
        )
          throw error;
        throw new InvalidScalarResult(type, "provider scalar decoding failed");
      }
    };
  }
  /**
   * ONE operation's raw result, through the same provider chain at the RESULT
   * boundary that {@link fieldReader} walks at the row-value boundary: the
   * driver first (it owns what its own TRANSPORT answers for a verb), then the
   * adapter (it owns what its DIALECT answers for one), then the engine's
   * decoder, which is the caller of this function and the one authority on what
   * a `count`/`exist` answer means: it asks for `_count` and reads `_count`
   * back. Neither provider leg says anything today: Arnaud's D-35 deleted the
   * SQLite drivers' count/exists arm and his D-40 the two adapter legs (MySQL's
   * count-column normalisation, PostgreSQL's bigint conversion), all three
   * measured answering `undefined` on every live operation of both routes.
   *
   * The other half of D-17 (Arnaud's D-28): `DriverResultParser.parseResult` is
   * a public driver contract — a driver may wrap the raw result of an operation
   * ONCE, before decoding — and it reached nothing after the result engine was
   * retired. Asked here, it is asked once per OPERATION, never per statement
   * and never per member, and the same way for live and prepared execution
   * (rule 7).
   */
  decodeResult(
    raw: Input[],
    operation: Operation,
    decode: (rows: Input[]) => Input[]
  ): Input[] {
    const adapterDecode = (input: unknown): unknown =>
      this.adapter.result.parseResult(
        input,
        operation,
        (transformed?: unknown) =>
          decode((transformed === undefined ? input : transformed) as Input[])
      );
    const driverParse = this.result?.parseResult;
    return (
      driverParse
        ? driverParse(raw, operation, (input: unknown) => adapterDecode(input))
        : adapterDecode(raw)
    ) as Input[];
  }
  columnName(model: AnyModel, field: string): string {
    return this.physical(model, field).name;
  }
  /** The declared native form of a column; a list's members live in its container. */
  protected nativeType(scalar: Scalar): NativeTypeDeclaration | undefined {
    return scalar["~"].state.array === true
      ? undefined
      : scalar["~"].nativeType;
  }
  /**
   * One field's decoded leaf, resolved once per (adapter, model, field).
   *
   * The answer is the field's declared scalar, its nullability and the
   * adapter's representation of it — schema and dialect only — so rebuilding a
   * fresh object (and a fresh enum `Set`) on every projection of every
   * operation was pure repetition (rule 1). Nothing consumes a leaf by
   * identity: the decoder, the result codec and the shape readers all read its
   * fields.
   */
  protected scalarShape(model: AnyModel, field: string): Leaf {
    let leaves = this.#views.leaves.get(model);
    if (leaves === undefined) {
      leaves = new Map();
      this.#views.leaves.set(model, leaves);
    }
    let shape = leaves.get(field);
    if (shape === undefined) {
      const physical = this.physical(model, field);
      shape = this.#leaf(
        physical.scalar,
        physical.nullable,
        identifierColumn(
          this.adapter,
          this.schema.index,
          model,
          field,
          physical
        )
      );
      leaves.set(field, shape);
    }
    return shape;
  }
  #leaf(
    scalar: Scalar,
    nullable: boolean,
    id: IdentifierColumn | undefined
  ): Leaf {
    const state = scalar["~"].state;
    return {
      kind: "scalar",
      type: state.type,
      nullable,
      scalar,
      list: state.array === true ? true : undefined,
      decimal: state.type === "decimal" ? state.decimal : undefined,
      dateTime:
        state.type === "datetime"
          ? (this.adapter.result.dateTimeRepresentation?.(
              this.nativeType(scalar)
            ) ?? "text")
          : undefined,
      enumValues:
        state.type === "enum" && "enumValues" in scalar
          ? new Set(scalar.enumValues as readonly string[])
          : undefined,
      dimension: state.dimension,
      id,
    };
  }
  /**
   * Whether {@link updateValue} names this payload over a known prior value:
   * the answer a counter `upsert` folds on (engine-08). Read before the
   * divide-by-zero refusal, which belongs to an assignment that runs.
   */
  namesUpdate(model: AnyModel, field: string, value: unknown): boolean {
    return this.named(model, field, readUpdate(value));
  }
  /**
   * A list operator, and an exact decimal's `multiply` or `divide`, have no
   * expression form: the provider's assignment decides the stored result.
   */
  protected named(
    model: AnyModel,
    field: string,
    update: PreparedUpdate
  ): update is Exclude<PreparedUpdate, { kind: "list" }> {
    if (update.kind !== "arithmetic") return update.kind === "value";
    return !(
      (update.operator === "multiply" || update.operator === "divide") &&
      exactDecimalDomain(this.physical(model, field).state) !== undefined
    );
  }
  /** `model`'s names and values as this lowering spells them, for a fragment written by hand. */
  abstract spelling(model: AnyModel, dialect: Dialect): ModelSql;
  abstract updateAssignment(
    model: AnyModel,
    field: string,
    value: unknown
  ): Sql;
  /**
   * One prepared selector. `unique` states that the caller admitted this
   * `where` as a UNIQUE selector (a `whereUnique` input): its top-level
   * addressable-key entries are the row's discriminator and compare through the
   * constraint, while every other entry — an extended `where`'s filters, its
   * `AND`/`OR`/`NOT` arms and its relation predicates — stays a filter. The
   * same `{ id: … }` object is a discriminator under `findUnique` and a filter
   * under `findFirst`, so the fact belongs to the admitted operation and cannot
   * be recovered from the object's shape.
   * SQL-only consumers omit dependency summaries through `includeFacts`; the
   * unique constraint comparison remains independent of that collection.
   */
  prepareSelector(
    model: AnyModel,
    where?: Input,
    unique?: boolean
  ): PreparedSelector;
  prepareSelector(
    model: AnyModel,
    where: Input | undefined,
    unique: boolean,
    includeFacts: false
  ): Pick<PreparedSelector, "model" | "predicate">;
  prepareSelector(
    model: AnyModel,
    where?: Input,
    unique = false,
    includeFacts = true
  ): Pick<PreparedSelector, "model" | "predicate"> | PreparedSelector {
    if (!includeFacts)
      return {
        model,
        predicate: where
          ? this.#rooted(model, undefined, () =>
              this.#prepareWhere(model, where, undefined, unique)
            )
          : undefined,
      };
    const facts = newSelectorFacts();
    const keys = Object.keys(where ?? {});
    const uniqueKey =
      keys.length === 1 ? findAddressableKey(model, keys[0]!) : undefined;
    const selected = uniqueKey
      ? uniqueKey.name
        ? record(where![uniqueKey.name])
        : where!
      : undefined;
    return {
      model,
      facts,
      uniqueKey,
      uniqueValues: selected
        ? new Map(uniqueKey!.fields.map((field) => [field, selected[field]]))
        : undefined,
      predicate: where
        ? this.#rooted(model, facts, () =>
            this.#prepareWhere(model, where, facts, unique)
          )
        : undefined,
    };
  }
  /**
   * The rows a predicate being prepared reads, from its root to the relation
   * body it is in: what a `{ $row, up }` names. `sealed` says why a reference
   * may not cross that body.
   */
  #scopes: readonly {
    readonly model: AnyModel;
    readonly facts: SelectorFacts | undefined;
    readonly sealed?: string;
  }[] = [];
  #rooted<T>(
    model: AnyModel,
    facts: SelectorFacts | undefined,
    prepare: () => T
  ): T {
    const scopes = this.#scopes;
    this.#scopes = [{ model, facts }];
    try {
      return prepare();
    } finally {
      this.#scopes = scopes;
    }
  }
  /** One row's identity as prepared meaning: its key fields' equalities. */
  identityPredicate(
    model: AnyModel,
    identity: Input,
    facts: SelectorFacts
  ): PreparedPredicate {
    return conjunction(
      Object.entries(identity).map(([field, value]) =>
        this.#prepareScalarPredicate(model, field, value, facts)
      )
    );
  }
  /**
   * The complement of a CAPTURED identity set — "this row is not one of the
   * rows the engine read" — as prepared meaning.
   *
   * A captured set is identities the engine itself read, so its complement is
   * composed here from {@link identityPredicate}'s equalities under the one
   * combinator owner ({@link combine}), and never spelled as a public
   * `{ NOT: { OR: … } }` payload: N4 lets a model DECLARE a scalar or relation
   * named `NOT`, `OR` or `AND`, and such a payload is then read as that field
   * ({@link combinator}) — the public name wins, as validation admitted it. An
   * internal premise that borrowed public syntax could not survive that, which
   * is why the meaning is stated and only the SQL is spelled.
   *
   * An empty set excludes nothing: it states no condition, so a caller that
   * conjoins it through {@link andSelectors} keeps exactly its own selector —
   * the truth both consumers already carried, one by omitting the bag and the
   * other through the vacuous `NOT` of an empty `OR`.
   */
  excludeIdentities(
    model: AnyModel,
    identities: readonly Input[]
  ): PreparedSelector {
    const facts = newSelectorFacts();
    const captured = this.#capturedSet(model, identities, facts, false);
    return {
      model,
      facts,
      predicate:
        identities.length === 0 ? undefined : this.combine("NOT", [captured]),
    };
  }
  /**
   * The captured identity set ITSELF — "this row is one of the rows the engine
   * read" — and the positive counterpart of {@link excludeIdentities}.
   *
   * D-65 gives the consuming UPDATE/DELETE of a captured ROOT set both facts:
   * the rows the capture named, and the selector it captured them by. This
   * states the first, from the same identities' own equalities under the same
   * combinator owner, so the effect addresses the captured rows with no public
   * payload to collide with a declared `OR` (N4).
   *
   * An empty set names NO row — the vacuous FALSE {@link combine} already
   * states — which is why each caller answers an empty capture before any
   * statement is built.
   */
  includeIdentities(
    model: AnyModel,
    identities: readonly Input[]
  ): PreparedSelector {
    const facts = newSelectorFacts();
    return {
      model,
      facts,
      predicate: this.#capturedSet(model, identities, facts),
    };
  }
  /** One captured set's rows, as the disjunction of their own identities. */
  #capturedSet(
    model: AnyModel,
    identities: readonly Input[],
    facts: SelectorFacts,
    taken = true
  ): PreparedPredicate {
    const keys = getModelKeyCatalog(model).rowKey?.fields;
    const field = keys?.length === 1 ? keys[0] : undefined;
    if (
      field &&
      identities.length > 0 &&
      identities.every(
        (identity) =>
          Object.keys(identity).length === 1 && Object.hasOwn(identity, field)
      )
    )
      return this.#prepareScalarPredicate(
        model,
        field,
        { in: identities.map((identity) => identity[field]) },
        facts
      );
    // A set pins no equality, and the rows left out (`taken` false) none
    // either: only one row taken holds what names it.
    const held = taken && identities.length === 1 ? facts : apart(facts, true);
    const captured = identities.map((identity) =>
      this.identityPredicate(model, identity, held)
    );
    if (captured.length > 0) facts.exact = false;
    return balancedOr(captured, (arms) => this.combine("OR", arms));
  }
  andSelectors(
    model: AnyModel,
    selectors: readonly PreparedSelector[]
  ): PreparedSelector {
    const facts = newSelectorFacts();
    const predicates: PreparedPredicate[] = [];
    for (const selector of selectors) {
      for (const field of selector.facts.fields) facts.fields.add(field);
      for (const [field, value] of selector.facts.equals)
        facts.equals.set(field, value);
      for (const [field, value] of selector.facts.keys)
        facts.keys.set(field, value);
      facts.exact &&= selector.facts.exact;
      for (const read of selector.facts.reads) facts.reads.add(read);
      if (selector.predicate) predicates.push(selector.predicate);
    }
    return {
      model,
      facts,
      predicate: predicates.length === 0 ? undefined : conjunction(predicates),
    };
  }
  /**
   * The key-preserving conjunction: `selector` AND `domain`'s predicate for
   * `purpose`, keeping the selector's unique key, so the consumers that read
   * the key to recover (race convergence, a hidden conflict's rethrow) behave
   * as without a domain; `scoped` tells the ones that trust the key alone to
   * name the row (the RETURNING confirmation fast path, the targeted
   * `ON CONFLICT` fold) that it no longer does. A write's `judgement` adds
   * its verb's predicates. The selector itself where the domain states
   * nothing for its model.
   */
  candidates(
    selector: PreparedSelector,
    purpose: RowPurpose,
    domain: PreparedDomain | undefined = this.domain,
    judgement?: RowJudgement
  ): PreparedSelector {
    const scope = domain?.selector(
      selector.model,
      purpose,
      NO_LAYERS,
      judgement
    );
    if (scope === undefined) return selector;
    return {
      ...this.andSelectors(selector.model, [selector, scope]),
      uniqueKey: selector.uniqueKey,
      uniqueValues: selector.uniqueValues,
      scoped: true,
    };
  }
  abstract lowerSelector(
    selector: Pick<PreparedSelector, "model" | "predicate">,
    alias?: string
  ): Sql | undefined;
  /** Whether the call drops every layer `predicate` is made of (R6). */
  #drops(predicate: PreparedPredicate | undefined): boolean {
    if (predicate?.kind === "layer")
      return predicate.resolve(this) === undefined;
    return (
      predicate?.kind === "and" &&
      predicate.predicates.length > 0 &&
      predicate.predicates.every((member) => this.#drops(member))
    );
  }
  abstract locatedValue(
    model: AnyModel,
    field: string,
    selector: PreparedSelector
  ): Sql;
  /**
   * The first `limit` rows of `selector` in key order, as prepared meaning: a
   * limited window two statements of one atomic unit both name — a premise
   * about the window, then the effect over it — and agree on by construction,
   * because a total order leaves the same data one answer. Its rows are rows
   * of `selector`, so the selector's facts hold for them.
   */
  window(selector: PreparedSelector, limit: number): PreparedSelector {
    return {
      model: selector.model,
      facts: selector.facts,
      predicate: { kind: "window", selector, limit },
    };
  }
  /**
   * A combinator, unless the model declares a field by that name: validation
   * extends its three combinator entries with the model's own fields, so a
   * scalar or relation literally named `AND` wins the key there
   * (`validation/model/core/where.ts`, `validation/model/args/aggregate.ts`
   * for `having`), and
   * the engine reads the admitted payload the same way (N4).
   */
  protected combinator(
    model: AnyModel,
    key: string
  ): key is "AND" | "OR" | "NOT" {
    return (
      (key === "AND" || key === "OR" || key === "NOT") &&
      !scalarsOf(model)[key] &&
      !model["~"].state.relations[key]
    );
  }
  /**
   * The one logical-combinator owner, shared by `where` and `having`. An arm
   * that builds no condition is absent: it contributes nothing to `AND`,
   * nothing to `NOT` and nothing to `OR`, and only `OR` turns "no surviving
   * arm" into a condition — the vacuous FALSE.
   */
  combine(
    key: "AND" | "OR" | "NOT",
    arms: readonly PreparedPredicate[]
  ): PreparedPredicate {
    const stated = arms.filter(states);
    if (key === "OR")
      return stated.length === 0 ? VACUOUS_FALSE : disjunction(stated);
    const predicates: readonly PreparedPredicate[] =
      key === "AND"
        ? (mergeQuantifiers("and", stated) ?? stated)
        : stated.map((predicate) => ({ kind: "not" as const, predicate }));
    return conjunction(predicates);
  }
  #prepareWhere(
    model: AnyModel,
    where: Input,
    facts: SelectorFacts | undefined,
    unique = false,
    positive = true
  ): PreparedPredicate {
    if (where instanceof Condition) {
      if (facts) facts.exact = false;
      return { kind: "condition", condition: where };
    }
    if (where instanceof Existence) return this.#prepareExists(where, facts);
    return conjunction(
      Object.entries(where).map(([field, operand]) => {
        if (this.combinator(model, field)) {
          const held = facts && field !== "AND" ? apart(facts, true) : facts;
          if (held !== facts) facts!.exact = false;
          return this.combine(
            field,
            entries(operand).map((clause) =>
              this.#prepareWhere(
                model,
                clause,
                held,
                false,
                field === "NOT" ? !positive : positive
              )
            )
          );
        }
        if (model["~"].state.relations[field])
          return this.#prepareSlotPredicate(
            model,
            field,
            operand,
            facts,
            positive
          );
        // An ordinary scalar predicate is not a unique discriminator. Only
        // unique selectors and possible compound names need the key catalog.
        const key =
          unique || scalarsOf(model)[field] === undefined
            ? findAddressableKey(model, field)
            : undefined;
        if (key?.name)
          return conjunction(
            key.fields.map((member) =>
              this.#prepareScalarPredicate(
                model,
                member,
                record(operand)[member],
                facts,
                unique,
                positive
              )
            )
          );
        return this.#prepareScalarPredicate(
          model,
          field,
          operand,
          facts,
          unique && key !== undefined,
          positive
        );
      })
    );
  }
  /**
   * `$exists`: the target's rows, read by the statement wherever it sits, so
   * a write to them orders before it (a read of the target with no path).
   */
  #prepareExists(
    existence: Existence,
    facts: SelectorFacts | undefined
  ): PreparedPredicate {
    const model = this.schema.schema[existence.model]!;
    const nestedFacts = facts && apart(facts);
    // One body below the row that holds it, joined to nothing: a
    // `{ $row, up }` inside it may read that row (or one above), and then it
    // is correlated; else it is the same wherever the statement holds it.
    const scopes = this.#scopes;
    this.#scopes = [...scopes, { model, facts: nestedFacts }];
    let predicate: PreparedPredicate;
    try {
      predicate = this.#prepareWhere(model, existence.where, nestedFacts);
    } finally {
      this.#scopes = scopes;
    }
    if (facts) {
      facts.exact = false;
      facts.reads.add(model);
    }
    return {
      kind: "exists",
      model,
      ...(states(predicate) && { predicate }),
    };
  }
  /** One prepared scalar: the field and its memoised physical view. */
  protected scalar(model: AnyModel, field: string): PreparedScalar {
    return {
      model,
      field,
      physical: this.physical(model, field),
    };
  }
  #prepareScalarPredicate(
    model: AnyModel,
    field: string,
    value: unknown,
    facts: SelectorFacts | undefined,
    key = false,
    positive = true
  ): PreparedPredicate {
    const scalar = this.scalar(model, field);
    if (facts) {
      facts.fields.add(field);
      const filter =
        value !== null &&
        typeof value === "object" &&
        !(value instanceof Sql) &&
        !(value instanceof Parameter) &&
        !isFieldRef(value)
          ? record(value)
          : undefined;
      const hasEquality =
        filter === undefined ||
        (Object.keys(filter).length === 1 && "equals" in filter);
      const equality = filter && hasEquality ? filter.equals : value;
      if (
        hasEquality &&
        (equality === null ||
          (typeof equality !== "object" && !(equality instanceof Sql)))
      ) {
        facts.equals.set(field, equality);
        if (key) facts.keys.set(field, equality);
      } else if (!(hasEquality && equality instanceof Parameter))
        facts.exact = false;
      // A call's value (K2) is an equality whose value preparation does not
      // know: it pins nothing, and leaves the selector a conjunction of
      // equalities, so its literal ones still prove a write disjoint (N1).
    }
    return this.prepareOperations(
      key ? { kind: "column", scalar, key: true } : { kind: "column", scalar },
      value,
      false,
      positive
    );
  }
  /**
   * One operator vocabulary over one target. A column, a JSON value inside it
   * and an aggregate over it are the same grammar, so `where` and `having`
   * cannot admit different operators or bind an operand two ways.
   */
  protected prepareOperations(
    target: PreparedTarget,
    value: unknown,
    insensitive = false,
    positive = true
  ): PreparedPredicate {
    const state = target.scalar?.physical.state;
    const shorthand =
      value === null ||
      value instanceof Sql ||
      isFieldRef(value) ||
      typeof value !== "object" ||
      jsonNullKindOf(value) !== undefined ||
      (state?.array === true && Array.isArray(value)) ||
      !addressesOperators(state, record(value));
    if (shorthand)
      return this.prepareOperation(
        target,
        "equals",
        value,
        insensitive,
        positive
      );
    return this.#prepareOperatorFilter(target, value, insensitive, positive);
  }
  /** An operator object (`{ gt: 1, not: … }`), out of line from the shorthand. */
  #prepareOperatorFilter(
    target: PreparedTarget,
    value: unknown,
    insensitive: boolean,
    positive: boolean
  ): PreparedPredicate {
    const state = target.scalar?.physical.state;
    const filter = record(value);
    // D-22. A JSON filter's own `mode` wins in BOTH directions — a declared
    // `default` really does restore exact matching on that arm — while a
    // scalar filter's `mode` may only UPGRADE to insensitive. That asymmetry
    // is the shipped pair of rules (`json-filter-builder.ts:31-45` against
    // `where-builder.ts`), and it is a fact about the TARGET KIND, resolved
    // here in the one operand owner rather than by a second walker.
    const declared = filter.mode;
    const folded =
      state?.type === "json" && declared !== undefined
        ? declared === "insensitive"
        : insensitive || declared === "insensitive";
    const scoped: PreparedTarget =
      state?.type === "json" && Array.isArray(filter.path)
        ? {
            ...(target as Extract<PreparedTarget, { kind: "column" }>),
            path: [...(filter.path as string[])],
          }
        : target;
    const predicates: PreparedPredicate[] = [];
    for (const name of Object.keys(filter)) {
      if (name === "mode" || name === "path") continue;
      const operand = filter[name];
      if (name === "equals") {
        predicates.push(
          this.prepareOperations(scoped, operand, folded, positive)
        );
      } else if (name === "not") {
        predicates.push({
          kind: "not",
          predicate: this.prepareOperations(scoped, operand, folded, !positive),
        });
      } else {
        predicates.push(
          this.prepareOperation(scoped, name, operand, folded, positive)
        );
      }
    }
    return conjunction(predicates);
  }
  /** One admitted operator, with its operand resolved once. */
  private prepareOperation(
    target: PreparedTarget,
    operator: string,
    value: unknown,
    insensitive: boolean,
    positive = true
  ): PreparedPredicate {
    const owner = target.scalar;
    switch (operator) {
      case "in":
      case "notIn":
        return {
          kind: "operation",
          operator,
          target,
          operands:
            value instanceof Parameter
              ? [
                  {
                    kind: "parameter" as const,
                    parameter: value,
                    spread: true as const,
                  },
                ]
              : (value as unknown[]).map((member) =>
                  owner
                    ? this.#prepareOperand(owner, member)
                    : { kind: "value" as const, value: member }
                ),
          insensitive,
        };
      case "equals":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
      case "contains":
      case "startsWith":
      case "endsWith":
        return {
          kind: "operation",
          operator,
          target,
          operand: owner
            ? this.#prepareOperand(owner, value)
            : ({ kind: "value", value } satisfies PreparedOperand),
          value,
          insensitive,
        };
      default:
        return {
          kind: "operation",
          operator,
          target,
          value,
          insensitive,
          ...(operator === "distance" &&
          positive &&
          owner?.physical.state.type === "point" &&
          distanceUpperBound(value) !== undefined
            ? { probe: true as const }
            : {}),
        };
    }
  }
  /**
   * One admitted filter member, resolved to the value it binds or the column it
   * names. A plain box per member: what is prepared is read-only by its type,
   * and nothing freezes it (a freeze per member of one `id: { in: ids₁₀₀ }`
   * measured 1.98–2.20 µs against 0.25–0.28 µs,
   * `g4/perf2/receipts/micro-in-list.json`).
   */
  #prepareOperand(owner: PreparedScalar, value: unknown): PreparedOperand {
    if (value instanceof Parameter)
      return { kind: "parameter", parameter: value };
    if (value instanceof OuterColumn)
      return this.#prepareOuterOperand(owner, value);
    if (isFieldRef(value)) {
      if (owner.physical.state.type === "json")
        throw new UnsupportedOperationError(
          `Field reference '${formatFieldRef(value)}' is not supported in a JSON filter operand.`
        );
      return this.#prepareFieldOperand(owner, value);
    }
    if (!(value instanceof Sql)) return { kind: "value", value };
    // Peeked, not flattened: the fragment keeps the nodes it is composed of
    // (a `RowsOf` its lowering settles).
    const flat = Sql.peek(value);
    const operands = flat.values.map((member) => {
      if (isFieldRef(member)) return this.#prepareFieldOperand(owner, member);
      // A token is executable only in a flat interpolation slot. An object
      // parameter stays data; never turn a hidden token into provider data.
      const pending = [member];
      const seen = new WeakSet<object>();
      for (const nested of pending) {
        if (isFieldRef(nested))
          throw new UnsupportedOperationError(
            "An SQL filter field reference must be a direct interpolation, not nested inside a parameter object."
          );
        if (nested instanceof OuterColumn)
          throw new UnsupportedOperationError(
            "An enclosing row's column ({ $row, up }) is compared directly, never inside an SQL filter."
          );
        if (nested === null || typeof nested !== "object" || seen.has(nested))
          continue;
        seen.add(nested);
        for (const descriptor of Object.values(
          Object.getOwnPropertyDescriptors(nested)
        ))
          if ("value" in descriptor) pending.push(descriptor.value);
      }
      return { kind: "value", value: member } as const;
    });
    return operands.some((member) => member.kind === "field")
      ? { kind: "sql", strings: [...flat.strings], operands }
      : { kind: "value", value };
  }
  /** A field-reference operand, out of line: most operands are values. */
  #prepareFieldOperand(
    owner: PreparedScalar,
    value: Parameters<typeof fieldRefPayload>[0]
  ): Extract<PreparedOperand, { kind: "field" }> {
    const { model } = owner;
    const payload = fieldRefPayload(value);
    const scope = nameOf(model) ?? "unknown";
    if (payload.model !== scope)
      throw new UnsupportedOperationError(
        `Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model.`
      );
    if (payload.list)
      throw new UnsupportedOperationError(
        `Field reference '${formatFieldRef(value)}' is a list field and cannot be used as a scalar SQL operand.`
      );
    const referenced = scalarsOf(model)[payload.field];
    if (!referenced)
      throw new UnsupportedOperationError(
        `Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'.`
      );
    const own = exactDecimalDomain(owner.physical.state);
    const other = exactDecimalDomain(referenced["~"].state);
    if (own && other && !sameDecimalDomain(own, other))
      throw new UnsupportedOperationError(
        `Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale.`
      );
    const storage = incomparableIdentifiers(
      this.scalarShape(model, owner.field).id,
      this.scalarShape(model, payload.field).id,
      owner.field,
      payload.field
    );
    if (storage !== undefined)
      throw new UnsupportedOperationError(
        `Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': ${storage}`
      );
    return {
      kind: "field",
      scalar: this.scalar(model, payload.field),
    };
  }
  /**
   * `{ $row, up }`: the column of the row `up` relation bodies above, which
   * that row's scope reads, compared like a field reference. Refused when it
   * leaves the predicate (or an `$exists` body), crosses a recursive or
   * polymorphic relation, or names what a comparison cannot read.
   */
  #prepareOuterOperand(
    owner: PreparedScalar,
    value: OuterColumn
  ): Extract<PreparedOperand, { kind: "field" }> {
    const spelled = `{ $row: ${JSON.stringify(value.$row)}, up: ${value.up} }`;
    const scopes = this.#scopes;
    const at = scopes.length - 1 - value.up;
    if (at < 0)
      throw new UnsupportedOperationError(
        `${spelled} reaches past the predicate it is written in: it is ${Math.max(scopes.length - 1, 0)} relation bodies deep.`
      );
    for (let index = at + 1; index < scopes.length; index++)
      if (scopes[index]!.sealed !== undefined)
        throw new UnsupportedOperationError(
          `${spelled} crosses a ${scopes[index]!.sealed} relation: an enclosing row is read only through plain relations.`
        );
    const { model, facts } = scopes[at]!;
    const name = nameOf(model) ?? "unknown";
    const referenced = scalarsOf(model)[value.$row];
    const own = owner.physical.state;
    if (!referenced)
      throw new UnsupportedOperationError(
        `${spelled} does not name a scalar field of '${name}'.`
      );
    const other = referenced["~"].state;
    const kinds = new Set([own.type, other.type]);
    if (
      own.array === true ||
      other.array === true ||
      own.type === "json" ||
      !(
        own.type === other.type ||
        (kinds.size === 2 && kinds.has("string") && kinds.has("enum"))
      )
    )
      throw new UnsupportedOperationError(
        `${spelled} names '${name}.${value.$row}' (${other.array === true ? `${other.type}[]` : other.type}), which cannot be compared with '${owner.field}' (${own.array === true ? `${own.type}[]` : own.type}).`
      );
    const ownDomain = exactDecimalDomain(own);
    const otherDomain = exactDecimalDomain(other);
    if (ownDomain && otherDomain && !sameDecimalDomain(ownDomain, otherDomain))
      throw new UnsupportedOperationError(
        `${spelled} names a decimal(${otherDomain.precision},${otherDomain.scale}) and '${owner.field}' is decimal(${ownDomain.precision},${ownDomain.scale}): two decimals compare exactly only when they declare the same precision and scale.`
      );
    const storage = incomparableIdentifiers(
      this.scalarShape(owner.model, owner.field).id,
      this.scalarShape(model, value.$row).id,
      owner.field,
      value.$row
    );
    if (storage !== undefined)
      throw new UnsupportedOperationError(`${spelled}: ${storage}`);
    // The row that holds the column reads it: a write to it reorders.
    facts?.fields.add(value.$row);
    return {
      kind: "field",
      scalar: this.scalar(model, value.$row),
      ...(value.up > 0 && { up: value.up }),
    };
  }
  /** One relation slot: ordinary quantifiers, to-one shorthand, or tagged arms. */
  #prepareSlotPredicate(
    model: AnyModel,
    name: string,
    operand: unknown,
    facts: SelectorFacts | undefined,
    positive = true
  ): PreparedPredicate {
    const resolved = this.schema.index.get(model)!.get(name)!;
    const entries = record(operand);
    if (
      resolved.member ||
      (resolved.edge.kind !== "variantRowCarrier" &&
        resolved.edge.kind !== "variantJunctionCarrier")
    ) {
      const edge = bindMembership(this.schema, model, name);
      // A spelled `recurse` IS the closure form (the validation dispatcher's
      // one rule), admitted densely: its unspelled arms are `undefined` holes.
      // The assertion names the admitted shape, as `Arguments.recurse` does.
      const recurrence = entries.recurse as NormalizedRecurrence | undefined;
      const closure: Closure | undefined =
        recurrence === undefined
          ? undefined
          : {
              depth: recurrence.depth,
              self: entries.self === true,
              ...(recurrence.selective && { selective: true as const }),
            };
      const arms: [string, unknown][] = closure
        ? Object.entries(entries).filter(
            ([key, value]) => QUANTIFIERS.has(key) && value !== undefined
          )
        : Object.keys(entries).every((key) => QUANTIFIERS.has(key))
          ? Object.entries(entries)
          : [["is", entries]];
      return conjunction(
        arms.map(([quantifier, value]) =>
          this.#relationPredicate(
            edge,
            quantifier,
            value,
            facts,
            positive,
            closure
          )
        )
      );
    }
    const members = resolved.edge.members;
    const many = resolved.edge.kind === "variantJunctionCarrier";
    const variantEdge = (variant: unknown) =>
      bindMembership(this.schema, model, name, variant as string);
    if (
      resolved.edge.kind === "variantRowCarrier" &&
      entries.type === undefined
    ) {
      const absent = "is" in entries;
      // Presence names the stored pair, independently of target-row existence.
      const fields = [
        resolved.edge.storage.typeColumn.name,
        resolved.edge.storage.idColumn.name,
      ];
      return conjunction(
        fields.map((field) =>
          this.#prepareScalarPredicate(
            model,
            field,
            absent ? null : { not: null },
            facts
          )
        )
      );
    }
    const arms: [string | undefined, Input][] = many
      ? Object.entries(entries).map(([quantifier, tagged]) => [
          quantifier,
          record(tagged),
        ])
      : [[undefined, entries]];
    return conjunction(
      arms.map(([quantifier, tagged]) => {
        const edge = variantEdge(tagged.type);
        const negated = tagged.isNot !== undefined;
        const inexact =
          negated || quantifier === "none" || quantifier === "every";
        const inner = this.#relationScope(
          edge,
          negated ? record(tagged.isNot) : (tagged.is as Input | undefined),
          facts,
          inexact,
          positive,
          undefined,
          "polymorphic"
        );
        if (quantifier !== undefined) {
          const quantified = {
            kind: "relation" as const,
            edge,
            quantifier,
            predicate:
              negated && inner
                ? { kind: "not" as const, predicate: inner }
                : inner,
          };
          // `some` and `none` address the tagged arm and nothing else.
          // `every` is a statement about the WHOLE collection — "every member
          // is an arm-`T` member satisfying P" — so a member of any OTHER arm
          // falsifies it. That is the one tagged quantifier that must also
          // state the arms it did not name; the shipped engine answers a
          // board holding two posts and one tag `false` for
          // `every: { type: "post", … }`, and this is why.
          if (quantifier !== "every") return quantified;
          return conjunction([
            ...(inner ? [quantified] : []),
            ...members
              .filter((member) => member.variant !== tagged.type)
              .map((member) =>
                this.#relationPredicate(
                  variantEdge(member.variant),
                  "none",
                  undefined,
                  facts,
                  positive
                )
              ),
          ]);
        }
        // A tagged to-one arm: `{ type }` asks only that the slot holds that
        // variant; `is`/`isNot` keep the ordinary to-one quantifier meaning.
        return {
          kind: "relation",
          edge,
          quantifier: "some",
          predicate:
            negated && inner ? { kind: "not", predicate: inner } : inner,
        };
      })
    );
  }
  #relationPredicate(
    edge: Membership,
    quantifier: string,
    value: unknown,
    facts: SelectorFacts | undefined,
    positive = true,
    closure?: Closure
  ): PreparedPredicate {
    const body =
      value === null || value === undefined ? undefined : record(value);
    const linkWhere =
      edge.kind === "junction" && edge.declared
        ? (body?.$through as Input | undefined)
        : undefined;
    const link = linkWhere && {
      link: this.prepareSelector(
        (edge as Extract<Membership, { kind: "junction" }>).declared!.model,
        linkWhere,
        false,
        false
      ).predicate,
      linkFields: Object.keys(linkWhere),
    };
    return {
      kind: "relation",
      edge,
      quantifier,
      ...link,
      predicate: this.#relationScope(
        edge,
        link ? withoutLinkKey(body!) : body,
        facts,
        quantifier === "none" ||
          quantifier === "every" ||
          quantifier === "isNot",
        positive,
        closure
      ),
      ...(closure ? { closure } : {}),
    };
  }
  /**
   * One relation's body, and the read of other rows it is. `inexact` is also
   * this arm's POLARITY: `none`, `isNot` and `every` consume their nested
   * predicate under a negation — `every` emits `NOT(nested)` inside its
   * `NOT EXISTS` — so a conjunct added there is a conjunct of what is
   * negated. One fact, read twice, instead of a second flag that could
   * disagree with it.
   */
  #relationScope(
    edge: Membership,
    where: Input | undefined,
    facts: SelectorFacts | undefined,
    inexact: boolean,
    positive = true,
    closure?: Closure,
    sealed: string | undefined = closure && "recursive"
  ): PreparedPredicate | undefined {
    if (facts) {
      // What other rows hold is not stated by what its own row holds.
      facts.exact = false;
      facts.reads.add(edge.target);
      if (edge.kind === "junction") facts.reads.add(edge.table);
    }
    if (!where) return;
    const scopes = this.#scopes;
    const nestedFacts = facts && apart(facts);
    this.#scopes = [
      ...scopes,
      { model: edge.target, facts: nestedFacts, ...(sealed && { sealed }) },
    ];
    try {
      return this.#prepareWhere(
        edge.target,
        where,
        nestedFacts,
        false,
        positive && !inexact
      );
    } finally {
      this.#scopes = scopes;
    }
  }
  /**
   * Whether a row that holds `held` of `field` holds the value `asked`:
   * `undefined` where the two are spelled apart and may still be one value to
   * the database (an instant, a decimal, a number, a document, an
   * identifier), which then answers.
   */
  told(
    model: AnyModel,
    field: string,
    held: unknown,
    asked: unknown
  ): boolean | undefined {
    if (same(held, asked)) return true;
    const leaf = this.scalarShape(model, field);
    return leaf.list || leaf.id || !SPELLED_ONCE.has(leaf.type)
      ? undefined
      : false;
  }
  /** A field of a model as it is stored. */
  physical(model: AnyModel, field: string): PhysicalField {
    return this.schema.physicalField(model, field);
  }
  /**
   * The model's key order: a bare scalar id, else the row key's fields in
   * declaration order. A windowed read's tie-break, and the order a limited
   * write takes its rows in ({@link capped}, {@link through}).
   */
  keyOrder(model: AnyModel): readonly string[] {
    const catalog = getModelKeyCatalog(model);
    const bare = catalog.addressableKeys.find(
      (key) => key.kind === "primary" && key.name === undefined
    );
    if (bare) return bare.fields;
    const rowKey = catalog.rowKey;
    if (!rowKey)
      throw new QueryEngineError(
        "Paginated scalar ordering requires a primary model identifier."
      );
    const fields = new Set<string>(rowKey.fields);
    return Object.keys(scalarsOf(model)).filter((field) => fields.has(field));
  }
  abstract select(
    model: AnyModel,
    args: Partial<Arguments>,
    membership?: { edge: Membership; parent: Input },
    controls?: SelectControls
  ): Query;
  abstract read(
    model: AnyModel,
    operation: ReadOperation,
    args: Arguments
  ): Read;
  /**
   * A widened `_sum` the provider's own `SUM` would overflow travels as two
   * parts no realistic row count overflows, joined before the field's decoder
   * reads it (engine-10): a number on every dialect, an int64 — an int, a
   * bigint or SQLite's decimal coefficient — where the adapter states
   * `integerSum`.
   */
  protected splitSum(leaf: Leaf): SplitSum | undefined {
    if (!leaf.widened) return undefined;
    const { numberSum, integerSum } = this.adapter.aggregates;
    if (leaf.type === "number")
      return numberSum && { sql: numberSum, join: joinNumberSum };
    return (
      integerSum && {
        sql: integerSum,
        join: (parts) => joinIntegerSum(parts, leaf.type),
      }
    );
  }
  abstract selectSeries(
    prepared: PreparedProjection,
    identities: Input[],
    operation?: "createMany" | "updateMany"
  ): Query;
  /** What a read-back owes its write: every row it names, or the write's refusal. */
  protected seriesExpectation(
    model: AnyModel,
    count: number,
    operation: "createMany" | "updateMany"
  ): NonNullable<Query["expectedRows"]> {
    return {
      count,
      missing:
        operation === "createMany"
          ? new QueryEngineError(
              "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls."
            )
          : new TransactionError(
              "updateMany with 'select' could not read back one of the updated rows at its final primary key.",
              {
                meta: {
                  model: nameOf(model) ?? "unknown",
                  operation: "updateMany",
                },
              }
            ),
    };
  }
  /** The `_count` member of a projection, out of line: most reads have none. */
  #projectCounts(
    model: AnyModel,
    name: string,
    selection: unknown,
    fields: Record<string, Shape | Leaf>,
    prepared: PreparedProjectionField[]
  ): void {
    const counts = this.#prepareCounts(model, selection);
    // An empty count SELECTION contributes no field at all: the shipped
    // engine pushed the `_count` pair only `if (relationCountPairs.length
    // > 0)` (`select-builder.ts:418`), so `_count: true` on a model with
    // no to-many relation publishes no `_count` key rather than `{}`.
    if (counts.length === 0) return;
    fields[name] = {
      kind: "object",
      // A count carrier is a document the statement always builds: a
      // provider that answers `null` here has not answered the question,
      // and an object shape that carried no nullability let that `null`
      // reach a caller whose type says `{ children: number }`.
      nullable: false,
      fields: Object.fromEntries(
        counts.map((count) => [count.relation, COUNT_LEAF])
      ),
    };
    prepared.push({ kind: "counts", name, counts });
  }
  /** A selected `_distance`, out of line: most reads select none. */
  #projectDistance(
    model: AnyModel,
    name: string,
    distance: unknown,
    distanceSelected: boolean,
    fields: Record<string, Shape | Leaf>,
    prepared: PreparedProjectionField[]
  ): void {
    if (distanceSelected) throw new QueryEngineError(DISTANCE_SELECTED_TWICE);
    // The output key `_distance` is the distance's alone: schema
    // validation refuses a member of that name (F010).
    prepared.push({
      kind: "distance",
      name: DISTANCE_FIELD,
      field: name,
      specification: record(distance),
    });
    fields[DISTANCE_FIELD] = this.#distanceLeaf(model, name, record(distance));
  }
  /** A polymorphic slot's projection, out of line: most reads have none. */
  #projectVariants(
    model: AnyModel,
    name: string,
    resolved: ResolvedSlot,
    selection: unknown,
    fields: Record<string, Shape | Leaf>,
    prepared: PreparedProjectionField[],
    path: string
  ): void {
    // The caller dispatched on a variant carrier; the closure below loses that.
    const edge = resolved.edge as ResolvedVariantEdge;
    const many = edge.kind === "variantJunctionCarrier";
    // A junction-carried slot's arm is a collection of its rows; a row
    // carrier's arm is the target's document.
    const collections: Record<string, CollectionShape> = {};
    const documents: Record<string, Shape> = {};
    const preparedArms: ({
      readonly variant: string;
    } & PreparedRelationProjection)[] = [];
    // The integrity probe's subjects: every configured member of a
    // junction-carried slot, each of which binds a junction membership (an
    // invariant of this one construction site, not a refusal: N4). A ROW
    // carrier states its own claim on the parent row, which the arm document
    // already answers (D-19).
    const memberships = many
      ? edge.members.map((member) => ({
          variant: member.variant,
          edge: bindMembership(
            this.schema,
            model,
            name,
            member.variant
          ) as Extract<Membership, { kind: "junction" }>,
        }))
      : [];
    // Which arms are read, and with which node, is `selectedArm`'s one
    // rule, shared with the schema-only result shape.
    for (const member of edge.members) {
      const arm = selectedArm(selection, many, member.variant);
      if (arm === undefined) continue;
      const nested = this.#prepareRelationProjection(
        bindMembership(this.schema, model, name, member.variant),
        arm,
        `${path}${many ? "variants." : ""}${member.variant}.`
      );
      if (many) collections[member.variant] = this.#collectionShape(nested);
      else documents[member.variant] = this.#relationShape(nested);
      preparedArms.push({ variant: member.variant, ...nested });
    }
    fields[name] = many
      ? {
          kind: "variants",
          relation: name,
          many,
          arms: collections,
        }
      : {
          kind: "variants",
          relation: name,
          many,
          arms: documents,
        };
    prepared.push({
      kind: "variants",
      name,
      many,
      arms: preparedArms,
      memberships,
    });
  }
  /**
   * One immutable alias-free projection description and decoder shape.
   *
   * An operation that names NEITHER `select` NOR `include` asks for the model's
   * DEFAULT projection, which is a fact of the model and the dialect and of
   * nothing else, so it is resolved once per (adapter, model) and shared
   * ({@link QueryViews}). Every other operation prepares per operation exactly
   * as before, reusing only the per-field leaves.
   */
  /**
   * `internal` names a projection the engine reads for itself (a stored row,
   * an identity): it carries no declared key and no gate, whatever the domain
   * declares (K5); every projection a caller's result reads is not internal.
   */
  prepareProjection(
    model: AnyModel,
    args: Partial<Arguments>,
    internal = false,
    path = ""
  ): PreparedProjection {
    const projected = internal ? undefined : this.domain?.projected(model);
    const shared = args.select === undefined && args.include === undefined;
    const defaults =
      projected === undefined
        ? this.#views.defaultProjections
        : this.domain!.defaultProjections;
    if (shared) {
      const resolved = defaults.get(model);
      if (resolved !== undefined) return resolved;
    }
    const named =
      projected && args.select !== undefined
        ? namedGatedFields.get(args.select)
        : undefined;
    // Made only where the domain gates a field of `model` (K5).
    const gated: Record<string, GatedMember> | undefined = projected && {};
    const gates = projected && new Map<FieldGate, string>();
    // `omit` is desugared into `select` at admission; an explicit selection and
    // an include can therefore both be present and both belong to the result.
    let selected = args.select ?? defaultSelection(model);
    if (args.include !== undefined) selected = { ...selected, ...args.include };
    const prepared: PreparedProjectionField[] = [];
    const fields: Record<string, Shape | Leaf> = {};
    let distanceSelected = false;
    for (const name of Object.keys(selected)) {
      const selection = selected[name];
      if (!selection) continue;
      // `_count` is the relation-count key and nothing else: schema
      // validation refuses a member of that name (F010).
      if (name === "_count") {
        this.#projectCounts(model, name, selection, fields, prepared);
        continue;
      }
      if (!model["~"].state.relations[name]) {
        const distance =
          selection === true ? undefined : record(selection)._distance;
        if (distance !== undefined) {
          this.#projectDistance(
            model,
            name,
            distance,
            distanceSelected,
            fields,
            prepared
          );
          distanceSelected = true;
          continue;
        }
      }
      const evidence = projected?.keys.get(name);
      if (evidence !== undefined) {
        this.domain!.projectEvidence(
          evidence,
          name,
          selection,
          fields,
          prepared
        );
        continue;
      }
      if (!model["~"].state.relations[name]) {
        prepared.push({ kind: "scalar", name });
        fields[name] = this.scalarShape(model, name);
        const gate = projected?.gates.get(name);
        if (gate === undefined) continue;
        let member = gates!.get(gate);
        if (member === undefined) {
          member = gateResultKey(gates!.size);
          gates!.set(gate, member);
          prepared.push({ kind: "gate", name: member, gate });
        }
        gated![name] = named?.has(name)
          ? { gate: member, refused: `${path}select.${name}` }
          : { gate: member };
        continue;
      }
      const resolved = this.schema.index.get(model)!.get(name)!;
      if (
        !resolved.member &&
        (resolved.edge.kind === "variantRowCarrier" ||
          resolved.edge.kind === "variantJunctionCarrier")
      ) {
        this.#projectVariants(
          model,
          name,
          resolved,
          selection,
          fields,
          prepared,
          `${path}${args.include?.[name] === undefined ? "select" : "include"}.${name}.`
        );
        continue;
      }
      const nested = this.#prepareRelationProjection(
        bindMembership(this.schema, model, name),
        selection,
        `${path}${args.include?.[name] === undefined ? "select" : "include"}.${name}.`
      );
      fields[name] = this.#relationShape(nested);
      prepared.push({ kind: "relation", name, ...nested });
    }
    // An empty projection is the model's own default — every scalar omitted —
    // and the row still exists, so it carries the sentinel column. A written
    // `select` that projects nothing never arrives: admission refuses it at
    // its path (`requireSelectedField`, validation/model/core/select.ts).
    if (prepared.length === 0)
      prepared.push({ kind: "sentinel", name: EMPTY_ROW_RESULT_KEY });
    const projection: PreparedProjection = {
      model,
      fields: prepared,
      shape: gates?.size
        ? {
            kind: "object",
            fields,
            gated: gated!,
            gates: [...gates.values()],
          }
        : { kind: "object", fields },
    };
    if (shared) defaults.set(model, projection);
    return projection;
  }
  /**
   * A to-many node's decoded shape. A negative `take` runs the reversed window
   * exactly as at the root, so the carried array is restored to the caller's
   * logical order by the one decoder that reads this shape.
   */
  #relationShape(nested: PreparedRelationProjection): Shape {
    if (nested.recurrence) {
      const resolved = this.schema.index
        .get(nested.edge.source)!
        .get(nested.edge.name)!;
      return {
        kind: "recursive",
        relation: nested.edge.name,
        many: nested.edge.many,
        optional: slotMayBeEmpty(resolved),
        recurrence: nested.recurrence,
        row: nested.projection.shape,
        identity: this.schema
          .keys(nested.edge.target)
          .map((field) => this.scalarShape(nested.edge.target, field)),
      };
    }
    if (!nested.edge.many) return nested.projection.shape;
    return this.#collectionShape(nested);
  }
  /** A to-many relation's rows, in the window its `take` requested. */
  #collectionShape(nested: PreparedRelationProjection): CollectionShape {
    const take = nested.arguments.take;
    return {
      kind: "collection",
      reversed: take !== undefined && take < 0 ? true : undefined,
      row: nested.linkRow
        ? {
            ...nested.projection.shape,
            fields: {
              ...nested.projection.shape.fields,
              $through: nested.linkRow.shape,
            },
          }
        : nested.projection.shape,
    };
  }
  /** A missing point/vector or a zero-norm cosine distance has no number. */
  #distanceLeaf(model: AnyModel, field: string, distance: Input): Leaf {
    const physical = this.physical(model, field);
    return {
      kind: "scalar",
      type: "number",
      nullable:
        physical.nullable ||
        (physical.state.type === "vector" && distance.metric === "cosine"),
    };
  }
  /**
   * A node's `$through`, and its arguments without it: the key is the slot's,
   * not a field of the target its projection reads. Admission mounted it only
   * on a slot a declared model holds, so no other slot has anything to take.
   *
   * It RETURNS the junction model's columns, so it is a read of that model,
   * unlike the hop beside it. Whatever a direct read of them would hide on
   * this client refuses the key, before any statement: a row its `rows` hide
   * or a field a gate masks has no faithful answer in a value the hop already
   * reached (the target row is there; the link it came through is not to be
   * told). `defaultOmit` is presentation, and is settled at the client.
   */
  #prepareLinkRow(edge: Membership, nested: Partial<Arguments>) {
    if (edge.kind !== "junction" || !edge.declared) return { nested };
    const { select, include } = nested as {
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
    };
    const asked = select?.$through ?? include?.$through;
    if (select?.$through === undefined && include?.$through === undefined)
      return { nested };
    const rest = {
      ...nested,
      ...(select && { select: withoutLinkKey(select as Input) }),
      ...(include && { include: withoutLinkKey(include as Input) }),
    };
    if (!asked) return { nested: rest };
    const model = edge.declared.model;
    const named = Object.entries(record(record(asked).select))
      .filter(([, wanted]) => wanted === true)
      .map(([field]) => field);
    this.domain?.refuseHiddenLinkRow(this, edge, named, "read");
    return {
      nested: rest,
      linkRow: {
        model,
        fields: named,
        shape: {
          kind: "object" as const,
          fields: Object.fromEntries(
            named.map((field) => [field, this.scalarShape(model, field)])
          ),
        },
      },
    };
  }
  #prepareRelationProjection(
    edge: Membership,
    selection: unknown,
    path = ""
  ): PreparedRelationProjection {
    const { nested: taken, linkRow } = this.#prepareLinkRow(
      edge,
      selection === true ? {} : (record(selection) as Partial<Arguments>)
    );
    const linkWhere =
      edge.kind === "junction" && edge.declared
        ? (taken.where?.$through as Input | undefined)
        : undefined;
    if (linkWhere)
      this.domain?.refuseHiddenLinkRow(
        this,
        edge,
        Object.keys(linkWhere),
        "filter"
      );
    const nested = linkWhere
      ? { ...taken, where: withoutLinkKey(taken.where as Input) }
      : taken;
    return {
      edge,
      linkRow,
      linkWhere:
        linkWhere &&
        this.prepareSelector(
          (edge as Extract<Membership, { kind: "junction" }>).declared!.model,
          linkWhere,
          false,
          false
        ),
      arguments: {
        selector: nested.where
          ? this.prepareSelector(edge.target, nested.where, false, false)
          : undefined,
        orderBy:
          nested.orderBy ??
          (edge.many ? this.defaultOrder(edge.target) : undefined),
        take: nested.take,
        skip: nested.skip,
        cursor: nested.cursor,
        distinct: nested.distinct,
      },
      projection: this.prepareProjection(edge.target, nested, false, path),
      recurrence: nested.recurse,
    };
  }
  /**
   * Admission desugars `_count: true` into `{ select: { relation: … } }`, so
   * the projection owner reads one shape; an entry may filter its target.
   */
  #prepareCounts(
    model: AnyModel,
    selection: unknown
  ): readonly PreparedCount[] {
    const requested = record(record(selection).select);
    const counts: PreparedCount[] = [];
    for (const [relation, configuration] of Object.entries(requested)) {
      if (!configuration) continue;
      const { edges, variants } = this.countedMemberships(model, relation);
      const where =
        configuration === true ? undefined : record(configuration).where;
      if (where === undefined) {
        counts.push({ relation, edges });
        continue;
      }
      const filter = record(where);
      if (!variants) {
        counts.push({
          relation,
          edges,
          selector: this.prepareSelector(
            edges[0]!.target,
            filter,
            false,
            false
          ),
        });
        continue;
      }
      // A TAGGED count filter selects an arm; it is not a scalar predicate
      // over one of them. `type` names the arm — admission makes it mandatory
      // for a polymorphic collection — and `is`/`isNot` are prepared against
      // THAT arm's target, whose columns are the only ones they can address.
      const tag = filter.type;
      const arm = edges.find((edge) => edge.scope.member?.variant === tag);
      if (!arm)
        throw new QueryEngineError(
          `Unknown polymorphic target '${String(tag)}' for relation '${relation}'.`
        );
      const negated = filter.isNot !== undefined;
      const inner = negated ? filter.isNot : filter.is;
      counts.push({
        relation,
        edges: [arm],
        selector:
          inner === undefined
            ? undefined
            : this.prepareSelector(arm.target, record(inner), false, false),
        ...(negated ? { negated: true as const } : {}),
      });
    }
    return counts;
  }
  /**
   * Every membership one relation SLOT counts.
   *
   * An ordinary relation is one edge. A variant carrier is not: it has no single
   * membership — each arm has its own target and its own correlation — so the
   * slot's population is the union of its arms, and its size is their sum. This
   * is the one place that fact is stated; the `_count` projection and `_count`
   * ordering both read it here.
   */
  countedMemberships(
    model: AnyModel,
    relation: string
  ): {
    readonly edges: readonly Membership[];
    /**
     * Whether those memberships are a carrier's ARMS. The same owner answers
     * it, because it is the same classification: a tagged `_count` filter
     * selects one arm and an ordinary `where` filters one target, and reading
     * "is this a carrier?" a second time is how the two got confused.
     */
    readonly variants: boolean;
  } {
    const resolved = this.schema.index.get(model)!.get(relation)!;
    const carrier =
      resolved.member === undefined &&
      (resolved.edge.kind === "variantRowCarrier" ||
        resolved.edge.kind === "variantJunctionCarrier")
        ? resolved.edge
        : undefined;
    return {
      edges: carrier
        ? carrier.members.map((member) =>
            bindMembership(this.schema, model, relation, member.variant)
          )
        : [bindMembership(this.schema, model, relation)],
      variants: carrier !== undefined,
    };
  }
  /**
   * ONE statement's row-count contract, on the rows that statement answered.
   *
   * It is the one fact a terminal WINDOW owns rather than the operation:
   * {@link Queries.selectSeries} stamps every bind-budget window with its own
   * identity count and its own registered refusal, so a terminal split into
   * windows is decided here, per window, while the window is still known. A
   * total taken over the concatenation would compare a whole terminal with one
   * window's count and could not raise that window's refusal at all
   * (`OperationContext.publishedTerminal`, Arnaud's D-28).
   */
  assertExpectedRows(query: Query, rows: number): void {
    if (query.expectedRows && rows < query.expectedRows.count)
      throw query.expectedRows.missing;
    if (query.expectedRows && rows > query.expectedRows.count)
      throw new QueryEngineError(
        "createMany returned a different number of rows than expected."
      );
  }
  /** A write's own read, decoded as the stored row it is (an internal read). */
  decodeQuery(query: Query, rows: Input[]): Input[] {
    this.assertExpectedRows(query, rows.length);
    return this.decodeProjection(query.shape, rows, true);
  }
  decodeProjection(
    shape: ProjectionShape,
    rows: Input[] | unknown[][],
    internal = false,
    columns?: readonly string[]
  ): Input[] {
    // An empty batch — a filter that matched nothing — reads nothing, so it
    // compiles nothing.
    if (rows.length === 0) return [];
    const read = this.compileReader(shape, internal, false, columns);
    return rows.map((row) => record(read(row)));
  }
  private decodeRecursiveCarrier(
    shape: Extract<Shape, { kind: "recursive" }>,
    value: unknown,
    readRow: Reader,
    readIdentity: readonly Reader[]
  ): unknown {
    const carrier = providerDocument(providerJson(value));
    if (!carrier)
      throw new InvalidScalarResult(
        "recursive carrier",
        "the carrier is not an object"
      );
    const root = own(carrier, RECURSIVE_CARRIER.root);
    const rawNodes = own(carrier, RECURSIVE_CARRIER.nodes);
    const rawEdges = own(carrier, RECURSIVE_CARRIER.edges);
    if (
      !(
        Array.isArray(root) &&
        Array.isArray(rawNodes) &&
        Array.isArray(rawEdges)
      )
    )
      throw new InvalidScalarResult(
        "recursive carrier",
        "the carrier's root, nodes or edges member is not an array"
      );

    const identity = (tuple: unknown): string => {
      if (!Array.isArray(tuple) || tuple.length !== shape.identity.length)
        throw new InvalidScalarResult(
          "recursive identity",
          "an identity is not a tuple of the key's width"
        );
      // A counted walk: `entries()` allocated an iterator and a pair per
      // member on every identity — root, node key and both edge endpoints.
      let index = 0;
      for (const read of readIdentity) {
        read(tuple[index]);
        index += 1;
      }
      return JSON.stringify(tuple);
    };
    const rootKey = identity(root);
    const nodes = new Map<string, unknown>();
    for (const rawNode of rawNodes) {
      const node = providerDocument(rawNode);
      if (!node)
        throw new InvalidScalarResult(
          "recursive node",
          "a node entry is not an object"
        );
      const key = identity(own(node, RECURSIVE_CARRIER.key));
      if (nodes.has(key))
        throw new InvalidScalarResult(
          "duplicate recursive node",
          "two nodes carry the same identity"
        );
      nodes.set(key, own(node, RECURSIVE_CARRIER.row));
    }

    type Edge = { readonly child: string; readonly depth?: number };
    const edges = new Map<string, Edge[]>();
    const facts = new Set<string>();
    for (const rawEdge of rawEdges) {
      const edge = providerDocument(rawEdge);
      if (!edge)
        throw new InvalidScalarResult(
          "recursive edge",
          "an edge entry is not an object"
        );
      const parent = identity(own(edge, RECURSIVE_CARRIER.parent));
      const child = identity(own(edge, RECURSIVE_CARRIER.child));
      if (!nodes.has(child))
        throw new InvalidScalarResult(
          "recursive edge endpoint",
          "an edge's child is not a carried node"
        );
      const rawDepth = own(edge, RECURSIVE_CARRIER.depth);
      let depth: number | undefined;
      if (shape.recurrence.depth === false) {
        if (rawDepth !== undefined)
          throw new InvalidScalarResult(
            "exhaustive recursive depth",
            "an exhaustive carrier states an edge depth"
          );
      } else {
        if (
          typeof rawDepth !== "number" ||
          !Number.isSafeInteger(rawDepth) ||
          rawDepth < 1 ||
          rawDepth > shape.recurrence.depth
        )
          throw new InvalidScalarResult(
            "recursive depth",
            "an edge depth is not an integer from 1 to the cutoff"
          );
        depth = rawDepth;
      }
      const fact = JSON.stringify([parent, child, depth ?? null]);
      if (facts.has(fact))
        throw new InvalidScalarResult(
          "duplicate recursive edge",
          "an edge fact is carried twice"
        );
      facts.add(fact);
      const siblings = edges.get(parent);
      const entry = {
        child,
        ...(depth === undefined ? {} : { depth }),
      };
      if (siblings) siblings.push(entry);
      else edges.set(parent, [entry]);
    }

    /**
     * One parent, one answer, taken once over the COMPLETE edge index: the
     * distinct successors it offers, in transported sibling order. Their count
     * is also where singular cardinality is answerable at all, so the parent's
     * endpoint, its cardinality and its successors are decided here — over
     * every transported fact — instead of being rediscovered at each
     * occurrence that happens to unfold this parent.
     */
    const successors = new Map<string, readonly string[]>();
    for (const [parent, entries] of edges) {
      if (parent !== rootKey && !nodes.has(parent))
        throw new InvalidScalarResult(
          "recursive edge endpoint",
          "an edge's parent is neither the root nor a carried node"
        );
      const unique = [...new Set(entries.map((entry) => entry.child))];
      if (!shape.many && unique.length > 1)
        throw new InvalidScalarResult(
          "recursive singular relation",
          "a singular parent has several successors"
        );
      successors.set(parent, unique);
    }
    /**
     * ONE walk over the transported facts, before any of them is unfolded.
     *
     * The root is reached at level 0, and a bounded edge is reachable only one
     * level below its own recorded `__rq_depth` — the only meaning that number
     * has, and the reason the provider transports it. An identity reached by
     * several distinct paths keeps EVERY level it was reached at, so a diamond
     * and a re-entered junction node stay legal; an exhaustive carrier records
     * no level, collapses to the identity alone, and so still terminates on a
     * legal cyclic graph.
     *
     * Three facts fall out of that one walk. A BOUNDED edge no level can
     * consume is a depth attributed to a hop it was not discovered at. A
     * bounded hop below the cutoff whose children at the next level are not
     * the parent's one answer is a hop the provider did not discover: the
     * statement discovers a parent's children at EVERY level it reaches that
     * parent (a filter prunes each hop the same way, and prevention is this
     * decoder's, not the statement's), so unfolding the one answer there would
     * invent an occurrence the carrier never transported. An identity no
     * consumed edge reaches is a node outside this answer. Only a stated depth
     * can be misattributed or missing, so only a bounded carrier is asked the
     * first two questions: on an exhaustive one an unconsumed edge means its
     * parent was never reached, which is the third question's answer.
     */
    const consumed = new Set<Edge>();
    const reached = new Set<string>();
    const levels = new Set<string>();
    const pending: (readonly [string, number])[] = [[rootKey, 0]];
    // `for…of` re-reads the length each step, so the levels pushed below are
    // walked too, exactly as the indexed loop did.
    for (const [parent, level] of pending) {
      const children = new Set<string>();
      for (const entry of edges.get(parent) ?? []) {
        if (entry.depth !== undefined && entry.depth !== level + 1) continue;
        consumed.add(entry);
        reached.add(entry.child);
        children.add(entry.child);
        const at =
          entry.depth === undefined
            ? entry.child
            : `${entry.depth} ${entry.child}`;
        if (levels.has(at)) continue;
        levels.add(at);
        pending.push([entry.child, level + 1]);
      }
      if (
        shape.recurrence.depth !== false &&
        carriesRepeatedKey(shape.recurrence.depth, level) &&
        children.size !== (successors.get(parent)?.length ?? 0)
      )
        throw new InvalidScalarResult(
          "recursive depth",
          "a hop below the cutoff omits some of its parent's children"
        );
    }
    if (shape.recurrence.depth !== false && consumed.size !== facts.size)
      throw new InvalidScalarResult(
        "recursive depth",
        "an edge is not reachable at its recorded depth"
      );
    if (reached.size !== nodes.size)
      throw new InvalidScalarResult(
        "unreachable recursive node",
        "a carried node is not reachable from the root"
      );

    /** A numeric cutoff reached: this occurrence omits the repeated slot. */
    const cutoff = (depth: number) =>
      !carriesRepeatedKey(shape.recurrence.depth, depth);
    /** One slot's successors, collapsed by its cardinality and emptiness. */
    // A singular slot here may be empty: CM002 refuses a required self
    // foreign key.
    const collapse = (rows: Input[]): unknown => {
      if (rows.length > 0) return shape.many ? rows : rows[0]!;
      return shape.many ? [] : null;
    };
    type Frame = {
      readonly key: string;
      readonly depth: number;
      readonly row: Input;
      readonly childKeys: readonly string[];
      readonly childRows: Input[];
      next: number;
    };
    /**
     * ONE active path, seeded by the outer row and kept by enter and leave.
     *
     * Copying the ancestry prefix into every descended occurrence held those
     * identities once per hop and made a chain quadratic in its own depth;
     * the stack already holds them.
     */
    const active = new Set<string>([rootKey]);
    const stack: Frame[] = [];
    /**
     * The one admission EVERY followed edge passes, the first hop included —
     * which is what seeding the path with the root makes possible: a graph
     * edge straight back to the outer row is a revisit like any other, and an
     * FK one is the same refusal at the first hop as at the hundredth.
     */
    let occurrences = 0;
    const budget = shape.recurrence.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
    const follow = (from: number, key: string): void => {
      if (active.has(key)) {
        if (shape.recurrence.cycles === "reject")
          throw new UnsupportedOperationError(
            `Recursive relation '${shape.relation}' contains a cycle.`,
            {
              meta: {
                relation: shape.relation,
                feature: "cyclic recursive traversal",
              },
            }
          );
        if (shape.recurrence.cycles === "prevent") return;
      }
      if (++occurrences > budget)
        throw new RecursiveOutputOverBudget(shape.relation, budget);
      active.add(key);
      const decoded = readRow(nodes.get(key));
      if (decoded === null)
        throw new InvalidScalarResult("recursive row", "a node's row is null");
      const depth = from + 1;
      stack.push({
        key,
        depth,
        row: record(decoded),
        childKeys: cutoff(depth) ? [] : (successors.get(key) ?? []),
        childRows: [],
        next: 0,
      });
    };
    const rootRows: Input[] = [];
    for (const child of successors.get(rootKey) ?? []) {
      follow(0, child);
      for (
        let current = stack.at(-1);
        current !== undefined;
        current = stack.at(-1)
      ) {
        if (current.next < current.childKeys.length) {
          follow(current.depth, current.childKeys[current.next++]!);
          continue;
        }
        active.delete(current.key);
        stack.pop();
        if (!cutoff(current.depth))
          current.row[shape.relation] = collapse(current.childRows);
        const parent = stack.at(-1);
        if (parent) parent.childRows.push(current.row);
        else rootRows.push(current.row);
      }
    }
    return collapse(rootRows);
  }
  /**
   * The ONE decoder of the projection language, compiled for one decoded
   * batch — a result window, a RETURNING answer, an internal read — and
   * dropped with it. Every invariant decision of a placement is taken here,
   * once: an object's member list and each member's placement, a variant
   * slot's arms, a collection's and a recursive carrier's row reader, a list
   * leaf's container reader ({@link compileList}), and — for a PHYSICAL
   * scalar slot only — this execution's provider continuation
   * ({@link fieldReader}). The returned reader then does only what depends on
   * the provider's value, through the preselected scalar codec
   * ({@link compileScalar}) and the one carrier validator
   * ({@link decodeRecursiveCarrier}).
   *
   * `carried` is a fact of the PLACEMENT, never of the shape: a to-one
   * relation's shape is its target's shared default projection, read as the
   * root row of one statement and inside a JSON document of another. Only a
   * scalar member of a physical row crosses the provider chain; a JSON window
   * already decoded everything under it.
   *
   * The reader holds a driver's parser, so it lives no longer than the batch
   * it was compiled for and is never stored on the prepared shape, which
   * `EngineSchema` shares across executions and driver bindings.
   */
  private compileReader(
    shape: Shape | Leaf,
    internal: boolean,
    carried: boolean,
    columns?: readonly string[]
  ): Reader {
    if (shape.kind === "scalar") {
      const provider = carried ? undefined : this.fieldReader(shape.type);
      const list = shape.list ? this.compileList(shape, internal) : undefined;
      return this.compileScalar(shape, internal, provider, list);
    }
    if (shape.kind === "recursive") {
      const readRow = this.compileReader(shape.row, internal, true);
      // An identity is validated as the stored key it is (an INTERNAL read),
      // never published.
      const readIdentity = shape.identity.map((leaf) =>
        this.compileReader(leaf, true, true)
      );
      return (value) =>
        this.decodeRecursiveCarrier(shape, value, readRow, readIdentity);
    }
    if (shape.kind === "variants") {
      const slot = (value: unknown): Input => {
        // The slot is a provider document the statement always builds, read
        // by the one document rule: a NULL or non-object slot is a malformed
        // result, refused at the slot before any arm is asked (Arnaud,
        // 2026-09-25).
        const variants = providerDocument(providerJson(value));
        if (!variants)
          throw new InvalidScalarResult(
            "polymorphic slot",
            "the slot is not an object"
          );
        // The integrity probe first, and before any arm: a membership whose
        // row is gone is a fact about the SLOT, so `only` — which selects what
        // is read — cannot make it unobservable (Arnaud's D-26). One refusal,
        // from the decoder arm that already owns the sentence. Its entry is a
        // document of the slot, read by the same rule: a slot with no
        // junction membership carries none, and a PRESENT entry that is no
        // document is the slot's malformed result — never "no memberships".
        const evidence = own(variants, POLYMORPHIC_COLLECTION_ORPHANS_KEY);
        if (evidence === undefined) return variants;
        const orphans = providerDocument(evidence);
        if (!orphans)
          throw new InvalidScalarResult(
            "polymorphic slot",
            "the integrity entry is not an object"
          );
        for (const [type, count] of Object.entries(orphans))
          if (Number(count) > 0) {
            if (type === "$storage")
              throw new QueryEngineError(
                `Polymorphic relation '${shape.relation}' has an unknown discriminator or incomplete stored pair.`
              );
            throw new QueryEngineError(
              `Polymorphic relation '${shape.relation}' references a missing '${type}' record.`
            );
          }
        return variants;
      };
      // Its arms, compiled once, in `shape.arms` order. A junction-carried
      // slot's arm is a collection, so its reader answers the arm's rows.
      if (shape.many) {
        const arms = Object.keys(shape.arms).map((type) => ({
          type,
          read: this.#compileCollection(shape.arms[type]!, internal),
        }));
        return (value) => {
          const variants = slot(value);
          const values: unknown[] = [];
          for (const { type, read } of arms)
            for (const data of read(own(variants, type)))
              values.push({ type, data });
          return values;
        };
      }
      const arms = Object.keys(shape.arms).map((type) => {
        const arm = shape.arms[type]!;
        return { type, arm, read: this.compileReader(arm, internal, true) };
      });
      return (value) => {
        const variants = slot(value);
        for (const { type, arm, read } of arms) {
          const carrier = own(variants, type);
          if (orphanedArm(carrier, arm))
            throw new QueryEngineError(
              `Polymorphic relation '${shape.relation}' references a missing '${type}' record.`
            );
          const data = read(carrier);
          if (data !== null) return { type, data };
        }
        return null;
      };
    }
    if (shape.kind === "collection")
      return this.#compileCollection(shape, internal);
    // The document's MEMBER LIST is a fact of the PREPARED PROJECTION, stated
    // once by {@link prepareProjection} on the shape; a row carries
    // only the values for it. It is read here, once per batch — the shape's
    // OWN keys, exactly as {@link own} reads the provider's — and never again
    // per row: materialising it per row as pairs (`Object.entries` read back
    // by `Object.fromEntries`) made this decoder allocate 2.5x the shipped
    // engine's bytes per row (`g4/release/p1/note.md`).
    const fields = Object.keys(shape.fields);
    const readers = fields.map((field) => {
      const nested = shape.fields[field]!;
      return this.compileReader(
        nested,
        internal,
        carried || nested.kind !== "scalar"
      );
    });
    // An internal read is the engine's own: it reads every member it asked
    // for, its gates unread (K5).
    if (shape.gates !== undefined && !internal)
      return this.domain!.gatedDocument(
        this.compileReader(BOOLEAN_LEAF, false, carried),
        shape,
        fields,
        readers,
        columns
      );
    if (columns) {
      // Native aliases locate cells once; a statement transform may reorder
      // columns. Last occurrence matches the keyed transport's duplicate names.
      const positions = fields.map((field) => columns.lastIndexOf(field));
      return (value) => {
        if (!Array.isArray(value))
          throw new InvalidScalarResult(
            "row",
            "a positional row is not an array"
          );
        const document: Input = {};
        for (let index = 0; index < fields.length; index++) {
          const position = positions[index]!;
          document[fields[index]!] = readers[index]!(
            position < 0 ? undefined : value[position]
          );
        }
        return document;
      };
    }
    return (value) => {
      const source = providerDocument(providerJson(value));
      if (source === null) {
        if (shape.nullable === false)
          throw new InvalidScalarResult(
            "row",
            "a document the statement always builds is null"
          );
        return null;
      }
      if (source === undefined)
        throw new InvalidScalarResult(
          "row",
          "a requested document is not a provider row"
        );
      // OWN-key semantics ({@link own}): a plain member read on a
      // `JSON.parse` result finds `Object.prototype`'s own members, so a
      // field named `toString` the provider OMITTED would inherit a function
      // instead of failing closed. Nested evidence documents also contain
      // user-named predicates, not just schema identifiers. Their `__proto__`
      // member must be an own data property, never the inherited setter.
      const document: Input = {};
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]!;
        const decoded = readers[index]!(own(source, field));
        if (field === "__proto__")
          Object.defineProperty(document, field, {
            value: decoded,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else document[field] = decoded;
      }
      return document;
    };
  }
  /**
   * A collection's reader, compiled by {@link compileReader} for a to-many
   * relation and for each arm of a junction-carried variant slot: its rows
   * are carried documents, restored to the requested order.
   */
  #compileCollection(
    shape: CollectionShape,
    internal: boolean
  ): (value: unknown) => unknown[] {
    const readRow = this.compileReader(shape.row, internal, true);
    return (value) => {
      const decoded = providerJson(value);
      if (!Array.isArray(decoded))
        throw new InvalidScalarResult(
          "collection",
          "a requested relation is not a provider array"
        );
      const rows = decoded.map(readRow);
      return shape.reversed ? rows.reverse() : rows;
    };
  }
  /**
   * One strict scalar decode per leaf, through the existing codec owners. A
   * value outside the column's declared domain is a malformed provider row,
   * never a value to coerce. `provider` is the physical value's continuation;
   * a CARRIED value — one a JSON document already holds — has none. `list` is
   * a list leaf's compiled container reader, and a list MEMBER's leaf is no
   * list.
   */
  private compileScalar(
    leaf: Leaf,
    internal: boolean,
    provider?: FieldReader,
    list?: Reader
  ): Reader {
    const readValue = list ?? this.#compileScalarValue(leaf, internal);
    const nullable = leaf.nullable;
    const allowsJsonNull = leaf.type === "json" && leaf.list !== true;
    const read: Reader = (raw) => {
      if (raw === null) {
        if (nullable) return null;
        if (!allowsJsonNull)
          throw new InvalidScalarResult(
            leaf.type,
            leaf.list ? "a required list is null" : "a required scalar is null"
          );
      }
      if (raw === undefined)
        throw new InvalidScalarResult(leaf.type, "the value is absent");
      return readValue(provider === undefined ? raw : provider(raw));
    };
    const join = this.splitSum(leaf)?.join;
    return join ? (parts) => read(join(parts)) : read;
  }
  /** Bind the declared scalar codec once, preserving its provider-value checks. */
  #compileScalarValue(leaf: Leaf, internal: boolean): Reader {
    const invalid = (why: string) => new InvalidScalarResult(leaf.type, why);
    const identifier = leaf.id;
    if (identifier !== undefined) {
      return (value) => {
        const decoded = decodeIdentifier(identifier, value);
        if (decoded === undefined)
          throw invalid(
            "the value is not in this column's declared identifier domain"
          );
        return internal && identifier.representation === "text"
          ? value
          : decoded;
      };
    }
    switch (leaf.type) {
      case "string":
        return decodeString;
      case "boolean":
        return decodeBoolean;
      case "int":
        return leaf.widened ? (sum) => decodeInt(sum, true) : decodeInt;
      case "bigint":
        return decodeBigint;
      case "number":
        // A number sum is already decoded by `joinNumberSum`.
        return leaf.widened ? (sum) => sum : decodeNumber;
      case "decimal":
        return (value) => {
          const decoded = decodeDecimalScalar(
            value,
            leaf.decimal!,
            leaf.widened === true,
            internal,
            this.adapter.result
          );
          if (decoded === undefined)
            throw invalid(
              leaf.widened
                ? "the sum is not an exact decimal at this column's scale"
                : "the value is not an exact decimal in this column's declared domain"
            );
          return decoded;
        };
      case "datetime":
        return (value) => {
          if (leaf.dateTime !== undefined && leaf.dateTime !== "text") {
            const decoded = decodePhysicalDateTime(value, leaf.dateTime);
            if (decoded === undefined)
              throw invalid(
                "the value is not this column's declared physical timestamp"
              );
            return decoded;
          }
          if (value instanceof Date) {
            if (isDateTimeInstant(value.getTime()))
              return new Date(value.getTime());
            throw invalid("the Date is outside the public DateTime domain");
          }
          const parsed =
            typeof value === "string"
              ? decodeProviderTimestamp(value)
              : undefined;
          if (!parsed)
            throw invalid(
              "the value is not a valid provider timestamp in the public DateTime domain"
            );
          // A TEXT-stored instant's PHYSICAL value is the spelling itself
          // (`encodePhysicalDateTime(iso, "text")` is the identity), and this
          // column admits more than one spelling of one instant, so an INTERNAL
          // read keeps the bytes the row holds and a public one materializes the
          // `Date` — the same split the decimal arm above takes through
          // `decodeDecimalScalar`. That is what makes a captured identity
          // address its own row: `Queries.scalarValue` binds this string back
          // unchanged, while a `Date` would be re-spelled by the admission
          // boundary and match a row only where the payload's spelling was that
          // one (FC-02B, which repaired N5 §6's residual).
          return internal ? value : parsed;
        };
      case "date":
        return (value) => {
          if (value instanceof Date) {
            const epoch = value.getTime();
            if (
              isDateTimeInstant(epoch) &&
              value.getUTCHours() === 0 &&
              value.getUTCMinutes() === 0 &&
              value.getUTCSeconds() === 0 &&
              value.getUTCMilliseconds() === 0
            )
              return new Date(epoch);
            throw invalid("the Date is invalid or not UTC midnight");
          }
          const match =
            typeof value === "string" ? DATE_TEXT.exec(value) : null;
          const parsed = match
            ? decodeProviderTimestamp(
                `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z${match[4] ? " BC" : ""}`
              )
            : undefined;
          if (!parsed)
            throw invalid("the value is not a valid ISO calendar date");
          return parsed;
        };
      case "time":
        return decodeTime;
      case "enum":
        return (value) => {
          if (typeof value === "string" && leaf.enumValues?.has(value) === true)
            return value;
          throw invalid("the value is not a declared enum member");
        };
      case "json":
        return (value) => this.jsonValue(value);
      case "blob":
        return decodeBlob;
      case "vector":
        return (value) => {
          const decoded = providerJson(value);
          if (
            !Array.isArray(decoded) ||
            decoded.some(
              (member) => typeof member !== "number" || !Number.isFinite(member)
            )
          )
            throw invalid("the value is not an array of finite numbers");
          if (leaf.dimension !== undefined && decoded.length !== leaf.dimension)
            throw invalid(
              `the value does not have the configured dimension ${leaf.dimension}`
            );
          return [...decoded];
        };
      case "point":
        return (value) => {
          const decoded = providerJson(value);
          const point = validateGeoPoint(decoded);
          if (point.issues)
            throw invalid(
              point.issues[0]?.message ??
                "the value is not a canonical GeoPoint"
            );
          return point.value;
        };
      default:
        return () => {
          throw invalid("the scalar type is unsupported");
        };
    }
  }
  /**
   * A list leaf's container reader, compiled with its placement by
   * {@link compileReader}: the decimal whole-list codec or one container, then
   * each member through the element's own codec. The member's non-null leaf
   * is derived here, once per list placement of a decoded batch, never per
   * returned list. The reader runs after the NULL and absence checks and the
   * provider continuation, and each member is a carried value.
   */
  private compileList(leaf: Leaf, internal: boolean): Reader {
    if (leaf.type === "decimal")
      return (value) => {
        const members = decodeDecimalList(
          value,
          leaf.decimal!,
          internal,
          this.adapter.result
        );
        if (members === undefined)
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not an exact decimal list in this column's declared domain"
          );
        return members;
      };
    const member: Leaf = {
      ...leaf,
      list: undefined,
      nullable: false,
    };
    const readMember = this.compileScalar(member, internal);
    const arrayText =
      this.adapter.result.enumListRepresentation === "arrayText";
    return (value) => {
      const items: unknown =
        typeof value !== "string"
          ? value
          : arrayText && value.startsWith("{")
            ? providerArrayMembers(value)
            : JSON.parse(value);
      if (!Array.isArray(items))
        throw new InvalidScalarResult(
          leaf.type,
          "a list scalar did not return an array"
        );
      return items.map((item, index) => {
        if (!Object.hasOwn(items, index))
          throw new InvalidScalarResult(
            leaf.type,
            "a list scalar returned a sparse array"
          );
        return readMember(item);
      });
    };
  }
  /**
   * The JSON value domain, normalized once.
   *
   * A provider's JSON is not JavaScript's: SQLite declares a `json` column
   * with NUMERIC affinity, so the bound text `"42"` comes back as `42n` and a
   * caller who wrote `42` must read `42` — and a non-finite number, a sparse
   * array or an exotic prototype is a malformed provider value rather than
   * something to publish. (The shipped `scalar-structured-parser.ts:144-200`.)
   *
   * A JavaScript value can also contain ITSELF, which provider text never can:
   * a recursive read's node row arrives as an object, not as text this decoder
   * parsed. That is the same fact as every other one here — the value is not
   * in the JSON domain — so this boundary answers it instead of recursing into
   * a `RangeError`. `enclosing` is the containers this value is being
   * normalized INSIDE, entered before a container's members and left after
   * them, so a document that merely REPEATS one object still normalizes it
   * twice and only a container reached from within itself is refused.
   */
  private jsonValue(value: unknown, enclosing?: object[]): unknown {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw new InvalidScalarResult("json", "a JSON number is not finite");
    }
    if (typeof value === "bigint") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
      throw new InvalidScalarResult(
        "json",
        "a JSON integer is outside the finite Number domain"
      );
    }
    if (Array.isArray(value)) {
      const path = this.#enterJsonContainer(value, enclosing);
      const members = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new InvalidScalarResult("json", "a JSON array is sparse");
        members[index] = this.jsonValue(value[index], path);
      }
      path.pop();
      return members;
    }
    if (isPlainJsonRecord(value)) {
      const path = this.#enterJsonContainer(value, enclosing);
      const members: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const member = this.jsonValue(value[key], path);
        // Defined where `Object.prototype` holds the key: assigning
        // `__proto__` would set the prototype, and an inherited property
        // a hardened (frozen) prototype holds would refuse the assignment.
        if (key in Object.prototype)
          Object.defineProperty(members, key, {
            configurable: true,
            enumerable: true,
            value: member,
            writable: true,
          });
        else members[key] = member;
      }
      path.pop();
      return members;
    }
    throw new InvalidScalarResult(
      "json",
      "the value is outside the JSON value domain"
    );
  }
  /**
   * The one entry into a JSON container: the containers already being
   * normalized around it, plus this one. A container that is already open is
   * inside itself, which no JSON document is. The path is a stack, as deep
   * as the document's nesting, so a scan of it is cheaper than a set.
   */
  #enterJsonContainer(
    container: object,
    enclosing: object[] | undefined
  ): object[] {
    const path = enclosing ?? [];
    if (path.includes(container))
      throw new InvalidScalarResult("json", "a JSON value contains itself");
    path.push(container);
    return path;
  }
}

/** A document, not a class instance: the shipped JSON record test. */
function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?: (BC))?$/;
const TIME_TEXT =
  /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;
const TIME_ZONE_SUFFIX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const TRAILING_FRACTION_ZEROS = /\.?0+$/;

function decodeString(value: unknown): unknown {
  if (typeof value === "string") return value;
  throw new InvalidScalarResult("string", "the value is not a string");
}

function decodeBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new InvalidScalarResult(
    "boolean",
    "the value is not true, false, zero, or one"
  );
}

/** `sum`: an int `_sum` past 2^53 reads as the nearest double (a lossy sum). */
function decodeInt(value: unknown, sum = false): unknown {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && INTEGER_TEXT.test(value)
        ? Number(value)
        : value;
  if (typeof parsed !== "number")
    throw new InvalidScalarResult(
      "int",
      "the value is not a canonical integer"
    );
  if (!(sum ? Number.isInteger(parsed) : Number.isSafeInteger(parsed)))
    throw new InvalidScalarResult(
      "int",
      "the integer is outside the safe range"
    );
  return parsed;
}

function decodeBigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  if (typeof value === "string" && INTEGER_TEXT.test(value))
    return BigInt(value);
  throw new InvalidScalarResult(
    "bigint",
    "the value is not a canonical integer"
  );
}

function decodeNumber(value: unknown): number {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed))
    throw new InvalidScalarResult(
      "number",
      "the value is not a canonical finite number"
    );
  return parsed;
}

/** A widened `_sum`'s SQL and the join its reader reads. */
export type SplitSumSql = ReturnType<
  DatabaseAdapter["aggregates"]["numberSum"]
>;
interface SplitSum {
  readonly sql: (expr: Sql) => SplitSumSql;
  readonly join: (parts: unknown) => unknown;
}

/** The divisor `aggregates.numberSum` scales its high part by. */
const NUMBER_SUM_SCALE = 2 ** 64;

/**
 * A number `_sum` from its two `numberSum` parts: `high * 2^64 + low`, which
 * is the summed double, `±Infinity` past the double range. Each part is null
 * when none of its members is present, so both are for an empty window.
 */
function joinNumberSum(value: unknown): number | null {
  const [first, second] = sumParts(value, "number");
  const high = first === null ? null : decodeNumber(first);
  const low = second === null ? null : decodeNumber(second);
  if (high === null) return low;
  return high * NUMBER_SUM_SCALE + (low ?? 0);
}

/** The factor `aggregates.integerSum` splits its high part at. */
const INTEGER_SUM_SCALE = 2n ** 32n;

/**
 * An int64 `_sum` from its two `integerSum` parts, `high * 2^32 + low`, as
 * the integer text the bigint and decimal-coefficient decoders read. Both
 * parts sum the same members, so both are null for an empty window.
 */
function joinIntegerSum(value: unknown, type: string): string | null {
  const [high, low] = sumParts(value, type);
  if (high === null) return null;
  return String(decodeBigint(high) * INTEGER_SUM_SCALE + decodeBigint(low));
}

function sumParts(value: unknown, type: string): [unknown, unknown] {
  if (!Array.isArray(value) || value.length !== 2)
    throw new InvalidScalarResult(type, "the sum is not its two parts");
  return [value[0], value[1]];
}

function decodeTime(value: unknown): string {
  if (typeof value !== "string")
    throw new InvalidScalarResult(
      "time",
      "the value is not a valid provider time"
    );
  const match = TIME_TEXT.exec(value);
  if (
    !(
      match &&
      isDateTimeClock(Number(match[1]), Number(match[2]), Number(match[3]))
    )
  )
    throw new InvalidScalarResult(
      "time",
      "the value is not a valid provider time"
    );
  if (Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59)
    throw new InvalidScalarResult("time", "the timezone suffix is invalid");
  let time = value.replace(TIME_ZONE_SUFFIX, "");
  if (time.includes(".")) time = time.replace(TRAILING_FRACTION_ZEROS, "");
  const fraction = time.split(".")[1];
  if (fraction && fraction.length > 3)
    throw new InvalidScalarResult(
      "time",
      "the normalized precision exceeds milliseconds"
    );
  return time;
}

/**
 * Every driver's binary spelling, normalized to one fresh Uint8Array by the one
 * binary-shape owner (`validation/primitives/binary-shapes.ts`); the refusal's
 * wording is this boundary's.
 */
function decodeBlob(value: unknown): Uint8Array {
  const { bytes } = normalizeBinaryValue(value);
  if (bytes) return bytes;
  throw new InvalidScalarResult("blob", "the value is not a binary value");
}

/** One dimension of a provider's own array output text: `{a,"b,c",NULL}`. */
function providerArrayMembers(text: string): unknown[] {
  if (!(text.startsWith("{") && text.endsWith("}")))
    throw new InvalidScalarResult(
      "enum",
      "a list scalar did not return an array"
    );
  const body = text.slice(1, -1);
  if (body.length === 0) return [];
  const members: unknown[] = [];
  let index = 0;
  while (index <= body.length) {
    if (body[index] === '"') {
      let member = "";
      index += 1;
      while (index < body.length && body[index] !== '"') {
        member += body[index] === "\\" ? body[++index] : body[index];
        index += 1;
      }
      members.push(member);
      index += 2;
      continue;
    }
    const next = body.indexOf(",", index);
    const end = next === -1 ? body.length : next;
    const member = body.slice(index, end);
    members.push(member === "NULL" ? null : member);
    index = end + 1;
    if (next === -1) break;
  }
  return members;
}

export type { PreparedDomain } from "@extensions/row-domain";
