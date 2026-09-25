import type { ArithmeticTarget } from "@adapters/adapter-core-types";
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import type { DatabaseAdapter, GeoPointSql } from "@adapters/database-adapter";
import type { DriverResultParser } from "@drivers";
import {
  FeatureNotSupportedError,
  QueryEngineError,
  TransactionError,
  VibORMError,
} from "@errors";
import { DISTANCE_NAME_COLLISION } from "@query-engine/result/result-shape";
import {
  CURSOR_CARRIER_PREFIX,
  EMPTY_ROW_RESULT_KEY,
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
import type { ResolvedJunctionSide } from "@schema/relation/junction-topology";
import type { Scalar } from "@schema/scalars/base";
import type { ScalarState } from "@schema/scalars/common";
import type { NativeType } from "@schema/scalars/native-types";
import { Sql, sql } from "@sql";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parse } from "@validation";
import {
  type DateTimePhysicalForm,
  decodePhysicalDateTime,
} from "@validation/primitives/datetime-physical-codec";
import {
  isDateTimeClock,
  isDateTimeInstant,
  isGregorianCalendarDate,
} from "@validation/primitives/datetime-values";
import { geoBoundsForDistance } from "@validation/primitives/geo-area-codec";
import { validateGeoPoint } from "@validation/primitives/geo-point-codec";
import type { GeoArea, GeoPoint } from "@validation/primitives/geo-values";
import {
  validateIsoDate,
  validateIsoTimestamp,
} from "@validation/primitives/iso";
import {
  carriesRepeatedKey,
  type NormalizedRecurrence,
} from "@validation/relations/recurrence";
import type { Operation } from "../../types";
import {
  canonicalDecimal,
  type DecimalDescriptor,
  decimalMembers,
  decimalSumOperand,
  decodeDecimalList,
  decodeDecimalScalar,
  dividesByZero,
  exactDecimalDomain,
  requireDecimal,
  sameDecimalDomain,
} from "./decimal";
import {
  aggregatedIdentifier,
  decodeIdentifier,
  encodeIdentifier,
  type IdentifierColumn,
  identifierColumn,
  incomparableIdentifiers,
  isCompact,
  transportedIdentifier,
} from "./identifier";
import {
  assertInvariant,
  EngineInvariantError,
  unreachable,
} from "./invariant";
import {
  type Arguments,
  type EngineSchema,
  entries,
  type Input,
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

export type Leaf = {
  kind: "scalar";
  type: string;
  nullable: boolean;
  /**
   * The DECLARING scalar, for consumers that compile a value codec from it.
   *
   * The fields beside it are a projection of this object's state, which SQL
   * lowering and row decoding read; a codec owner such as
   * `result/cache-value-codecs.ts` is addressed by the object itself and must
   * never re-dispatch on `type`, which would be a second scalar-meaning
   * authority (g4/unit03/note.md FU.6 B-1c). Absent on the leaves no declared
   * scalar produces — `_count`, `exist`, a non-decimal `_avg`, `_distance` —
   * whose meaning is the aggregate's, not a column's.
   */
  scalar?: Scalar;
  /** A list column: the container decodes once, then each member as `type`. */
  list?: boolean;
  decimal?: DecimalDescriptor;
  /** A decimal `_sum`, which keeps the field scale and drops its precision. */
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
  /**
   * The field's OWN output schema (`s.json().schema(…)`), which only a `json`
   * column declares. Read here, once per (adapter, model, field), exactly
   * where the engine replaced read it once per compiled field chain
   * (`result/ResultParser.ts:721`) — never per row, and never by a second
   * walker of the projection looking for JSON fields.
   */
  jsonSchema?: StandardSchemaV1;
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
    }
  | {
      kind: "collection";
      /** A negative `take` runs a reversed window; the decoder restores it. */
      reversed?: boolean;
      row: ProjectionShape;
    }
  | {
      kind: "variants";
      /** The public slot, for the refusal that names it. */
      relation: string;
      many: boolean;
      arms: Record<string, ProjectionShape>;
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
type Shape = ProjectionShape;
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
type Reader = (value: unknown) => unknown;
type RelationProjectionArguments = Pick<
  Partial<Arguments>,
  "orderBy" | "take" | "skip" | "cursor" | "distinct"
> & { readonly selector?: PreparedSelector };
interface PreparedRelationProjection {
  readonly edge: Membership;
  readonly arguments: RelationProjectionArguments;
  readonly projection: PreparedProjection;
  readonly recurrence?: NormalizedRecurrence;
}
/** One counted slot: its memberships, and the filter that narrows them. */
export type PreparedCount = {
  readonly relation: string;
  /** Every membership the slot counts: one edge, or every variant arm. */
  readonly edges: readonly Membership[];
  readonly selector?: PreparedSelector;
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
        readonly edge: Membership;
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
export interface Query {
  sql: Sql;
  shape: Shape;
  expectedRows?: {
    readonly count: number;
    readonly missing: Error;
  };
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
export interface SelectorFacts {
  fields: Set<string>;
  equals: Map<string, unknown>;
  /**
   * The admitted unique selector's DISCRIMINATOR pins: the literal equality of
   * every `key: true` prepared column, which is exactly what the shipped
   * `partitionWhereUnique` files under `entries`
   * (`write-engine/shared.ts:154-166`). An extended `where`'s filter half, an
   * `AND`/`OR`/`NOT` arm and every entry of a selector admitted as a filter are
   * absent by construction — they are `equals` and not a pin.
   */
  keys: Map<string, unknown>;
  exact: boolean;
  reads: SelectorRead[];
}
export interface SelectorRead {
  readonly model: AnyModel;
  readonly path: readonly Membership[];
  readonly fields: Set<string>;
  readonly equals: Map<string, unknown>;
  readonly exact: boolean;
}
function newSelectorFacts(exact = true): SelectorFacts {
  return {
    fields: new Set(),
    equals: new Map(),
    keys: new Map(),
    exact,
    reads: [],
  };
}
type PreparedScalar = {
  readonly model: AnyModel;
  readonly field: string;
  readonly physical: PhysicalField;
};
type PreparedOperand =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "field"; readonly scalar: PreparedScalar };
/**
 * What a prepared operator compares. A physical column, a JSON value addressed
 * inside one, and an aggregate over a column are three targets of the SAME
 * operator vocabulary — `where` and `having` never interpret operators twice.
 */
type PreparedTarget =
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
type PreparedPredicate =
  | {
      readonly kind: "and" | "or";
      readonly predicates: readonly PreparedPredicate[];
    }
  | { readonly kind: "not"; readonly predicate: PreparedPredicate }
  | { readonly kind: "always"; readonly value: boolean }
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
    };
/**
 * A conjunction of nothing states nothing; every other prepared predicate is a
 * condition. This is the one reading of "this arm built no condition" that the
 * shipped builders express by answering `undefined`
 * (`builders/where-builder.ts:217-308`, `operations/groupby-having.ts:77-173`).
 */
function states(predicate: PreparedPredicate): boolean {
  return predicate.kind !== "and" || predicate.predicates.some(states);
}
/**
 * The smallest FINITE upper bound a distance filter states, or `undefined`
 * when it states none. A bound of zero or less bounds nothing worth probing:
 * the box degenerates to the point itself.
 */
function distanceUpperBound(value: unknown): number | undefined {
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
 * A structured value — a document, a collection, a variant slot or a
 * recursive carrier — as the provider handed it: a driver that does not parse
 * JSON itself hands back the carrier's TEXT, which is parsed here once, and
 * any other value is already the parsed structure.
 */
function providerJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
/**
 * The ONE reading of a provider DOCUMENT, whatever carries it: a root row, a
 * relation, `_count` or aggregate carrier, a collection row, a variant arm, a
 * recursive node row, the recursive carrier and each of its node and edge
 * entries. A document is an object that is not an array, and its members are
 * then read by {@link own}. `null` is answered as itself, because only the
 * placement knows whether its shape permits it; anything else is no document
 * (`undefined`), which the placement refuses in its own registered sentence.
 */
function providerDocument(value: unknown): Input | null | undefined {
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
function own(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}
/**
 * The ONE cursor-eligibility sentence, raised from the order walker for a key
 * whose lowering would consult a provider capability, and from
 * {@link Queries.page} for every other non-scalar key.
 */
const CURSOR_ORDER_REFUSAL =
  "Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported.";
/** A disjunction of nothing is FALSE; it is the one predicate that says so. */
const VACUOUS_FALSE: PreparedPredicate = Object.freeze({
  kind: "always",
  value: false,
});
/** One normalized sort key; `field` marks a direct scalar a cursor can use. */
interface OrderTerm {
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
export interface PreparedSelector {
  readonly model: AnyModel;
  readonly facts: SelectorFacts;
  readonly uniqueKey?: OrderedModelKey;
  readonly uniqueValues?: ReadonlyMap<string, unknown>;
  readonly predicate?: PreparedPredicate;
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

/** The public output name of a `_distance` projection, stated once. */
const DISTANCE_FIELD = "_distance";
/**
 * The private recursive carrier's member names, stated once: the one wire
 * vocabulary the recursive lowering writes and `decodeRecursiveCarrier` reads.
 */
const RECURSIVE_CARRIER = Object.freeze({
  root: "__rq_root",
  nodes: "__rq_nodes",
  edges: "__rq_edges",
  key: "__rq_key",
  row: "__rq_row",
  parent: "__rq_parent",
  child: "__rq_child",
  depth: "__rq_depth",
});
const AGGREGATES = ["_count", "_avg", "_sum", "_min", "_max"] as const;
/**
 * The aggregate vocabulary as a TYPE, so the lowering switch over it is
 * exhaustive by construction rather than by a sentence (N4, plan §4).
 * {@link isAggregate} is the ONE narrowing of a payload key into it — the same
 * set admission enumerates (`validation/model/args/aggregate.ts`), never a
 * second one.
 */
type Aggregate = (typeof AGGREGATES)[number];
const AGGREGATE_NAMES: ReadonlySet<string> = new Set(AGGREGATES);
function isAggregate(name: string): name is Aggregate {
  return AGGREGATE_NAMES.has(name);
}
const BOOLEAN_LEAF: Leaf = Object.freeze({
  kind: "scalar",
  type: "boolean",
  nullable: false,
});
const COUNT_LEAF: Leaf = Object.freeze({
  kind: "scalar",
  type: "int",
  nullable: false,
});
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
type PreparedUpdate =
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
function admittedTemporal(
  value: unknown,
  admit: (value: unknown) => { value: string } | { issues: unknown }
): unknown {
  if (!(value instanceof Date)) return value;
  const admitted = admit(value);
  return "value" in admitted ? admitted.value : value;
}

export class Queries {
  readonly schema: EngineSchema;
  readonly adapter: DatabaseAdapter;
  private nextAlias = 0;
  private readonly views: QueryViews;
  /**
   * The DRIVER's own representation rules (D-17). Scalar meaning is owned by
   * the existing codecs, but "what shape does THIS transport hand back?" is
   * owned by the driver and the adapter — SQLite stores `json` as TEXT and
   * booleans as 0/1, MySQL hands back naive wall-clock datetimes — and that
   * chain is declared, implemented by every adapter and driver, and was
   * reached by nothing. The decoder asks it once per row value, at the row
   * boundary, and never for a value a JSON window already decoded.
   */
  private readonly result: DriverResultParser | undefined;
  constructor(
    schema: EngineSchema,
    adapter: DatabaseAdapter,
    result?: DriverResultParser
  ) {
    this.schema = schema;
    this.adapter = adapter;
    this.views = schema.queryViews(adapter);
    this.result = result;
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
  alias(): string {
    return `q${this.nextAlias++}`;
  }
  /**
   * The FIRST alias of one statement, which opens that statement's alias scope.
   *
   * An alias is a fact of the statement it names, not of this owner's history,
   * so a statement whose first alias is minted by one of the owners named
   * below starts at `q0`, and the same logical query always emits the same
   * text. Without it the engine-lifetime read owner
   * (`commands/index.ts`) minted `q0, q1, … q10000` for the SAME
   * `findUnique`, so its statement text was unique per call — measured as an
   * obstacle by the cutover protocol (`g4/cutover/protocol.md` §7.2) and a
   * guaranteed miss for any transport that caches by statement text
   * (PostgreSQL named statements, `mysql2`'s prepare cache, D1/PlanetScale).
   *
   * The statement owners are {@link select}, {@link aggregated},
   * {@link grouped}, {@link selectSeries} and {@link junction} — every method
   * here that assembles a complete statement —
   * and each calls this before any other alias of that statement. Nothing else
   * may: a `lower…` fragment continues the statement it is part of, because a
   * mutation statement is assembled from several of them by the physical owner
   * (`OperationContext`'s `lowerMutationLimit` + `lowerProjection` pair) and
   * two fragments of ONE statement must not both start at `q0`. For the same
   * reason no statement owner may be entered while another statement is being
   * built: a nested complete statement is a subquery of its parent and shares
   * the parent's scope, which is why the nested relation projection, the
   * correlated count and the cursor window mint plain {@link alias}es.
   */
  private rootAlias(): string {
    this.nextAlias = 0;
    return this.alias();
  }
  table(model: AnyModel, alias?: string): Sql {
    return this.adapter.identifiers.table(model["~"].names.sql!, alias);
  }
  column(model: AnyModel, field: string, alias?: string): Sql {
    const name = this.columnName(model, field);
    return alias
      ? this.adapter.identifiers.column(alias, name)
      : this.adapter.identifiers.escape(name);
  }
  columnName(model: AnyModel, field: string): string {
    return physicalField(this.schema, model, field).name;
  }
  /**
   * A raw `Sql` operand is PARENTHESIZED. A caller's fragment is an
   * expression, not a token: `views: { gte: ctx => ctx.sql\`SELECT MAX(...)\` }`
   * composed as `"views" >= SELECT MAX(…)` is a syntax error on every dialect,
   * and a fragment with its own operator would re-associate. The shipped
   * engine wrapped at this same seam (`where-builder.ts:472`, applied `:492`).
   */
  value(value: unknown): Sql {
    return value instanceof Sql
      ? sql`(${value})`
      : this.adapter.literals.value(value);
  }
  /**
   * The one destination-aware operand owner: filters, cursors, order operands,
   * assignments and reference values all bind a value through this function,
   * so a column is never written in one vocabulary and read in another.
   */
  fieldValue(model: AnyModel, field: string, value: unknown): Sql {
    return this.scalarValue(
      physicalField(this.schema, model, field).scalar,
      value,
      field,
      this.scalarShape(model, field).id
    );
  }
  /**
   * `id` is the destination column's identifier storage, which the scalar
   * alone cannot answer: a foreign key DERIVES its domain and a private
   * carrier column names the key it stands in for. Only a COLUMN operand
   * carries it — an aggregate's `having` operand is a number.
   */
  private scalarValue(
    scalar: Scalar,
    value: unknown,
    field: string,
    id?: IdentifierColumn
  ): Sql {
    const a = this.adapter;
    const state = scalar["~"].state;
    if (value instanceof Sql) {
      const fragment = sql`(${value})`;
      return state.type === "decimal" && state.array !== true
        ? a.expressions.decimalCast(fragment, state.decimal)
        : fragment;
    }
    const sentinel = jsonNullKindOf(value);
    if (sentinel)
      return sentinel === "DbNull" ? a.literals.null() : a.json.value(null);
    if (value === null || value === undefined) return a.literals.null();
    if (state.array === true && Array.isArray(value))
      return this.listValue(state, value, field);
    // A COMPACT identifier binds its physical form — the payload's bytes, or
    // a PostgreSQL `uuid`'s canonical text — through the adapter's one
    // identifier literal. A text-stored domain holds the public string itself
    // and takes the ordinary arm below, byte for byte what it took before.
    if (isCompact(id))
      return a.literals.id(
        encodeIdentifier(id, value, field),
        id.representation
      );
    // A single value bound against a LIST field is one MEMBER of that field's
    // container (`has` is the operator that asks for one), and a container
    // carries what it was WRITTEN with — the same fact {@link nativeType}
    // already states for the decode leaf, which refuses to hand a list's
    // native type to a literal. The two scalars whose column spelling is
    // PHYSICAL have to consume it: a decimal's exact `DECIMAL(p,s)` operand
    // cast, and a datetime's dialect rendering of the instant (MySQL's naive
    // `DATETIME`, which a JSON container has no column to hold). Every other
    // scalar crosses a container exactly as it crosses its column.
    const member = state.array === true;
    switch (state.type) {
      case "decimal":
        return member
          ? a.literals.value(
              decimalMembers(state, [value], field, this.adapter.result)[0]!
            )
          : a.literals.decimal(
              canonicalDecimal(value, field),
              requireDecimal(state, field)
            );
      case "json":
        return a.literals.json(value);
      case "point":
        return this.geoPoint("value").value(
          this.value((value as GeoPoint).longitude),
          this.value((value as GeoPoint).latitude)
        );
      case "vector":
        // The provider's own vector tier spells a vector; a provider that
        // declares none binds it as an ordinary value, which is the ONE
        // crossing the shipped engine uses for every vector
        // (`builders/values-builder.ts` has no vector case at all). The
        // refusal then comes from the provider, identically on both engines,
        // instead of from a tier the shipped engine never consults for a value.
        // This is the same capability the distance owner reads below.
        return a.capabilities.supportsVector
          ? a.vector.literal(value as number[])
          : a.literals.value(value);
      case "datetime": {
        const wire = admittedTemporal(value, validateIsoTimestamp);
        return typeof wire === "string" && !member
          ? a.literals.dateTime(wire, this.nativeType(scalar))
          : a.literals.value(wire);
      }
      case "date":
        return a.literals.value(admittedTemporal(value, validateIsoDate));
      default:
        return a.literals.value(value);
    }
  }
  /** A whole list, bound as the container the destination column stores. */
  private listValue(
    state: ScalarState,
    values: readonly unknown[],
    field: string
  ): Sql {
    if (state.type === "decimal")
      return this.adapter.arrays.value(
        decimalMembers(state, values, field, this.adapter.result)
      );
    return state.type === "enum"
      ? this.adapter.arrays.enumValue([...values])
      : this.adapter.arrays.value([...values]);
  }
  /** The declared native form of a column; a list's members live in its container. */
  private nativeType(scalar: Scalar): NativeType | undefined {
    return scalar["~"].state.array === true
      ? undefined
      : scalar["~"].nativeType;
  }
  /** The provider's settled point protocol, or its named capability refusal. */
  private geoPoint(usage: string): GeoPointSql {
    const geoPoint = this.adapter.geoPoint;
    if (!geoPoint)
      throw new FeatureNotSupportedError(
        "point",
        usage,
        "GeoPoint requires a provider with its physical point tier enabled."
      );
    return geoPoint;
  }
  projectedColumn(model: AnyModel, field: string, alias?: string): Sql {
    const column = this.column(model, field, alias);
    const leaf = this.scalarShape(model, field);
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    if (state.type === "decimal")
      return state.array === true
        ? this.adapter.arrays.decimalProjection(column)
        : this.adapter.expressions.cast(column, "text");
    if (state.type === "point" && state.array !== true) {
      const geoPoint = this.geoPoint("projection");
      const projected = this.adapter.json.objectFromColumns([
        ["longitude", geoPoint.longitude(column)],
        ["latitude", geoPoint.latitude(column)],
      ]);
      return state.nullable
        ? this.adapter.expressions.caseWhen(
            [
              {
                when: this.adapter.operators.isNull(column),
                then: this.adapter.literals.null(),
              },
            ],
            projected
          )
        : projected;
    }
    return transportedIdentifier(this.adapter, leaf.id, column, leaf.nullable);
  }
  /**
   * A projected value carried INSIDE a JSON document. A value that is already
   * JSON stays a document; a value the container would round stays exact text.
   */
  private carriedValue(leaf: Shape | Leaf, expression: Sql): Sql {
    if (leaf.kind !== "scalar") return this.adapter.json.document(expression);
    // A decimal crossed the projection in the spelling {@link projectedColumn}
    // states — a text cast for a scalar, the adapter's decimal array
    // projection for a list — and its codec reads an exact value only from
    // that spelling: carried as a JSON number it is rounded by the container,
    // and carried as a JSON array its members are. This is the same physical
    // fact the projection stated, consumed rather than re-derived from the leaf.
    if (leaf.type === "decimal")
      return leaf.list
        ? this.adapter.arrays.decimalProjection(expression)
        : this.adapter.expressions.cast(expression, "text");
    if (
      leaf.list ||
      leaf.type === "json" ||
      leaf.type === "point" ||
      leaf.type === "vector"
    )
      return this.adapter.json.document(expression);
    if (leaf.type === "bigint")
      return this.adapter.expressions.cast(expression, "text");
    if (leaf.type === "blob")
      return this.adapter.expressions.blobToHex(expression);
    return expression;
  }
  /**
   * One field's decoded leaf, resolved once per (adapter, model, field).
   *
   * The answer is the field's declared scalar, its nullability and the
   * adapter's representation of it — schema and dialect only — so rebuilding a
   * fresh frozen object (and a fresh enum `Set`) on every projection of every
   * operation was pure repetition (rule 1). Nothing consumes a leaf by
   * identity: the decoder, the cache codec and the shape readers all read its
   * fields.
   */
  private scalarShape(model: AnyModel, field: string): Leaf {
    let leaves = this.views.leaves.get(model);
    if (leaves === undefined) {
      leaves = new Map();
      this.views.leaves.set(model, leaves);
    }
    let shape = leaves.get(field);
    if (shape === undefined) {
      const physical = physicalField(this.schema, model, field);
      shape = this.leaf(
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
  private leaf(
    scalar: Scalar,
    nullable: boolean,
    id: IdentifierColumn | undefined
  ): Leaf {
    const state = scalar["~"].state;
    return Object.freeze({
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
      jsonSchema: state.type === "json" ? state.schema : undefined,
      id,
    });
  }
  junctionWhere(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    alias?: string
  ): Sql {
    return this.adapter.operators.and(
      ...[edge.sourceSide, edge.targetSide].flatMap((side) =>
        side.members
          .filter((pair) => Object.hasOwn(values, pair.junctionField))
          .map((pair) =>
            this.adapter.operators.eq(
              alias
                ? this.adapter.identifiers.column(alias, pair.junctionField)
                : this.adapter.identifiers.escape(pair.junctionField),
              this.fieldValue(
                side.model,
                pair.referencedField,
                values[pair.junctionField]
              )
            )
          )
      )
    );
  }
  junctionSideConditions(
    side: ResolvedJunctionSide,
    junctionAlias: string | undefined,
    endpoint: string | Input
  ): Sql[] {
    const a = this.adapter;
    return side.members.map((pair) =>
      a.operators.eq(
        junctionAlias
          ? a.identifiers.column(junctionAlias, pair.junctionField)
          : a.identifiers.escape(pair.junctionField),
        typeof endpoint === "string"
          ? this.column(side.model, pair.referencedField, endpoint)
          : this.fieldValue(
              side.model,
              pair.referencedField,
              endpoint[pair.referencedField]
            )
      )
    );
  }
  junction(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    forUpdate = false
  ): Query {
    const a = this.adapter;
    const alias = this.rootAlias();
    const owner =
      edge.uniqueSide === "target" ? edge.sourceSide : edge.targetSide;
    const fields: Record<string, Leaf> = {};
    const columns = owner.members.map((pair) => {
      const shape = this.scalarShape(owner.model, pair.referencedField);
      fields[pair.junctionField] = shape;
      const column = a.identifiers.column(alias, pair.junctionField);
      return a.identifiers.aliased(
        shape.type === "decimal"
          ? a.expressions.cast(column, "text")
          : transportedIdentifier(a, shape.id, column, shape.nullable),
        pair.junctionField
      );
    });
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: a.identifiers.table(edge.table, alias),
        where: this.junctionWhere(edge, values, alias),
        forUpdate,
      }),
      shape: { kind: "object", fields },
    };
  }
  /**
   * The ONE interpreter of an admitted scalar update payload.
   *
   * It answers WHICH operator the caller spelled and WHAT its operand is, and
   * nothing about SQL. Two lowerings consume that one answer — the provider's
   * own `SET` assignment ({@link updateAssignment}) and the same operator named
   * over an already-known value ({@link updateValue}) — so an operator can
   * never be admitted in one spelling and refused in the other.
   */
  private prepareUpdate(
    model: AnyModel,
    field: string,
    value: unknown
  ): PreparedUpdate {
    const whole = wholeValue(value);
    if (whole) return { kind: "value", value: whole.value };
    const operation = record(value);
    for (const operator of ARITHMETIC_UPDATES)
      if (Object.hasOwn(operation, operator)) {
        const by = operation[operator];
        // An exact decimal divided by zero fails HERE, before any statement is
        // issued: the operand's value is knowable and every dialect answers it
        // differently otherwise (SQLite NULL, MySQL NULL or an error,
        // PostgreSQL raises). The shipped refusal, verbatim.
        if (
          operator === "divide" &&
          exactDecimalDomain(
            physicalField(this.schema, model, field).scalar["~"].state
          ) &&
          dividesByZero(by)
        )
          throw new QueryEngineError(
            `Cannot divide decimal field '${field}' by zero.`
          );
        return { kind: "arithmetic", operator, by };
      }
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
  /**
   * The target domain an arithmetic assignment lands back inside: an integer
   * column divides as an integer, an exact decimal is quantized to its scale.
   * The adapter owns both spellings; this only names the destination.
   */
  private arithmeticTarget(model: AnyModel, field: string): ArithmeticTarget {
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    return {
      integer: state.type === "int" || state.type === "bigint",
      decimal: exactDecimalDomain(state),
    };
  }
  /**
   * One admitted update payload as the provider's own `SET` assignment. Every
   * operator crosses through the adapter's `set` vocabulary, so the dialect owns
   * integer truncation, decimal quantization and list concatenation, and the
   * query owner spells no arithmetic of its own.
   */
  updateAssignment(model: AnyModel, field: string, value: unknown): Sql {
    const a = this.adapter;
    const column = this.column(model, field);
    const update = this.prepareUpdate(model, field, value);
    if (update.kind === "value")
      return a.set.assign(column, this.fieldValue(model, field, update.value));
    if (update.kind === "list")
      return a.set[update.operator](
        column,
        this.fieldValue(model, field, update.members)
      );
    return a.set[update.operator](
      column,
      this.fieldValue(model, field, update.by),
      this.arithmeticTarget(model, field)
    );
  }
  /**
   * The same admitted update payload named over an ALREADY-KNOWN value: the
   * key a row will carry after the mutation, which a non-returning readback and
   * a relation-key transition both have to state in SQL.
   *
   * Every operator is named through the SAME adapter vocabulary its assignment
   * uses, so the expression and the `SET` clause cannot disagree: `+`, `-` and
   * `*` are the dialect's own native arithmetic in every non-decimal domain,
   * and an integer `divide` asks `expressions.integerDivide` for the dialect's
   * truncation — the same provider fact `set.divide`'s `target.integer` flag
   * carries, in expression form.
   *
   * The one shape with no expression form is an EXACT DECIMAL under `multiply`
   * or `divide`: there the provider's assignment is a guarded coefficient
   * rewrite that rounds half-even back to the field's scale and refuses an
   * intermediate the dialect cannot represent, and restating it here would be a
   * second arithmetic owner. The refusal is registered and recorded as a
   * decision for Arnaud (note §R2.1).
   *
   * WHICH PAYLOAD REACHES IT, measured for the N4 census (the earlier reading
   * of this paragraph named the wrong shape). A decimal RELATION key does NOT
   * reach it: a relation key written beside a mutation of that relation must be
   * a literal (`Assignments.requireLiteral`, `commands/relation-body.ts:127`),
   * so no operator survives to be named, and a key transition is the only thing
   * that would ask. The reachable shape is a decimal PRIMARY key on an UPSERT's
   * FOUND arm whose update payload names NO relation: `EngineSchema.admit`
   * states `keyPortabilityRefusal` for `update` / `updateMany`, and the found
   * arm carries it only when the update payload names relations
   * (`commands/commands.ts:1743`, the shipped gate) — so
   * `upsert({ update: { decimalKey: { multiply: n } } })` arrives here through
   * `OperationContext.updatedIdentity`, which has to ADDRESS the row it just
   * wrote. It is a TRANSPORT boundary, not an invariant: the same payload
   * succeeds on a provider with RETURNING, where the post-update key is read
   * back instead of named. Executing it therefore belongs to that read-back's
   * owner (D-50's scratch at the column's declared type), not here; an ordered
   * observation cannot answer it, because what is missing is the row's address,
   * not a value a dependent consumes.
   */
  updateValue(
    model: AnyModel,
    field: string,
    value: unknown,
    before: Sql
  ): Sql {
    const a = this.adapter;
    const update = this.prepareUpdate(model, field, value);
    if (update.kind === "value")
      return this.fieldValue(model, field, update.value);
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    const rounds =
      exactDecimalDomain(state) !== undefined &&
      (update.operator === "multiply" || update.operator === "divide");
    if (update.kind === "list" || rounds)
      throw new QueryEngineError(
        `Raptor 3 cannot name the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' under '${update.operator}': the provider owns that operator's rounding inside its own assignment.`
      );
    const base =
      state.type === "int" ? a.expressions.cast(before, "integer") : before;
    const operand = this.fieldValue(model, field, update.by);
    if (update.operator === "increment")
      return a.expressions.add(base, operand);
    if (update.operator === "decrement")
      return a.expressions.subtract(base, operand);
    if (update.operator === "multiply")
      return a.expressions.multiply(base, operand);
    return state.type === "int" || state.type === "bigint"
      ? a.expressions.integerDivide(base, operand)
      : a.expressions.divide(base, operand);
  }
  /**
   * One prepared selector. `unique` states that the caller admitted this
   * `where` as a UNIQUE selector (a `whereUnique` input): its top-level
   * addressable-key entries are the row's discriminator and compare through the
   * constraint, while every other entry — an extended `where`'s filters, its
   * `AND`/`OR`/`NOT` arms and its relation predicates — stays a filter. The
   * same `{ id: … }` object is a discriminator under `findUnique` and a filter
   * under `findFirst`, so the fact belongs to the admitted operation and cannot
   * be recovered from the object's shape.
   */
  prepareSelector(
    model: AnyModel,
    where?: Input,
    unique = false
  ): PreparedSelector {
    const facts = newSelectorFacts();
    const keys = Object.keys(where ?? {});
    const uniqueKey =
      keys.length === 1 ? findAddressableKey(model, keys[0]!) : undefined;
    const selected = uniqueKey
      ? uniqueKey.name
        ? record(where![uniqueKey.name])
        : where!
      : undefined;
    return Object.freeze({
      model,
      facts,
      uniqueKey,
      uniqueValues: selected
        ? new Map(uniqueKey!.fields.map((field) => [field, selected[field]]))
        : undefined,
      predicate: where
        ? this.prepareWhere(model, where, facts, [], unique)
        : undefined,
    });
  }
  selectorFacts(selector: PreparedSelector): SelectorFacts {
    return selector.facts;
  }
  identitySelector(model: AnyModel, identity: Input): PreparedSelector {
    const facts = newSelectorFacts();
    return Object.freeze({
      model,
      facts,
      predicate: this.identityPredicate(model, identity, facts),
    });
  }
  /** One row's identity as prepared meaning: its key fields' equalities. */
  private identityPredicate(
    model: AnyModel,
    identity: Input,
    facts: SelectorFacts
  ): PreparedPredicate {
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(identity).map(([field, value]) =>
          this.prepareScalarPredicate(model, field, value, facts)
        )
      ),
    });
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
    const captured = this.capturedSet(model, identities, facts);
    return Object.freeze({
      model,
      facts,
      predicate:
        identities.length === 0 ? undefined : this.combine("NOT", [captured]),
    });
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
    return Object.freeze({
      model,
      facts,
      predicate: this.capturedSet(model, identities, facts),
    });
  }
  /** One captured set's rows, as the disjunction of their own identities. */
  private capturedSet(
    model: AnyModel,
    identities: readonly Input[],
    facts: SelectorFacts
  ): PreparedPredicate {
    const captured = identities.map((identity) =>
      this.identityPredicate(model, identity, facts)
    );
    // A SET pins no equality: the facts describe a filter, not a discriminator,
    // exactly as the combinator walker records any `OR` arm.
    if (captured.length > 0) facts.exact = false;
    return this.combine("OR", captured);
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
      facts.reads.push(...selector.facts.reads);
      if (selector.predicate) predicates.push(selector.predicate);
    }
    return Object.freeze({
      model,
      facts,
      predicate:
        predicates.length === 0
          ? undefined
          : Object.freeze({
              kind: "and",
              predicates: Object.freeze(predicates),
            }),
    });
  }
  lowerSelector(
    selector: PreparedSelector,
    alias?: string,
    mutationTarget?: string
  ): Sql | undefined {
    return selector.predicate
      ? this.lowerPredicate(selector.predicate, alias, mutationTarget)
      : undefined;
  }
  lowerWhere(
    model: AnyModel,
    where: Input | undefined,
    alias?: string
  ): Sql | undefined {
    return this.lowerSelector(this.prepareSelector(model, where), alias);
  }
  /**
   * The value a LOCATED row holds for one field, read where it is SPENT:
   * `(SELECT <column> FROM <target> WHERE <this arm's selector> LIMIT 1)`,
   * inside the statement that writes it.
   *
   * A parent-held `connect` folds its target's referenced value into the
   * parent's own SET. Its planning probe answers EXISTENCE and the branch; the
   * bytes that land in the column are the target's own, read at the write — so
   * no second, re-derived provenance stands between the row the selector named
   * and the key written, and a collation that makes the selector's literal
   * differ from the stored value cannot change the answer (E1 U1, and the
   * create root's `toOneFkAssign` before it).
   *
   * `mutating` is the model the enclosing statement writes: where the provider
   * refuses to read the table its own statement mutates (MySQL ERROR 1093) the
   * read hides behind a derived table, the same one condition
   * {@link hideMutationTarget} already owns — the SELF relation's shape.
   */
  locatedValue(
    model: AnyModel,
    field: string,
    selector: PreparedSelector,
    mutating?: AnyModel
  ): Sql {
    const alias = this.alias();
    const located = assembleAdapterSelect(this.adapter, {
      columns: this.column(model, field, alias),
      from: this.table(model, alias),
      where: this.lowerSelector(selector, alias),
      limit: this.value(1),
    });
    return this.adapter.subqueries.scalar(
      this.hideMutationTarget(located, model, mutating?.["~"].names.sql)
    );
  }
  lowerMutationLimit(
    model: AnyModel,
    selector: PreparedSelector,
    limit: number | undefined
  ): { readonly where?: Sql; readonly suffix?: Sql } {
    const adapter = this.adapter;
    // The UPDATE/DELETE target carries no alias, so it is addressable only by
    // its NAME. Without that qualifier a correlated `EXISTS` emits the parent
    // column bare and it rebinds to the CHILD table wherever both carry the
    // name — `some` matches nothing, `none`/`every` match everything, and a
    // `deleteMany` removes the complement of the intended set. The shipped
    // engine passed the table name for exactly this reason
    // (`operations/update.ts:79-90`, `delete.ts:85-92`).
    const mutated = model["~"].names.sql!;
    if (limit === undefined)
      return { where: this.lowerSelector(selector, mutated, mutated) };
    if (adapter.capabilities.supportsMutationRowLimit)
      return {
        where: this.lowerSelector(selector, mutated, mutated),
        suffix: adapter.clauses.limit(this.value(limit)),
      };
    const alias = this.alias();
    const keys = this.schema.keys(model);
    const targetColumns = keys.map((field) => this.column(model, field));
    const selectedColumns = keys.map((field) =>
      this.column(model, field, alias)
    );
    const target =
      targetColumns.length === 1
        ? targetColumns[0]!
        : sql`(${sql.join(targetColumns, ", ")})`;
    const capped = assembleAdapterSelect(adapter, {
      columns: sql.join(selectedColumns, ", "),
      from: this.table(model, alias),
      where: this.lowerSelector(selector, alias),
      limit: this.value(limit),
    });
    return {
      where: adapter.operators.in(target, adapter.subqueries.scalar(capped)),
    };
  }
  lowerIdentity(model: AnyModel, identity: Input, alias?: string): Sql {
    return this.adapter.operators.and(
      ...Object.entries(identity).map(([field, value]) =>
        this.adapter.operators.eq(
          this.column(model, field, alias),
          this.fieldValue(model, field, value)
        )
      )
    );
  }
  /**
   * A combinator, unless the model declares a field by that name: validation
   * extends its three combinator entries with the model's own fields, so a
   * scalar or relation literally named `AND` wins the key there
   * (`validation/model/core/where.ts`, `validation/model/args/aggregate.ts`
   * for `having`), and
   * the engine reads the admitted payload the same way (N4).
   */
  private combinator(
    model: AnyModel,
    key: string
  ): key is "AND" | "OR" | "NOT" {
    return (
      (key === "AND" || key === "OR" || key === "NOT") &&
      !model["~"].state.scalars[key] &&
      !model["~"].state.relations[key]
    );
  }
  /**
   * The one logical-combinator owner, shared by `where` and `having`. An arm
   * that builds no condition is absent: it contributes nothing to `AND`,
   * nothing to `NOT` and nothing to `OR`, and only `OR` turns "no surviving
   * arm" into a condition — the vacuous FALSE.
   */
  private combine(
    key: "AND" | "OR" | "NOT",
    arms: readonly PreparedPredicate[]
  ): PreparedPredicate {
    const stated = arms.filter(states);
    if (key === "OR")
      return stated.length === 0
        ? VACUOUS_FALSE
        : Object.freeze({ kind: "or", predicates: Object.freeze(stated) });
    const predicates: readonly PreparedPredicate[] =
      key === "AND"
        ? stated
        : stated.map((predicate) =>
            Object.freeze({ kind: "not" as const, predicate })
          );
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(predicates),
    });
  }
  private prepareWhere(
    model: AnyModel,
    where: Input,
    facts: SelectorFacts,
    path: readonly Membership[],
    unique = false,
    positive = true
  ): PreparedPredicate {
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(where).map(([field, operand]) => {
          if (this.combinator(model, field)) {
            if (field !== "AND") facts.exact = false;
            return this.combine(
              field,
              entries(operand).map((clause) =>
                this.prepareWhere(
                  model,
                  clause,
                  facts,
                  path,
                  false,
                  field === "NOT" ? !positive : positive
                )
              )
            );
          }
          if (model["~"].state.relations[field])
            return this.prepareSlotPredicate(
              model,
              field,
              operand,
              facts,
              path,
              positive
            );
          const key = findAddressableKey(model, field);
          if (key?.name)
            return Object.freeze({
              kind: "and",
              predicates: Object.freeze(
                key.fields.map((member) =>
                  this.prepareScalarPredicate(
                    model,
                    member,
                    record(operand)[member],
                    facts,
                    unique,
                    positive
                  )
                )
              ),
            });
          return this.prepareScalarPredicate(
            model,
            field,
            operand,
            facts,
            unique && key !== undefined,
            positive
          );
        })
      ),
    });
  }
  private prepareScalarPredicate(
    model: AnyModel,
    field: string,
    value: unknown,
    facts: SelectorFacts,
    key = false,
    positive = true
  ): PreparedPredicate {
    const scalar = Object.freeze({
      model,
      field,
      physical: physicalField(this.schema, model, field),
    });
    facts.fields.add(field);
    const filter =
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Sql) &&
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
    } else facts.exact = false;
    return this.prepareOperations(
      key
        ? Object.freeze({ kind: "column", scalar, key: true })
        : Object.freeze({ kind: "column", scalar }),
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
  private prepareOperations(
    target: PreparedTarget,
    value: unknown,
    insensitive = false,
    positive = true
  ): PreparedPredicate {
    const state = target.scalar?.physical.scalar["~"].state;
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
        ? Object.freeze({
            ...(target as Extract<PreparedTarget, { kind: "column" }>),
            path: Object.freeze([...(filter.path as string[])]),
          })
        : target;
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(filter)
          .filter(([name]) => name !== "mode" && name !== "path")
          .map(([name, operand]) =>
            name === "equals"
              ? this.prepareOperations(scoped, operand, folded, positive)
              : name === "not"
                ? Object.freeze({
                    kind: "not",
                    predicate: this.prepareOperations(
                      scoped,
                      operand,
                      folded,
                      !positive
                    ),
                  })
                : this.prepareOperation(scoped, name, operand, folded, positive)
          )
      ),
    });
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
    const operand = () =>
      owner
        ? this.prepareOperand(owner, value)
        : { kind: "value" as const, value };
    switch (operator) {
      case "in":
      case "notIn":
        return Object.freeze({
          kind: "operation",
          operator,
          target,
          operands: Object.freeze(
            (value as unknown[]).map((member) =>
              owner
                ? this.prepareOperand(owner, member)
                : { kind: "value" as const, value: member }
            )
          ),
          insensitive,
        });
      case "equals":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
      case "contains":
      case "startsWith":
      case "endsWith":
        return Object.freeze({
          kind: "operation",
          operator,
          target,
          operand: operand(),
          value,
          insensitive,
        });
      default:
        return Object.freeze({
          kind: "operation",
          operator,
          target,
          value,
          insensitive,
          ...(operator === "distance" &&
          positive &&
          owner?.physical.scalar["~"].state.type === "point" &&
          distanceUpperBound(value) !== undefined
            ? { probe: true as const }
            : {}),
        });
    }
  }
  /**
   * One admitted filter member, resolved to the value it binds or the column it
   * names.
   *
   * The operand is NOT frozen and the structure that holds it is: the prepared
   * predicate ({@link prepareOperation}) and, for `in`/`notIn`, its operand
   * list. One owner builds an operand and one owner reads it
   * ({@link lowerOperation}), both in this file, so freezing each box restated
   * the same immutability the enclosing predicate already carries — and
   * restated it PER MEMBER: `Object.freeze` transitions a fresh object's map on
   * every call, measured at 1.98–2.20 µs for the 100 members of one
   * `id: { in: ids₁₀₀ }` against 0.25–0.28 µs for the same 100 boxes
   * (`g4/perf2/receipts/micro-in-list.json`).
   */
  private prepareOperand(
    owner: PreparedScalar,
    value: unknown
  ): PreparedOperand {
    if (!isFieldRef(value)) return { kind: "value", value };
    const { model } = owner;
    const payload = fieldRefPayload(value);
    const scope = model["~"].names.ts ?? "unknown";
    if (payload.model !== scope)
      throw new QueryEngineError(
        `Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model.`
      );
    const referenced = model["~"].state.scalars[payload.field];
    if (!referenced)
      throw new QueryEngineError(
        `Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'.`
      );
    const own = exactDecimalDomain(owner.physical.scalar["~"].state);
    const other = exactDecimalDomain(referenced["~"].state);
    if (own && other && !sameDecimalDomain(own, other))
      throw new QueryEngineError(
        `Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale.`
      );
    const storage = incomparableIdentifiers(
      this.scalarShape(model, owner.field).id,
      this.scalarShape(model, payload.field).id,
      owner.field,
      payload.field
    );
    if (storage !== undefined)
      throw new QueryEngineError(
        `Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': ${storage}`
      );
    return {
      kind: "field",
      scalar: Object.freeze({
        model,
        field: payload.field,
        physical: physicalField(this.schema, model, payload.field),
      }),
    };
  }
  /** One relation slot: ordinary quantifiers, to-one shorthand, or tagged arms. */
  private prepareSlotPredicate(
    model: AnyModel,
    name: string,
    operand: unknown,
    facts: SelectorFacts,
    path: readonly Membership[],
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
      const quantified = Object.keys(entries).every((key) =>
        QUANTIFIERS.has(key)
      );
      const arms: [string, unknown][] = quantified
        ? Object.entries(entries)
        : [["is", entries]];
      return Object.freeze({
        kind: "and",
        predicates: Object.freeze(
          arms.map(([quantifier, value]) =>
            this.relationPredicate(
              edge,
              quantifier,
              value,
              facts,
              path,
              positive
            )
          )
        ),
      });
    }
    const members = resolved.edge.members;
    const many = resolved.edge.kind === "variantJunctionCarrier";
    const variantEdge = (variant: unknown) =>
      bindMembership(this.schema, model, name, variant as string);
    if (!many && entries.type === undefined) {
      // Presence is a property of the SLOT: `{ is: null }` asks that no
      // configured variant holds a member, `{ isNot: null }` that one does.
      const absent = "is" in entries;
      return Object.freeze({
        kind: absent ? "and" : "or",
        predicates: Object.freeze(
          members.map((member) =>
            this.relationPredicate(
              variantEdge(member.variant),
              absent ? "none" : "some",
              undefined,
              facts,
              path,
              positive
            )
          )
        ),
      });
    }
    const arms: [string | undefined, Input][] = many
      ? Object.entries(entries).map(([quantifier, tagged]) => [
          quantifier,
          record(tagged),
        ])
      : [[undefined, entries]];
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        arms.map(([quantifier, tagged]) => {
          const edge = variantEdge(tagged.type);
          const negated = tagged.isNot !== undefined;
          const inexact =
            negated || quantifier === "none" || quantifier === "every";
          const inner = this.relationScope(
            edge,
            negated ? record(tagged.isNot) : (tagged.is as Input | undefined),
            facts,
            path,
            inexact,
            positive
          );
          if (quantifier !== undefined) {
            const quantified = Object.freeze({
              kind: "relation" as const,
              edge,
              quantifier,
              predicate:
                negated && inner
                  ? Object.freeze({ kind: "not" as const, predicate: inner })
                  : inner,
            });
            // `some` and `none` address the tagged arm and nothing else.
            // `every` is a statement about the WHOLE collection — "every member
            // is an arm-`T` member satisfying P" — so a member of any OTHER arm
            // falsifies it. That is the one tagged quantifier that must also
            // state the arms it did not name; the shipped engine answers a
            // board holding two posts and one tag `false` for
            // `every: { type: "post", … }`, and this is why.
            if (quantifier !== "every") return quantified;
            return Object.freeze({
              kind: "and",
              predicates: Object.freeze([
                quantified,
                ...members
                  .filter((member) => member.variant !== tagged.type)
                  .map((member) =>
                    this.relationPredicate(
                      variantEdge(member.variant),
                      "none",
                      undefined,
                      facts,
                      path,
                      positive
                    )
                  ),
              ]),
            });
          }
          // A tagged to-one arm: `{ type }` asks only that the slot holds that
          // variant; `is`/`isNot` keep the ordinary to-one quantifier meaning.
          return Object.freeze({
            kind: "relation",
            edge,
            quantifier: negated ? "isNot" : inner ? "is" : "some",
            predicate: inner,
          });
        })
      ),
    });
  }
  private relationPredicate(
    edge: Membership,
    quantifier: string,
    value: unknown,
    facts: SelectorFacts,
    path: readonly Membership[],
    positive = true
  ): PreparedPredicate {
    return Object.freeze({
      kind: "relation",
      edge,
      quantifier,
      predicate: this.relationScope(
        edge,
        value === null || value === undefined ? undefined : record(value),
        facts,
        path,
        quantifier === "none" ||
          quantifier === "every" ||
          quantifier === "isNot",
        positive
      ),
    });
  }
  /** One relation read: SQL meaning and dependency facts from one traversal. */
  /**
   * `inexact` is also this arm's POLARITY: `none`, `isNot` and `every` consume
   * their nested predicate under a negation — `every` emits `NOT(nested)`
   * inside its `NOT EXISTS` — so a conjunct added there is a conjunct of what
   * is negated. One fact, read twice, instead of a second flag that could
   * disagree with it.
   */
  private relationScope(
    edge: Membership,
    where: Input | undefined,
    facts: SelectorFacts,
    path: readonly Membership[],
    inexact: boolean,
    positive = true
  ): PreparedPredicate | undefined {
    const scope = [...path, edge];
    const nestedFacts = newSelectorFacts(!inexact);
    const predicate = where
      ? this.prepareWhere(
          edge.target,
          where,
          nestedFacts,
          scope,
          false,
          positive && !inexact
        )
      : undefined;
    facts.reads.push({
      model: edge.target,
      path: scope,
      fields: nestedFacts.fields,
      equals: nestedFacts.equals,
      exact: nestedFacts.exact,
    });
    facts.reads.push(...nestedFacts.reads);
    return predicate;
  }
  private lowerPredicate(
    predicate: PreparedPredicate,
    alias?: string,
    mutationTarget?: string
  ): Sql {
    const a = this.adapter;
    // biome-ignore lint/style/useDefaultSwitchClause: the prepared predicate union is exhaustive; a default would be dead code.
    switch (predicate.kind) {
      case "and":
        return a.operators.and(
          ...predicate.predicates.map((member) =>
            this.lowerPredicate(member, alias, mutationTarget)
          )
        );
      case "or":
        return a.operators.or(
          ...predicate.predicates.map((member) =>
            this.lowerPredicate(member, alias, mutationTarget)
          )
        );
      case "not":
        return a.operators.not(
          this.lowerPredicate(predicate.predicate, alias, mutationTarget)
        );
      case "always":
        return predicate.value ? a.literals.true() : a.literals.false();
      case "operation":
        return this.lowerOperation(predicate, alias);
      case "relation":
        return this.lowerRelationPredicate(predicate, alias, mutationTarget);
    }
  }
  private preparedColumn(scalar: PreparedScalar, alias?: string): Sql {
    return alias
      ? this.adapter.identifiers.column(alias, scalar.physical.name)
      : this.adapter.identifiers.escape(scalar.physical.name);
  }
  private lowerTarget(target: PreparedTarget, alias?: string): Sql {
    return target.kind === "column"
      ? this.preparedColumn(target.scalar, alias)
      : this.aggregateExpression(target.aggregate, target.scalar, alias);
  }
  private lowerOperation(
    predicate: Extract<PreparedPredicate, { kind: "operation" }>,
    alias?: string
  ): Sql {
    const a = this.adapter;
    const { operator, target, operand } = predicate;
    const scalar = target.scalar;
    // A `_count` compares with `COUNT(col)`, a row count on every storage, and
    // admission types its operand as a number (`numericFilterOps`). It has no
    // column domain: no JSON document class, no text collation, no identifier
    // or decimal binding — every domain dispatch below reads `state`, so the
    // fact is stated once, here.
    const counted =
      target.kind === "aggregate" && target.aggregate === "_count";
    const state = counted ? undefined : scalar?.physical.scalar["~"].state;
    const column = this.lowerTarget(target, alias);
    if (state?.type === "json" && state.array !== true)
      return this.lowerJsonOperation(predicate, column);
    const insensitive = predicate.insensitive === true;
    // A discriminator member is compared by the constraint that answers it; the
    // engine's case-sensitivity contract governs every other comparison. An
    // `insensitive` mode is a filter spelling and never reaches a discriminator,
    // so it keeps the folded pair rather than silently folding one side.
    // A COLUMN target's identifier storage: its value operands bind the
    // physical form, and a compact column is compared as the bytes (or the
    // `uuid`) it holds — never collated or ASCII-folded as text.
    const id =
      target.kind === "column" && scalar
        ? this.scalarShape(scalar.model, scalar.field).id
        : undefined;
    const text =
      !(target.kind === "column" && target.key === true && !insensitive) &&
      state !== undefined &&
      state.array !== true &&
      (state.type === "string" || state.type === "enum") &&
      !isCompact(id);
    const exact = (expression: Sql) =>
      text ? a.expressions.caseSensitiveText(expression) : expression;
    const folded = text
      ? a.expressions.caseSensitiveText(a.expressions.asciiCaseFold(column))
      : column;
    /**
     * An enum compared against ANOTHER COLUMN compares its SPELLING — on BOTH
     * sides, on every dialect. PostgreSQL gives each enum field its own type,
     * so `status = review_status` has no operator there (42883) while MySQL and
     * SQLite, which store the value as text, answer it; casting the operand
     * alone left the filtered column typed as its own enum and produced
     * `post_status = text`. A LITERAL operand still binds an enum-typed
     * parameter against the bare column, so ordinary enum equality keeps its
     * index. Ordered comparison has no portable answer and is refused at
     * admission (`validation/scalars/enum.ts`), so equality — and the `not`
     * that negates it — is the whole reach of this fact.
     */
    const spelledAsText = (member: PreparedOperand): boolean =>
      state?.type === "enum" && member.kind === "field";
    const comparableColumn = (member: PreparedOperand): Sql =>
      exact(
        spelledAsText(member) ? a.expressions.cast(column, "text") : column
      );
    const bind = (member: PreparedOperand, fold = false): Sql => {
      if (member.kind === "field") {
        const reference = this.preparedColumn(member.scalar, alias);
        const comparable = spelledAsText(member)
          ? a.expressions.cast(reference, "text")
          : reference;
        return fold
          ? a.expressions.caseSensitiveText(
              a.expressions.asciiCaseFold(comparable)
            )
          : exact(comparable);
      }
      const literal =
        scalar && !counted
          ? this.targetValue(target, scalar, member.value, id)
          : this.value(member.value);
      return fold ? a.expressions.asciiCaseFold(literal) : literal;
    };
    const members = () => predicate.operands ?? [];
    switch (operator) {
      case "equals": {
        const single = operand!;
        const literal = single.kind === "value" ? single.value : undefined;
        if (single.kind === "value" && literal === null)
          return a.operators.isNull(column);
        if (state?.type === "point" && state.array !== true)
          return this.geoPoint("equals").equals(column, literal as GeoPoint);
        if (state?.array === true && Array.isArray(literal))
          return a.operators.eq(column, bind(single));
        if (
          insensitive &&
          (single.kind === "field" ||
            typeof literal === "string" ||
            literal instanceof Sql)
        )
          return a.operators.eq(folded, bind(single, true));
        if (text && single.kind === "value" && !(literal instanceof Sql))
          return a.operators.exactTextEq(column, bind(single));
        return a.operators.eq(comparableColumn(single), bind(single));
      }
      case "in":
      case "notIn": {
        const negated = operator === "notIn";
        const operands = members();
        if (operands.length === 0)
          return negated ? a.literals.true() : a.literals.false();
        if (insensitive) {
          const comparisons = operands.map((member) =>
            negated
              ? a.operators.neq(folded, bind(member, true))
              : a.operators.eq(folded, bind(member, true))
          );
          return negated
            ? a.operators.and(...comparisons)
            : a.operators.or(...comparisons);
        }
        const list = a.literals.list(operands.map((member) => bind(member)));
        if (negated) return a.operators.notIn(exact(column), list);
        return text
          ? a.operators.exactTextIn(column, list)
          : a.operators.in(column, list);
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        return a.operators[operator](column, bind(operand!));
      case "contains":
        return insensitive
          ? a.operators.containsText(folded, bind(operand!, true))
          : a.operators.containsText(column, bind(operand!));
      case "startsWith":
        if (insensitive)
          return a.operators.startsWithText(folded, bind(operand!, true));
        return operand!.kind === "value" && typeof operand!.value === "string"
          ? a.operators.startsWithPrefix(column, operand!.value)
          : a.operators.startsWithText(column, bind(operand!));
      case "endsWith":
        return insensitive
          ? a.operators.endsWithText(folded, bind(operand!, true))
          : a.operators.endsWithText(column, bind(operand!));
      case "has":
        return predicate.value === null
          ? a.literals.false()
          : a.arrays.has(
              column,
              this.scalarValue(
                scalar!.physical.scalar,
                predicate.value,
                scalar!.field
              )
            );
      case "hasEvery": {
        const values = predicate.value as unknown[];
        return values.length === 0
          ? a.operators.isNotNull(column)
          : a.arrays.hasEvery(
              column,
              this.scalarValue(scalar!.physical.scalar, values, scalar!.field)
            );
      }
      case "hasSome": {
        const values = predicate.value as unknown[];
        return values.length === 0
          ? a.literals.false()
          : a.arrays.hasSome(
              column,
              this.scalarValue(scalar!.physical.scalar, values, scalar!.field)
            );
      }
      case "isEmpty":
        return predicate.value
          ? a.arrays.isEmpty(column)
          : a.operators.not(a.arrays.isEmpty(column));
      case "within": {
        const area = predicate.value as GeoArea;
        const geoPoint = this.geoPoint("within");
        if ("bounds" in area) return geoPoint.withinBounds(column, area.bounds);
        if (geoPoint.withinPolygon)
          return geoPoint.withinPolygon(column, area.polygon);
        throw new FeatureNotSupportedError(
          "point",
          "within polygon",
          "GeoPoint polygon filtering is not supported by this provider."
        );
      }
      case "distance": {
        const specification = record(predicate.value);
        const expression = this.distanceExpression(
          column,
          state!,
          scalar!.field,
          specification,
          "filter"
        );
        // The index probe. `distance <= X` implies `withinBounds(box(X))`, so
        // the box is a redundant conjunct the provider can answer from the
        // spatial index before it evaluates one great-circle distance. It is
        // added only where preparation saw POSITIVE polarity
        // ({@link PreparedPredicate.probe}); the adapter spells both arms.
        const upper = predicate.probe
          ? distanceUpperBound(specification)
          : undefined;
        const probe =
          upper === undefined
            ? []
            : [
                this.geoPoint("distance filter").withinBounds(
                  column,
                  geoBoundsForDistance(specification.to as GeoPoint, upper)
                ),
              ];
        return a.operators.and(
          ...probe,
          ...(["lt", "lte", "gt", "gte"] as const)
            .filter((bound) => specification[bound] !== undefined)
            .map((bound) =>
              a.operators[bound](expression, this.value(specification[bound]))
            )
        );
      }
      default:
        // Admission enumerates this operator set once, per scalar type
        // (`validation/scalars/**`), and `prepareOperation` carries the key it
        // admitted; there is no second operator list here to disagree with it
        // (AGENTS.md: "Do not add a second operator switch"). The state this
        // arm names is therefore one the code cannot be in when it is right.
        throw new EngineInvariantError(
          `Raptor 3 filter operator is not implemented: ${operator}`
        );
    }
  }
  /**
   * One operand, bound in the domain of the expression it is COMPARED WITH.
   * A `_count` never reaches here: `lowerOperation` binds its row-count
   * operand as a plain value.
   *
   * Everything compares inside the field's own domain except a `_sum` over an
   * exact decimal: the compared expression is `SUM(col)`, whose value is wider
   * than one column can hold, so the operand's cast widens the PRECISION while
   * keeping the field's SCALE — every summed row carries that scale, and an
   * operand at another one would be a different number on SQLite. The adapter
   * states how wide its exact HAVING cast can be; the refusal below is the
   * shipped sentence, verbatim.
   */
  private targetValue(
    target: PreparedTarget,
    scalar: PreparedScalar,
    value: unknown,
    id: IdentifierColumn | undefined
  ): Sql {
    const state = scalar.physical.scalar["~"].state;
    const domain =
      target.kind === "aggregate" && target.aggregate === "_sum"
        ? exactDecimalDomain(state)
        : undefined;
    const operand = domain ? decimalSumOperand(value, domain) : undefined;
    // A value that is not an exact decimal is the ordinary binder's refusal.
    if (!domain || operand === undefined)
      return this.scalarValue(scalar.physical.scalar, value, scalar.field, id);
    const { canonical, coefficient } = operand;
    const precision =
      this.adapter.aggregates.decimalSumOperandPrecision(coefficient);
    if (precision === undefined) {
      const digits = coefficient.startsWith("-")
        ? coefficient.length - 1
        : coefficient.length;
      throw new QueryEngineError(
        `The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. ` +
          "The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written."
      );
    }
    return this.adapter.literals.decimal(canonical, {
      precision: Math.max(domain.precision, precision),
      scale: domain.scale,
    });
  }
  /**
   * THE JSON NULL TRUTH TABLE and the document operator set. A JSON column's
   * operands are documents rather than scalars, which is a storage difference,
   * not a second semantic interpretation of the same operator.
   *
   * The target always names a scalar here: `lowerOperation` reaches this only
   * when that scalar's own state is a JSON document — never for a `_count`,
   * which has no column domain — so the refusal below can name the field.
   */
  private lowerJsonOperation(
    predicate: Extract<PreparedPredicate, { kind: "operation" }>,
    column: Sql
  ): Sql {
    const a = this.adapter;
    const path = [
      ...(predicate.target.kind === "column"
        ? (predicate.target.path ?? [])
        : []),
    ];
    const value = predicate.value;
    const target = path.length ? a.json.extract(column, path) : column;
    const fold = (expression: Sql) =>
      predicate.insensitive
        ? a.expressions.asciiCaseFold(expression)
        : expression;
    const textTarget = () => fold(a.json.extractText(column, path));
    const textValue = (member: unknown) => fold(a.literals.value(member));
    switch (predicate.operator) {
      case "equals": {
        const sentinel = jsonNullKindOf(value);
        if (sentinel) {
          if (path.length)
            throw new QueryEngineError(
              `JSON filter for field '${predicate.target.scalar!.field}' cannot combine 'path' with the ${sentinel} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path.`
            );
          const isDatabaseNull = a.operators.isNull(column);
          const isJsonNull = a.operators.eq(column, a.json.value(null));
          if (sentinel === "DbNull") return isDatabaseNull;
          if (sentinel === "JsonNull") return isJsonNull;
          return a.operators.or(isDatabaseNull, isJsonNull);
        }
        if (value === null && path.length === 0)
          return a.operators.isNull(column);
        return a.operators.eq(target, a.json.value(value));
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const compare = a.operators[predicate.operator];
        if (typeof value === "number")
          return compare(a.json.numberAtPath(column, path), this.value(value));
        if (typeof value === "string")
          return compare(a.json.stringAtPath(column, path), this.value(value));
        throw new QueryEngineError(
          `JSON filter '${predicate.operator}' requires a number or string operand.`
        );
      }
      case "string_contains":
        return a.operators.containsText(textTarget(), textValue(value));
      case "string_starts_with":
        return a.operators.startsWithText(textTarget(), textValue(value));
      case "string_ends_with":
        return a.operators.endsWithText(textTarget(), textValue(value));
      case "array_contains":
        return a.json.contains(
          target,
          a.json.value(Array.isArray(value) ? value : [value])
        );
      case "array_starts_with":
        return a.operators.eq(
          a.json.extract(column, [...path, "0"]),
          a.json.value(value)
        );
      case "array_ends_with":
        return a.operators.eq(a.json.lastElement(target), a.json.value(value));
      default:
        // Same upstream owner as the scalar operator switch above: the JSON
        // document operators are enumerated once at admission.
        throw new EngineInvariantError(
          `Raptor 3 JSON filter operator is not implemented: ${predicate.operator}`
        );
    }
  }
  /** One distance expression, for filters, ordering and projection alike. */
  private distanceExpression(
    column: Sql,
    state: ScalarState,
    field: string,
    specification: Input,
    usage: "filter" | "orderBy" | "select"
  ): Sql {
    if (state.type === "vector") {
      // The three registered vector refusals, in the shipped order and the
      // shipped words (`builders/distance-builder.ts:142-188`): a nullable
      // vector has no distance to project and is refused before any
      // capability is consulted; the capability sentence names pgvector; and
      // a `to` of the wrong length is admitted input, because the declared
      // dimension does not constrain the operand's length.
      if (usage === "select" && state.nullable === true)
        throw new QueryEngineError(
          `Vector distance select does not support nullable vector field '${field}'.`
        );
      if (!this.adapter.capabilities.supportsVector)
        throw new FeatureNotSupportedError(
          "vector",
          usage,
          usage === "orderBy"
            ? "vector ordering requires a pgvector-enabled PostgreSQL driver"
            : "vector distance select requires a pgvector-enabled PostgreSQL driver"
        );
      const to = specification.to as number[];
      const { dimension } = state;
      if (dimension !== undefined && to.length !== dimension)
        throw new QueryEngineError(
          `Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}.`
        );
      const metric = specification.metric === "cosine" ? "cosine" : "l2";
      return this.adapter.vector[metric](
        column,
        this.adapter.vector.literal(to)
      );
    }
    const geoPoint = this.geoPoint(`distance ${usage}`);
    if (!geoPoint.distance)
      throw new FeatureNotSupportedError(
        "point",
        `distance ${usage}`,
        "GeoPoint distance is not supported by this provider."
      );
    const target = specification.to as GeoPoint;
    return geoPoint.distance(
      column,
      geoPoint.value(this.value(target.longitude), this.value(target.latitude))
    );
  }
  private lowerRelationPredicate(
    predicate: Extract<PreparedPredicate, { kind: "relation" }>,
    parentAlias?: string,
    mutationTarget?: string
  ): Sql {
    const a = this.adapter;
    const childAlias = this.alias();
    const nested = predicate.predicate
      ? this.lowerPredicate(predicate.predicate, childAlias, mutationTarget)
      : undefined;
    const condition = a.operators.and(
      this.correlation(predicate.edge, parentAlias ?? "", childAlias),
      ...(nested
        ? [predicate.quantifier === "every" ? a.operators.not(nested) : nested]
        : [])
    );
    const query = this.hideMutationTarget(
      a.subqueries.existsCheck(
        this.table(predicate.edge.target, childAlias),
        condition
      ),
      predicate.edge.target,
      mutationTarget
    );
    switch (predicate.quantifier) {
      case "some":
        return a.filters.some(query);
      case "none":
        return a.filters.none(query);
      case "every":
        return a.filters.every(query);
      case "is":
        return predicate.predicate
          ? a.filters.is(query)
          : a.filters.isNot(query);
      case "isNot":
        return predicate.predicate
          ? a.filters.isNot(query)
          : a.filters.is(query);
      default:
        // Every relation filter that spells quantifiers refuses a payload
        // naming none of them in its own registered sentence, at admission;
        // this switch only ever receives an already-admitted quantifier.
        throw new EngineInvariantError(
          `Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier}`
        );
    }
  }
  /**
   * MySQL ERROR 1093: a subquery may not read the table its own statement is
   * mutating. A derived table sidesteps it — it is materialized before the
   * write — while the correlation to the outer mutation survives as an outer
   * reference (MySQL 8.0.14+). The capability the adapter already declares
   * (`supportsMutationTargetInSubquery`) is the whole condition; the wrap goes
   * inside the `EXISTS (…)`, which supplies its own parentheses.
   */
  private hideMutationTarget(
    subquery: Sql,
    child: AnyModel,
    mutationTarget: string | undefined
  ): Sql {
    if (
      mutationTarget === undefined ||
      this.adapter.capabilities.supportsMutationTargetInSubquery ||
      child["~"].names.sql !== mutationTarget
    )
      return subquery;
    return sql`SELECT * FROM ${this.adapter.subqueries.correlate(
      subquery,
      this.alias()
    )}`;
  }
  /**
   * Does the PARENT row claim a membership in this arm?
   *
   * A variant ROW carrier stores the claim on the parent itself — a
   * discriminator naming the arm and a reference to the row — so "linked" is
   * answerable without reading the target at all. That is what separates an
   * EMPTY slot (no claim) from an ORPHANED one (a claim whose row is gone),
   * which the target subquery alone reports identically as `null`.
   *
   * `undefined` where the claim is not the parent's to make: the membership is
   * then the child's or a junction's, and this owner says nothing about it.
   */
  private parentClaimsArm(
    edge: Membership,
    parentAlias: string
  ): Sql | undefined {
    if (
      edge.kind !== "reference" ||
      edge.owner !== "source" ||
      edge.discriminator?.side !== "source"
    )
      return undefined;
    const a = this.adapter;
    return a.operators.and(
      a.operators.eq(
        this.column(edge.source, edge.discriminator.field, parentAlias),
        this.value(edge.discriminator.value)
      ),
      ...edge.pairs.map((pair) =>
        a.operators.isNotNull(
          this.column(edge.source, pair.source, parentAlias)
        )
      )
    );
  }
  correlation(edge: Membership, parent: string, target: string): Sql {
    return this.membershipWhere(edge, target, parent);
  }
  memberWhere(edge: Membership, parent: Input, alias: string): Sql {
    return this.membershipWhere(edge, alias, parent);
  }
  /**
   * The rows OUTSIDE a membership, in three-valued logic: a member-side
   * column left NULL, or a parent that holds no key, is outside — where a
   * plain negation of {@link memberWhere} would answer NULL and select nothing
   * (an ordered observation's found requirement, N1).
   */
  outsideWhere(edge: Membership, parent: Input, alias: string): Sql {
    const a = this.adapter;
    const inside = this.membershipWhere(edge, alias, parent);
    if (edge.kind !== "reference") return a.operators.not(inside);
    const unbound = edge.pairs.some(
      (pair) =>
        parent[pair.source] === null || parent[pair.source] === undefined
    );
    if (unbound) return sql`1 = 1`;
    const columns = [
      ...(edge.discriminator?.side === "target"
        ? [edge.discriminator.field]
        : []),
      ...edge.pairs.map((pair) => pair.target),
    ];
    return a.operators.or(
      a.operators.not(inside),
      ...columns.map((field) =>
        a.operators.isNull(this.column(edge.target, field, alias))
      )
    );
  }
  private membershipWhere(
    edge: Membership,
    target: string,
    source: string | Input
  ): Sql {
    const a = this.adapter;
    if (edge.kind === "reference") {
      return a.operators.and(
        ...(edge.discriminator
          ? [
              a.operators.eq(
                edge.discriminator.side === "source"
                  ? typeof source === "string"
                    ? this.column(edge.source, edge.discriminator.field, source)
                    : this.value(source[edge.discriminator.field])
                  : this.column(edge.target, edge.discriminator.field, target),
                this.value(edge.discriminator.value)
              ),
            ]
          : []),
        ...edge.pairs.map((pair) =>
          a.operators.eq(
            typeof source === "string"
              ? this.column(edge.source, pair.source, source)
              : this.column(edge.target, pair.target, target),
            typeof source === "string"
              ? this.column(edge.target, pair.target, target)
              : this.fieldValue(edge.target, pair.target, source[pair.source])
          )
        )
      );
    }
    const junction = this.alias();
    const conditions = [
      ...this.junctionSideConditions(edge.sourceSide, junction, source),
      ...this.junctionSideConditions(edge.targetSide, junction, target),
    ];
    return a.filters.some(
      a.subqueries.existsCheck(
        a.identifiers.table(edge.table, junction),
        a.operators.and(...conditions)
      )
    );
  }
  order(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string
  ): Sql | undefined {
    if (!input) return undefined;
    return this.lowerOrder(this.orderTerms(model, input, alias));
  }
  private lowerOrder(terms: readonly OrderTerm[]): Sql | undefined {
    if (terms.length === 0) return undefined;
    const a = this.adapter;
    return sql.join(
      terms.map((term) => {
        const direction = term.descending ? "desc" : "asc";
        if (!term.nullable || term.nulls === undefined)
          return a.orderBy[direction](term.expression);
        return term.nulls === "first"
          ? a.orderBy.nullsFirst(term.expression, direction)
          : a.orderBy.nullsLast(term.expression, direction);
      }),
      ", "
    );
  }
  /**
   * One order owner. A scalar key, a to-one relation path, a collection
   * `_count`, a distance and a grouped aggregate are all sort keys; only a
   * direct scalar key can also serve as a cursor's total order.
   */
  private orderTerms(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string,
    cursored = false
  ): OrderTerm[] {
    if (!input) return [];
    return entries(input).flatMap((order) =>
      Object.entries(order).flatMap(([field, direction]) =>
        direction === undefined
          ? []
          : [this.orderTerm(model, field, direction, alias, cursored)]
      )
    );
  }
  private orderTerm(
    model: AnyModel,
    field: string,
    direction: unknown,
    alias: string,
    cursored = false
  ): OrderTerm {
    if (model["~"].state.relations[field])
      return this.relationOrderTerm(model, field, record(direction), alias);
    const physical = physicalField(this.schema, model, field);
    const state = physical.scalar["~"].state;
    const column = this.column(model, field, alias);
    if (direction !== "asc" && direction !== "desc") {
      const specification = record(direction);
      if (specification._distance !== undefined) {
        // A cursor's eligibility is a fact about the REQUEST; a provider's
        // vector support is a fact about the PROVIDER. Classifying the order
        // first is what keeps `page`'s sentence the answer on a driver that
        // happens not to support vectors — `distanceExpression` consults the
        // capability while it BUILDS, so it would otherwise pre-empt it.
        if (cursored) throw new QueryEngineError(CURSOR_ORDER_REFUSAL);
        const distance = record(specification._distance);
        const point = state.type === "point";
        return this.sortKey(
          this.distanceExpression(column, state, field, distance, "orderBy"),
          distance.sort === "desc",
          point ? "last" : undefined,
          point,
          undefined,
          point ? true : undefined
        );
      }
      return this.sortKey(
        column,
        specification.sort === "desc",
        specification.nulls as "first" | "last" | undefined,
        physical.nullable,
        field
      );
    }
    return this.sortKey(
      column,
      direction === "desc",
      undefined,
      physical.nullable,
      field
    );
  }
  /** A to-one path is one correlated value; a collection orders by `_count`. */
  private relationOrderTerm(
    model: AnyModel,
    field: string,
    specification: Input,
    alias: string
  ): OrderTerm {
    const a = this.adapter;
    // A collection orders by `_count`, and that count is the projection's own
    // count owner — including a variant carrier, which has no single membership.
    const { edges: counted } = this.countedMemberships(model, field);
    if (
      counted.length > 1 ||
      counted[0]!.many ||
      specification._count !== undefined
    )
      return this.sortKey(
        this.correlatedCount(counted, undefined, alias),
        specification._count === "desc",
        undefined,
        false
      );
    const edge = counted[0]!;
    const childAlias = this.alias();
    const correlation = this.correlation(edge, alias, childAlias);
    const [nested] = Object.entries(specification);
    const inner = this.orderTerm(
      edge.target,
      nested![0],
      nested![1],
      childAlias
    );
    const value = assembleAdapterSelect(a, {
      columns: inner.expression,
      from: this.table(edge.target, childAlias),
      where: correlation,
      limit: this.value(1),
    });
    return this.sortKey(
      a.subqueries.scalar(value),
      inner.descending,
      inner.nulls,
      true
    );
  }
  private sortKey(
    expression: Sql,
    descending: boolean,
    nulls: "first" | "last" | undefined,
    nullable: boolean,
    field?: string,
    expressionNulls?: true
  ): OrderTerm {
    return Object.freeze({
      expression,
      descending,
      nulls,
      expressionNulls,
      nullable,
      field,
    });
  }
  private reverseOrder(terms: readonly OrderTerm[]): OrderTerm[] {
    return terms.map((term) =>
      Object.freeze({
        ...term,
        descending: !term.descending,
        nulls:
          term.nulls === undefined || term.expressionNulls
            ? term.nulls
            : term.nulls === "first"
              ? ("last" as const)
              : ("first" as const),
      })
    );
  }
  /**
   * One page owner: the root read and every nested node use it, so a nested
   * window is the ordinary page operator inside its parent's correlation.
   */
  private page(
    model: AnyModel,
    args: Pick<
      Partial<Arguments>,
      "orderBy" | "take" | "skip" | "cursor" | "distinct"
    >,
    alias: string
  ): {
    readonly orderBy?: Sql;
    readonly limit?: Sql;
    readonly offset?: Sql;
    readonly cursor?: Sql;
    readonly distinct?: Sql;
  } {
    const backward = args.take !== undefined && args.take < 0;
    const cursored = args.cursor !== undefined;
    const requested = this.orderTerms(model, args.orderBy, alias, cursored);
    const windowed = cursored || args.take !== undefined;
    const total =
      windowed && requested.every((term) => term.field !== undefined)
        ? this.totalOrder(model, requested, args.cursor, alias)
        : undefined;
    // The single raise point for every other non-scalar key: a relation term
    // builds with `field: undefined` and is classified here.
    if (cursored && !total) throw new QueryEngineError(CURSOR_ORDER_REFUSAL);
    const terms = total ?? requested;
    return {
      orderBy: this.lowerOrder(backward ? this.reverseOrder(terms) : terms),
      limit:
        args.take === undefined ? undefined : this.value(Math.abs(args.take)),
      offset: args.skip === undefined ? undefined : this.value(args.skip),
      cursor:
        args.cursor === undefined
          ? undefined
          : this.cursorCondition(
              model,
              backward ? this.reverseOrder(total!) : total!,
              args.cursor
            ),
      distinct: args.distinct?.length
        ? sql.join(
            args.distinct.map((field) => this.column(model, field, alias)),
            ", "
          )
        : undefined,
    };
  }
  /** A windowed read needs a deterministic total order, not just the caller's. */
  private totalOrder(
    model: AnyModel,
    requested: readonly OrderTerm[],
    cursor: Input | undefined,
    alias: string
  ): OrderTerm[] {
    // A windowed read is the one read whose null placement must be stated: the
    // cursor predicate and the emitted order have to name the same total order,
    // so an unspelled key takes the established default here and nowhere else.
    const terms = requested.map((term) =>
      term.nulls === undefined
        ? Object.freeze({
            ...term,
            nulls: term.descending ? ("first" as const) : ("last" as const),
          })
        : term
    );
    return this.completeOrder(
      model,
      terms,
      alias,
      cursor ? Object.keys(this.identityEntries(model, cursor)) : []
    );
  }
  /**
   * The caller's terms completed by the model's identity: the ONE complete-key
   * tie-break. A windowed page and a recursive sibling order both need a
   * deterministic order and both read it here, so equal sort keys break the
   * same way wherever one parent's rows are ordered — a second spelling (the
   * row key in constraint order) ordered the same tied siblings differently
   * under recursion than under the ordinary window.
   */
  private completeOrder(
    model: AnyModel,
    requested: readonly OrderTerm[],
    alias: string,
    cursorFields: readonly string[] = []
  ): OrderTerm[] {
    const terms = [...requested];
    const ordered = new Set(
      terms.flatMap((term) => (term.field === undefined ? [] : [term.field]))
    );
    for (const field of [...this.identityOrder(model), ...cursorFields]) {
      if (ordered.has(field)) continue;
      ordered.add(field);
      const physical = physicalField(this.schema, model, field);
      terms.push(
        this.sortKey(
          this.column(model, field, alias),
          false,
          "last",
          physical.nullable,
          field
        )
      );
    }
    return terms;
  }
  /** The cursor's tie-break identity: a bare scalar id, else the row key. */
  private identityOrder(model: AnyModel): readonly string[] {
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
    return Object.keys(model["~"].state.scalars).filter((field) =>
      fields.has(field)
    );
  }
  /** A strict unique selector's exact field values, compound keys expanded. */
  private identityEntries(model: AnyModel, input: Input): Input {
    const identity: Input = {};
    for (const [name, value] of Object.entries(input)) {
      const key = findAddressableKey(model, name);
      if (key?.name)
        for (const field of key.fields) identity[field] = record(value)[field];
      else identity[name] = value;
    }
    return identity;
  }
  /**
   * One null-aware lexicographic window against the cursor row. Where every
   * key is NOT NULL and shares a direction the same meaning is spelled as a
   * row-value comparison, which a planner can turn into a range seek.
   */
  private cursorCondition(
    model: AnyModel,
    order: readonly OrderTerm[],
    cursor: Input
  ): Sql {
    const a = this.adapter;
    const identity = this.identityEntries(model, cursor);
    const sourceAlias = this.alias();
    const where = a.operators.and(
      ...Object.entries(identity).map(([field, value]) => {
        if (value === null)
          throw new QueryEngineError(
            `Cursor field '${field}' cannot be null. Cursor must point to a specific record.`
          );
        return a.operators.eq(
          this.column(model, field, sourceAlias),
          this.fieldValue(model, field, value)
        );
      })
    );
    const descending = order[0]!.descending;
    const sargable = order.every(
      (term) => !term.nullable && term.descending === descending
    );
    const cursorRow = (columns: Sql[]) =>
      assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: this.table(model, sourceAlias),
        where,
        limit: this.value(1),
      });
    const keyColumns = order.map((term) =>
      this.column(model, term.field!, sourceAlias)
    );
    if (sargable) {
      const row = (expressions: Sql[]) =>
        expressions.length === 1
          ? expressions[0]!
          : sql`(${sql.join(expressions, ", ")})`;
      return (descending ? a.operators.lte : a.operators.gte)(
        row(order.map((term) => term.expression)),
        a.subqueries.scalar(cursorRow(keyColumns))
      );
    }
    const cursorAlias = this.alias();
    const carrier = (index: number) => `${CURSOR_CARRIER_PREFIX}${index}`;
    const derived = cursorRow(
      keyColumns.map((column, index) =>
        a.identifiers.aliased(column, carrier(index))
      )
    );
    const comparisons = order.map((term, index) => ({
      row: term.expression,
      cursor: a.identifiers.column(cursorAlias, carrier(index)),
      term,
    }));
    const equalities: Sql[] = [];
    const afterTerms: Sql[] = [];
    for (const { row, cursor: key, term } of comparisons) {
      const compare = term.descending ? a.operators.lt : a.operators.gt;
      const strict = a.operators.and(
        a.operators.isNotNull(row),
        compare(row, key)
      );
      afterTerms.push(
        a.operators.and(
          ...equalities,
          term.nulls === "first"
            ? a.operators.or(
                a.operators.and(
                  a.operators.isNull(key),
                  a.operators.isNotNull(row)
                ),
                a.operators.and(a.operators.isNotNull(key), strict)
              )
            : a.operators.and(
                a.operators.isNotNull(key),
                a.operators.or(a.operators.isNull(row), strict)
              )
        )
      );
      equalities.push(
        a.operators.or(
          a.operators.and(a.operators.isNull(row), a.operators.isNull(key)),
          a.operators.and(
            a.operators.isNotNull(row),
            a.operators.isNotNull(key),
            a.operators.eq(row, key)
          )
        )
      );
    }
    afterTerms.push(a.operators.and(...equalities));
    return a.operators.exists(
      assembleAdapterSelect(a, {
        columns: a.literals.true(),
        from: a.subqueries.correlate(derived, cursorAlias),
        where: a.operators.or(...afterTerms),
      })
    );
  }
  select(
    model: AnyModel,
    args: Partial<Arguments>,
    membership?: { edge: Membership; parent: Input; outside?: boolean },
    controls: {
      condition?: Sql;
      forUpdate?: boolean;
      identity?: Input;
      projection?: PreparedProjection;
      selector?: PreparedSelector;
    } = {}
  ): Query {
    const alias = this.rootAlias();
    // The shipped owner sequence, and the reason it is stated here: when one
    // call violates two contracts at once, the refusal the caller sees is the
    // one whose owner runs first. `buildFind` (`operations/find-common.ts`)
    // pages before it selects and selects before it builds the `where`, so the
    // cursor refusal outranks a projection refusal and both outrank a `where`
    // refusal. Nothing below reads the projection or the selector, so this is
    // an ORDER, not a dependency (`g4/unit01-review-followup-3.md` finding K).
    const page = this.page(model, args, alias);
    const prepared = controls.projection ?? this.prepareProjection(model, args);
    const projection = this.lowerProjection(prepared, alias);
    const selector =
      controls.selector ??
      (args.where === undefined
        ? undefined
        : this.prepareSelector(model, args.where));
    const filter = selector ? this.lowerSelector(selector, alias) : undefined;
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns: sql.join(projection.columns, ", "),
        from: this.table(model, alias),
        where: this.adapter.operators.and(
          ...(membership
            ? [
                membership.outside
                  ? this.outsideWhere(membership.edge, membership.parent, alias)
                  : this.memberWhere(membership.edge, membership.parent, alias),
              ]
            : []),
          ...(filter ? [filter] : []),
          ...(page.cursor ? [page.cursor] : []),
          ...(controls.identity
            ? [this.lowerIdentity(model, controls.identity, alias)]
            : []),
          ...(controls.condition ? [controls.condition] : [])
        ),
        orderBy: page.orderBy,
        limit: page.limit,
        offset: page.offset,
        forUpdate: controls.forUpdate,
        ...(page.distinct
          ? {
              distinct: page.distinct,
              distinctColumnAliases: projection.names,
            }
          : {}),
      }),
      shape: prepared.shape,
    };
  }
  /**
   * Every read verb is one cardinality and shape decision over the same
   * select, projection and decoder owners.
   */
  read(model: AnyModel, operation: ReadOperation, args: Arguments): Read {
    const rowSet = (query: Query): ProjectionShape => ({
      kind: "collection",
      row: query.shape,
    });
    // biome-ignore lint/style/useDefaultSwitchClause: the read operation union is exhaustive; a default would be dead code.
    switch (operation) {
      case "findUnique": {
        // The one read verb whose `where` is a unique selector: its addressable
        // entries name the row through the constraint, exactly as the shipped
        // `buildWhereUnique` compiles them, while `findFirst`/`findMany` read
        // the same object as a filter.
        const query = this.select(model, args, undefined, {
          selector:
            args.where === undefined
              ? undefined
              : this.prepareSelector(model, args.where, true),
        });
        return {
          query,
          single: true,
          value: query.shape,
          result: (rows) => rows[0] ?? null,
        };
      }
      case "findFirst": {
        // A negative take selects from the end of the window: the signed unit
        // limit flips the total order and still returns one row.
        const take = args.take === undefined ? 1 : Math.sign(args.take);
        const query = this.select(model, { ...args, take });
        return {
          query,
          single: true,
          value: query.shape,
          result: (rows) => rows[0] ?? null,
        };
      }
      case "findMany": {
        const backward = args.take !== undefined && args.take < 0;
        const query = this.select(model, args);
        return {
          query,
          single: false,
          value: rowSet(query),
          result: (rows) => (backward ? rows.reverse() : rows),
        };
      }
      case "count":
      case "exist": {
        const selected = args.select ? record(args.select) : undefined;
        const outputs: { name: string; field?: string }[] = selected
          ? [
              ...(selected._all ? [{ name: "_all" }] : []),
              ...Object.keys(selected)
                .filter((field) => field !== "_all" && selected[field])
                .map((field) => ({ name: field, field })),
            ]
          : [{ name: "_count" }];
        const fields = outputs.flatMap(({ field }) =>
          field === undefined ? [] : [field]
        );
        const query = this.aggregated(
          model,
          args,
          fields,
          (alias) =>
            outputs.map(({ name, field }): [string, Sql] => [
              name,
              this.adapter.aggregates.count(
                field === undefined
                  ? undefined
                  : this.column(model, field, alias)
              ),
            ]),
          () => ({
            kind: "object",
            fields: Object.fromEntries(
              outputs.map(({ name }) => [name, COUNT_LEAF])
            ),
          })
        );
        return {
          query,
          // `count` publishes a number and `exist` a boolean: one VALUE, not one
          // row, so neither is `single` — the row they decode is scaffolding.
          single: operation === "count" && selected !== undefined,
          value:
            operation === "exist"
              ? BOOLEAN_LEAF
              : selected
                ? query.shape
                : COUNT_LEAF,
          result: (rows) =>
            operation === "exist"
              ? (rows[0]?._count as number) > 0
              : selected
                ? (rows[0] ?? {})
                : ((rows[0]?._count as number) ?? 0),
        };
      }
      case "aggregate": {
        const prepared = this.prepareAggregates(model, args);
        const query = this.aggregated(
          model,
          args,
          prepared.fields,
          (alias) => prepared.columns(alias),
          () => ({ kind: "object", fields: prepared.fields_ })
        );
        return {
          query,
          single: true,
          value: query.shape,
          result: (rows) => rows[0] ?? {},
        };
      }
      case "groupBy": {
        const query = this.grouped(model, args);
        return {
          query,
          single: false,
          value: rowSet(query),
          result: (rows) => rows,
        };
      }
    }
  }
  /** One aggregate window: the same filter/order/cursor/page, then aggregates. */
  private aggregated(
    model: AnyModel,
    args: Arguments,
    fields: readonly string[],
    columns: (alias: string) => [string, Sql][],
    shape: (alias: string) => Extract<Shape, { kind: "object" }>
  ): Query {
    const a = this.adapter;
    const inner = this.rootAlias();
    const page = this.page(model, args, inner);
    const filter = this.lowerWhere(model, args.where, inner);
    const window = assembleAdapterSelect(a, {
      columns: fields.length
        ? sql.join(
            [...new Set(fields)].map((field) =>
              a.identifiers.aliased(
                this.column(model, field, inner),
                this.columnName(model, field)
              )
            ),
            ", "
          )
        : a.identifiers.aliased(this.value(1), "0viborm_row"),
      from: this.table(model, inner),
      where: a.operators.and(
        ...(filter ? [filter] : []),
        ...(page.cursor ? [page.cursor] : [])
      ),
      orderBy: page.orderBy,
      limit: page.limit,
      offset: page.offset,
    });
    const outer = this.alias();
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(
          columns(outer).map(([name, expression]) =>
            a.identifiers.aliased(expression, name)
          ),
          ", "
        ),
        from: a.subqueries.correlate(window, outer),
      }),
      shape: shape(outer),
    };
  }
  /** The admitted aggregate selections, as columns and as decoder leaves. */
  private prepareAggregates(
    model: AnyModel,
    args: Arguments
  ): {
    readonly fields: string[];
    readonly fields_: Record<string, Shape | Leaf>;
    columns(alias: string): [string, Sql][];
  } {
    const a = this.adapter;
    const fields: string[] = [];
    const shape: Record<string, Shape | Leaf> = {};
    const builders: ((alias: string) => [string, Sql])[] = [];
    for (const name of AGGREGATES) {
      const selection = args[name];
      if (!selection) continue;
      if (name === "_count" && selection === true) {
        shape._count = COUNT_LEAF;
        builders.push(() => ["_count", a.aggregates.count()]);
        continue;
      }
      const selected = Object.entries(record(selection)).filter(
        ([, include]) => include
      );
      if (selected.length === 0) continue;
      const leaves: Record<string, Leaf> = {};
      for (const [field] of selected) {
        if (field !== "_all") fields.push(field);
        leaves[field] = this.aggregateLeaf(model, name, field);
      }
      shape[name] = { kind: "object", fields: leaves };
      builders.push((alias) => [
        name,
        a.json.objectFromColumns(
          selected.map(([field]) => [
            field,
            this.carriedValue(
              leaves[field]!,
              this.aggregateExpression(
                name,
                field === "_all"
                  ? undefined
                  : Object.freeze({
                      model,
                      field,
                      physical: physicalField(this.schema, model, field),
                    }),
                alias
              )
            ),
          ])
        ),
      ]);
    }
    return {
      fields,
      fields_: shape,
      columns: (alias) => builders.map((build) => build(alias)),
    };
  }
  /** One aggregate leaf classification, shared by projection and `having`. */
  private aggregateLeaf(
    model: AnyModel,
    aggregate: Aggregate,
    field: string
  ): Leaf {
    if (aggregate === "_count") return COUNT_LEAF;
    const leaf = this.scalarShape(model, field);
    const decimal = leaf.type === "decimal";
    if (aggregate === "_avg" && !decimal)
      return Object.freeze({ kind: "scalar", type: "number", nullable: true });
    return Object.freeze({
      ...leaf,
      nullable: true,
      widened: aggregate === "_sum" && decimal ? true : undefined,
    });
  }
  private aggregateExpression(
    aggregate: Aggregate,
    scalar: PreparedScalar | undefined,
    alias?: string
  ): Sql {
    const a = this.adapter;
    const column = scalar ? this.preparedColumn(scalar, alias) : undefined;
    const state = scalar?.physical.scalar["~"].state;
    switch (aggregate) {
      case "_count":
        return a.aggregates.count(column);
      case "_sum":
        return a.aggregates.sum(column!);
      case "_min":
      case "_max": {
        assertInvariant(
          scalar !== undefined && column !== undefined,
          `Raptor 3 aggregate '${aggregate}' names no column: admission admits '_all' under '_count' alone.`
        );
        // A compact identifier is aggregated in the spelling it TRAVELS in
        // (`identifier.ts`); every other column is aggregated as stored.
        const operand = aggregatedIdentifier(
          a,
          this.scalarShape(scalar.model, scalar.field).id,
          column
        );
        return aggregate === "_min"
          ? a.aggregates.min(operand)
          : a.aggregates.max(operand);
      }
      case "_avg":
        return state?.type === "decimal" && state.decimal
          ? a.aggregates.decimalAvg(column!, state.decimal)
          : a.aggregates.avg(column!);
      default:
        return unreachable(aggregate, "Raptor 3 aggregate is not implemented");
    }
  }
  selectSeries(
    prepared: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query {
    const model = prepared.model;
    const alias = this.rootAlias();
    const projection = this.lowerProjection(prepared, alias);
    const predicates = identities.map((identity) =>
      this.lowerIdentity(model, identity, alias)
    );
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns: sql.join(projection.columns, ", "),
        from: this.table(model, alias),
        where: this.adapter.operators.or(...predicates),
        orderBy: this.adapter.expressions.caseWhen(
          predicates.map((when, index) => ({
            when,
            then: this.value(index),
          })),
          this.value(identities.length)
        ),
      }),
      shape: prepared.shape,
      expectedRows: {
        count: identities.length,
        missing:
          operation === "createMany"
            ? new QueryEngineError(
                "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls."
              )
            : new TransactionError(
                "updateMany with 'select' could not read back one of the updated rows at its final primary key.",
                {
                  meta: {
                    model: model["~"].names.ts ?? "unknown",
                    operation: "updateMany",
                  },
                }
              ),
      },
    };
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
  prepareProjection(
    model: AnyModel,
    args: Partial<Arguments>
  ): PreparedProjection {
    const shared = args.select === undefined && args.include === undefined;
    if (shared) {
      const resolved = this.views.defaultProjections.get(model);
      if (resolved !== undefined) return resolved;
    }
    // `omit` is desugared into `select` at admission; an explicit selection and
    // an include can therefore both be present and both belong to the result.
    const selected = {
      ...(args.select ??
        Object.fromEntries(
          model["~"].scalarFieldNames
            .filter((field) => !model["~"].state.omit?.[field])
            .map((field) => [field, true])
        )),
      ...args.include,
    };
    const prepared: PreparedProjectionField[] = [];
    const fields: Record<string, Shape | Leaf> = {};
    let distanceSelected = false;
    for (const [name, selection] of Object.entries(selected)) {
      if (!selection) continue;
      if (name === "_count" && !model["~"].state.scalars[name]) {
        const counts = this.prepareCounts(model, selection);
        // An empty count SELECTION contributes no field at all: the shipped
        // engine pushed the `_count` pair only `if (relationCountPairs.length
        // > 0)` (`select-builder.ts:418`), so `_count: true` on a model with
        // no to-many relation publishes no `_count` key rather than `{}`.
        if (counts.length === 0) continue;
        fields[name] = Object.freeze({
          kind: "object",
          // A count carrier is a document the statement always builds: a
          // provider that answers `null` here has not answered the question,
          // and an object shape that carried no nullability let that `null`
          // reach a caller whose type says `{ children: number }`.
          nullable: false,
          fields: Object.freeze(
            Object.fromEntries(
              counts.map((count) => [count.relation, COUNT_LEAF])
            )
          ),
        });
        prepared.push(Object.freeze({ kind: "counts", name, counts }));
        continue;
      }
      if (!model["~"].state.relations[name]) {
        const distance =
          selection === true ? undefined : record(selection)._distance;
        if (distance !== undefined) {
          if (distanceSelected)
            throw new QueryEngineError(
              "Distance select supports only one _distance field per select."
            );
          // The OTHER registered collision (`result/result-shape.ts`
          // `buildModelShape`, the guard after every producer): the output key
          // `_distance` is the distance's, and a model that owns a field of
          // that name: scalar, relation or variant slot, cannot publish both
          // under it.
          if (fields[DISTANCE_FIELD])
            throw new QueryEngineError(DISTANCE_NAME_COLLISION);
          distanceSelected = true;
          prepared.push(
            Object.freeze({
              kind: "distance",
              name: DISTANCE_FIELD,
              field: name,
              specification: record(distance),
            })
          );
          fields[DISTANCE_FIELD] = this.distanceLeaf(model, name);
          continue;
        }
      }
      // The output key `_distance` has ONE producer. A distance prepared
      // earlier in this projection owns it; a scalar OR a relation of that
      // name prepared after it — a recursive slot included — would otherwise
      // overwrite the leaf silently and publish under one key at some levels
      // and the other at the rest.
      if (name === DISTANCE_FIELD && distanceSelected)
        throw new QueryEngineError(DISTANCE_NAME_COLLISION);
      if (!model["~"].state.relations[name]) {
        prepared.push(Object.freeze({ kind: "scalar", name }));
        fields[name] = this.scalarShape(model, name);
        continue;
      }
      const resolved = this.schema.index.get(model)!.get(name)!;
      if (
        !resolved.member &&
        (resolved.edge.kind === "variantRowCarrier" ||
          resolved.edge.kind === "variantJunctionCarrier")
      ) {
        const many = resolved.edge.kind === "variantJunctionCarrier";
        const configuration = selection === true ? {} : record(selection);
        const only = configuration.only as string[] | undefined;
        const arms: Record<string, Shape> = {};
        const preparedArms: ({
          readonly variant: string;
        } & PreparedRelationProjection)[] = [];
        // The integrity probe's subjects: every configured member of a
        // junction-carried slot. A ROW carrier states its own claim on the
        // parent row, which the arm document already answers (D-19).
        const memberships = many
          ? resolved.edge.members.map((member) => ({
              variant: member.variant,
              edge: bindMembership(this.schema, model, name, member.variant),
            }))
          : [];
        for (const member of resolved.edge.members) {
          if (
            many
              ? only && !only.includes(member.variant)
              : selection !== true &&
                configuration[member.variant] === undefined
          )
            continue;
          const arm = many
            ? record(configuration.variants ?? {})[member.variant]
            : configuration[member.variant];
          const nested = this.prepareRelationProjection(
            bindMembership(this.schema, model, name, member.variant),
            arm === undefined ? true : arm
          );
          arms[member.variant] = this.relationShape(nested);
          preparedArms.push(
            Object.freeze({ variant: member.variant, ...nested })
          );
        }
        fields[name] = Object.freeze({
          kind: "variants",
          relation: name,
          many,
          arms: Object.freeze(arms),
        });
        prepared.push(
          Object.freeze({
            kind: "variants",
            name,
            many,
            arms: Object.freeze(preparedArms),
            memberships: Object.freeze(memberships),
          })
        );
        continue;
      }
      const nested = this.prepareRelationProjection(
        bindMembership(this.schema, model, name),
        selection
      );
      fields[name] = this.relationShape(nested);
      prepared.push(Object.freeze({ kind: "relation", name, ...nested }));
    }
    // The empty-projection arm, in the shipped engine's two cases
    // (`select-builder.ts:425-437`). An empty projection is only legitimate
    // when the caller wrote no `select`: then it is the model's own default —
    // every scalar omitted — and the row still exists, so it carries the
    // sentinel column. An empty projection BECAUSE a `select` was written is
    // the caller asking for nothing, which is a refusal, not "everything".
    if (prepared.length === 0) {
      if (args.select !== undefined)
        throw new QueryEngineError(
          `The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value.`
        );
      prepared.push(
        Object.freeze({ kind: "sentinel", name: EMPTY_ROW_RESULT_KEY })
      );
    }
    const projection: PreparedProjection = Object.freeze({
      model,
      fields: Object.freeze(prepared),
      shape: Object.freeze({ kind: "object", fields: Object.freeze(fields) }),
    });
    if (shared) this.views.defaultProjections.set(model, projection);
    return projection;
  }
  /**
   * A to-many node's decoded shape. A negative `take` runs the reversed window
   * exactly as at the root, so the carried array is restored to the caller's
   * logical order by the one decoder that reads this shape.
   */
  private relationShape(nested: PreparedRelationProjection): Shape {
    if (nested.recurrence) {
      // The repeated slot publishes under the relation's name inside its own
      // node. Admission refuses that name there, so a field of it in the node
      // is a distance: `_distance` would have two producers — the slot at every
      // level before the cutoff, the distance at the cutoff.
      if (nested.projection.shape.fields[nested.edge.name])
        throw new QueryEngineError(DISTANCE_NAME_COLLISION);
      const resolved = this.schema.index
        .get(nested.edge.source)!
        .get(nested.edge.name)!;
      return Object.freeze({
        kind: "recursive",
        relation: nested.edge.name,
        many: nested.edge.many,
        optional: slotMayBeEmpty(resolved),
        recurrence: nested.recurrence,
        row: nested.projection.shape,
        identity: Object.freeze(
          this.schema
            .keys(nested.edge.target)
            .map((field) => this.scalarShape(nested.edge.target, field))
        ),
      });
    }
    if (!nested.edge.many) return nested.projection.shape;
    const take = nested.arguments.take;
    return Object.freeze({
      kind: "collection",
      reversed: take !== undefined && take < 0 ? true : undefined,
      row: nested.projection.shape,
    });
  }
  /** The distance leaf: one number, null only where a nullable point has none. */
  private distanceLeaf(model: AnyModel, field: string): Leaf {
    const physical = physicalField(this.schema, model, field);
    return Object.freeze({
      kind: "scalar",
      type: "number",
      nullable:
        physical.scalar["~"].state.type === "point" && physical.nullable,
    });
  }
  private prepareRelationProjection(
    edge: Membership,
    selection: unknown
  ): PreparedRelationProjection {
    const nested =
      selection === true ? {} : (record(selection) as Partial<Arguments>);
    return Object.freeze({
      edge,
      arguments: Object.freeze({
        selector: nested.where
          ? this.prepareSelector(edge.target, nested.where)
          : undefined,
        orderBy: nested.orderBy,
        take: nested.take,
        skip: nested.skip,
        cursor: nested.cursor,
        distinct: nested.distinct,
      }),
      projection: this.prepareProjection(edge.target, nested),
      recurrence: nested.recurse,
    });
  }
  /**
   * Admission desugars `_count: true` into `{ select: { relation: … } }`, so
   * the projection owner reads one shape; an entry may filter its target.
   */
  private prepareCounts(
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
        counts.push(Object.freeze({ relation, edges }));
        continue;
      }
      const filter = record(where);
      if (!variants) {
        counts.push(
          Object.freeze({
            relation,
            edges,
            selector: this.prepareSelector(edges[0]!.target, filter),
          })
        );
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
      counts.push(
        Object.freeze({
          relation,
          edges: Object.freeze([arm]),
          selector:
            inner === undefined
              ? undefined
              : this.prepareSelector(arm.target, record(inner)),
          ...(negated ? { negated: true as const } : {}),
        })
      );
    }
    return Object.freeze(counts);
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
  private countedMemberships(
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
    return Object.freeze({
      edges: Object.freeze(
        carrier
          ? carrier.members.map((member) =>
              bindMembership(this.schema, model, relation, member.variant)
            )
          : [bindMembership(this.schema, model, relation)]
      ),
      variants: carrier !== undefined,
    });
  }
  lowerProjection(
    projection: PreparedProjection,
    alias?: string
  ): {
    readonly columns: Sql[];
    readonly entries: [string, Sql][];
    readonly names: string[];
  } {
    const a = this.adapter;
    const columns: Sql[] = [];
    const entries: [string, Sql][] = [];
    for (const field of projection.fields) {
      let expression: Sql;
      if (field.kind === "scalar") {
        expression = this.projectedColumn(projection.model, field.name, alias);
      } else if (field.kind === "sentinel") {
        expression = a.expressions.cast(a.literals.value(1), "integer");
      } else if (field.kind === "relation") {
        expression = this.duplicateMembershipGuard(
          field.edge,
          alias ?? "",
          field.recurrence
            ? this.lowerRecursiveRelationProjection(
                field,
                field.recurrence,
                alias ?? ""
              )
            : this.lowerRelationProjection(field, alias ?? "")
        );
      } else if (field.kind === "counts") {
        expression = a.json.objectFromColumns(
          field.counts.map((count) => [
            count.relation,
            this.correlatedCount(
              count.edges,
              count.selector,
              alias ?? "",
              count.negated
            ),
          ])
        );
      } else if (field.kind === "distance") {
        expression = this.distanceExpression(
          this.column(projection.model, field.field, alias),
          physicalField(this.schema, projection.model, field.field).scalar["~"]
            .state,
          field.field,
          field.specification,
          "select"
        );
      } else {
        // The slot's own document: one entry per SELECTED arm, and — for a
        // junction-carried slot — one integrity entry naming every CONFIGURED
        // member (D-26). The integrity entry is a sibling of the arms, so it is
        // answered whatever `only` selected, including nothing at all.
        const integrity: [string, Sql][] =
          field.memberships.length === 0
            ? []
            : [
                [
                  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
                  a.json.document(
                    a.json.objectFromColumns(
                      field.memberships.map((member) => [
                        member.variant,
                        this.orphanedMemberships(member.edge, alias ?? ""),
                      ])
                    )
                  ),
                ],
              ];
        expression = a.json.object([
          ...field.arms.map((arm) => {
            const row = this.lowerRelationProjection(arm, alias ?? "");
            const claim = field.many
              ? undefined
              : this.parentClaimsArm(arm.edge, alias ?? "");
            // A claimed arm always carries a DOCUMENT: the empty one says
            // "linked, and the row is gone", which the decoder refuses from
            // the arm's own selected keys (Arnaud's D-19 — no private carrier
            // column). An unclaimed arm stays null, which is an empty slot.
            return [
              arm.variant,
              a.json.document(
                claim
                  ? a.expressions.caseWhen(
                      [
                        {
                          when: claim,
                          then: a.expressions.coalesce(row, a.json.object([])),
                        },
                      ],
                      a.literals.null()
                    )
                  : row
              ),
            ] as [string, Sql];
          }),
          ...integrity,
        ]);
      }
      columns.push(a.identifiers.aliased(expression, field.name));
      entries.push([field.name, expression]);
    }
    return { columns, entries, names: projection.fields.map((f) => f.name) };
  }
  /**
   * How many of this member's memberships name a row that is gone.
   *
   * A polymorphic member table carries no real foreign key to its target on
   * every provider, so a disabled constraint or a raw write can leave the
   * membership behind; reading the slot must then FAIL, not report the row as
   * absent — existence and membership are execution semantics (rule 4), and a
   * silent absence is a wrong answer.
   *
   * The probe is a SIBLING scalar subquery of the arm's row window: it carries
   * no user filter, no cursor and no window, so it is evaluated outside — and
   * therefore ahead of — the arm's own `WHERE` and `LIMIT`, exactly as the
   * shipped `guardJunctionIntegrity` did
   * (`builders/include-many-to-many.ts` at `ff5e77ca`). It is emitted for every
   * configured member, so `only` cannot hide one (Arnaud's D-26).
   */
  /**
   * A SINGULAR polymorphic inverse holding more than one membership is
   * malformed provider state, even where a missing unique constraint allowed
   * it — and the row window cannot say so: a target filter that leaves one
   * visible row, or the `LIMIT 1` itself, hides the second member.
   *
   * So the count is a SIBLING scalar subquery over the member table, ahead of
   * the row subquery's `WHERE` and its `LIMIT`, and the refusal is carried in
   * the VALUE, not raised in SQL — no provider has a portable `RAISE`. The
   * branch emits a JSON ARRAY where the leaf owes one row object, which is the
   * shape the decoder already refuses by name and which no projection of a
   * model row can produce (the shipped `guardJunctionIntegrity`,
   * `builders/include-many-to-many.ts` at `ff5e77ca`).
   *
   * Only a polymorphic member table: an ordinary pair table's inverse is
   * enforced by its own unique constraint and its bytes are unchanged.
   */
  private duplicateMembershipGuard(
    edge: Membership,
    parentAlias: string,
    projected: Sql
  ): Sql {
    if (
      edge.kind !== "junction" ||
      edge.many ||
      edge.scope.edge.kind !== "variantJunctionCarrier"
    )
      return projected;
    const a = this.adapter;
    const junction = this.alias();
    const members = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.aggregates.count(),
        from: a.identifiers.table(edge.table, junction),
        where: a.operators.and(
          ...this.junctionSideConditions(edge.sourceSide, junction, parentAlias)
        ),
      })
    );
    return a.expressions.caseWhen(
      [
        {
          when: a.operators.gt(members, this.value(1)),
          then: a.json.emptyArray(),
        },
      ],
      projected
    );
  }
  private orphanedMemberships(edge: Membership, parentAlias: string): Sql {
    const a = this.adapter;
    // The probe's subjects are built only for a junction-carried slot, whose
    // members bind junction memberships (`prepareProjection`, D-26): an
    // invariant of that one construction site, not a refusal (N4).
    assertInvariant(
      edge.kind === "junction",
      "a junction-carried slot's integrity probe names junction memberships"
    );
    const junction = this.alias();
    const target = this.alias();
    return a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.aggregates.count(),
        from: a.identifiers.table(edge.table, junction),
        where: a.operators.and(
          ...this.junctionSideConditions(
            edge.sourceSide,
            junction,
            parentAlias
          ),
          a.filters.none(
            a.subqueries.existsCheck(
              this.table(edge.target, target),
              a.operators.and(
                ...this.junctionSideConditions(
                  edge.targetSide,
                  junction,
                  target
                )
              )
            )
          )
        ),
      })
    );
  }
  /**
   * One slot's correlated count, shared by the `_count` projection and `_count`
   * ordering. A variant carrier's arms are summed, because the slot's population
   * is their union ({@link countedMemberships}).
   */
  private correlatedCount(
    edges: readonly Membership[],
    selector: PreparedSelector | undefined,
    parentAlias: string,
    negated = false
  ): Sql {
    const a = this.adapter;
    const counted = edges.map((edge) => {
      const childAlias = this.alias();
      const filter = selector
        ? this.lowerSelector(selector, childAlias)!
        : undefined;
      return a.expressions.coalesce(
        a.subqueries.scalar(
          assembleAdapterSelect(a, {
            columns: a.aggregates.count(),
            from: this.table(edge.target, childAlias),
            where: a.operators.and(
              this.correlation(edge, parentAlias, childAlias),
              ...(filter ? [negated ? a.operators.not(filter) : filter] : [])
            ),
          })
        ),
        this.value(0)
      );
    });
    return counted.reduce((total, arm) => a.expressions.add(total, arm));
  }
  /**
   * One value this unit PRODUCED, published as the field it belongs to.
   *
   * `SELECT <expression> AS <field>` — no FROM, so one row by construction —
   * composed from the owners that already hold the parts: the field's own
   * physical value ({@link fieldValue}, the one destination-aware operand
   * owner) and its own decode leaf ({@link scalarShape}), read back by
   * {@link decodeQuery} like every other row. That is the composition
   * {@link grouped} and {@link junction} already state for every scalar they
   * publish.
   *
   * A user projection was never the question: D-58's segment boundary asks for
   * exactly ONE field, so preparing one to borrow its shape and its lowering
   * was a detour through arms — relation, variant, `_count`, `_distance`,
   * sentinel — that a produced scalar cannot reach, and it ended in a cast back
   * to the scalar arm the caller already knew it had.
   */
  scalarQuery(model: AnyModel, field: string, value: unknown): Query {
    return {
      shape: {
        kind: "object",
        fields: { [field]: this.scalarShape(model, field) },
      },
      sql: this.adapter.clauses.select(
        this.adapter.identifiers.aliased(
          this.fieldValue(model, field, value),
          field
        )
      ),
    };
  }
  private lowerRelationProjection(
    relation: PreparedRelationProjection,
    alias: string
  ): Sql {
    const a = this.adapter;
    const { edge, arguments: nested, projection } = relation;
    const childAlias = this.alias();
    const child = this.lowerProjection(projection, childAlias);
    const childFields = Object.keys(projection.shape.fields);
    // A nested node is the ordinary page operator inside the parent's
    // correlation scope; `take: -n` reverses the window exactly as at the root.
    const window = this.page(edge.target, nested, childAlias);
    const page = assembleAdapterSelect(a, {
      columns: sql.join(child.columns, ", "),
      from: this.table(edge.target, childAlias),
      where: a.operators.and(
        this.correlation(edge, alias, childAlias),
        ...(nested.selector
          ? [this.lowerSelector(nested.selector, childAlias)!]
          : []),
        ...(window.cursor ? [window.cursor] : [])
      ),
      orderBy: window.orderBy,
      // The aggregate below reads this page IN ORDER, so an ordered page
      // states its bound. MySQL merges an UNLIMITED derived table into the
      // query that reads it and the merge takes the ORDER BY with it, and the
      // rows then arrive in storage order — measured, both answers from the
      // same aggregate over the same page. What the bound buys is the MERGE
      // RULE, which is the documented fact: MySQL does not merge a derived
      // table that states a LIMIT. That the same page then answered in the
      // requested order is the measurement beside it, not a documented
      // property of materialising. The caller's window is that bound wherever
      // it asked for one — including the offset-only window, whose bare
      // OFFSET already needs the same spelling — and where it asked for none,
      // the dialect's own "no limit" value is. A dialect that needs no bound
      // to keep a derived order declares none (PostgreSQL) and emits nothing.
      limit: edge.many
        ? (window.limit ?? (window.orderBy ? a.noLimitValue : undefined))
        : this.value(1),
      offset: window.offset,
      ...(window.distinct
        ? { distinct: window.distinct, distinctColumnAliases: child.names }
        : {}),
    });
    const pageAlias = this.alias();
    const object = a.json.object(
      childFields.map((field) => [
        field,
        this.carriedValue(
          projection.shape.fields[field]!,
          a.identifiers.column(pageAlias, field)
        ),
      ])
    );
    const expression = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: edge.many
          ? a.expressions.coalesce(a.json.agg(object), a.json.emptyArray())
          : object,
        from: a.subqueries.correlate(page, pageAlias),
      })
    );
    return expression;
  }

  /**
   * One physical row identity, encoded through the existing JSON carrier rule:
   * the one encoder of the carrier's root, node keys and edge endpoints, whose
   * texts the decoder matches.
   */
  private recursiveIdentity(model: AnyModel, key: readonly Sql[]): Sql {
    return this.adapter.json.array(
      this.schema.keys(model).map((field, index) => {
        // The carried key is the RAW column, so a byte identifier takes its
        // transport spelling here, as every projected column already has.
        const leaf = this.scalarShape(model, field);
        return this.carriedValue(
          leaf,
          transportedIdentifier(
            this.adapter,
            leaf.id,
            key[index]!,
            leaf.nullable
          )
        );
      })
    );
  }

  /**
   * A recursive relation remains one ordinary projected field. The recursive
   * CTE carries only edge facts; one node table supplies each projected row,
   * and the decoder owns path occurrences and cutoff omission. The recursive
   * member expands every reached row below the bound with the same
   * correlation and filter and prunes nothing (the cycle policy belongs to the
   * decoder), because `decodeRecursiveCarrier` refuses a carrier in which a
   * parent lacks its children at any level it is reached below the cutoff.
   */
  private lowerRecursiveRelationProjection(
    relation: PreparedRelationProjection,
    recurrence: NormalizedRecurrence,
    parentAlias: string
  ): Sql {
    const a = this.adapter;
    const model = relation.edge.target;
    const keys = this.schema.keys(model);
    const scope = this.alias();
    const cteName = `__${scope}_recursive`;
    const parentColumns = keys.map((_, index) => `__${scope}_parent_${index}`);
    const childColumns = keys.map((_, index) => `__${scope}_child_${index}`);
    const depthColumn = `__${scope}_depth`;
    const columns = (
      names: readonly string[],
      expressions: readonly Sql[]
    ): Sql[] =>
      names.map((name, index) =>
        a.identifiers.aliased(expressions[index]!, name)
      );
    const rawIdentity = (alias: string): Sql[] =>
      keys.map((field) => this.column(model, field, alias));
    /** The complete-key join of one model alias to carried key columns. */
    const sameRow = (alias: string, carried: readonly Sql[]): Sql =>
      a.operators.and(
        ...rawIdentity(alias).map((column, index) =>
          a.operators.eq(column, carried[index]!)
        )
      );

    const anchorChild = this.alias();
    const anchorColumns = [
      ...columns(parentColumns, rawIdentity(parentAlias)),
      ...columns(childColumns, rawIdentity(anchorChild)),
      ...(recurrence.depth === false
        ? []
        : [
            a.identifiers.aliased(
              a.expressions.cast(this.value(1), "integer"),
              depthColumn
            ),
          ]),
    ];
    const anchor = assembleAdapterSelect(a, {
      columns: sql.join(anchorColumns, ", "),
      from: this.table(model, anchorChild),
      where: a.operators.and(
        this.correlation(relation.edge, parentAlias, anchorChild),
        ...(relation.arguments.selector
          ? [this.lowerSelector(relation.arguments.selector, anchorChild)!]
          : [])
      ),
    });

    const walk = this.alias();
    const current = this.alias();
    const next = this.alias();
    const walkColumn = (name: string) => a.identifiers.column(walk, name);
    const recursiveColumns = [
      ...columns(parentColumns, childColumns.map(walkColumn)),
      ...columns(childColumns, rawIdentity(next)),
      ...(recurrence.depth === false
        ? []
        : [
            a.identifiers.aliased(
              a.expressions.add(walkColumn(depthColumn), this.value(1)),
              depthColumn
            ),
          ]),
    ];
    const recursive = assembleAdapterSelect(a, {
      columns: sql.join(recursiveColumns, ", "),
      from: sql`${a.identifiers.aliased(
        a.identifiers.escape(cteName),
        walk
      )} ${a.joins.inner(
        this.table(model, current),
        sameRow(current, childColumns.map(walkColumn))
      )} ${a.joins.inner(
        this.table(model, next),
        this.correlation(relation.edge, current, next)
      )}`,
      where: a.operators.and(
        ...(recurrence.depth === false
          ? []
          : [
              a.operators.lt(
                walkColumn(depthColumn),
                this.value(recurrence.depth)
              ),
            ]),
        ...(relation.arguments.selector
          ? [this.lowerSelector(relation.arguments.selector, next)!]
          : [])
      ),
    });

    const ids = this.alias();
    const idColumns = childColumns.map((_, index) => `__${scope}_id_${index}`);
    const distinctIds = assembleAdapterSelect(a, {
      distinct: sql.join(childColumns.map(walkColumn), ", "),
      distinctColumnAliases: idColumns,
      columns: sql.join(columns(idColumns, childColumns.map(walkColumn)), ", "),
      from: a.identifiers.aliased(a.identifiers.escape(cteName), walk),
    });
    const node = this.alias();
    const nodeProjection = this.lowerProjection(relation.projection, node);
    const nodeDocument = a.json.object(
      nodeProjection.entries.map(([field, expression]) => [
        field,
        this.carriedValue(relation.projection.shape.fields[field]!, expression),
      ])
    );
    const nodeCarrier = a.json.object([
      [RECURSIVE_CARRIER.key, this.recursiveIdentity(model, rawIdentity(node))],
      [RECURSIVE_CARRIER.row, nodeDocument],
    ]);
    const nodes = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.json.agg(nodeCarrier),
        from: sql`${a.subqueries.correlate(distinctIds, ids)} ${a.joins.inner(
          this.table(model, node),
          sameRow(
            node,
            idColumns.map((name) => a.identifiers.column(ids, name))
          )
        )}`,
      })
    );

    const edgeWalk = this.alias();
    const edgeChild = this.alias();
    const edgeColumn = (name: string) => a.identifiers.column(edgeWalk, name);
    const edgeCarrierName = `__${scope}_edge`;
    const edgePairs: [string, Sql][] = [
      [
        RECURSIVE_CARRIER.parent,
        this.recursiveIdentity(model, parentColumns.map(edgeColumn)),
      ],
      [
        RECURSIVE_CARRIER.child,
        this.recursiveIdentity(model, childColumns.map(edgeColumn)),
      ],
    ];
    if (recurrence.depth !== false)
      edgePairs.push([RECURSIVE_CARRIER.depth, edgeColumn(depthColumn)]);
    const edgeCarrier = a.json.object(edgePairs);
    // Each parent's siblings in the caller's order, ties broken by the order
    // owner's one complete key — the ordinary window's tie-break, not another.
    const siblingOrder = this.lowerOrder(
      this.completeOrder(
        model,
        this.orderTerms(model, relation.arguments.orderBy, edgeChild),
        edgeChild
      )
    );
    const edgePage = assembleAdapterSelect(a, {
      columns: a.identifiers.aliased(edgeCarrier, edgeCarrierName),
      from: sql`${a.identifiers.aliased(
        a.identifiers.escape(cteName),
        edgeWalk
      )} ${a.joins.inner(
        this.table(model, edgeChild),
        sameRow(edgeChild, childColumns.map(edgeColumn))
      )}`,
      orderBy: sql.join(
        [
          ...parentColumns.map((name) => a.orderBy.asc(edgeColumn(name))),
          ...(siblingOrder ? [siblingOrder] : []),
        ],
        ", "
      ),
      // MySQL otherwise merges the derived page into the aggregate reader and
      // drops its ORDER BY. The adapter's unbounded LIMIT prevents that merge.
      limit: a.noLimitValue,
    });
    const edgePageAlias = this.alias();
    const edges = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.json.agg(
          a.json.document(a.identifiers.column(edgePageAlias, edgeCarrierName))
        ),
        from: a.subqueries.correlate(edgePage, edgePageAlias),
      })
    );

    const carrier = (nodeFacts: Sql, edgeFacts: Sql) =>
      a.json.object([
        [
          RECURSIVE_CARRIER.root,
          this.recursiveIdentity(model, rawIdentity(parentAlias)),
        ],
        [RECURSIVE_CARRIER.nodes, a.json.document(nodeFacts)],
        [RECURSIVE_CARRIER.edges, a.json.document(edgeFacts)],
      ]);
    const cte = a.cte.recursive(cteName, anchor, recursive, "distinct");
    if (!a.capabilities.supportsLateralJoins)
      return a.subqueries.scalar(
        sql`${cte} ${a.clauses.select(carrier(nodes, edges))}`
      );
    // MySQL materializes a correlated recursive CTE that is read twice (the
    // nodes and the edges) once for the whole statement and hands every outer
    // row the first row's facts. A lateral derived table is re-evaluated per
    // outer row by definition, so the CTE and both readers live inside one
    // wherever the provider spells LATERAL (PostgreSQL, MySQL); SQLite, which
    // has no LATERAL, evaluates the correlated CTE per row as written above.
    const one = this.alias();
    const facts = this.alias();
    const nodeFacts = `__${scope}_nodes`;
    const edgeFacts = `__${scope}_edges`;
    return a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: carrier(
          a.identifiers.column(facts, nodeFacts),
          a.identifiers.column(facts, edgeFacts)
        ),
        from: a.subqueries.correlate(a.clauses.select(sql`1`), one),
        joins: [
          a.joins.lateral(
            sql`${cte} ${a.clauses.select(
              sql.join(
                [
                  a.identifiers.aliased(nodes, nodeFacts),
                  a.identifiers.aliased(edges, edgeFacts),
                ],
                ", "
              )
            )}`,
            facts
          ),
        ],
      })
    );
  }
  grouped(model: AnyModel, args: Arguments): Query {
    const a = this.adapter;
    const alias = this.rootAlias();
    // The ONE `by` authority. Admission normalises `by` to an array and
    // refuses its duplicates; the grouped read computes the grouped column SET
    // once and hands it to the two owners that have to know it — `having` and
    // the grouped `orderBy` — instead of each re-reading `args`.
    const by = args.by!;
    const grouped: ReadonlySet<string> = new Set(by);
    const aggregates = this.prepareAggregates(model, args);
    const fields: Record<string, Shape | Leaf> = {};
    const columns: Sql[] = by.map((field) => {
      fields[field] = this.scalarShape(model, field);
      return a.identifiers.aliased(
        this.projectedColumn(model, field, alias),
        field
      );
    });
    for (const [name, expression] of aggregates.columns(alias)) {
      fields[name] = aggregates.fields_[name]!;
      columns.push(a.identifiers.aliased(expression, name));
    }
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: this.table(model, alias),
        where: this.lowerWhere(model, args.where, alias),
        groupBy: sql.join(
          by.map((field) => this.column(model, field, alias)),
          ", "
        ),
        having: args.having
          ? this.lowerPredicate(
              this.prepareHaving(model, record(args.having), grouped),
              alias
            )
          : undefined,
        orderBy: this.lowerOrder(
          this.groupOrderTerms(model, args.orderBy, alias, grouped)
        ),
        limit: args.take === undefined ? undefined : this.value(args.take),
        offset: args.skip === undefined ? undefined : this.value(args.skip),
      }),
      shape: { kind: "object", fields },
    };
  }
  /** `having` is the same predicate vocabulary over aggregate targets. */
  private prepareHaving(
    model: AnyModel,
    having: Input,
    grouped: ReadonlySet<string>
  ): PreparedPredicate {
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(having).flatMap(([key, value]) => {
          if (value === undefined) return [];
          // Prisma negates each NOT arm and conjoins the negations.
          if (this.combinator(model, key))
            return [
              this.combine(
                key,
                entries(value).map((clause) =>
                  this.prepareHaving(model, record(clause), grouped)
                )
              ),
            ];
          const scalar = Object.freeze({
            model,
            field: key,
            physical: physicalField(this.schema, model, key),
          });
          const filter = record(value);
          const aggregated = AGGREGATES.filter(
            (name) => filter[name] !== undefined
          );
          if (aggregated.length === 0) {
            // A field-keyed condition names ONE row's column, and a grouped
            // read has one row per group: the column exists only where it is
            // a grouped column. An aggregate condition is always legitimate.
            if (!grouped.has(key))
              throw new QueryEngineError(
                `Scalar '${key}' used in 'having' must be included in 'by'.`
              );
            return [
              this.prepareOperations(
                Object.freeze({ kind: "column", scalar }),
                value
              ),
            ];
          }
          return aggregated.map((aggregate) =>
            this.prepareOperations(
              Object.freeze({ kind: "aggregate", aggregate, scalar }),
              filter[aggregate]
            )
          );
        })
      ),
    });
  }
  /** A grouped read orders by a grouped field or by an aggregate. */
  private groupOrderTerms(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string,
    grouped: ReadonlySet<string>
  ): OrderTerm[] {
    if (!input) return [];
    return entries(input).flatMap((order) =>
      Object.entries(order).flatMap(([name, direction]) => {
        if (direction === undefined) return [];
        if (!isAggregate(name)) {
          if (!grouped.has(name))
            throw new QueryEngineError(
              `GroupBy orderBy field '${name}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max).`
            );
          return [this.orderTerm(model, name, direction, alias)];
        }
        return Object.entries(record(direction)).map(([field, sort]) =>
          this.sortKey(
            this.aggregateExpression(
              name,
              field === "_all"
                ? undefined
                : Object.freeze({
                    model,
                    field,
                    physical: physicalField(this.schema, model, field),
                  }),
              alias
            ),
            sort === "desc",
            undefined,
            false
          )
        );
      })
    );
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
        "Raptor 3 createMany final read returned inconsistent row counts."
      );
  }
  decodeQuery(query: Query, rows: Input[], internal = false): Input[] {
    this.assertExpectedRows(query, rows.length);
    return this.decodeProjection(query.shape, rows, internal);
  }
  decodeProjection(
    shape: ProjectionShape,
    rows: Input[],
    internal = false
  ): Input[] {
    // An empty batch — a filter that matched nothing — reads nothing, so it
    // compiles nothing.
    if (rows.length === 0) return [];
    const read = this.compileReader(shape, internal, false);
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
      const entry = Object.freeze({
        child,
        ...(depth === undefined ? {} : { depth }),
      });
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
    const collapse = (rows: Input[]): unknown => {
      if (rows.length > 0) return shape.many ? rows : rows[0]!;
      assertInvariant(
        shape.many || shape.optional,
        "A singular recursive slot may be empty: CM002 refuses a required self foreign key."
      );
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
    const follow = (from: number, key: string): void => {
      if (active.has(key)) {
        if (shape.recurrence.cycles === "reject")
          throw new QueryEngineError(
            `Recursive relation '${shape.relation}' contains a cycle.`
          );
        if (shape.recurrence.cycles === "prevent") return;
      }
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
   * slot's arms, a collection's and a recursive carrier's row reader, and —
   * for a PHYSICAL scalar slot only — this execution's provider continuation
   * ({@link fieldReader}). The returned reader then does only what depends on
   * the provider's value, through the one scalar decoder
   * ({@link decodeScalar}) and the one carrier validator
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
    carried: boolean
  ): Reader {
    if (shape.kind === "scalar") {
      const provider = carried ? undefined : this.fieldReader(shape.type);
      return (value) => this.decodeScalar(shape, value, internal, provider);
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
      // Its arms, compiled once, in `shape.arms` order.
      const arms = Object.entries(shape.arms).map(([type, arm]) => ({
        type,
        arm,
        read: this.compileReader(arm, internal, true),
      }));
      return (value) => {
        // The slot is read by own key WITHOUT {@link providerDocument}'s
        // rule: the statement always builds it, and a NULL slot escapes as
        // the raw `TypeError` of `Object.hasOwn`.
        // `tests/raptor3/result-decoder.test.ts` pins that published failure;
        // applying the document rule here changes it, which needs a ruling
        // rather than a refactor.
        const variants = record(providerJson(value));
        // The integrity probe first, and before any arm: a membership whose
        // row is gone is a fact about the SLOT, so `only` — which selects what
        // is read — cannot make it unobservable (Arnaud's D-26). One refusal,
        // from the decoder arm that already owns the sentence.
        const orphans = own(variants, POLYMORPHIC_COLLECTION_ORPHANS_KEY);
        if (orphans !== null && typeof orphans === "object")
          for (const [type, count] of Object.entries(orphans))
            if (Number(count) > 0)
              throw new QueryEngineError(
                `Polymorphic relation '${shape.relation}' references a missing '${type}' record.`
              );
        const values: unknown[] = [];
        for (const { type, arm, read } of arms) {
          const carrier = own(variants, type);
          if (orphanedArm(carrier, arm))
            throw new QueryEngineError(
              `Polymorphic relation '${shape.relation}' references a missing '${type}' record.`
            );
          const rows = read(carrier);
          if (shape.many) {
            for (const data of rows as unknown[]) values.push({ type, data });
          } else if (rows !== null) return { type, data: rows };
        }
        return shape.many ? values : null;
      };
    }
    if (shape.kind === "collection") {
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
    // The document's MEMBER LIST is a fact of the PREPARED PROJECTION, stated
    // once by {@link prepareProjection} and frozen on the shape; a row carries
    // only the values for it. It is read here, once per batch — the shape's
    // OWN keys, exactly as {@link own} reads the provider's — and never again
    // per row: materialising it per row as pairs (`Object.entries` read back
    // by `Object.fromEntries`) made this decoder allocate 2.5x the shipped
    // engine's bytes per row (`g4/release/p1/note.md`).
    const members = Object.entries(shape.fields).map(([field, nested]) => ({
      field,
      read: this.compileReader(
        nested,
        internal,
        carried || nested.kind !== "scalar"
      ),
    }));
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
      // instead of failing closed. The write is a plain assignment because
      // the destination key is a schema identifier — `schema/identifier.ts`
      // refuses every `Object.prototype` own name, `__proto__` among them, at
      // hydration — or one of this engine's own carrier names, which is the
      // same write the shape owners take to build `fields`.
      const document: Input = {};
      for (const { field, read } of members)
        document[field] = read(own(source, field));
      return document;
    };
  }
  /**
   * One strict scalar decode per leaf, through the existing codec owners. A
   * value outside the column's declared domain is a malformed provider row,
   * never a value to coerce. `provider` is the physical value's continuation;
   * a CARRIED value — one a JSON document already holds — has none.
   */
  private decodeScalar(
    leaf: Leaf,
    raw: unknown,
    internal: boolean,
    provider?: FieldReader
  ): unknown {
    // The SQL NULL and the absent column are facts about the ROW, answered
    // before any representation rule: a provider that decodes `'null'` into
    // the JSON null document has produced a VALUE, and asking the null
    // question after the chain would refuse it on a NOT NULL json column.
    //
    // A json DOCUMENT is the one domain whose values include a null, and two
    // of the three drivers parse the column themselves (`pg` and `mysql2` hand
    // back the JS null for the stored `null` document; SQLite hands the text
    // `'null'` and reaches the chain below). The COLUMN's own nullability is
    // what tells the two apart there, and it is already on the leaf: a NOT NULL
    // json column cannot hold the SQL NULL, so this null is the document
    // `JsonNull` wrote. It continues through the same chain as every other json
    // value, so a declared output schema still sees it.
    if (raw === null) {
      if (leaf.nullable) return null;
      if (!(leaf.type === "json" && leaf.list !== true))
        throw new InvalidScalarResult(
          leaf.type,
          leaf.list ? "a required list is null" : "a required scalar is null"
        );
    }
    if (raw === undefined)
      throw new InvalidScalarResult(leaf.type, "the value is absent");
    // A carried value came out of a JSON document the provider already
    // decoded; asking the transport about it a second time is what turned
    // `"just a json string"` into a `SyntaxError`.
    const value = provider === undefined ? raw : provider(raw);
    if (leaf.list) return this.decodeList(leaf, value, internal);
    // An identifier column hands back its PHYSICAL value — bytes, their hex
    // transport, a `uuid`'s text, or the stored text — and the codec turns it
    // into the canonical PUBLIC string, prefix re-applied. A TEXT column's
    // physical value is the spelling itself, so an INTERNAL read keeps the
    // bytes the row holds (a captured identity must address its own row) while
    // a public one canonicalizes — the split the datetime arm below takes.
    if (leaf.id !== undefined) {
      const decoded = decodeIdentifier(leaf.id, value);
      if (decoded === undefined)
        throw new InvalidScalarResult(
          leaf.type,
          "the value is not in this column's declared identifier domain"
        );
      return internal && leaf.id.representation === "text" ? value : decoded;
    }
    switch (leaf.type) {
      case "string":
        if (typeof value === "string") return value;
        throw new InvalidScalarResult(leaf.type, "the value is not a string");
      case "boolean":
        if (typeof value === "boolean") return value;
        if (value === 0 || value === 0n) return false;
        if (value === 1 || value === 1n) return true;
        throw new InvalidScalarResult(
          leaf.type,
          "the value is not true, false, zero, or one"
        );
      case "int": {
        const parsed =
          typeof value === "bigint"
            ? Number(value)
            : typeof value === "string" && INTEGER_TEXT.test(value)
              ? Number(value)
              : value;
        if (typeof parsed !== "number")
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not a canonical integer"
          );
        if (!Number.isSafeInteger(parsed))
          throw new InvalidScalarResult(
            leaf.type,
            "the integer is outside the safe range"
          );
        return parsed;
      }
      case "bigint":
        if (typeof value === "bigint") return value;
        if (typeof value === "number" && Number.isSafeInteger(value))
          return BigInt(value);
        if (typeof value === "string" && INTEGER_TEXT.test(value))
          return BigInt(value);
        throw new InvalidScalarResult(
          leaf.type,
          "the value is not a canonical integer"
        );
      case "number": {
        const parsed =
          typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : value;
        if (typeof parsed !== "number" || !Number.isFinite(parsed))
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not a canonical finite number"
          );
        return parsed;
      }
      case "decimal": {
        const decoded = decodeDecimalScalar(
          value,
          leaf.decimal!,
          leaf.widened === true,
          internal,
          this.adapter.result
        );
        if (decoded === undefined)
          throw new InvalidScalarResult(
            leaf.type,
            leaf.widened
              ? "the sum is not an exact decimal at this column's scale"
              : "the value is not an exact decimal in this column's declared domain"
          );
        return decoded;
      }
      case "datetime": {
        if (leaf.dateTime !== undefined && leaf.dateTime !== "text") {
          const decoded = decodePhysicalDateTime(value, leaf.dateTime);
          if (decoded === undefined)
            throw new InvalidScalarResult(
              leaf.type,
              "the value is not this column's declared physical timestamp"
            );
          return decoded;
        }
        if (value instanceof Date) {
          if (isDateTimeInstant(value.getTime()))
            return new Date(value.getTime());
          throw new InvalidScalarResult(
            leaf.type,
            "the Date is outside the public DateTime domain"
          );
        }
        const parsed =
          typeof value === "string" ? providerTimestamp(value) : undefined;
        if (!parsed)
          throw new InvalidScalarResult(
            leaf.type,
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
      }
      case "date": {
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
          throw new InvalidScalarResult(
            leaf.type,
            "the Date is invalid or not UTC midnight"
          );
        }
        const match = typeof value === "string" ? DATE_TEXT.exec(value) : null;
        if (
          !(
            match &&
            isGregorianCalendarDate(
              Number(match[1]),
              Number(match[2]),
              Number(match[3])
            )
          )
        )
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not a valid ISO calendar date"
          );
        return new Date(`${value as string}T00:00:00.000Z`);
      }
      case "time":
        return decodeTime(value);
      case "enum":
        if (typeof value === "string" && leaf.enumValues?.has(value) === true)
          return value;
        throw new InvalidScalarResult(
          leaf.type,
          "the value is not a declared enum member"
        );
      case "json": {
        const document = this.jsonValue(value);
        return leaf.jsonSchema === undefined
          ? document
          : this.jsonValue(this.schemaValue(leaf.jsonSchema, document));
      }
      case "blob":
        return decodeBlob(value);
      case "vector": {
        const decoded = typeof value === "string" ? JSON.parse(value) : value;
        if (
          !Array.isArray(decoded) ||
          decoded.some(
            (member) => typeof member !== "number" || !Number.isFinite(member)
          )
        )
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not an array of finite numbers"
          );
        if (leaf.dimension !== undefined && decoded.length !== leaf.dimension)
          throw new InvalidScalarResult(
            leaf.type,
            `the value does not have the configured dimension ${leaf.dimension}`
          );
        return [...decoded];
      }
      case "point": {
        const decoded = typeof value === "string" ? JSON.parse(value) : value;
        const point = validateGeoPoint(decoded);
        if (point.issues)
          throw new InvalidScalarResult(
            leaf.type,
            point.issues[0]?.message ?? "the value is not a canonical GeoPoint"
          );
        return point.value;
      }
      default:
        throw new InvalidScalarResult(
          leaf.type,
          "the scalar type is unsupported"
        );
    }
  }
  /** One list container, then each member through the element's own codec. */
  private decodeList(leaf: Leaf, value: unknown, internal: boolean): unknown[] {
    if (leaf.type === "decimal") {
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
    }
    let items: unknown = value;
    if (typeof items === "string")
      items =
        leaf.type === "enum" &&
        this.adapter.result.enumListRepresentation === "arrayText"
          ? providerArrayMembers(items)
          : JSON.parse(items);
    if (!Array.isArray(items))
      throw new InvalidScalarResult(
        leaf.type,
        "a list scalar did not return an array"
      );
    const member: Leaf = Object.freeze({
      ...leaf,
      list: undefined,
      nullable: false,
    });
    return items.map((item, index) => {
      if (!Object.hasOwn(items as unknown[], index))
        throw new InvalidScalarResult(
          leaf.type,
          "a list scalar returned a sparse array"
        );
      return this.decodeScalar(member, item, internal);
    });
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
  private jsonValue(value: unknown, enclosing?: Set<object>): unknown {
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
      if (Number.isSafeInteger(parsed)) return parsed;
      throw new InvalidScalarResult(
        "json",
        "a JSON integer is outside the safe range"
      );
    }
    if (Array.isArray(value)) {
      const path = this.enterJsonContainer(value, enclosing);
      const members = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new InvalidScalarResult("json", "a JSON array is sparse");
        members[index] = this.jsonValue(value[index], path);
      }
      path.delete(value);
      return members;
    }
    if (isPlainJsonRecord(value)) {
      const path = this.enterJsonContainer(value, enclosing);
      const members: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(value))
        Object.defineProperty(members, key, {
          configurable: true,
          enumerable: true,
          value: this.jsonValue(member, path),
          writable: true,
        });
      path.delete(value);
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
   * inside itself, which no JSON document is.
   */
  private enterJsonContainer(
    container: object,
    enclosing: Set<object> | undefined
  ): Set<object> {
    const path = enclosing ?? new Set<object>();
    if (path.has(container))
      throw new InvalidScalarResult("json", "a JSON value contains itself");
    path.add(container);
    return path;
  }
  /**
   * The field's own output schema, run at that same boundary (Arnaud's D-33).
   *
   * `s.json().schema(…)` is a Standard Schema the CALLER wrote, and the engine
   * replaced ran it on every read of the field
   * (`result/scalar-structured-parser.ts:78`). Restored here, at the one decode
   * boundary, so every provider and every route answers the same way — and
   * once per VALUE, never per member of it, because {@link jsonValue} is what
   * descends.
   *
   * The engine is only the caller. `parse` is the estate's one owner of the
   * invocation protocol — it refuses an asynchronous schema, catches one that
   * throws, and refuses a malformed result — and the schema owns whether the
   * document is admissible; the decoder inspects no issue and re-implements no
   * validation. The refusal carries the registered sentence and NO issue
   * detail: those messages describe a STORED document, which is not the
   * caller's to read (the deleted `scalar-result-contracts.core.test.ts` ›
   * "redacts custom JSON validation details").
   */
  private schemaValue(schema: StandardSchemaV1, document: unknown): unknown {
    const validated = parse(schema, document);
    if (validated.issues)
      throw new InvalidScalarResult(
        "json",
        "custom output schema rejected the value"
      );
    return validated.value;
  }
}

