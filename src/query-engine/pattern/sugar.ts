/**
 * The vocabulary table (pattern-engine-ideal-state.md §3).
 *
 * The eleven public nested verbs are ROWS OF DATA over six primitives:
 *
 *   match           bind a target row from the database (by selector, or by
 *                   membership in the parent's neighbour set along the edge)
 *   assertFresh     a target row at a fresh key (an INSERT), recursing into
 *                   its payload
 *   assertAtKey     cells on a row that already has a key — either the edge's
 *                   reference cells (X ∈ N) or the row's scalar cells
 *   retract         the edge's reference cells (X ∉ N), or the whole row
 *   merge           a decision match with a *found* arm and a *missing* arm
 *   setDifference   retract for N \ S, assert for S \ N
 *
 * This is the ONLY module in the engine where a verb name appears, and it
 * mentions cells, never columns or storage. Which cells a reference occupies is
 * `cells.ts`'s answer; how a plan turns into rows and cells is `construct.ts`'s.
 * Neither this file nor `construct.ts` may spell a storage kind — the census in
 * `tests/pattern/construct/census.core.test.ts` greps both for those words.
 *
 * The rows are listed in the ONE mutation order (ATOM §6): named readers, then
 * unbounded writers, then pure adders. `VERB_ORDER` is derived from the table,
 * never restated.
 */

import {
  relationTargetNotFound,
  upsertTargetNotFoundForParent,
} from "../write-engine/messages";

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

export type Verb =
  | "disconnect"
  | "delete"
  | "update"
  | "upsert"
  | "connectOrCreate"
  | "set"
  | "updateMany"
  | "deleteMany"
  | "connect"
  | "create"
  | "createMany";

/** ATOM §6: 1 named readers, 2 unbounded writers, 3 pure adders. */
export type Stage = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Primitives (the six)
// ---------------------------------------------------------------------------

export type Primitive =
  | "match"
  | "assertFresh"
  | "assertAtKey"
  | "retract"
  | "merge"
  | "setDifference";

/**
 * One instruction of a verb's plan. Every field is a fact about the PATTERN
 * (what is matched, what is asserted, on which rows), never about storage.
 */
export type Step =
  | {
      readonly primitive: "match";
      /**
       * `selector`: the item names one row by a unique selector; `membership`:
       * the row is one of the parent's neighbours along the edge (and the item's
       * selector or filter, when present, narrows it further).
       */
      readonly locate: "selector" | "membership";
      /** Whether the match's outcome selects an arm (a merge decision). */
      readonly decision: boolean;
      /**
       * `unlessHolderIsParent`: an untargeted retract of a reference the parent
       * row itself holds needs no target row at all — the parent's own cells are
       * retracted. Everything else always binds the target.
       */
      readonly need: "always" | "unlessHolderIsParent";
    }
  | {
      readonly primitive: "assertFresh";
      /** Which member of the item carries the record payload. */
      readonly from: "data" | "create" | "rows";
    }
  | {
      readonly primitive: "assertAtKey";
      /** The edge's reference cells, or the record's scalar (and nested) cells. */
      readonly what: "reference" | "record";
      readonly from?: "data" | "update";
    }
  | {
      readonly primitive: "retract";
      readonly what: "reference" | "row";
    }
  | {
      readonly primitive: "merge";
      readonly decision: Extract<Step, { readonly primitive: "match" }>;
      readonly found: readonly Step[];
      readonly missing: readonly Step[];
    }
  | { readonly primitive: "setDifference" };

// ---------------------------------------------------------------------------
// Items (a verb's validated payload, read into one uniform shape)
// ---------------------------------------------------------------------------

/** One unique selector, with the variant it was tagged with when the payload selects the target table. */
export interface SelectorItem {
  readonly variant?: string;
  readonly selector: Record<string, unknown>;
}

/**
 * One item of a verb: every verb reads its validated payload into a list of
 * these, so the plan interpreter never sees a verb-specific envelope.
 */
