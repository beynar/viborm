/**
 * THE STATIC INVERSE PROJECTION, over VARIANT carriers.
 *
 * `src/schema/relation/static-membership.ts` is the one compile-time view of
 * the relation graph (plan §8.1). It mirrors only the predicate it can PROVE —
 * asking-slot exclusion, the exact literal-name partition, and the mutual
 * degree-one reverse proof — and answers `unknown` for everything else. Every
 * pin below is written through `s.model` / `s.toOne` / `s.toMany` exactly as a
 * caller spells them; the projection is the subject, never the input.
 *
 * The ordinary half of the same projection lives in
 * `static-membership.core.types.ts`. This file owns the variant carrier cells:
 * §11.3.13 (which key a nested payload may not spell) and §11.3.14 (which
 * carrier exposes a disconnect).
 *
 * FAIL-CLOSED IS THE POINT. Where a pin says `unknown`, the runtime resolver
 * either refuses the schema outright or resolves an edge the type view cannot
 * see; both are safe, because `unknown` grants no omission and no verb.
 */

import type { AnyModel } from "@src/schema";
import { s } from "@src/schema";
import type {
  DerivedNestedKeys,
  MembershipCanBeCleared,
  ModelRelationMemberships,
  SlotMayBeEmpty,
  StaticResolvedMembership,
  StaticUnknownMembership,
  StaticVariantInverseMembership,
  TargetKind,
  VariantEntries,
} from "@src/schema/relation/static-membership";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

/** The membership of one contextual slot, spelled the way a consumer asks. */
type RelationAt<
  Source extends AnyModel,
  Field extends keyof Source["~"]["state"]["relations"],
> = Source["~"]["state"]["relations"][Field];

type MembershipAt<
  Source extends AnyModel,
  Field extends keyof Source["~"]["state"]["relations"],
> = StaticResolvedMembership<Source, Field, RelationAt<Source, Field>>;

// ---------------------------------------------------------------------------
// 1. A MEMBER-JUNCTION CARRIER — both inverse cardinalities bind
// ---------------------------------------------------------------------------

const article = s.model({
  id: s.string().id(),
  gallery: s.toOne(() => owner),
});
const photo = s.model({
  id: s.string().id(),
  galleries: s.toMany(() => owner),
});
const owner = s.model({
  id: s.string().id(),
  items: s.toMany(
    { article: () => article, photo: () => photo },
    { values: { article: "carrier.article.v1", photo: "carrier.photo.v1" } }
  ),
});

type _singularInverseOfAMemberJunction = Expect<
  Equal<
    MembershipAt<typeof article, "gallery">,
    StaticVariantInverseMembership<"items", true>
  >
>;
type _pluralInverseOfAMemberJunction = Expect<
  Equal<
    MembershipAt<typeof photo, "galleries">,
    StaticVariantInverseMembership<"items", true>
  >
>;

/** The carrier holds its OWN membership, so it derives nothing to hide. */
type _theCarrierItselfIsNotAMembership = Expect<
  Equal<MembershipAt<typeof owner, "items">, StaticUnknownMembership>
>;

/** §11.3.13: the EXACT carrier relation key, and nothing else. */
type _nestedPayloadMayNotSpellTheCarrierKey = Expect<
  Equal<
    DerivedNestedKeys<
      typeof article,
      "gallery",
      RelationAt<typeof article, "gallery">
    >,
    "items"
  >
>;

/** §11.3.14: a member junction clears by deleting its membership row. */
type _memberJunctionMembershipClears = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof article,
      "gallery",
      RelationAt<typeof article, "gallery">
    >,
    true
  >
>;

// ---------------------------------------------------------------------------
// 2. A ROW-HELD CARRIER — clearability follows the carrier's own `.optional()`
// ---------------------------------------------------------------------------

const badge = s.model({
  id: s.string().id(),
  holder: s.toOne(() => requiredHolder),
});
const requiredHolder = s.model({
  id: s.string().id(),
  mark: s.toOne(
    { badge: () => badge },
    { values: { badge: "carrier.badge.v1" } }
  ),
});

const optionalBadge = s.model({
  id: s.string().id(),
  holder: s.toOne(() => optionalHolder),
});
const optionalHolder = s.model({
  id: s.string().id(),
  mark: s
    .toOne(
      { badge: () => optionalBadge },
      { values: { badge: "carrier.optional-badge.v1" } }
    )
    .optional(),
});

