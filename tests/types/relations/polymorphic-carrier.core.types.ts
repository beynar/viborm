import type { AnyModel, GetPolymorphicInverseBinding } from "@src/schema";
import { s } from "@src/schema";
import { PolymorphicToManyRelation } from "@src/schema/relation";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

const target = s.model({ id: s.string().id() });
const secondTarget = s.model({ id: s.string().id() });
const targets = Object.freeze({
  target: () => target,
  second: () => secondTarget,
});
const values = Object.freeze({
  target: "content.target.v1",
  second: "content.second.v1",
});
const relation = s.polymorphicToOne(targets, { values });
const defaultedRelation = s.polymorphicToOne(targets);
const explicitlyDefaultedRelation = s.polymorphicToOne(targets, undefined);

type _targetKeysRemainExact = Expect<
  Equal<keyof (typeof relation)["~"]["state"]["targets"], "target" | "second">
>;
type _storedValueRemainsLiteral = Expect<
  Equal<
    (typeof relation)["~"]["state"]["values"]["target"],
    "content.target.v1"
  >
>;
type _defaultedStoredValuesUseLiteralPublicKeys = Expect<
  Equal<
    (typeof defaultedRelation)["~"]["state"]["values"],
    { readonly target: "target"; readonly second: "second" }
  >
>;
type _explicitUndefinedUsesTheSameDefaults = Expect<
  Equal<
    (typeof explicitlyDefaultedRelation)["~"]["state"]["values"],
    (typeof defaultedRelation)["~"]["state"]["values"]
  >
>;

// @ts-expect-error - non-fresh values still require every target key
s.polymorphicToOne(targets, {
  values: { target: "content.target.v1" },
});
const extraValues = Object.freeze({
  ...values,
  other: "content.other.v1",
});
// @ts-expect-error - non-fresh values refuse extra keys structurally
s.polymorphicToOne(targets, {
  values: extraValues,
});
// @ts-expect-error - fresh values refuse an unknown target key
s.polymorphicToOne(targets, {
  values: { ...values, other: "content.other.v1" },
});
// The OPTIONS BAG is exact too, both freshness modes — a non-fresh bag with a
// sibling key beside `values` is the case excess-property checking cannot see.
// @ts-expect-error - fresh options bag refuses unknown sibling keys
s.polymorphicToOne(targets, { values, junk: true });
const nonFreshBag = { values, junk: true } as const;
// @ts-expect-error - non-fresh options bag refuses unknown sibling keys
s.polymorphicToOne(targets, nonFreshBag);

// The SECOND factory carries its own copy of both instruments, so it needs its
// own evidence: dropping `NoExtraKeys` from either signature must redden here
// and not be covered by the to-one block above.
const collectionRelation = s.polymorphicToMany(targets, { values });
type _collectionStoredValueRemainsLiteral = Expect<
  Equal<
    (typeof collectionRelation)["~"]["state"]["values"]["target"],
    "content.target.v1"
  >
>;
// @ts-expect-error - non-fresh values still require every target key
s.polymorphicToMany(targets, {
  values: { target: "content.target.v1" },
});
// @ts-expect-error - non-fresh values refuse extra keys structurally
s.polymorphicToMany(targets, { values: extraValues });
// @ts-expect-error - non-fresh options bag refuses unknown sibling keys
s.polymorphicToMany(targets, nonFreshBag);

const self = s.model({
  id: s.string().id(),
  parent: s.polymorphicToOne(
    { self: () => self },
    { values: { self: "tree.self.v1" } }
  ),
});
type _selfDoesNotCollapse = Expect<
  IsAny<typeof self> extends false ? true : false
>;

const left = s.model({
  id: s.string().id(),
  right: s.polymorphicToOne(
    { right: () => right },
    { values: { right: "pair.right.v1" } }
  ),
});
const right = s.model({
  id: s.string().id(),
  left: s.polymorphicToOne(
    { left: () => left },
    { values: { left: "pair.left.v1" } }
  ),
});
type _leftDoesNotCollapse = Expect<
  IsAny<typeof left> extends false ? true : false
