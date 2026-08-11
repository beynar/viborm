/**
 * The one runtime owner of inverse-relation CANDIDATE DISCOVERY AND RESOLUTION.
 *
 * Given a relation's TARGET model and the SOURCE model it should point back to,
 * this module answers which back-reference carries the relation's stored
 * membership — an ordinary fields-bearing to-one, a polymorphic edge, nothing,
 * or several competing candidates. It owns the MATCHING FACTS only:
 *
 * - it throws nothing — `missing` and `ambiguous` are answers, and each caller
 *   translates them by its own established policy (definition validation into
 *   schema issues at push time, `bindRelation` into its `QueryEngineError`s at
 *   query time, the operation-schema map view into its historical
 *   first-candidate / undefined answers);
 * - it decides no timing — callers invoke it inside the thunks they always
 *   used, so lazy/circular model graphs stay lazy;
 * - the `ambiguous` arm carries the full ordered candidates (a deliberate
 *   enrichment of the plan's §4.6 sketch: `getInverseRelationMap` derives its
 *   preserved first-candidate FK-omission policy from them, which a bare key
 *   list could not feed).
 *
 * Precedence, stated once (previously composed across `bindRelation` →
 * `bindPolymorphicInverse` → `getPolymorphicInverseBinding` → the ordinary
 * scan):
 *
 * 1. an exact polymorphic pairing `.name()` selects the polymorphic edge, even
 *    beside a physical FK back-reference;
 * 2. otherwise a non-empty-`.fields()` ordinary back-reference owns the
 *    inverse — one candidate resolves whatever either side is named, several
 *    resolve by `.name()` or stand as `ambiguous`;
 * 3. otherwise the sole-polymorphic-relation convenience rule applies;
 * 4. otherwise the inverse is `missing`.
 *
 * A `.fields()` spelled with ZERO arguments is fields-LESS everywhere here —
 * the aligned reading (`fields.length > 0`) the engine always applied and the
 * operation-schema scanner historically did not; that alignment is the
 * recorded retirement condition of guard-ledger site 11.
 *
 * A SECOND, inert alignment axis rides along: candidates are filtered to
 * `manyToOne`/`oneToOne` (the operation-schema scanner's reading), where the
 * deleted engine scanners accepted any fields-bearing relation. No public
 * builder can put `.fields()` on a to-many today, so no constructible schema
 * differs — recorded so that a future to-many `fields` channel knows this
 * filter decides engine binding too.
 */

import type { AnyModel } from "@schema/model";
import {
  getPolymorphicInverseCandidates,
  type PolymorphicInverseBinding,
} from "./polymorphic";
import type { AnyRelation, ReferentialAction } from "./types";

export interface ResolvedInverseCandidate {
  /** The back-reference's key on the TARGET model. */
  readonly relationKey: string;
  readonly fields: readonly string[];
  readonly references: readonly string[] | undefined;
  readonly onUpdate: ReferentialAction | undefined;
  /** The candidate relation's own `.name()`, used for disambiguation. */
  readonly pairingName: string | undefined;
}

export type ResolvedInverseRelation =
  | ({ readonly kind: "ordinary" } & ResolvedInverseCandidate)
  | ({ readonly kind: "polymorphic" } & PolymorphicInverseBinding)
  | { readonly kind: "missing" }
  | {
      readonly kind: "ambiguous";
      /** Every competing candidate, in the target's declaration order. */
      readonly candidates: readonly ResolvedInverseCandidate[];
    };

export function resolveInverseRelation(
  targetModel: AnyModel,
  sourceModel: unknown,
  relationName: string | undefined
): ResolvedInverseRelation {
  // 1. An exact polymorphic pairing name wins outright.
  const namedPolymorphic = selectPolymorphicInverse(
    targetModel,
    sourceModel,
    relationName,
    "namedOnly"
  );
  if (namedPolymorphic) {
    return { kind: "polymorphic", ...namedPolymorphic };
  }

  // 2. Ordinary fields-bearing back-references — the ONE ordinary precedence,
  // stated in resolveOrdinaryInverse and only called from here.
  const ordinary = resolveOrdinaryInverse(targetModel, sourceModel, relationName);
  if (ordinary.kind !== "missing") {
    return ordinary;
  }

  // 3. No physical FK owns the edge: the sole-polymorphic-relation rule.
  const solePolymorphic = selectPolymorphicInverse(
    targetModel,
    sourceModel,
    relationName,
    "soleGroup"
  );
  if (solePolymorphic) {
    return { kind: "polymorphic", ...solePolymorphic };
  }

  return { kind: "missing" };
}