type _requiredRowCarrierExposesNoDisconnect = Expect<
  Equal<
    MembershipAt<typeof badge, "holder">,
    StaticVariantInverseMembership<"mark", false>
  >
>;
type _optionalRowCarrierClears = Expect<
  Equal<
    MembershipAt<typeof optionalBadge, "holder">,
    StaticVariantInverseMembership<"mark", true>
  >
>;

/** The carrier's own slot: empty exactly when it is `.optional()` (§8.4). */
type _requiredCarrierSlotIsNotEmpty = Expect<
  Equal<
    SlotMayBeEmpty<
      typeof requiredHolder,
      "mark",
      RelationAt<typeof requiredHolder, "mark">
    >,
    false
  >
>;
type _optionalCarrierSlotMayBeEmpty = Expect<
  Equal<
    SlotMayBeEmpty<
      typeof optionalHolder,
      "mark",
      RelationAt<typeof optionalHolder, "mark">
    >,
    true
  >
>;

/** A COLLECTION carrier has no `.optional()` to read and holds many rows. */
type _collectionCarrierSlotMayBeEmpty = Expect<
  Equal<
    SlotMayBeEmpty<typeof owner, "items", RelationAt<typeof owner, "items">>,
    true
  >
>;

// ---------------------------------------------------------------------------
// 3. THE EXACT LITERAL-NAME PARTITION (§8.1 step 4)
// ---------------------------------------------------------------------------

const twoCarrierSource = s.model({
  id: s.string().id(),
  slot: s.toOne(() => twoCarrierHost),
});
const twoCarrierHost = s.model({
  id: s.string().id(),
  primary: s.toOne(
    { source: () => twoCarrierSource },
    { values: { source: "two.primary.v1" } }
  ),
  secondary: s.toOne(
    { source: () => twoCarrierSource },
    { values: { source: "two.secondary.v1" } }
  ),
});

/** Two candidates, no name to choose between them: nothing is proven. */
type _competingCarriersFailClosed = Expect<
  Equal<MembershipAt<typeof twoCarrierSource, "slot">, StaticUnknownMembership>
>;

const namedSource = s.model({
  id: s.string().id(),
  slot: s.toOne(() => namedHost).name("Primary"),
});
const namedHost = s.model({
  id: s.string().id(),
  primary: s
    .toOne(
      { source: () => namedSource },
      { values: { source: "named.primary.v1" } }
    )
    .name("Primary"),
  secondary: s
    .toOne(
      { source: () => namedSource },
      { values: { source: "named.secondary.v1" } }
    )
    .name("Secondary"),
});

/** The same two candidates, partitioned by an exact matching label. */
type _matchingNamesSelectOneCarrier = Expect<
  Equal<
    MembershipAt<typeof namedSource, "slot">,
    StaticVariantInverseMembership<"primary", false>
  >
>;

const mismatchedSource = s.model({
  id: s.string().id(),
  slot: s.toOne(() => mismatchedHost).name("NoSuchPair"),
});
const mismatchedHost = s.model({
  id: s.string().id(),
  primary: s
    .toOne(
      { source: () => mismatchedSource },
      { values: { source: "mismatch.primary.v1" } }
    )
    .name("Primary"),
});

/** A one-sided label is a MISMATCH, never permission to fall back (§6.2). */
type _aMismatchedLabelSelectsNothing = Expect<
  Equal<MembershipAt<typeof mismatchedSource, "slot">, StaticUnknownMembership>
>;

// ---------------------------------------------------------------------------
// 4. ONE TARGET UNDER TWO MEMBERS OF THE SAME CARRIER
// ---------------------------------------------------------------------------

const repeatedSource = s.model({
  id: s.string().id(),
  slot: s.toOne(() => repeatedHost),
});
const repeatedHost = s.model({
  id: s.string().id(),
  items: s.toMany(
    { first: () => repeatedSource, second: () => repeatedSource },
    { values: { first: "repeat.first.v1", second: "repeat.second.v1" } }
  ),
});

