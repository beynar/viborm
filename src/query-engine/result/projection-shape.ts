import type { Scalar } from "@schema/scalars/base";
import type { DateTimePhysicalForm } from "@validation/primitives/datetime-physical-codec";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import type { NormalizedRecurrence } from "@validation/relations/recurrence-values";
import type { IdentifierColumn } from "../raptor3/shared/identifier";

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
  /**
   * A `_sum` answering outside the field's domain: a decimal keeps the field
   * scale and drops its precision, a bigint may leave the int64 range, a
   * number may be `±Infinity`, and an int past 2^53 is the nearest double, as
   * a number sum is; `#splitSum` states which travel as two parts.
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
  enumValues?: readonly string[];
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
/** One read-gated member of a document: its gate, and the path a caller named it at. */
export interface GatedMember {
  readonly gate: string;
  readonly refused?: string;
}
/** A to-many relation's rows. */
export type CollectionShape = {
  kind: "collection";
  /** A negative `take` runs a reversed window; the decoder restores it. */
  reversed?: boolean;
  row: ProjectionShape;
};

/**
 * The private recursive carrier's member names, stated once: the one wire
 * vocabulary the recursive lowering writes and `decodeRecursiveCarrier` reads.
 */
export const RECURSIVE_CARRIER = Object.freeze({
  root: "__rq_root",
  nodes: "__rq_nodes",
  edges: "__rq_edges",
  key: "__rq_key",
  row: "__rq_row",
  parent: "__rq_parent",
  child: "__rq_child",
  depth: "__rq_depth",
});