export interface VerbItem {
  /** Present when the payload bound the target table (a tagged item). */
  readonly variant?: string;
  /** A unique selector naming one row. */
  readonly selector?: Record<string, unknown>;
  /** A non-unique filter narrowing the parent's neighbours. */
  readonly filter?: Record<string, unknown>;
  /** The record payload of a single-record verb. */
  readonly data?: Record<string, unknown>;
  /** A merge's missing-arm payload. */
  readonly create?: Record<string, unknown>;
  /** A merge's found-arm payload. */
  readonly update?: Record<string, unknown>;
  /** A bulk assertion's rows. */
  readonly rows?: readonly Record<string, unknown>[];
  readonly skipDuplicates?: boolean;
  /** A set-difference's target set (may be empty: clear where legal). */
  readonly selectors?: readonly SelectorItem[];
  /** The item addresses the current neighbour set with no selector at all. */
  readonly current: boolean;
}

/** The shape a verb's validated payload takes on a given edge. */
export interface PayloadShape {
  readonly cardinality: "one" | "many";
  /** Every item carries a `type` discriminator that binds the target table. */
  readonly tagged: boolean;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface VerbRow {
  readonly verb: Verb;
  readonly stage: Stage;
  readonly plan: readonly Step[];
  /** Read the verb's validated payload into items. An empty list is inert. */
  readonly read: (payload: unknown, shape: PayloadShape) => readonly VerbItem[];
  /**
   * The failure today's engine raises when this verb's match binds nothing —
   * byte-identical text from the write engine's message catalog. Absent when
   * the verb tolerates an empty match (a merge creates; a fresh row and a
   * set-valued write name no target).
   */
  readonly notFound?: (relationName: string) => string;
}

/** `relationTargetNotFound` reads only the relation's public name. */
const targetNotFound =
  (verb: "connect" | "delete" | "disconnect" | "set" | "update") =>
  (relationName: string): string =>
    relationTargetNotFound({ name: relationName } as never, verb);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [value];

const records = (value: unknown): readonly Record<string, unknown>[] =>
  listOf(value).filter(isRecord);

/** Strip a tagged item's discriminator; `undefined` when the shape is untagged. */
const variantOf = (
  item: Record<string, unknown>,
  shape: PayloadShape
): string | undefined =>
  shape.tagged && typeof item.type === "string" ? item.type : undefined;

const filterOf = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) && Object.keys(value).length > 0 ? value : undefined;

const selectorItems = (
  value: unknown,
  shape: PayloadShape
): readonly SelectorItem[] =>
  shape.tagged
    ? records(value).map((item) => ({
        ...(variantOf(item, shape) === undefined
          ? {}
          : { variant: variantOf(item, shape) }),
        selector: asRecord(item.where),
      }))
    : records(value).map((selector) => ({ selector }));

const withVariant = (
  variant: string | undefined,
  item: Omit<VerbItem, "variant">
): VerbItem => (variant === undefined ? item : { variant, ...item });

/** `disconnect` and `delete` share one reading: a boolean names the current neighbour(s); selectors name rows. */
const readRemoval = (
  payload: unknown,
  shape: PayloadShape
): readonly VerbItem[] => {
  if (payload === false || payload === undefined) return [];
  if (payload === true) return [{ current: true }];
  if (shape.tagged) {
    return records(payload).map((item) =>
      withVariant(variantOf(item, shape), {
        ...(isRecord(item.where) ? { selector: item.where } : {}),
        current: !isRecord(item.where),
      })
    );
  }
  return records(payload).map((selector) => ({ selector, current: false }));
};

const MATCH_SELECTOR: Step = {
  primitive: "match",
  locate: "selector",
  decision: false,
  need: "always",
};
const MATCH_MEMBER: Step = {
  primitive: "match",
  locate: "membership",
  decision: false,
  need: "always",
};
const DECIDE_SELECTOR = { ...MATCH_SELECTOR, decision: true } as const;
const DECIDE_MEMBER = { ...MATCH_MEMBER, decision: true } as const;
const ASSERT_REFERENCE: Step = { primitive: "assertAtKey", what: "reference" };

/**
 * The table. Order is the mutation order (ATOM §6) and is behavior: it decides
 * variable allocation and therefore every downstream tie-break.
 */
