import { s } from "@schema";

/**
 * The schema the database-namespace falsifiers read and write.
 *
 * Every model carries a `.map()`ed object name and every junction is named, so
 * a statement that qualifies a table shows the namespace beside a name the
 * schema chose. The graph covers each persistent-table shape the runtime
 * renders: a root table, a foreign-key target, an explicit `.through()`
 * junction with its target, a self junction, and — for plan §10's "ordinary and
 * VARIANT nested reads" and "variant junction paths" — both variant carriers:
 * a row-held `toOne` and a collection `toMany` with its two inverse views.
 */
export const namespaceSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      age: s.int().nullable(),
      posts: s.toMany(() => post),
      tags: s
        .toMany(() => tag)
        .through("ns_user_tags")
        .source("user_ref")
        .target("tag_ref"),
      // A self junction whose table name the schema never spells: the generated
      // name must stay free of namespace text.
      follows: s
        .toMany(() => user)
        .source("followerId")
        .target("followedId"),
      followedBy: s.toMany(() => user),
    })
    .map("ns_users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("ns_posts");

  const tag = s
    .model({
      id: s.string().id(),
      label: s.string().unique(),
      users: s.toMany(() => user),
    })
    .map("ns_tags");

  // ---------------------------------------------------------------------------
  // VARIANT FAMILY 1 — ROW-HELD carrier.
  //
  // The membership lives in a private `(subject_type, subject_id)` pair on the
  // note's own row, so every variant read and filter reaches its target table
  // through a CASE arm or an EXISTS subquery rather than through a join.
  // ---------------------------------------------------------------------------
  const image = s
    .model({
      id: s.string().id(),
      url: s.string(),
    })
    .map("ns_images");

  const clip = s
    .model({
      id: s.string().id(),
      seconds: s.int(),
    })
    .map("ns_clips");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      subject: s.toOne(
        { image: () => image, clip: () => clip },
        { values: { image: "ns.image.v1", clip: "ns.clip.v1" } }
      ),
    })
    .map("ns_notes");

  // ---------------------------------------------------------------------------
  // VARIANT FAMILY 2 — COLLECTION carrier.
  //
  // The membership lives in one MEMBER JUNCTION per variant, generated as
  // `${ownerTable}_${field}_${variant}`, so the qualification census sees a
  // junction name the schema never spells. Both inverse views are declared —
  // `article.board` is the fields-less SINGULAR inverse (backed by the unique
  // over the member junction's complete target side) and `photo.boards` the
  // PLURAL one — so the member junction is also reached from the target side.
  // ---------------------------------------------------------------------------
  const article = s
    .model({
      id: s.string().id(),
      title: s.string(),
      rank: s.int(),
      board: s.toOne(() => board),
    })
    .map("ns_articles");

  const photo = s
    .model({
      id: s.string().id(),
      caption: s.string(),
      boards: s.toMany(() => board),
    })
    .map("ns_photos");

  const board = s
    .model({
      id: s.string().id(),
      items: s.toMany(
        { article: () => article, photo: () => photo },
        { values: { article: "ns.article.v1", photo: "ns.photo.v1" } }
      ),
    })
    .map("ns_boards");

  return { user, post, tag, image, clip, note, article, photo, board };
})();

/**
 * Every persistent object name this schema publishes, including the junction
 * name the self relation generates and the two member junctions the variant
 * collection generates.
 */
export const NAMESPACE_SCHEMA_TABLES = [
  "ns_users",
  "ns_posts",
  "ns_tags",
  "ns_user_tags",
  "user_user",
  "ns_images",
  "ns_clips",
  "ns_notes",
  "ns_articles",
  "ns_photos",
  "ns_boards",
  "ns_boards_items_article",
  "ns_boards_items_photo",
] as const;