>;
type _rightDoesNotCollapse = Expect<
  IsAny<typeof right> extends false ? true : false
>;

// WHERE THE CONSUMER COVERAGE FOR THIS TYPE ALSO LIVES.
//
// Every `GetPolymorphicInverseBinding` assertion below names the type alias
// rather than a call a user writes. Measured against the hazard
// `PolymorphicStateOf`'s own docblock names: collapsing the alias to `never`
// reddens SEVEN of the assertions below (all TS2344, the ones pinning a concrete
// `{ readonly relationKey: … }`), while the six that assert `never` stay green
// by construction. So this block does catch the collapse — through the alias.
//
// `tests/types/relations/polymorphic-operation-schemas.core.types.ts` catches
// the same collapse a different way, at 19 sites, 11 of them spelled as a user
// spells them: `inverseClient.<model>.<op>({ ... })`. Per AGENTS.md only that
// second form is evidence about what the EDITOR does. The two blocks are not
// duplication and neither may be deleted as such.
const inverseSource = s.model({ id: s.string().id() });
const soleInverseTarget = s.model({
  id: s.string().id(),
  subject: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.sole.v1" } }
    )
    .name("declared"),
});
type _soleInverseIgnoresDecorativeMismatch = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof soleInverseTarget,
      typeof inverseSource,
      "mismatch"
    >,
    { readonly relationKey: "subject" }
  >
>;

const multipleInverseTarget = s.model({
  id: s.string().id(),
  first: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.first.v1" } }
    )
    .name("shared"),
  second: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.second.v1" } }
    )
    .name("shared"),
});
type _multipleInverseNeedsName = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof multipleInverseTarget,
      typeof inverseSource,
      undefined
    >,
    never
  >
>;
type _missingInverseNameSelectsNothing = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof multipleInverseTarget,
      typeof inverseSource,
      "missing"
    >,
    never
  >
>;
type _ambiguousInverseNameSelectsNothing = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof multipleInverseTarget,
      typeof inverseSource,
      "shared"
    >,
    never
  >
>;

const duplicateSelectedTarget = s.model({
  id: s.string().id(),
  duplicate: s.polymorphicToOne(
    { first: () => inverseSource, second: () => inverseSource },
    {
      values: {
        first: "source.duplicate-first.v1",
        second: "source.duplicate-second.v1",
      },
    }
  ),
});
type _typeBindingCarriesOnlyTheSelectedRelationGroup = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof duplicateSelectedTarget,
      typeof inverseSource,
      undefined
    >,
    { readonly relationKey: "duplicate" }
  >
>;

const duplicateUnselectedTarget = s.model({
  id: s.string().id(),
  selected: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.selected.v1" } }
    )
    .name("selected"),
  duplicate: s
    .polymorphicToOne(
      { first: () => inverseSource, second: () => inverseSource },
      {
        values: {
          first: "source.duplicate-first.v1",
          second: "source.duplicate-second.v1",
        },
      }
    )
    .name("other"),
});
type _unselectedDuplicateDoesNotPoisonSelectedInverse = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof duplicateUnselectedTarget,
      typeof inverseSource,
      "selected"
    >,
    { readonly relationKey: "selected" }
  >
>;

const identicalPost = s.model({ id: s.string().id() });
const identicalVideo = s.model({ id: s.string().id() });
const identicalTarget = s.model({
  id: s.string().id(),
  subject: s.polymorphicToOne(
    { post: () => identicalPost, video: () => identicalVideo },
    { values: { post: "post.v1", video: "video.v1" } }
  ),
});
type _identicalTargetShapesStillSelectTheRelationGroup = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof identicalTarget,
      typeof identicalPost,
      undefined
    >,
    { readonly relationKey: "subject" }
  >
>;