export const SUGAR: readonly VerbRow[] = [
  // ---- 1. named readers --------------------------------------------------
  {
    verb: "disconnect",
    stage: 1,
    // retract reference cell(s) for X, or for all of N
    plan: [
      {
        primitive: "match",
        locate: "membership",
        decision: false,
        need: "unlessHolderIsParent",
      },
      { primitive: "retract", what: "reference" },
    ],
    read: readRemoval,
    notFound: targetNotFound("disconnect"),
  },
  {
    verb: "delete",
    stage: 1,
    // match X ∈ N; retract all cells of X
    plan: [MATCH_MEMBER, { primitive: "retract", what: "row" }],
    read: readRemoval,
    notFound: targetNotFound("delete"),
  },
  {
    verb: "update",
    stage: 1,
    // match X ∈ N by selector; assert X's scalar cells; recurse
    plan: [
      MATCH_MEMBER,
      { primitive: "assertAtKey", what: "record", from: "data" },
    ],
    notFound: targetNotFound("update"),
    read: (payload, shape) => {
      if (shape.cardinality === "one") {
        // The to-one payload is the canonical `{ data, where? }` envelope; a
        // tagged one additionally carries its discriminator.
        const envelope = asRecord(payload);
        return [
          withVariant(variantOf(envelope, shape), {
            data: asRecord(envelope.data),
            ...(filterOf(envelope.where)
              ? { filter: filterOf(envelope.where) }
              : {}),
            current: true,
          }),
        ];
      }
      return records(payload).map((item) =>
        withVariant(variantOf(item, shape), {
          selector: asRecord(item.where),
          data: asRecord(item.data),
          current: false,
        })
      );
    },
  },
  {
    verb: "upsert",
    stage: 1,
    // merge: match X ∈ N; found: as update; missing: as create
    plan: [
      {
        primitive: "merge",
        decision: DECIDE_MEMBER,
        found: [{ primitive: "assertAtKey", what: "record", from: "update" }],
        missing: [
          { primitive: "assertFresh", from: "create" },
          ASSERT_REFERENCE,
        ],
      },
    ],
    notFound: upsertTargetNotFoundForParent,
    read: (payload, shape) => {
      if (shape.cardinality === "one") {
        const envelope = asRecord(payload);
        return [
          withVariant(variantOf(envelope, shape), {
            create: asRecord(envelope.create),
            update: asRecord(envelope.update),
            current: true,
          }),
        ];
      }
      return records(payload).map((item) =>
        withVariant(variantOf(item, shape), {
          selector: asRecord(item.where),
          create: asRecord(item.create),
          update: asRecord(item.update),
          current: false,
        })
      );
    },
  },
  {
    verb: "connectOrCreate",
    stage: 1,
    // merge: match X by selector; found: assert X ∈ N; missing: as create
    plan: [
      {
        primitive: "merge",
        decision: DECIDE_SELECTOR,
        found: [ASSERT_REFERENCE],
        missing: [
          { primitive: "assertFresh", from: "create" },
          ASSERT_REFERENCE,
        ],
      },
    ],
    read: (payload, shape) =>
      records(payload).map((item) =>
        withVariant(variantOf(item, shape), {
          selector: asRecord(item.where),
          create: asRecord(item.create),
          current: false,
        })
      ),
  },
  // ---- 2. unbounded writers ----------------------------------------------
  {
    verb: "set",
    stage: 2,
    // retract reference cells for N \ S; assert them for S \ N
    plan: [{ primitive: "setDifference" }],
    notFound: targetNotFound("set"),
    read: (payload, shape) =>
      payload === undefined
        ? []
        : [{ selectors: selectorItems(payload, shape), current: true }],
  },
  {
    verb: "updateMany",
    stage: 2,
    // assert over the set-valued key variable matching a predicate under N
    plan: [
      {
        primitive: "match",
        locate: "membership",
        decision: false,
        need: "always",
      },
      { primitive: "assertAtKey", what: "record", from: "data" },
    ],
    read: (payload, shape) =>
      records(payload).map((item) =>
        withVariant(variantOf(item, shape), {
          ...(filterOf(item.where) ? { filter: filterOf(item.where) } : {}),
          data: asRecord(item.data),
          current: true,
        })
      ),
  },
  {
    verb: "deleteMany",
    stage: 2,
    // retract over the set-valued key variable matching a predicate under N
    plan: [
      {
        primitive: "match",
        locate: "membership",
        decision: false,
        need: "always",
      },
      { primitive: "retract", what: "row" },
    ],
    read: (payload, shape) =>
      shape.tagged
        ? records(payload).map((item) =>
            withVariant(variantOf(item, shape), {
              ...(filterOf(item.where) ? { filter: filterOf(item.where) } : {}),
              current: true,
            })
          )
        : listOf(payload).map((where) => ({
            ...(filterOf(where) ? { filter: filterOf(where) } : {}),
            current: true,
          })),
  },
  // ---- 3. pure adders ----------------------------------------------------
  {
    verb: "connect",
    stage: 3,
    // match X by selector; assert reference cell(s) so X ∈ N
    plan: [MATCH_SELECTOR, ASSERT_REFERENCE],
    notFound: targetNotFound("connect"),
    read: (payload, shape) =>
      selectorItems(payload, shape).map((item) => ({
        ...item,
        current: false,
      })),
  },
  {
    verb: "create",
    stage: 3,
    // assert X at a fresh key; assert reference cell(s) so X ∈ N; recurse
    plan: [{ primitive: "assertFresh", from: "data" }, ASSERT_REFERENCE],
    read: (payload, shape) =>
      shape.tagged
        ? records(payload).map((item) =>
            withVariant(variantOf(item, shape), {
              data: asRecord(item.data),
              current: false,
            })
          )
        : records(payload).map((data) => ({ data, current: false })),
  },
  {
    verb: "createMany",
    stage: 3,
    // assert N fresh keys; recurse only when rows carry relation payloads
    plan: [{ primitive: "assertFresh", from: "rows" }, ASSERT_REFERENCE],
    read: (payload, shape) =>
      // An untagged group is ONE envelope; a tagged payload is a list of groups.
      (shape.tagged ? records(payload) : [asRecord(payload)]).map((group) =>
        withVariant(variantOf(group, shape), {
          rows: records(group.data),
          ...(typeof group.skipDuplicates === "boolean"
            ? { skipDuplicates: group.skipDuplicates }
            : {}),
          current: false,
        })
      ),
  },
];

