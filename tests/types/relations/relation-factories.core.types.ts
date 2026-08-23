/**
 * The two relation factories: overload selection, exact inference, the variant
 * map/options contract, and recursion safety.
 *
 * Plan §4.1 (overloads), §4.2 (variant-map contract), §5.1 (state algebra),
 * falsifiers §11.1.1-6, §11.1.14, §11.1.16 (type half).
 */

import { s } from "@src/schema";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type StateOf<Relation> = Relation extends {
  readonly "~": { readonly state: infer State };
}
  ? State
  : never;

// ---------------------------------------------------------------------------
// A mutually recursive graph, a self pair, two named self pairs, and an
// `.extends()`-derived model — the shapes §11.1.14 measures.
// ---------------------------------------------------------------------------

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  posts: s.toMany(() => post).name("PostAuthor"),
  profile: s.toOne(() => profile),
});

const profile = s.model({
  id: s.string().id(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("PostAuthor")
    .fields("authorId")
    .references("id"),
  tags: s.toMany(() => tag),
  comments: s.toMany(() => comment),
});

const tag = s.model({
  id: s.string().id(),
  label: s.string(),
  posts: s.toMany(() => post),
});

const video = s.model({ id: s.string().id(), url: s.string() });

/** Row-held variant carrier. */
const comment = s.model({
  id: s.string().id(),
  body: s.string(),
  subject: s
    .toOne({
      post: () => post,
      video: () => video,
    })
    .optional(),
});

/** Member-junction variant carrier with explicit stored values. */
const mention = s.model({
  id: s.string().id(),
  items: s.toMany(
    { post: () => post, video: () => video },
    { values: { post: "content.post.v1", video: "content.video.v1" } }
  ),
});

const node = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .name("Tree")
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
  children: s.toMany(() => node).name("Tree"),
});

const person = s.model({
  id: s.string().id(),
  managerId: s.string().nullable(),
  manager: s
    .toOne(() => person)
    .name("Chain")
    .fields("managerId")
    .references("id"),
  reports: s.toMany(() => person).name("Chain"),
});

const document = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  tenant: s
    .toOne(() => tenant)
    .fields("tenantId")
    .references("id"),
});

const archivedDocument = document.extends({
  archivedAt: s.string().nullable(),
});

const tenant = s.model({
  id: s.string().id(),
  documents: s.toMany(() => document),
});

// ---------------------------------------------------------------------------
// §11.1.1 — the getter overload infers the EXACT model target on both factories
// ---------------------------------------------------------------------------

type PostShape = (typeof post)["~"]["state"]["shape"];
type UserShape = (typeof user)["~"]["state"]["shape"];

type _toOneGetterKeepsTheExactGetter = Expect<
  Equal<StateOf<PostShape["author"]>["target"]["getter"], () => typeof user>
>;
type _toManyGetterKeepsTheExactGetter = Expect<
  Equal<StateOf<UserShape["posts"]>["target"]["getter"], () => typeof post>
>;
type _toOneIsSingular = Expect<
  Equal<StateOf<PostShape["author"]>["cardinality"], "one">
>;
type _toManyIsACollection = Expect<
  Equal<StateOf<UserShape["posts"]>["cardinality"], "many">
>;
type _modelTargetIsNamedOnce = Expect<
  Equal<StateOf<PostShape["author"]>["target"]["kind"], "model">
>;
type _everyDeclarationCarriesTheRelationBrand = Expect<
  Equal<StateOf<UserShape["posts"]>["kind"], "relation">
>;

// ---------------------------------------------------------------------------
// §11.1.2 — the map overload preserves the exact variant keys on both factories
// ---------------------------------------------------------------------------

type CommentShape = (typeof comment)["~"]["state"]["shape"];
type MentionShape = (typeof mention)["~"]["state"]["shape"];

type _variantToOneKeysStayExact = Expect<
  Equal<
    keyof StateOf<CommentShape["subject"]>["target"]["entries"],
    "post" | "video"
  >
>;
type _variantToManyKeysStayExact = Expect<
  Equal<
    keyof StateOf<MentionShape["items"]>["target"]["entries"],
    "post" | "video"
  >
>;
type _variantTargetIsNamedOnce = Expect<
  Equal<StateOf<CommentShape["subject"]>["target"]["kind"], "variants">
>;
type _variantCarrierIsSingular = Expect<
  Equal<StateOf<CommentShape["subject"]>["cardinality"], "one">
>;
type _memberJunctionCarrierIsACollection = Expect<
  Equal<StateOf<MentionShape["items"]>["cardinality"], "many">
>;
type _variantEntryKeepsItsExactGetter = Expect<
  Equal<
    StateOf<CommentShape["subject"]>["target"]["entries"]["video"]["getter"],
    () => typeof video
  >
>;

