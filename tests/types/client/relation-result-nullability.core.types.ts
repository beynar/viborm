/**
 * WHAT A RELATION READS BACK AS — derived, never declared.
 *
 * A model-target relation carries no `.optional()` any more (§5.1). Emptiness
 * follows the stored tuple under the any-nullable-member rule, and a non-owner
 * is always nullable because no referencing row is guaranteed to exist (§8.1).
 * This file measures that through client calls, at the surface a caller reads.
 *
 * It also carries the asking-key evidence §10D asks for: TWO NAMED SELF PAIRS
 * on one model stay separated, through the core client and through a driver
 * wrapper, because the projection excludes the asking slot from its own
 * candidate set and partitions the rest by their exact literal labels.
 */

import { createClient } from "@client/client";
import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import { s } from "@schema";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const writer = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => article),
  draft: s.toOne(() => draft),
});

const article = s.model({
  id: s.string().id(),
  title: s.string(),
  writerId: s.string(),
  // REQUIRED: the local tuple cannot be NULL, so the slot cannot be empty.
  writer: s
    .toOne(() => writer)
    .fields("writerId")
    .references("id"),
});

const draft = s.model({
  id: s.string().id(),
  body: s.string(),
  writerId: s.string().unique().nullable(),
  // OPTIONAL: one nullable member makes the whole membership absent-able.
  writer: s
    .toOne(() => writer)
    .fields("writerId")
    .references("id"),
});

const client = createClient({
  schema: { writer, article, draft },
  driver: new PGliteDriver(),
});

const requiredOwner = () =>
  client.article.findMany({ include: { writer: true } });
type RequiredOwnerRows = Awaited<ReturnType<typeof requiredOwner>>;

type _aRequiredOwnerReadsBackNonNull = Expect<
  Equal<RequiredOwnerRows[number]["writer"], { id: string; name: string }>
>;

const optionalOwner = () =>
  client.draft.findMany({ include: { writer: true } });
type OptionalOwnerRows = Awaited<ReturnType<typeof optionalOwner>>;

type _aNullableOwnerReadsBackNullable = Expect<
  Equal<
    OptionalOwnerRows[number]["writer"],
    { id: string; name: string } | null
  >
>;

const nonOwner = () => client.writer.findMany({ include: { draft: true } });
type NonOwnerRows = Awaited<ReturnType<typeof nonOwner>>;

type _aNonOwnerReadsBackNullable = Expect<
  Equal<
    NonOwnerRows[number]["draft"],
    { id: string; body: string; writerId: string | null } | null
  >
>;

const collection = () => client.writer.findMany({ include: { posts: true } });
type CollectionRows = Awaited<ReturnType<typeof collection>>;

/** A collection is NEVER `| null`: an empty collection is `[]`. */
type _aCollectionReadsBackAsAnArray = Expect<
  Equal<
    CollectionRows[number]["posts"],
    { id: string; title: string; writerId: string }[]
  >
>;

// ---------------------------------------------------------------------------
// TWO NAMED SELF PAIRS, through the core client AND a driver wrapper
// ---------------------------------------------------------------------------

const folder = s.model({
  id: s.string().id(),
  name: s.string(),
  parentId: s.string().nullable(),
  archiveId: s.string().nullable(),
  parent: s
    .toOne(() => folder)
    .name("Tree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => folder).name("Tree"),
  archive: s
    .toOne(() => folder)
    .name("Archive")
    .fields("archiveId")
    .references("id"),
  archived: s.toMany(() => folder).name("Archive"),
});

const folderClient = createClient({
  schema: { folder },
  driver: new PGliteDriver(),
});

const wrappedFolderClient = createPGliteClient({ schema: { folder } });

const selfPairs = () =>
  folderClient.folder.findMany({
    include: { parent: true, children: true, archive: true, archived: true },
  });
type SelfPairRows = Awaited<ReturnType<typeof selfPairs>>;

type FolderRow = {
  id: string;
  name: string;
  parentId: string | null;
  archiveId: string | null;
};

/** Both singular sides are nullable — their tuples accept NULL. */
type _bothNamedSelfParentsAreNullable = Expect<
  Equal<SelfPairRows[number]["parent"], FolderRow | null> extends true
    ? Equal<SelfPairRows[number]["archive"], FolderRow | null>
    : false
>;
type _bothNamedSelfCollectionsAreArrays = Expect<
  Equal<SelfPairRows[number]["children"], FolderRow[]> extends true
    ? Equal<SelfPairRows[number]["archived"], FolderRow[]>
    : false
>;

/**
 * The two pairs stay SEPARATE: each nested payload omits only the tuple its own
 * label proves, so a `children.create` may still spell `archiveId` and an
 * `archived.create` may still spell `parentId`. Spelled keys under `data` are
 * at the estate's exactness ceiling, so this is a compile-SUCCESS pin; the
 * refusal it guards is the one the runtime schema owns.
 */
const _eachSelfPairOmitsOnlyItsOwnTuple = () =>
  folderClient.folder.update({
    where: { id: "f1" },
    data: {
      children: { create: { id: "c1", name: "child", archiveId: "a1" } },
      archived: { create: { id: "a2", name: "archived", parentId: "f1" } },
    },
  });

/** The same two pairs, reached through the DRIVER WRAPPER's own entry point. */
const wrappedSelfPairs = () =>
  wrappedFolderClient.folder.findMany({
    include: { parent: true, archived: true },
  });
type WrappedSelfPairRows = Awaited<ReturnType<typeof wrappedSelfPairs>>;

type _theWrapperKeepsTheSameTwoPairs = Expect<
  Equal<WrappedSelfPairRows[number]["parent"], FolderRow | null> extends true
    ? Equal<WrappedSelfPairRows[number]["archived"], FolderRow[]>
    : false
>;

const _theWrapperKeysItsRelationClause = () =>
  wrappedFolderClient.folder.findMany({
    // @ts-expect-error - "childrn" is refused beside the real `children`
    include: { children: true, childrn: true },
  });