/** The eleven verbs in mutation order — derived, never restated. */
export const VERB_ORDER: readonly Verb[] = SUGAR.map((row) => row.verb);

const ROW_BY_VERB: ReadonlyMap<Verb, VerbRow> = new Map(
  SUGAR.map((row) => [row.verb, row])
);

export function verbRow(verb: Verb): VerbRow {
  const row = ROW_BY_VERB.get(verb);
  if (!row) throw new TypeError(`sugar: no row for verb '${verb}'`);
  return row;
}

/** Whether a payload key is one of the eleven verbs. */
export function isVerb(key: string): key is Verb {
  return ROW_BY_VERB.has(key as Verb);
}

/**
 * The step-label suffix a row's WRITE statement carries (`team.connect`,
 * `org.update`). It is the verb itself — except for a FRESH row a merge
 * created, which today names `create`: the arm writes a new record whatever
 * the merge was spelled. A verb whose own plan opens with a fresh assertion
 * (`create`, `createMany`) keeps its name, because that name IS the write.
 *
 * The model half of the label is the caller's; this is the half the verb owns,
 * so the packer never keys a table by (edge kind × verb) to recover it.
 */
export function writeLabel(verb: string | undefined, fresh: boolean): string {
  if (verb === undefined) return "";
  if (!isVerb(verb)) return verb;
  const [first] = verbRow(verb).plan;
  // A merge names its arms after what each arm WRITES, never after the merge:
  // the missing arm creates, the found arm updates.
  if (first?.primitive === "merge") return fresh ? "create" : "update";
  return fresh && first?.primitive !== "assertFresh" ? "create" : verb;
}

/**
 * The label a REFERENCE ROW's statement carries (K1 `Row.label`).
 *
 * Today names it for what the statement does to the REFERENCE, not for the
 * target it points at: a fresh target's row is an insert, a retracted one a
 * delete, a set's two halves clear and refill, and a UNIQUE reference — the
 * singular slot — inserts whether or not its target is fresh. Every spelling
 * below is a byte-pinned step id, which is why the census exempts its line: an
 * id, like an error message, is text rather than a branch.
 */
export function referenceRowLabel(input: {
  readonly verb: string | undefined;
  readonly freshTarget: boolean;
  readonly retracting: boolean;
  readonly uniqueReference: boolean;
}): string {
  if (input.verb === "set") {
    return input.retracting ? "set.clear" : "set.insert"; // census: label
  }
  if (input.retracting) {
    return input.verb === "disconnect" ? "disconnect" : "junction.delete"; // census: label
  }
  return input.freshTarget || input.uniqueReference
    ? "junction.insert" // census: label
    : (input.verb ?? "connect");
}

