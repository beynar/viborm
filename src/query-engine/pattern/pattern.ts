/**
 * K1 — the pattern contract (pattern-engine-ideal-state.md §2, §13.2).
 *
 * A database is a partial function `cell → value`. A pattern is a finite set of
 * rows and cells whose values are literals or variables, used in one of three
 * modes — match, assert, retract — and composed in exactly one way: extending
 * along a reference. There is no verb, no storage kind, no substrate, and no
 * phase in this file. Those are, respectively, the sugar table (`sugar.ts`),
 * the cell map (`cells.ts`), the executors (`execute/`), and the scheduler
 * (`schedule.ts`).
 *
 * This module is a value type: it imports nothing from the engine. Validation
 * may construct it; the engine consumes it.
 */
import type { Model } from "@schema/model";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Pattern-local row identity. Allocated in payload order at construction. */
export type RowId = number;

/** Pattern-local variable identity. Allocated in payload order; bound once (D4). */
export type VariableId = number;

/** Pattern-local arm identity for a merge's two branches. */
export type ArmId = number;

export interface TableRef {
  readonly model: Model<any>;
  /** Physical table name, namespace-free; the adapter qualifies it. */
  readonly table: string;
}

// ---------------------------------------------------------------------------
// Variables and bindings (D4 — single assignment)
// ---------------------------------------------------------------------------

/**
 * How a variable receives its one value. `matched` and `returned` are bound by
 * the database; the scheduler orders their consumers after the statement that
 * binds them. `generated` is materialized once per fragment, when the fragment
 * opens, so that client-side defaults differ per bulk member (§5 rule 1).
 */
export type Binding =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "generated"; readonly materialize: () => unknown }
  | {
      /** Bound by a match on `row` reading `column`. */
      readonly kind: "matched";
      readonly row: RowId;
      readonly column: string;
    }
  | {
      /**
       * Bound by the database when `row` is asserted (a generated key or any
       * database-assigned column). Whether the asserting statement can return it
       * in place is a substrate fact (`bindsGeneratedKey`); if it cannot, the
       * scheduler opens a fragment after that statement (§6.3).
       */
      readonly kind: "returned";
      readonly row: RowId;
      readonly column: string;
    };

export interface Variable {
  readonly id: VariableId;
  readonly binding: Binding;
  /**
   * The scalar the value belongs to, when known: decides destination casts and
   * decoding. `undefined` for a discriminator or a junction column whose type
   * the cell map resolves later.
   */
  readonly scalar?: { readonly model: Model<any>; readonly field: string };
}

// ---------------------------------------------------------------------------
// Rows and cells (D1, D2)
// ---------------------------------------------------------------------------

export type Mode = "match" | "assert" | "retract";

/**
 * A row of the pattern. `key` is the row's key as it stands when the fragment
 * opens: literals for a selected row, `returned` variables for a fresh row,
 * `matched` variables for a row located by a match. `newKey` is present only
 * when the pattern asserts a key change; every cell that must carry the new key
 * references a `newKey` variable (k′) and every match that must observe the old
 * key references `key` (k). That is the whole of "old-read / new-write".
 */
export interface Row {
  readonly id: RowId;
  readonly table: TableRef;
  readonly mode: Mode;
  /** `one`: exactly one row. `set`: every row matching `predicate` (bulk forms). */
  readonly cardinality: "one" | "set";
  readonly key: readonly Variable[];
  readonly newKey?: readonly Variable[];
  /** A row asserted at a fresh key is an INSERT; a bound key is an UPDATE. */
  readonly fresh: boolean;
  /**
   * Which arm this row belongs to, when it is inside a merge. Rows outside any
   * arm are unconditional. Both arms are present in the pattern (§5 rule 2);
   * only the taken arm's asserts and retracts are packed.
   */
  readonly arm?: ArmId;
  /** Match-mode predicate on this row (the `where` tree), when any. */
  readonly predicate?: Predicate;
  /**
   * `matchIsDecision`: a match whose result selects an arm. Decision matches
   * state a premise and lock where the substrate supports it (ATOM §11); plain
   * matches (a `select`) do not.
   */
  readonly matchIsDecision?: boolean;
}

/**
 * A cell in a row. In match mode the cell's value is expected (a scalar
 * equality or the bound variable); in assert mode it is made so; in retract
 * mode the cell is cleared (a nullable reference) — retracting a whole row is
 * `Row.mode === "retract"`.
 */
export interface Cell {
  readonly row: RowId;
  readonly column: string;
  readonly value: Variable;
  readonly mode: Mode;
  /**
   * Relative assignments (`increment`, `push`, …) are assert cells whose value
   * is a function of the current cell; the packer spells them through the
   * adapter's set vocabulary and the agreement rule treats them as opaque.
   */
  readonly relative?: {
    readonly operation: string;
    readonly operand: Variable;
  };
}

// ---------------------------------------------------------------------------
// References (the one composition — D2)
// ---------------------------------------------------------------------------

/**
 * A reference from `holder` to `referenced`: the holder's listed columns hold
 * the referenced row's key. A junction is a `holder` row of its own (a fresh
 * key whose only cells are two references). A discriminator is a cell on the
 * holder whose value selects `referenced.table` — it is listed here so the
 * scheduler knows the reference is complete only when both are bound.
 */
