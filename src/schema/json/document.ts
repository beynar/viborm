// The JSON schema document format.
//
// This file is the FORMAT: the declaration-state algebra spelled as data, with
// model-key strings where a coded schema writes a getter. Nothing here decides
// anything — `read.ts` owns whether a value has this shape, `interpret.ts` owns
// what the builders make of it, and `serialize.ts` owns the reverse direction.
// One type serves all three, so the format has exactly one definition.

import type { IndexType } from "@schema/model/model";
import type {
  JunctionReferentialAction,
  ReferentialAction,
} from "@schema/relation/types";
import type { AutoGenerateType, ScalarType } from "@schema/scalars/common";
import type { NativeType } from "@schema/scalars/native-types";
import type { JsonValue } from "@validation/primitives/json";

/**
 * The only supported document version.
 *
 * An unknown version is refused by name rather than tolerated: a document key
 * never changes meaning across versions, so evolution adds keys and a parser
 * that cannot read a version cannot guess at it either.
 */
export const SCHEMA_DOCUMENT_VERSION = 1;

/** A schema stated as data. `parseSchema` reads it; `serializeSchema` writes it. */
export interface SchemaDocument {
  version: typeof SCHEMA_DOCUMENT_VERSION;
  /**
   * Enum definitions addressable by a document-local reference. A definition
   * carrying `name` yields ONE database enum type shared by every field that
   * references it; without `name` each column keeps its own derived type,
   * exactly as an inline `"enum": ["a", "b"]` does.
   *
   * The KEY is that reference and must be a schema identifier; the database's
   * own type name lives in `name` alone, and may be anything the database
   * allows.
   */
  enums?: Record<string, EnumDocument>;
  models: Record<string, ModelDocument>;
}

export interface EnumDocument {
  values: string[];
  /**
   * The database enum type name — `.name()`. Not the reference key: a database
   * identifier is not a schema identifier, so the canonical document uses the
   * name as its key only when it already passes that grammar and derives
   * `enum_1`, `enum_2` … by declaration order otherwise.
   */
  name?: string;
}

/**
 * One model. Field ORDER is a declaration fact: DDL column order follows it,
 * and the format binds it to JSON key order — stable under `JSON.parse`, and
 * destroyed by a producer that sorts keys.
 */
export interface ModelDocument {
  /** `.map(tableName)`. */
  table?: string;
  fields: Record<string, FieldDocument>;
  indexes?: IndexDocument[];
  /** Compound `.id(fields, { name })` calls, in declaration order. */
  ids?: CompoundKeyDocument[];
  /** Compound `.unique(fields, { name })` calls, in declaration order. */
  uniques?: CompoundKeyDocument[];
  /** `.omit({ ... })` as a sorted array of scalar field keys. */
  omit?: string[];
}

/**
 * `.index(fields, options)` with its options flattened onto the node.
 *
 * `where` has no spelling: it is the declaration surface's one raw-SQL string,
 * interpolated unescaped into DDL, and a machine-written document is exactly
 * the place that must not carry an execution channel. It returns when a
 * structured predicate form exists.
 */
export interface IndexDocument {
  fields: string[];
  name?: string;
  unique?: boolean;
  type?: IndexType;
}

export interface CompoundKeyDocument {
  fields: string[];
  name?: string;
}

export type FieldDocument = ScalarFieldDocument | RelationFieldDocument;

/**
 * Which arm of the field union a node is. `type` carries both vocabularies —
 * the two cardinalities and the fourteen scalar types — so one read decides it.
 */
export function isRelationField(
  field: FieldDocument
): field is RelationFieldDocument {
  return field.type === "toOne" || field.type === "toMany";
}

/**
 * One scalar field: its type plus every chainable modifier as an explicit key.
 *
 * Common chainable modifiers stay flat. Factory arguments are discriminated:
 * ordinary/enum fields may carry `native`, while a decimal must carry
 * `precision` and `scale` and cannot carry `native`. A document declaration is
 * never accepted by one arm and then silently ignored by its factory.
 */
export type ScalarFieldDocument =
  | ValueFieldDocument
  | DecimalFieldDocument
  | EnumFieldDocument;