const unnamedAndNamedTarget = s.model({
  id: s.string().id(),
  unnamed: s.polymorphicToOne(
    { source: () => inverseSource },
    { values: { source: "source.unnamed.v1" } }
  ),
  named: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.named.v1" } }
    )
    .name("named"),
});
type _undefinedNeverSelectsAnUnnamedGroupAmongSeveral = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof unnamedAndNamedTarget,
      typeof inverseSource,
      undefined
    >,
    never
  >
>;

const compatiblePost = s.model({
  id: s.string().id(),
  postOnly: s.string(),
});
const compatibleVideo = s.model({
  id: s.string().id(),
  videoOnly: s.string(),
});
const unrelatedImage = s.model({
  id: s.string().id(),
  imageOnly: s.string(),
});
const unrelatedPdf = s.model({
  id: s.string().id(),
  pdfOnly: s.string(),
});
const independentlyGroupedTarget = s.model({
  id: s.string().id(),
  subject: s
    .polymorphicToOne(
      { post: () => compatiblePost, video: () => compatibleVideo },
      { values: { post: "post.v1", video: "video.v1" } }
    )
    .name("subject"),
  attachment: s
    .polymorphicToOne(
      { image: () => unrelatedImage, pdf: () => unrelatedPdf },
      { values: { image: "image.v1", pdf: "pdf.v1" } }
    )
    .name("attachment"),
});
type _multipleGroupsRequireANameEvenWhenTheirShapesDiffer = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof independentlyGroupedTarget,
      typeof compatiblePost,
      undefined
    >,
    never
  >
>;
type _nameSelectsOneStructurallyCompatibleGroup = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof independentlyGroupedTarget,
      typeof compatiblePost,
      "subject"
    >,
    { readonly relationKey: "subject" }
  >
>;

const separateIdenticalPost = s.model({ id: s.string().id() });
const separateIdenticalVideo = s.model({ id: s.string().id() });
const separatelyGroupedIdenticalTargets = s.model({
  id: s.string().id(),
  subject: s
    .polymorphicToOne(
      { post: () => separateIdenticalPost },
      { values: { post: "post.v1" } }
    )
    .name("subject"),
  attachment: s
    .polymorphicToOne(
      { video: () => separateIdenticalVideo },
      { values: { video: "video.v1" } }
    )
    .name("attachment"),
});
type _identicalShapesInSeparateGroupsCannotGuessByIdentity = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof separatelyGroupedIdenticalTargets,
      typeof separateIdenticalPost,
      undefined
    >,
    never
  >
>;
type _aNameDisambiguatesSeparateIdenticalShapeGroups = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof separatelyGroupedIdenticalTargets,
      typeof separateIdenticalPost,
      "subject"
    >,
    { readonly relationKey: "subject" }
  >
>;

// Package A's rewrite moved this answer, and nothing consumes the difference.
// At base 39a0f12e the deleted `Relation extends PolymorphicRelation<infer
// State>` distributed over `any` and produced `never`; `PolymorphicStateOf<any>`
// does not distribute, so an `AnyModel` target now resolves a binding whose
// `relationKey` is the unnarrowed `string`. No user-visible difference was
// demonstrated either way — this records the current answer so that a future
// move of it is a decision rather than a surprise.
type _anyTargetResolvesAnUnnarrowedRelationKey = Expect<
  Equal<
    GetPolymorphicInverseBinding<AnyModel, typeof inverseSource, undefined>,
    { readonly relationKey: string }
  >
>;

// Second recorded divergence, same family: an `any`-typed `.name()` argument.
// Base spelled the name test `State["name"] extends Name ? Key : never`, so an
// any-named relation matched EVERY queried name and forced ambiguity — the
// binding was `never` beside a real-named sibling. The rewritten
// `RelationCarriesName` gates on `extends true`; `any` splits to `boolean`,
// fails the gate, and the any-named sibling is EXCLUDED — so the literal-named
// sibling now binds where base refused. Runtime candidate collection still
// surfaces both relations, so the optimistic type stays runtime-guarded.
const anyName = JSON.parse('"loose"') as ReturnType<JSON["parse"]>;
const anyNamedSibling = s.model({
  id: s.string().id(),
  loose: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.loose.v1" } }
    )
    .name(anyName),
  strict: s
    .polymorphicToOne(
      { source: () => inverseSource },
      { values: { source: "source.strict.v1" } }
    )
    .name("real"),
});
type _anyNamedSiblingIsExcludedRatherThanAmbiguous = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof anyNamedSibling,
      typeof inverseSource,
      "real"
    >,
    { readonly relationKey: "strict" }
  >
