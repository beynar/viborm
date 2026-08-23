/**
 * The modifier matrix: every modifier is available only in its cell, the
 * fields/references staging admits only complete foreign keys, `.name(...)`
 * composes anywhere and obeys last-call-wins, and the variant member-junction
 * map is exact at both levels.
 *
 * Plan §4.3 (modifier matrix), §4.4 (variant `.through()`), falsifiers
 * §11.1.7-9, §11.1.12.
 */

import { s } from "@src/schema";

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

const target = s.model({ id: s.string().id(), label: s.string() });
const other = s.model({ id: s.string().id() });

// ---------------------------------------------------------------------------
// §11.1.7 — one cell per modifier
// ---------------------------------------------------------------------------

// @ts-expect-error - a model-target to-one derives emptiness; there is no `.optional()`
s.toOne(() => target).optional();

// @ts-expect-error - a to-many does not own foreign-key fields
s.toMany(() => target).fields("targetId");

// @ts-expect-error - a model-target to-one owns no junction table
s.toOne(() => target).through("source_targets");

// @ts-expect-error - a model-target to-one owns no junction side token
s.toOne(() => target).source("sourceId");

// @ts-expect-error - a model-target to-one owns no junction side token
s.toOne(() => target).target("targetId");

// @ts-expect-error - the paired slot cardinality owns uniqueness; there is no `.unique()`
s.toMany(() => target).unique();

// @ts-expect-error - the paired slot cardinality owns uniqueness; there is no `.unique()`
s.toOne(() => target).unique();

// @ts-expect-error - `.A()` is replaced by `.source()`
s.toMany(() => target).A("sourceId");

// @ts-expect-error - `.B()` is replaced by `.target()`
s.toMany(() => target).B("targetId");

// @ts-expect-error - a variant to-one exposes no member-junction configuration
s.toOne({ post: () => target }).through({
  post: { table: "t", source: "s", target: "g" },
});

// @ts-expect-error - an empty collection is already the empty case
s.toMany({ post: () => target }).optional();

// @ts-expect-error - a variant carrier owns private storage, not a public foreign key
s.toOne({ post: () => target }).fields("subjectId");

// ---------------------------------------------------------------------------
// §11.1.8 — the transient references stage
// ---------------------------------------------------------------------------

// @ts-expect-error - `.fields()` requires a non-empty tuple
s.toOne(() => target).fields();

s.toOne(() => target)
  .fields("tenantId", "parentId")
  // @ts-expect-error - `.references()` must have the same arity as `.fields()`
  .references("id");

const incompleteForeignKeyStage = s.toOne(() => target).fields("targetId");

// @ts-expect-error - the stage exposes only `.references()` and `.name()`
incompleteForeignKeyStage.onDelete("cascade");

// @ts-expect-error - the stage exposes only `.references()` and `.name()`
incompleteForeignKeyStage.fields("otherId");

s.model({
  id: s.string().id(),
  // @ts-expect-error - a transient references stage is not a model member
  broken: incompleteForeignKeyStage,
});

/** A completed pair IS a model member, and its tuple survives verbatim. */
const owner = s
  .toOne(() => target)
  .fields("targetId")
  .references("id");

type _completedPairKeepsItsLocalTuple = Expect<
  Equal<StateOf<typeof owner>["foreignKey"]["fields"], readonly ["targetId"]>
>;
type _completedPairKeepsItsReferencedTuple = Expect<
  Equal<StateOf<typeof owner>["foreignKey"]["references"], readonly ["id"]>
>;

/**
 * A second stage replaces the PAIR atomically and preserves the endpoint's name
 * and actions; the prior terminal keeps its own tuple.
 */
const replaced = s
  .toOne(() => target)
  .name("Replaced")
  .fields("targetId")
  .references("id")
  .onDelete("cascade")
  .fields("tenantId")
  .references("id");

type _replacementKeepsTheName = Expect<
  Equal<StateOf<typeof replaced>["name"], "Replaced">
>;
type _replacementReplacesTheTuple = Expect<
  Equal<StateOf<typeof replaced>["foreignKey"]["fields"], readonly ["tenantId"]>
>;
type _replacementKeepsTheAction = Expect<
  Equal<StateOf<typeof replaced>["foreignKey"]["onDelete"], "cascade">