/**
 * RECORDED, not asserted as correct: the projection counts candidate relation
 * KEYS, so it sees ONE candidate here and binds — while the resolver counts
 * MEMBERS and refuses the schema outright (R009: a carrier-wide label cannot
 * choose one member of that same carrier).
 *
 * The over-promise is UNREACHABLE, because the schema cannot reach a client.
 * Counting members here instead would be strictly worse: TypeScript cannot tell
 * two DISTINCT targets with identical shapes apart, so the count would read
 * "two" for a perfectly legal carrier and silently withdraw its inverse's
 * omission and disconnect verb. The repair for a real repeated target is
 * separate carrier fields with matching `.name(...)` pairs — there is no member
 * selector.
 */
type _repeatedTargetUnderOneCarrierBindsWhereTheGateRefuses = Expect<
  Equal<
    MembershipAt<typeof repeatedSource, "slot">,
    StaticVariantInverseMembership<"items", true>
  >
>;

// ---------------------------------------------------------------------------
// 5. WHAT THE PROJECTION CANNOT SEE
// ---------------------------------------------------------------------------

const extendedSource = s.model({
  id: s.string().id(),
  slot: s.toOne(() => extendedHost),
});
const extendedHost = s.model({
  id: s.string().id(),
  items: s.toMany(
    { source: () => extendedSource },
    { values: { source: "extend.source.v1" } }
  ),
});
const derivedSource = extendedSource.extends({ extra: s.string() });

/**
 * `.extends()` produces a NEW model whose relations still name the BASE, so
 * nothing on the host points at the derived model and the projection proves
 * nothing. This is a FAIL-CLOSED answer, not an omission the runtime shares:
 * the resolver sees the derived model's contextual slots and pairs them.
 */
type _anExtendedSourceFailsClosed = Expect<
  Equal<MembershipAt<typeof derivedSource, "slot">, StaticUnknownMembership>
>;

const looseSource = s.model({
  id: s.string().id(),
  slot: s.toOne(() => looseHost),
});
const looseHost = s.model({
  id: s.string().id(),
  items: s.toMany(
    { anything: () => looseSource as AnyModel },
    { values: { anything: "loose.any.v1" } }
  ),
});

/** A widened target names no model, so it identifies no candidate. */
type _aWidenedTargetProvesNothing = Expect<
  Equal<MembershipAt<typeof looseSource, "slot">, StaticUnknownMembership>
>;

/**
 * A UNION of carriers at one relation key — only reachable from declare-level
 * or generic code, since no `s.*` chain builds one. It is still a VARIANT
 * target, but the two members share no public key, so the projection can name
 * no member and nothing downstream can be proven through it.
 *
 * The two instantiation expressions below are hand-converted (ruling D22): the
 * codemod rewrites CALLS, and a type-argument-only instantiation is not one.
 */
declare const unionCarrier:
  | ReturnType<typeof s.toOne<{ readonly a: () => typeof looseSource }>>
  | ReturnType<typeof s.toOne<{ readonly b: () => typeof looseSource }>>;

type _aUnionOfCarriersResolvesNoTargetKind = Expect<
  Equal<TargetKind<typeof unionCarrier>, unknown>
>;
type _aUnionOfCarriersSharesNoPublicKey = Expect<
  Equal<keyof VariantEntries<typeof unionCarrier>, never>
>;

// ---------------------------------------------------------------------------
// 6. RECURSION DOES NOT COLLAPSE (§11.1.14)
// ---------------------------------------------------------------------------

const selfCarrier = s.model({
  id: s.string().id(),
  parent: s.toOne(
    { self: () => selfCarrier },
    { values: { self: "carrier.self.v1" } }
  ),
  children: s.toMany(() => selfCarrier),
});

type _selfCarrierIsNotAny = Expect<
  IsAny<typeof selfCarrier> extends false ? true : false
>;
type _ownerIsNotAny = Expect<IsAny<typeof owner> extends false ? true : false>;
type _articleIsNotAny = Expect<
  IsAny<typeof article> extends false ? true : false
>;
type _theWholeMembershipViewIsNotAny = Expect<
  IsAny<ModelRelationMemberships<typeof owner>> extends false ? true : false
>;
type _theSelfMembershipViewIsNotAny = Expect<
  IsAny<ModelRelationMemberships<typeof selfCarrier>> extends false
    ? true
    : false
>;

/**
 * A SELF carrier: the asking slot is excluded from its own candidate set
 * (§8.1 step 2), so `children` pairs with `parent` rather than with itself.
 */
type _selfInverseSelectsTheCarrierNotItself = Expect<
  Equal<
    MembershipAt<typeof selfCarrier, "children">,
    StaticVariantInverseMembership<"parent", false>
  >
>;