>;

// Third recorded divergence: a UNION of carriers at one relation key (only
// reachable from declare-level or generic user code — no `s.*` chain builds
// one). Base distributed the source-containment test per union member; the
// rewrite merges the states first, so target keys shared by NO member vanish
// and the binding conservatively resolves `never`. Refusal, not unsoundness.
declare const unionCarrier:
  | ReturnType<
      typeof s.polymorphicToOne<{ readonly a: () => typeof inverseSource }>
    >
  | ReturnType<
      typeof s.polymorphicToOne<{ readonly b: () => typeof inverseSource }>
    >;
declare const unionModelState: {
  readonly "~": {
    readonly state: {
      readonly polymorphicRelations: {
        readonly subject: typeof unionCarrier;
      };
    };
  };
};
type _unionCarrierResolvesConservativeNever = Expect<
  Equal<
    GetPolymorphicInverseBinding<
      typeof unionModelState,
      typeof inverseSource,
      undefined
    >,
    never
  >
>;

// --- PACKAGE A: the factory IS the cardinality, and the argument is MAP ONLY ---

const carrierTarget = s.model({ id: s.string().id() });

// A bare thunk reads like an ordinary edge and would silently build a private
// `(type, id)` pair where the caller expected a foreign key, so both factories
// refuse it — `TargetMapOnly` in `src/schema/relation/polymorphic.ts` is what
// does the refusing, and the four ordinary factories are named in the message.
// Each refusal is paired with the map spelling that must keep compiling, so a
// green pin cannot mean "this surface refuses everything".
// @ts-expect-error - a single target getter is an ordinary relation, not a carrier
s.polymorphicToOne(() => carrierTarget);
s.polymorphicToOne({ carrierTarget: () => carrierTarget });
// @ts-expect-error - a single target getter is an ordinary relation, not a carrier
s.polymorphicToMany(() => carrierTarget);
s.polymorphicToMany({ carrierTarget: () => carrierTarget });

s.polymorphicToMany({ carrierTarget: () => carrierTarget })
  // @ts-expect-error - a collection has no second reading of emptiness
  .optional();

// The FORCED half of the same rule. The chain above cannot REACH `.optional()`;
// this pins that a collection STATE cannot CARRY one, so a caller who bypasses
// the factory and constructs the terminal directly is refused here rather than
// reaching definition validation.
new PolymorphicToManyRelation({
  type: "polymorphic",
  cardinality: "many",
  targets: { carrierTarget: () => carrierTarget },
  values: { carrierTarget: "carrierTarget" },
  // @ts-expect-error - a collection state has no `optional` to carry
  optional: true,
});

const collectionSelf = s.model({
  id: s.string().id(),
  children: s.polymorphicToMany(
    { collectionSelf: () => collectionSelf },
    { values: { collectionSelf: "tree.collectionSelf.v1" } }
  ),
});
type _collectionSelfDoesNotCollapse = Expect<
  IsAny<typeof collectionSelf> extends false ? true : false
>;

const collectionLeft = s.model({
  id: s.string().id(),
  rights: s.polymorphicToMany(
    { collectionRight: () => collectionRight },
    { values: { collectionRight: "pair.collectionRight.v1" } }
  ),
});
const collectionRight = s.model({
  id: s.string().id(),
  lefts: s.polymorphicToMany(
    { collectionLeft: () => collectionLeft },
    { values: { collectionLeft: "pair.collectionLeft.v1" } }
  ),
});
type _collectionLeftDoesNotCollapse = Expect<
  IsAny<typeof collectionLeft> extends false ? true : false