/** A document, not a class instance: the shipped JSON record test. */
function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/;
const ZONELESS_TIMESTAMP_TEXT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const TIME_TEXT =
  /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;
const TIME_ZONE_SUFFIX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const TRAILING_FRACTION_ZEROS = /\.?0+$/;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64_PROVIDER = /^base64:type\d+:(.*)$/;

/** The provider timestamp grammar; the domain rules are the codec's. */
function providerTimestamp(value: string): Date | undefined {
  const match = TIMESTAMP_TEXT.exec(value);
  if (!match) return undefined;
  if (
    !(
      isGregorianCalendarDate(
        Number(match[1]),
        Number(match[2]),
        Number(match[3])
      ) && isDateTimeClock(Number(match[4]), Number(match[5]), Number(match[6]))
    )
  )
    return undefined;
  const zoned = match[8] !== undefined || match[9] !== undefined;
  if (value[10] === " " && zoned) return undefined;
  if (Number(match[10] ?? 0) > 23 || Number(match[11] ?? 0) > 59)
    return undefined;
  const parsed = ZONELESS_TIMESTAMP_TEXT.test(value)
    ? new Date(`${value.replace(" ", "T")}Z`)
    : new Date(value);
  return isDateTimeInstant(parsed.getTime()) ? parsed : undefined;
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

/** Every driver's binary spelling, normalized to one fresh Uint8Array. */
function decodeBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "string") {
    const provider = BASE64_PROVIDER.exec(value);
    if (provider) return base64Bytes(provider[1]!);
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    if (HEX_BYTES.test(hex)) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      return bytes;
    }
    return base64Bytes(value);
  }
  throw new InvalidScalarResult("blob", "the value is not a binary value");
}

function base64Bytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new InvalidScalarResult("blob", "the value is not a binary value");
  }
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