export interface Reference {
  readonly holder: RowId;
  readonly referenced: RowId;
  readonly columns: readonly {
    readonly holderColumn: string;
    readonly referencedColumn: string;
  }[];
  readonly discriminator?: {
    readonly column: string;
    readonly value: Variable;
  };
  /**
   * Referential action on the referenced key changing. `cascade` means the
   * database rebinds the holder's cells itself (the scheduler models it as a
   * pseudo-statement, §6.2). Anything else makes an unre-asserted reference to
   * the old key an occupied slot.
   */
  readonly onKeyChange: "cascade" | "restrict" | "setNull" | "none";
  /** May the holder's reference cells be cleared (retract without deleting the holder). */
  readonly nullable: boolean;
  /** Cardinality one: at most one holder per referenced key on these columns. */
  readonly unique: boolean;
  /** The public relation this reference realizes, for error attribution and step labels. */
  readonly relation: { readonly model: Model<any>; readonly field: string };
}

// ---------------------------------------------------------------------------
// Arms (merge)
// ---------------------------------------------------------------------------

/**
 * A merge has two arms decided by whether `decision` matched a row. Both arms'
 * rows and cells are in the pattern; the scheduler runs both arms' matches
 * (the planning superset), and packs only the taken arm.
 */
export interface Arm {
  readonly id: ArmId;
  readonly decision: RowId;
  readonly taken: "found" | "missing";
}

// ---------------------------------------------------------------------------
// Predicates (match mode)
// ---------------------------------------------------------------------------

/**
 * The `where` tree. Scalar leaves carry the public operator and operand; the
 * packer spells them through the adapter's filter vocabulary. A `relation`
 * leaf quantifies a sub-pattern in match mode under EXISTS / NOT EXISTS.
 */
export type Predicate =
  | {
      readonly kind: "scalar";
      readonly column: string;
      readonly operator: string;
      readonly operand: Variable | readonly Variable[];
      readonly mode?: "default" | "insensitive";
    }
  | { readonly kind: "and"; readonly items: readonly Predicate[] }
  | { readonly kind: "or"; readonly items: readonly Predicate[] }
  | { readonly kind: "not"; readonly item: Predicate }
  | {
      readonly kind: "relation";
      readonly quantifier: "some" | "every" | "none" | "is" | "isNot";
      readonly extension: Extension;
      readonly inner?: Predicate;
    }
  | {
      /** A distance / geo / JSON-path leaf: structural decision here, spelling in the adapter. */
      readonly kind: "structural";
      readonly column: string;
      readonly form: string;
      readonly operands: readonly Variable[];
    };

// ---------------------------------------------------------------------------
// Extensions (match mode composition)
// ---------------------------------------------------------------------------

/**
 * Extending a pattern along a reference in match mode: an `include`, a relation
 * filter, a `_count`, a relation-aggregate order. The sub-pattern is rooted at
 * `target` and correlated through `reference`.
 */
export interface Extension {
  readonly reference: Reference;
  readonly target: Pattern;
}

// ---------------------------------------------------------------------------
// Projection and window (match mode output)
// ---------------------------------------------------------------------------

export interface Window {
  readonly orderBy: readonly OrderTerm[];
  readonly take?: number;
  readonly skip?: number;
  readonly cursor?: { readonly key: readonly Variable[] };
  readonly distinct?: readonly string[];
}

export type OrderTerm =
  | {
      readonly kind: "scalar";
      readonly column: string;
      readonly direction: "asc" | "desc";
      readonly nulls?: "first" | "last";
    }
  | {
      readonly kind: "relationAggregate";
      readonly extension: Extension;
      readonly aggregate: "count";
      readonly direction: "asc" | "desc";
    };

/**
 * What a match emits: the expected result shape IS the projection, so decoding
 * walks this and nothing else (§9.2).
 */
export interface Projection {
  readonly scalars: readonly string[];
  readonly relations: readonly {
    readonly field: string;
    readonly extension: Extension;
    readonly cardinality: "one" | "many";
  }[];
  readonly relationCounts: readonly {
    readonly field: string;
    readonly extension: Extension;
  }[];
  readonly aggregates?: readonly {
    readonly kind: "count" | "avg" | "sum" | "min" | "max";
    readonly column?: string;
  }[];
  readonly groupBy?: readonly string[];
  readonly having?: Predicate;
  readonly window?: Window;
  readonly computed?: readonly {
    readonly name: string;
    readonly form: string;
    readonly operands: readonly Variable[];
  }[];
}

// ---------------------------------------------------------------------------
// The pattern
// ---------------------------------------------------------------------------

export interface Pattern {
  readonly root: RowId;
  readonly rows: readonly Row[];
  readonly cells: readonly Cell[];
  readonly references: readonly Reference[];
  readonly arms: readonly Arm[];
  readonly variables: readonly Variable[];
  /** Present when the pattern is (or ends in) a match with an output shape. */
  readonly projection?: Projection;
  /**
   * Public operation name, for attribution, terminal-result cardinality and
   * error messages. Never a discriminant inside the engine.
   */
  readonly operation: string;
}