interface ScalarFieldModifiers {
  nullable?: boolean;
  array?: boolean;
  id?: boolean;
  unique?: boolean;
  /** `.map(columnName)`. */
  column?: string;
  /**
   * A literal default, at any depth. Values from domains JSON cannot spell take
   * a TAG — a one-key object naming the domain: `{"$bigint": "5"}`,
   * `{"$bytes": "AQID"}`, `{"$date": "<iso>"}`, and `{"$raw": <value>}` for a
   * literal whose own shape collides with one. A bare ISO string on a temporal
   * field stays a STRING, which is a different declaration from a `Date`.
   *
   * A function default has no spelling — use `generate`, a literal, or a
   * database default through `native`.
   */
  default?: JsonValue;
  generate?: GenerateDocument;
  /** `.dimension(n)`. */
  dimension?: number;
  /** `.withoutTimezone()`. */
  withoutTimezone?: boolean;
}

interface NativeScalarFieldModifiers extends ScalarFieldModifiers {
  /**
   * The factory's sole argument — `{ db, type }`, already plain data.
   *
   * `type` is emitted into DDL verbatim, so a document may carry only a member
   * of the declared dialect's closed native-type catalog (`J011`), in both
   * directions. `native-catalog.ts` owns that set.
   */
  native?: NativeType;
  precision?: never;
  scale?: never;
}

export interface ValueFieldDocument extends NativeScalarFieldModifiers {
  type: Exclude<ScalarType, "decimal" | "enum">;
  enum?: never;
}

/** The one scalar whose factory argument is its portable value domain. */
export interface DecimalFieldDocument extends ScalarFieldModifiers {
  type: "decimal";
  precision: number;
  scale: number;
  native?: never;
  enum?: never;
}

export interface EnumFieldDocument extends NativeScalarFieldModifiers {
  type: "enum";
  /** An `enums` reference, or the values inline. */
  enum: string | string[];
}

/**
 * A generator declaration. `kind` names the scalar method that installs it, so
 * the seven tokens are the seven methods and there is no second table.
 */
export interface GenerateDocument {
  kind: AutoGenerateType;
  prefix?: string;
  length?: number;
}

/**
 * One relation slot: the cardinality its `type` was spelled with, and the
 * target domain named by `target` (one model) XOR `variants` (named variants).
 *
 * The two target domains are two arms, not two optional keys: naming both or
 * neither is not a document the format has, and the `?: never` exclusions make
 * a cross-arm key fail under structural assignment as well as at parse time.
 */
export type RelationFieldDocument = ModelTargetDocument | VariantTargetDocument;

interface RelationSlotDocument {
  type: "toOne" | "toMany";
  /** The pairing label — free-form and non-empty, not an identifier. */
  name?: string;
}

export interface ModelTargetDocument extends RelationSlotDocument {
  /** A model key. */
  target: string;
  /** `.fields(...)` — `toOne` only. */
  fields?: string[];
  /** `.references(...)` — `toOne` only. */
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  /**
   * Junction overrides for a `toMany`, nested so `target` here cannot collide
   * with the relation's own target key. At least one override, matching what
   * trusted state can hold.
   */
  junction?: JunctionDocument;
  variants?: never;
  values?: never;
  through?: never;
  optional?: never;
}

export interface VariantTargetDocument extends RelationSlotDocument {
  /** Variant key → model key. */
  variants: Record<string, string>;
  /**
   * Stored discriminator per variant. All-or-nothing: when present it is exact
   * over the variant keys, because a partial bag is refused by the factory.
   */
  values?: Record<string, string>;
  /** Per-variant member junctions — `toMany` only. */
  through?: Record<string, VariantJunctionDocument>;
  /** `.optional()` — `toOne` only. */
  optional?: boolean;
  target?: never;
  fields?: never;
  references?: never;
  onDelete?: never;
  onUpdate?: never;
  junction?: never;
}

export interface JunctionDocument {
  table?: string;
  source?: string;
  target?: string;
  onDelete?: JunctionReferentialAction;
  onUpdate?: JunctionReferentialAction;
}

export interface VariantJunctionDocument {
  table: string;
  source: string;
  target: string;
}
