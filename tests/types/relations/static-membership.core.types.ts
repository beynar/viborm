/**
 * THE STATIC INVERSE PROJECTION, over MODEL targets.
 *
 * `src/schema/relation/static-membership.ts` replaces the deleted runtime
 * inverse scanners' type residue with ONE compile-time projection (plan §8.1).
 * Every pin below enters through `s.model` / `s.toOne` / `s.toMany` exactly as
 * a caller spells them, then reads what the projection answers for that
 * declaration.
 *
 * The variant-carrier half lives in `polymorphic-carrier.core.types.ts`.
 *
 * WHAT "PROVEN" MEANS HERE, in the projection's own order:
 *  - the asking slot is excluded from its own candidate set, so a self relation
 *    cannot select its own declaration;
 *  - candidates are partitioned by the EXACT literal `.name(...)` claim,
 *    unnamed-to-unnamed included;
 *  - exactly one candidate must survive, AND that candidate's own candidate set
 *    must be exactly the asking slot — the mutual degree-one rule;
 *  - anything else answers `unknown`, which grants no omission and no verb.
 */

import type { AnyModel } from "@src/schema";
import { s } from "@src/schema";
import type {
  AnyNullableMember,
  DerivedNestedKeys,
  MembershipCanBeCleared,
  ModelRelationMemberships,
  SlotMayBeEmpty,
  StaticForeignKeyMembership,
  StaticJunctionMembership,
  StaticResolvedMembership,
  StaticUnknownMembership,
} from "@src/schema/relation/static-membership";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type RelationAt<
  Source extends AnyModel,
  Field extends keyof Source["~"]["state"]["relations"],
> = Source["~"]["state"]["relations"][Field];

type MembershipAt<
  Source extends AnyModel,
  Field extends keyof Source["~"]["state"]["relations"],
> = StaticResolvedMembership<Source, Field, RelationAt<Source, Field>>;

type EmptyAt<
  Source extends AnyModel,
  Field extends keyof Source["~"]["state"]["relations"],
> = SlotMayBeEmpty<Source, Field, RelationAt<Source, Field>>;

// ---------------------------------------------------------------------------
// 1. A STORED REFERENCE, FROM BOTH ENDS
// ---------------------------------------------------------------------------

const user = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  posts: s.toMany(() => post),
  profile: s.toOne(() => profile),
});

const profile = s.model({
  id: s.string().id(),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});

const post = s.model({
  id: s.string().id(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  tags: s.toMany(() => tag),
});

const tag = s.model({
  id: s.string().id(),
  posts: s.toMany(() => post),
});

/** The OWNER carries its own ordered tuple and the nullable subset of it. */
type _theOwnerSeesItsOwnTuple = Expect<
  Equal<
    MembershipAt<typeof post, "author">,
    StaticForeignKeyMembership<"asking", readonly ["authorId"], readonly []>
  >
>;

/** The INVERSE sees the same tuple, named as the other row's. */
type _theInverseSeesTheOwnersTuple = Expect<
  Equal<
    MembershipAt<typeof user, "posts">,
    StaticForeignKeyMembership<"inverse", readonly ["authorId"], readonly []>
  >
>;

/** An all-non-nullable tuple cannot be absent, so the owner slot is not null. */
type _aRequiredOwnerIsNotEmpty = Expect<
  Equal<EmptyAt<typeof post, "author">, false>
>;

/** A nullable tuple can be absent — the ONLY optionality an owner has now. */
type _aNullableOwnerMayBeEmpty = Expect<
  Equal<EmptyAt<typeof profile, "user">, true>
>;

/** A non-owner is always nullable: no referencing row is guaranteed to exist. */
type _aNonOwnerMayAlwaysBeEmpty = Expect<
  Equal<EmptyAt<typeof user, "profile">, true>
>;

/**
 * The inverse of a stored reference omits the owner's columns from a nested
 * payload; the owner itself omits NOTHING, because its columns are on the row
 * spelling the payload rather than on the target (§11.2.21 exactness).
 */
type _theInverseOmitsTheForeignKeyColumns = Expect<
  Equal<
    DerivedNestedKeys<typeof user, "posts", RelationAt<typeof user, "posts">>,
    "authorId"
  >
>;
type _theOwnerOmitsNothing = Expect<
  Equal<
    DerivedNestedKeys<typeof post, "author", RelationAt<typeof post, "author">>,
    never
  >
>;

/** Disconnect follows the nullable subset, from either end of the edge. */
type _aRequiredReferenceCannotBeCleared = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof user,
      "posts",
      RelationAt<typeof user, "posts">
    >,
    false
  >
>;
type _aNullableReferenceClears = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof user,
      "profile",
      RelationAt<typeof user, "profile">
    >,
    true
  >
>;

// ---------------------------------------------------------------------------
// 2. A JUNCTION
// ---------------------------------------------------------------------------

type _bothEndsOfAJunctionAgree = Expect<
  Equal<
    MembershipAt<typeof post, "tags">,
    StaticJunctionMembership
  > extends true
    ? Equal<MembershipAt<typeof tag, "posts">, StaticJunctionMembership>
    : false
>;

/** A junction row goes away; no column on either row is nulled. */
type _aJunctionMembershipAlwaysClears = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof post,
      "tags",
      RelationAt<typeof post, "tags">
    >,
    true
  >
>;

/** A junction membership names no column, so it omits nothing either. */
type _aJunctionOmitsNothing = Expect<
  Equal<
    DerivedNestedKeys<typeof post, "tags", RelationAt<typeof post, "tags">>,
    never
  >
>;

// ---------------------------------------------------------------------------
// 2b. A SELF JUNCTION — TWO TYPE-IDENTICAL SLOTS (§11.2.11, §11.4.6)
// ---------------------------------------------------------------------------

/**
 * Both halves of an unnamed self junction are ONE type: same cardinality, same
 * getter, no name, and the junction side tokens live outside the state's public
 * type. Only the KEY tells them apart, so the mutual degree-one proof has to
 * address the candidate by key. Reading the key back out of the candidate VALUE
 * answers `"follows" | "followedBy"` here, excludes both, and collapses a
 * provable junction into `unknown` — which withdraws `disconnect` from a legal
 * schema.
 */
const peer = s.model({
  id: s.string().id(),
  follows: s.toMany(() => peer),
  followedBy: s.toMany(() => peer),
});

type _theTwoSelfJunctionHalvesAreOneType = Expect<
  Equal<
    RelationAt<typeof peer, "follows">,
    RelationAt<typeof peer, "followedBy">
  >
>;

type _aSelfJunctionResolvesFromBothEnds = Expect<
  Equal<
    MembershipAt<typeof peer, "follows">,
    StaticJunctionMembership
  > extends true
    ? Equal<MembershipAt<typeof peer, "followedBy">, StaticJunctionMembership>
    : false
>;

/** §11.4.6: the self junction publishes `disconnect` like any other junction. */
type _aSelfJunctionMembershipClears = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof peer,
      "follows",
      RelationAt<typeof peer, "follows">
    >,
    true
  >
>;

// ---------------------------------------------------------------------------
// 3. A SELF PAIR WITH A MIXED COMPOUND TUPLE
// ---------------------------------------------------------------------------

const node = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
  children: s.toMany(() => node),
});

