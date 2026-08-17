import { QueryEngineError } from "@errors";
import type { RelationMutationEntry } from "./relation-mutation-parser";

/**
 * The ONE reading of a composed to-one payload: `(vacate?, supplier, modify?)`.
 *
 * Two owners consume it and neither re-derives it. `RecordUpdateCompiler` lowers the
 * composition into ordered Parts; `OwnWriteRelation` decides what the modify READS, and
 * those two answers must be the same answer — a plan that locates the modify by the
 * supplier's identity while the analyzer reports it as a membership read names a
 * dependency the plan does not have (and misses one it does). Before this owner existed
 * the rule was written twice and agreed only by construction; the ledger recorded that
 * as one invariant with two writers.
 *
 * The ORDER claim is the relation owner's, not `RELATION_MUTATION_KEYS`': the constant's
 * key order was once read positionally, which `parity-h-to-one-lattice` falsified by
 * reordering it.
 */

const TO_ONE_VACATE_KINDS: ReadonlySet<string> = new Set([
  "disconnect",
  "delete",
]);

const TO_ONE_SUPPLY_KINDS: ReadonlySet<string> = new Set([
  "connectOrCreate",
  "connect",
  "create",
]);

/**
 * How the composed modify reaches the row it modifies. A lone to-one `update` is located
 * by FK correlation alone, and correlation BEFORE the fragment's first write names the
 * OUTGOING member — or nothing at all on an empty slot — so a composed modify never uses
 * it.
 *
 * - `suppliedSelector` — the supplier is a `connect`, whose unique selector already
 *   names one row at construction. The modify is an ordinary selected-record update
 *   located by that selector, in the same fragment.
 * - `membershipCapture` — the supplier PRODUCES the row (`create`, or
 *   `connectOrCreate`'s missing arm), so no identity exists until it writes. The modify
 *   becomes the continuation of a record series: the supplier runs, the singular member
 *   is then selected through the exact physical-membership predicate, and its complete
 *   captured row key addresses the update. Membership after supply is the selector, so
 *   the supplier is never asked to predict or publish its own row key.
 */
export type ToOneContinuation =
  | {
      readonly kind: "suppliedSelector";
      readonly where: Record<string, unknown>;
    }
  | { readonly kind: "membershipCapture" };

export interface ToOneComposition {
  /** vacate → supplier → modify, whatever order the payload listed them in. */
  readonly ordered: readonly RelationMutationEntry[];
  readonly supplier: RelationMutationEntry;
  readonly modify: RelationMutationEntry | undefined;
  /** Present exactly when `modify` is. */
  readonly continuation: ToOneContinuation | undefined;
}

/**
 * Classify a to-one relation's parsed entries, or answer `undefined` when they are not
 * a composition this owner recognizes: fewer than two entries, no supplier, or a kind
 * outside `(vacate, supplier, modify)`.
 *
 * `undefined` is deliberately NOT a refusal. The analyzer asks this question about every
 * program and must not move an error ahead of the parse boundary; the compiler's own
 * dispatch owns the engine-fault sentence for a payload the lattice should have excluded.
 */
export function classifyToOneComposition(
  relationName: string,
  entries: readonly RelationMutationEntry[]
): ToOneComposition | undefined {
  if (entries.length <= 1) return undefined;
  let vacate: RelationMutationEntry | undefined;
  let supplier: RelationMutationEntry | undefined;
  let modify: RelationMutationEntry | undefined;
  for (const entry of entries) {
    if (TO_ONE_VACATE_KINDS.has(entry.kind)) vacate = entry;
    else if (TO_ONE_SUPPLY_KINDS.has(entry.kind)) supplier = entry;
    else if (entry.kind === "update") modify = entry;
  }
  const ordered: RelationMutationEntry[] = [];
  for (const entry of [vacate, supplier, modify]) {
    if (entry) ordered.push(entry);
  }
  if (ordered.length !== entries.length || !supplier) return undefined;
  return {
    ordered,
    supplier,
    modify,
    continuation: modify
      ? resolveContinuation(relationName, supplier)
      : undefined,
  };
}

function resolveContinuation(
  relationName: string,
  supplier: RelationMutationEntry
): ToOneContinuation {
  return supplier.kind === "connect"
    ? {
        kind: "suppliedSelector",
        where: requireToOneConnectTarget(supplier, relationName),
      }
    : { kind: "membershipCapture" };
}

/**
 * The unique selector a to-one `connect` names, from the ONE place that answers it.
 * Three readers need it — the parent-held link, the parent-held composition and the
 * child-held composition — and two of those three would otherwise fall back to FK
 * correlation, which before the first write addresses the OUTGOING member. An absent
 * target is not a payload this layer declines: a to-one arm parses to exactly one
 * record, because its schema is an object and `isRecord` refuses arrays, so zero means
 * the parse and this dispatch disagree.
 */
export function requireToOneConnectTarget(
  entry: Extract<RelationMutationEntry, { kind: "connect" }>,
  relationName: string
): Record<string, unknown> {
  const target = entry.targets[0];
  if (!target) {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-one connect on relation '${relationName}' has no target.`
    );
  }
  return target;
}
