import { s } from "@src/schema";
import type { GetPolymorphicInverseBinding } from "@src/schema";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() =>
    Value extends Right ? 1 : 2
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
const relation = s.polymorphic(targets, { values });

type _targetKeysRemainExact = Expect<
  Equal<keyof typeof relation["~"]["state"]["targets"], "target" | "second">
>;
type _storedValueRemainsLiteral = Expect<
  Equal<
    typeof relation["~"]["state"]["values"]["target"],
    "content.target.v1"
  >
>;

s.polymorphic(targets, {
  // @ts-expect-error - non-fresh values still require every target key
  values: { target: "content.target.v1" },
});
const extraValues = Object.freeze({
  ...values,
  other: "content.other.v1",
});
s.polymorphic(targets, {
  // @ts-expect-error - non-fresh values refuse extra keys structurally
  values: extraValues,
});

const self = s.model({
  id: s.string().id(),
  parent: s.polymorphic(
    { self: () => self },
    { values: { self: "tree.self.v1" } }
  ),
});
type _selfDoesNotCollapse = Expect<IsAny<typeof self> extends false ? true : false>;

const left = s.model({
  id: s.string().id(),
  right: s.polymorphic(
    { right: () => right },
    { values: { right: "pair.right.v1" } }
  ),
});
const right = s.model({
  id: s.string().id(),
  left: s.polymorphic(
    { left: () => left },
    { values: { left: "pair.left.v1" } }
  ),
});
type _leftDoesNotCollapse = Expect<IsAny<typeof left> extends false ? true : false>;
type _rightDoesNotCollapse = Expect<
  IsAny<typeof right> extends false ? true : false
>;

const inverseSource = s.model({ id: s.string().id() });
const soleInverseTarget = s.model({
  id: s.string().id(),
  subject: s
    .polymorphic(
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
    .polymorphic(
      { source: () => inverseSource },
      { values: { source: "source.first.v1" } }
    )
    .name("shared"),
  second: s
    .polymorphic(
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
  duplicate: s.polymorphic(
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
    .polymorphic(
      { source: () => inverseSource },
      { values: { source: "source.selected.v1" } }
    )
    .name("selected"),
  duplicate: s
    .polymorphic(
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
  subject: s.polymorphic(
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
  unnamed: s.polymorphic(
    { source: () => inverseSource },
    { values: { source: "source.unnamed.v1" } }
  ),
  named: s
    .polymorphic(
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
    .polymorphic(
      { post: () => compatiblePost, video: () => compatibleVideo },
      { values: { post: "post.v1", video: "video.v1" } }
    )
    .name("subject"),
  attachment: s
    .polymorphic(
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
    .polymorphic(
      { post: () => separateIdenticalPost },
      { values: { post: "post.v1" } }
    )
    .name("subject"),
  attachment: s
    .polymorphic(
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