/**
 * The asking slot is excluded from its own candidate set, so `parent` pairs
 * with `children` rather than with itself — and the nullable subset is the
 * EXACT ordered part of the tuple that accepts NULL, never the whole tuple
 * (§8.4: disconnect clears these and retains the required context member).
 */
type _theSelfOwnerKeepsItsOrderedTuple = Expect<
  Equal<
    MembershipAt<typeof node, "parent">,
    StaticForeignKeyMembership<
      "asking",
      readonly ["tenantId", "parentId"],
      readonly ["parentId"]
    >
  >
>;
type _theSelfInverseSeesTheSameSubset = Expect<
  Equal<
    MembershipAt<typeof node, "children">,
    StaticForeignKeyMembership<
      "inverse",
      readonly ["tenantId", "parentId"],
      readonly ["parentId"]
    >
  >
>;

/** A mixed tuple with one nullable member IS an absent membership. */
type _aMixedTupleMayBeEmpty = Expect<
  Equal<EmptyAt<typeof node, "parent">, true>
>;
type _aMixedTupleClears = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof node,
      "parent",
      RelationAt<typeof node, "parent">
    >,
    true
  >
>;

/** §11.2.21: the self pair omits the EXACT parent-owned foreign key. */
type _theSelfChildrenSideOmitsTheParentTuple = Expect<
  Equal<
    DerivedNestedKeys<
      typeof node,
      "children",
      RelationAt<typeof node, "children">
    >,
    "tenantId" | "parentId"
  >
>;
type _theSelfParentSideOmitsNothing = Expect<
  Equal<
    DerivedNestedKeys<typeof node, "parent", RelationAt<typeof node, "parent">>,
    never
  >
>;

// ---------------------------------------------------------------------------
// 4. THE EXACT LITERAL-NAME PARTITION
// ---------------------------------------------------------------------------

const author = s.model({
  id: s.string().id(),
  written: s.toMany(() => article).name("Written"),
  edited: s.toMany(() => article).name("Edited"),
});
const article = s.model({
  id: s.string().id(),
  writerId: s.string(),
  editorId: s.string().nullable(),
  writer: s
    .toOne(() => author)
    .name("Written")
    .fields("writerId")
    .references("id"),
  editor: s
    .toOne(() => author)
    .name("Edited")
    .fields("editorId")
    .references("id"),
});

/** Two edges between one pair of models, each partitioned by its own label. */
type _theWrittenPairSelectsTheWriterTuple = Expect<
  Equal<
    MembershipAt<typeof author, "written">,
    StaticForeignKeyMembership<"inverse", readonly ["writerId"], readonly []>
  >
>;
type _theEditedPairSelectsTheEditorTuple = Expect<
  Equal<
    MembershipAt<typeof author, "edited">,
    StaticForeignKeyMembership<
      "inverse",
      readonly ["editorId"],
      readonly ["editorId"]
    >
  >