/**
 * The polymorphic-only projection of the composed resolution — the established
 * name every definition-validation rule and operation-schema factory consumes.
 * A child may carry both a real FK back to the source and a polymorphic field
 * that also targets it: an exact pairing name selects the polymorphic edge,
 * otherwise the physical FK owns the ordinary inverse, and with no ordinary
 * edge the convenient single-polymorphic-owner rule applies — all of which is
 * the resolver's own precedence, so this view only filters its verdict.
 */
export function getPolymorphicInverseBinding(
  targetModel: AnyModel,
  sourceModel: AnyModel,
  name: string | undefined
): PolymorphicInverseBinding | undefined {
  const resolved = resolveInverseRelation(targetModel, sourceModel, name);
  return resolved.kind === "polymorphic"
    ? {
        relationKey: resolved.relationKey,
        publicType: resolved.publicType,
        storedType: resolved.storedType,
      }
    : undefined;
}

/**
 * The ordinary-only resolution — the polymorphic arms skipped. The engine asks
 * this for relation types that can never bind a polymorphic inverse (the
 * retained fields-less `manyToOne` compatibility form), where the composed
 * precedence's named-pairing arm must not shadow a physical back-reference.
 */
export function resolveOrdinaryInverse(
  targetModel: AnyModel,
  sourceModel: unknown,
  relationName: string | undefined
): ResolvedInverseRelation {
  const candidates = collectInverseCandidates(targetModel, sourceModel);
  if (candidates.length === 1) {
    return { kind: "ordinary", ...(candidates[0] as ResolvedInverseCandidate) };
  }
  if (candidates.length > 1) {
    if (relationName !== undefined) {
      const named = candidates.find(
        (candidate) => candidate.pairingName === relationName
      );
      if (named) {
        return { kind: "ordinary", ...named };
      }
    }
    return { kind: "ambiguous", candidates };
  }
  return { kind: "missing" };
}

export function collectInverseCandidates(
  targetModel: AnyModel,
  sourceModel: unknown
): ResolvedInverseCandidate[] {
  const relations: Readonly<Record<string, AnyRelation>> =
    targetModel["~"].state.relations ?? {};
  const candidates: ResolvedInverseCandidate[] = [];
  for (const [relationKey, relation] of Object.entries(relations)) {
    const state = relation["~"].state;
    if (state.type !== "manyToOne" && state.type !== "oneToOne") {
      continue;
    }
    const fields = state.fields;
    if (!(fields && fields.length > 0)) {
      continue;
    }
    if (state.getter?.() !== sourceModel) {
      continue;
    }
    candidates.push({
      relationKey,
      fields,
      references: state.references,
      onUpdate: state.onUpdate,
      pairingName: state.name,
    });
  }
  return candidates;
}

/**
 * The two polymorphic selection modes of the old `getPolymorphicInverseBinding`
 * composition, split by where they sit in the precedence: an exact pairing
 * name beats the ordinary scan; the sole-group convenience rule loses to it.
 */
function selectPolymorphicInverse(
  targetModel: AnyModel,
  sourceModel: unknown,
  relationName: string | undefined,
  mode: "namedOnly" | "soleGroup"
): PolymorphicInverseBinding | undefined {
  // Unguarded like getPolymorphicInverseCandidates' own read: every model
  // constructed through s.model() carries the map.
  const polymorphicRelations: Readonly<
    Record<string, { "~": { state: { name?: string } } }>
  > = targetModel["~"].state.polymorphicRelations;
  const groups = Object.entries(polymorphicRelations);
  let selectedKey: string | undefined;
  if (mode === "namedOnly") {
    if (relationName === undefined) {
      return undefined;
    }
    const named = groups.filter(
      ([, relation]) => relation["~"].state.name === relationName
    );
    selectedKey = named.length === 1 ? named[0]?.[0] : undefined;
  } else {
    selectedKey = groups.length === 1 ? groups[0]?.[0] : undefined;
  }
  if (selectedKey === undefined) {
    return undefined;
  }
  const matches = getPolymorphicInverseCandidates(
    targetModel,
    sourceModel as AnyModel
  ).filter((candidate) => candidate.relationKey === selectedKey);
  if (matches.length !== 1) {
    return undefined;
  }
  const candidate = matches[0] as (typeof matches)[number];
  return {
    relationKey: candidate.relationKey,
    publicType: candidate.publicType,
    storedType: candidate.storedType,
  };
}