// ---------------------------------------------------------------------------
// §11.1.6 — a stored discriminator is runtime storage, never a public type
// parameter. This deliberately INVERTS the retired literal-value pins.
// ---------------------------------------------------------------------------

const defaultedVariants = s.toOne({ post: () => post, video: () => video });

type _explicitStoredValueIsAString = Expect<
  Equal<
    StateOf<MentionShape["items"]>["target"]["entries"]["post"]["storedValue"],
    string
  >
>;
type _defaultedStoredValueIsAString = Expect<
  Equal<
    StateOf<
      typeof defaultedVariants
    >["target"]["entries"]["post"]["storedValue"],
    string
  >
>;

/** Explicit `undefined` options are equivalent to omission (§4.2). */
const explicitlyDefaultedVariants = s.toOne(
  { post: () => post, video: () => video },
  undefined
);
type _explicitUndefinedKeepsTheDefaults = Expect<
  Equal<
    keyof StateOf<typeof explicitlyDefaultedVariants>["target"]["entries"],
    "post" | "video"
  >
>;

/** Getter form has exactly one argument, even when the second is undefined. */
// @ts-expect-error - getter form has no options argument
s.toOne(() => post, undefined);
// @ts-expect-error - getter form has no options argument
s.toOne(() => post, { values: {} });
// @ts-expect-error - getter form has no options argument
s.toMany(() => post, undefined);
// @ts-expect-error - getter form has no options argument
s.toMany(() => post, { values: {} });

/** Map form still accepts explicit undefined options on both factories. */
s.toOne({ post: () => post }, undefined);
s.toMany({ post: () => post }, undefined);

// ---------------------------------------------------------------------------
// §11.1.3 / §11.1.4 / §11.1.5 — refused targets and options
// ---------------------------------------------------------------------------

declare const looseVariantMap: Record<string, () => typeof video>;

// @ts-expect-error - a broad string-index map has already lost the finite key union
s.toOne(looseVariantMap);

// @ts-expect-error - a broad string-index map has already lost the finite key union
s.toMany(looseVariantMap);

// @ts-expect-error - an empty variant map has no variants
s.toOne({});

// @ts-expect-error - an empty variant map has no variants
s.toMany({});

// @ts-expect-error - a direct model is not a lazy getter
s.toOne({ video });

// @ts-expect-error - a direct model is not a relation target
s.toOne(video);

// @ts-expect-error - a direct model is not a relation target
s.toMany(video);

// @ts-expect-error - `values` must be total over the variant keys
s.toOne({ post: () => post, video: () => video }, { values: { post: "p" } });

s.toOne(
  { post: () => post, video: () => video },
  {
    values: { post: "p", video: "v" },
    // @ts-expect-error - unknown sibling option beside `values`
    unknownOption: true,
  }
);

s.toOne(
  { post: () => post, video: () => video },
  {
    // @ts-expect-error - an extra key beside the real variant keys
    values: { post: "p", video: "v", audio: "a" },
  }
);

// @ts-expect-error - `{}` is not a valid options object; omit it to use defaults
s.toOne({ post: () => post, video: () => video }, {});

/**
 * Exactness is STRUCTURAL, not excess-property checking: a bag held in a
 * variable is not fresh, so EPC never runs on it (AGENTS.md rule 3).
 */
const nonFreshPartialValues = { values: { post: "p" } };
// @ts-expect-error - a non-fresh options bag is refused structurally
s.toMany({ post: () => post, video: () => video }, nonFreshPartialValues);

const nonFreshExtraOption = {
  values: { post: "p", video: "v" },
  unknownOption: true,
};
// @ts-expect-error - a non-fresh unknown sibling option is refused structurally
s.toMany({ post: () => post, video: () => video }, nonFreshExtraOption);

// ---------------------------------------------------------------------------
// §11.1.14 — nothing collapses to `any`
// ---------------------------------------------------------------------------

type _userIsNotAny = Expect<IsAny<typeof user> extends false ? true : false>;
type _postIsNotAny = Expect<IsAny<typeof post> extends false ? true : false>;
type _profileIsNotAny = Expect<
  IsAny<typeof profile> extends false ? true : false
>;
type _tagIsNotAny = Expect<IsAny<typeof tag> extends false ? true : false>;
type _commentIsNotAny = Expect<
  IsAny<typeof comment> extends false ? true : false
>;
type _mentionIsNotAny = Expect<
  IsAny<typeof mention> extends false ? true : false
>;
type _nodeIsNotAny = Expect<IsAny<typeof node> extends false ? true : false>;
type _personIsNotAny = Expect<
  IsAny<typeof person> extends false ? true : false
>;
type _tenantIsNotAny = Expect<
  IsAny<typeof tenant> extends false ? true : false
>;
type _documentIsNotAny = Expect<
  IsAny<typeof document> extends false ? true : false
>;
type _archivedDocumentIsNotAny = Expect<
  IsAny<typeof archivedDocument> extends false ? true : false
>;