>;
type _collectionRightDoesNotCollapse = Expect<
  IsAny<typeof collectionRight> extends false ? true : false
>;

// --- PACKAGE B2: `.through()` is exact in both directions ---
//
// Every public variant must appear, no extra variant key and no extra entry key
// is admitted — fresh or held in a variable (`NoExtraKeys`, the structural
// instrument, not excess-property checking). P017 is the runtime mirror.

const throughLeft = s.model({ id: s.string().id() });
const throughRight = s.model({ id: s.string().id() });
const throughTargets = Object.freeze({
  left: () => throughLeft,
  right: () => throughRight,
});

const throughComplete = s.polymorphicToMany(throughTargets).through({
  left: { table: "o_items_left", source: "oId", target: "leftId" },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
});
type _throughKeysRemainExact = Expect<
  Equal<
    keyof NonNullable<(typeof throughComplete)["~"]["state"]["through"]>,
    "left" | "right"
  >
>;
type _throughTableRemainsLiteral = Expect<
  Equal<
    NonNullable<
      (typeof throughComplete)["~"]["state"]["through"]
    >["left"]["table"],
    "o_items_left"
  >
>;

s.polymorphicToMany(throughTargets)
  // @ts-expect-error - every public variant must appear in .through()
  .through({
    left: { table: "o_items_left", source: "oId", target: "leftId" },
  });

s.polymorphicToMany(throughTargets).through({
  left: { table: "o_items_left", source: "oId", target: "leftId" },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
  // @ts-expect-error - an unknown variant key is refused beside the real ones
  extra: { table: "o_items_extra", source: "oId", target: "extraId" },
});

s.polymorphicToMany(throughTargets).through({
  left: {
    table: "o_items_left",
    source: "oId",
    target: "leftId",
    // @ts-expect-error - an unknown entry key is refused beside the real ones
    onDelete: "cascade",
  },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
});

s.polymorphicToMany(throughTargets).through({
  // @ts-expect-error - entry values are the three junction names, all strings
  left: { table: 42, source: "oId", target: "leftId" },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
});

const heldExtraVariantThrough = Object.freeze({
  left: { table: "o_items_left", source: "oId", target: "leftId" },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
  extra: { table: "o_items_extra", source: "oId", target: "extraId" },
});
s.polymorphicToMany(throughTargets)
  // @ts-expect-error - non-fresh maps refuse extra variant keys structurally
  .through(heldExtraVariantThrough);

const heldExtraEntryKey = Object.freeze({
  left: {
    table: "o_items_left",
    source: "oId",
    target: "leftId",
    onDelete: "cascade",
  },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
});
s.polymorphicToMany(throughTargets)
  // @ts-expect-error - non-fresh entries refuse extra entry keys structurally
  .through(heldExtraEntryKey);

const heldCompleteThrough = Object.freeze({
  left: { table: "o_items_left", source: "oId", target: "leftId" },
  right: { table: "o_items_right", source: "oId", target: "rightId" },
});
s.polymorphicToMany(throughTargets).through(heldCompleteThrough);

s.polymorphicToOne(throughTargets)
  // @ts-expect-error - a to-one carrier has no `.through()`
  .through({
    left: { table: "o_items_left", source: "oId", target: "leftId" },
    right: { table: "o_items_right", source: "oId", target: "rightId" },
  });

const collectionThroughSelf = s.model({
  id: s.string().id(),
  children: s
    .polymorphicToMany(
      { self: () => collectionThroughSelf },
      { values: { self: "tree.self.v1" } }
    )
    .through({
      self: {
        table: "node_children_self",
        source: "parentRef",
        target: "childRef",
      },
    }),
});
type _collectionThroughSelfDoesNotCollapse = Expect<
  IsAny<typeof collectionThroughSelf> extends false ? true : false
>;