>;
type _priorTerminalIsUnchanged = Expect<
  Equal<StateOf<typeof owner>["foreignKey"]["fields"], readonly ["targetId"]>
>;

// ---------------------------------------------------------------------------
// §11.1.9 — `.name()` on all four terminals, composing anywhere, last-call-wins
// ---------------------------------------------------------------------------

const namedModelToOne = s.toOne(() => target).name("Author");
const namedModelToMany = s.toMany(() => target).name("Posts");
const namedVariantToOne = s.toOne({ post: () => target }).name("Subject");
const namedVariantToMany = s.toMany({ post: () => target }).name("Items");

type _modelToOneKeepsItsLabel = Expect<
  Equal<StateOf<typeof namedModelToOne>["name"], "Author">
>;
type _modelToManyKeepsItsLabel = Expect<
  Equal<StateOf<typeof namedModelToMany>["name"], "Posts">
>;
type _variantToOneKeepsItsLabel = Expect<
  Equal<StateOf<typeof namedVariantToOne>["name"], "Subject">
>;
type _variantToManyKeepsItsLabel = Expect<
  Equal<StateOf<typeof namedVariantToMany>["name"], "Items">
>;

/** Last-call-wins: the new value carries the last literal, not their union. */
const renamed = s
  .toOne(() => target)
  .name("First")
  .name("Second");
type _lastNameWins = Expect<Equal<StateOf<typeof renamed>["name"], "Second">>;

const renamedCollection = s
  .toMany(() => target)
  .name("First")
  .name("Second");
type _lastCollectionNameWins = Expect<
  Equal<StateOf<typeof renamedCollection>["name"], "Second">
>;

/** Before, between, and after the foreign-key stage. */
const namedBefore = s
  .toOne(() => target)
  .name("Before")
  .fields("targetId")
  .references("id");
const namedBetween = s
  .toOne(() => target)
  .fields("targetId")
  .name("Between")
  .references("id");
const namedAfter = s
  .toOne(() => target)
  .fields("targetId")
  .references("id")
  .name("After");

type _nameBeforeSurvives = Expect<
  Equal<StateOf<typeof namedBefore>["name"], "Before">
>;
type _nameBetweenSurvives = Expect<
  Equal<StateOf<typeof namedBetween>["name"], "Between">
>;
type _nameAfterSurvives = Expect<
  Equal<StateOf<typeof namedAfter>["name"], "After">
>;

const unownedToOne = s.toOne(() => target);
// @ts-expect-error - FK actions exist only after `.references(...)`
unownedToOne.onDelete("cascade");

const namedUnownedToOne = s.toOne(() => target).name("Author");
// @ts-expect-error - FK actions exist only after `.references(...)`
namedUnownedToOne.onUpdate("cascade");

/** The action lands inside the completed foreign key, not beside it. */
const withActions = s
  .toOne(() => target)
  .fields("targetId")
  .references("id")
  .onDelete("cascade")
  .onUpdate("restrict");

type _deleteActionIsPartOfTheForeignKey = Expect<
  Equal<StateOf<typeof withActions>["foreignKey"]["onDelete"], "cascade">
>;
type _updateActionIsPartOfTheForeignKey = Expect<
  Equal<StateOf<typeof withActions>["foreignKey"]["onUpdate"], "restrict">
>;

// ---------------------------------------------------------------------------
// §11.1.12 — the variant member-junction map is exact at BOTH levels
// ---------------------------------------------------------------------------

const bothVariants = s.toMany({ post: () => target, video: () => other });

bothVariants.through({
  post: { table: "mention_post", source: "mentionId", target: "postId" },
  video: { table: "mention_video", source: "mentionId", target: "videoId" },
});

// @ts-expect-error - the map is total over every variant
bothVariants.through({
  post: { table: "mention_post", source: "mentionId", target: "postId" },
});

s.toMany({ post: () => target }).through({
  post: { table: "t", source: "s", target: "g" },
  // @ts-expect-error - the variant through map is exact at the outer level
  video: { table: "v", source: "s", target: "g" },
});

s.toMany({ post: () => target }).through({
  // @ts-expect-error - the variant through map is exact at the inner level
  post: { table: "t", source: "s", target: "g", extra: 1 },
});