>;

const unlabelled = s.model({
  id: s.string().id(),
  first: s.toMany(() => labelled),
  second: s.toMany(() => labelled),
});
const labelled = s.model({
  id: s.string().id(),
  hostId: s.string(),
  host: s
    .toOne(() => unlabelled)
    .fields("hostId")
    .references("id"),
});

/**
 * The MUTUAL degree-one rule. `labelled.host` has exactly one candidate KEY, so
 * the forward count alone would prove it — the REVERSE proof is what refuses
 * it, because `host`'s own candidate set holds both `first` and `second`. That
 * makes the first pin below the reverse proof's UNIQUE coverage (measured:
 * deleting the reverse test turns exactly that line red). The second pin is
 * owned by the forward count, from the ambiguous side.
 */
type _anAmbiguousReverseSetProvesNothing = Expect<
  Equal<MembershipAt<typeof unlabelled, "first">, StaticUnknownMembership>
>;
type _theReverseProofRejectsTheAmbiguousPartner = Expect<
  Equal<MembershipAt<typeof labelled, "host">, StaticUnknownMembership>
>;

const decorated = s.model({
  id: s.string().id(),
  slot: s.toMany(() => plain).name("NoSuchPair"),
});
const plain = s.model({
  id: s.string().id(),
  hostId: s.string(),
  host: s
    .toOne(() => decorated)
    .fields("hostId")
    .references("id"),
});

/** A one-sided label is a MISMATCH, not permission to fall back (§6.2 rule 3). */
type _aOneSidedLabelSelectsNothing = Expect<
  Equal<MembershipAt<typeof decorated, "slot">, StaticUnknownMembership>
>;

// ---------------------------------------------------------------------------
// 5. WHAT THE PROJECTION CANNOT SEE
// ---------------------------------------------------------------------------

const lonely = s.model({
  id: s.string().id(),
  peerId: s.string(),
  peer: s
    .toOne(() => hermit)
    .fields("peerId")
    .references("id"),
});
const hermit = s.model({ id: s.string().id() });

/** No candidate at all: unprovable, and the gate refuses the schema (R002). */
type _anUnpairedSlotProvesNothing = Expect<
  Equal<MembershipAt<typeof lonely, "peer">, StaticUnknownMembership>
>;
type _anUnprovenSlotIsNullable = Expect<
  Equal<EmptyAt<typeof lonely, "peer">, true>
>;
type _anUnprovenSlotExposesNoDisconnect = Expect<
  Equal<
    MembershipCanBeCleared<
      typeof lonely,
      "peer",
      RelationAt<typeof lonely, "peer">
    >,
    false
  >
>;
type _anUnprovenSlotOmitsNothing = Expect<
  Equal<
    DerivedNestedKeys<typeof lonely, "peer", RelationAt<typeof lonely, "peer">>,
    never
  >
>;

const baseOwner = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  owner: s
    .toOne(() => holder)
    .fields("ownerId")
    .references("id"),
});
const holder = s.model({
  id: s.string().id(),
  owned: s.toMany(() => baseOwner),
});
const derivedOwner = baseOwner.extends({ extra: s.string() });

/**
 * `.extends()` produces a NEW model, and `holder.owned` still names the BASE,
 * so the derived model has no proven partner. FAIL-CLOSED, not an omission the
 * runtime shares: the resolver pairs the derived model's contextual slots.
 */
type _anExtendedSourceFailsClosed = Expect<
  Equal<MembershipAt<typeof derivedOwner, "owner">, StaticUnknownMembership>
>;

// ---------------------------------------------------------------------------
// 6. NULLABILITY OF A LOCAL TUPLE
// ---------------------------------------------------------------------------

type _anAllRequiredTupleIsNotNullable = Expect<
  Equal<AnyNullableMember<typeof node, readonly ["tenantId"]>, false>
>;
type _oneNullableMemberMakesTheTupleNullable = Expect<
  Equal<AnyNullableMember<typeof node, readonly ["tenantId", "parentId"]>, true>
>;
/** A WIDENED tuple is honestly `boolean`, and every reader treats it as nullable. */
type _aWidenedTupleIsBoolean = Expect<
  Equal<AnyNullableMember<typeof node, readonly string[]>, boolean>
>;

// ---------------------------------------------------------------------------
// 7. RECURSION DOES NOT COLLAPSE (§11.1.14)
// ---------------------------------------------------------------------------

type _userIsNotAny = Expect<IsAny<typeof user> extends false ? true : false>;
type _postIsNotAny = Expect<IsAny<typeof post> extends false ? true : false>;
type _nodeIsNotAny = Expect<IsAny<typeof node> extends false ? true : false>;
type _theUserMembershipViewIsNotAny = Expect<
  IsAny<ModelRelationMemberships<typeof user>> extends false ? true : false
>;
type _theNodeMembershipViewIsNotAny = Expect<
  IsAny<ModelRelationMemberships<typeof node>> extends false ? true : false
>;