/**
 * How a row's identity is obtained (K1 `Row.located`), from the verb's plan and
 * the cell map — never from the storage kind by name.
 *
 * A row whose item spells a selector or filter names its own target and is
 * PROBED. Otherwise the reference decides: when the PARENT holds it, the
 * target's key has to be read out of the parent's row (a probe); when the
 * TARGET holds it, the write correlates inline (no probe). A reference row of
 * its own is probed for the verbs that name one target, and correlated for the
 * ones that address the whole neighbour set.
 */
export function locatedBy(input: {
  readonly verb: Verb;
  readonly fresh: boolean;
  readonly targeted: boolean;
  readonly parentHoldsReference: boolean;
  readonly ownReferenceRow: boolean;
  readonly clearable: boolean;
  readonly setValued: boolean;
}): "probe" | "correlated" | "none" {
  if (input.fresh) return "none";
  if (input.targeted) return "probe";
  const row = verbRow(input.verb);
  // An unbounded writer addresses the whole set through its own predicate.
  if (row.stage === 2 && input.verb !== "set") return "correlated";
  if (input.ownReferenceRow) {
    return input.verb === "disconnect" ? "correlated" : "probe";
  }
  if (input.parentHoldsReference) {
    return row.plan.some(
      (step) =>
        step.primitive === "merge" ||
        (step.primitive === "match" && step.locate === "selector")
    ) || input.verb === "update"
      ? "probe"
      : "correlated";
  }
  // The target holds the reference: only a departure that cannot be nulled is
  // read (today's required-foreign-key orphan refusal).
  if (input.verb === "set" && input.setValued) {
    return input.clearable ? "correlated" : "probe";
  }
  return input.verb === "disconnect" || input.verb === "delete"
    ? "correlated"
    : "probe";
}

/**
 * The text a violated target premise raises for the verb stamped on a row
 * (`Row.verb`), or `undefined` when that verb tolerates an empty match. The
 * raiser (packing) reads this; construction never spells the sentence.
 */
export function targetNotFoundFailure(
  verb: string | undefined,
  relationName: string
): string | undefined {
  if (verb === undefined || !isVerb(verb)) return undefined;
  return ROW_BY_VERB.get(verb)?.notFound?.(relationName);
}

// ---------------------------------------------------------------------------
// The to-one composition (to-one-composition.ts, as data)
// ---------------------------------------------------------------------------

/**
 * A composed to-one payload reads as `(vacate?, supplier, modify?)`: the modify
 * addresses the row the SUPPLIER produced or named, never the outgoing member
 * that membership would locate before the first write. The order claim is this
 * table's, not the verb order's.
 */
export const TO_ONE_VACATE: ReadonlySet<Verb> = new Set<Verb>([
  "disconnect",
  "delete",
]);
export const TO_ONE_SUPPLY: ReadonlySet<Verb> = new Set<Verb>([
  "connectOrCreate",
  "connect",
  "create",
]);
export const TO_ONE_MODIFY: Verb = "update";

/**
 * Whether a set of verbs on a singular edge composes: at least a supplier, and
 * every verb one of vacate / supply / modify. Anything else runs in plain verb
 * order (a single verb, or a shape the lattice already refused).
 */
export function toOneComposition(
  verbs: readonly Verb[]
):
  | { readonly vacate?: Verb; readonly supplier: Verb; readonly modify?: Verb }
  | undefined {
  if (verbs.length <= 1) return undefined;
  let vacate: Verb | undefined;
  let supplier: Verb | undefined;
  let modify: Verb | undefined;
  for (const verb of verbs) {
    if (TO_ONE_VACATE.has(verb)) vacate = verb;
    else if (TO_ONE_SUPPLY.has(verb)) supplier = verb;
    else if (verb === TO_ONE_MODIFY) modify = verb;
    else return undefined;
  }
  if (!supplier) return undefined;
  const named = [vacate, supplier, modify].filter((v) => v !== undefined);
  if (named.length !== verbs.length) return undefined;
  return {
    ...(vacate ? { vacate } : {}),
    supplier,
    ...(modify ? { modify } : {}),
  };
}

/** The ONE scalar-update spelling that is not relative: `{ set: value }`. */
export const ABSOLUTE_UPDATE_KEY = "set";
