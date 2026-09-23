/**
 * The relation world shared by the G4 fixed read witnesses.
 *
 * Deliberately restricted to simple scalars, so that a filter, order, page or
 * projection witness that fails here fails because of the read feature it
 * names, not because of a codec — the codec rows have their own world in
 * `read-codecs.test.ts`. The ONE exception is `author.score`, an `s.number()`:
 * it is outside the four domains the frozen candidate decodes (`string`,
 * `int`, `float`, `decimal`, see `handoff.md` §3.1) and it is deliberately the
 * column the `{ sort, nulls }` witness orders by, so that cell is red on the
 * codec and not on the ordering feature.
 *
 * Every mapped name differs from its field name, both to-one orientations are
 * present (a child-held reference and a parent-held reference), the root key is
 * a mapped compound key, and the world carries an ordinary junction, a variant
 * collection and a self-relation.
 */
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { s } from "@schema";

export const AUTHOR_TABLE = "g4_read_authors";
export const POST_TABLE = "g4_read_posts";
export const PROFILE_TABLE = "g4_read_profiles";
export const TAG_TABLE = "g4_read_tags";
export const AUTHOR_TAG_TABLE = "g4_read_author_tags";
export const BOARD_TABLE = "g4_read_boards";
export const BOARD_POST_TABLE = "g4_read_board_posts";
export const BOARD_TAG_TABLE = "g4_read_board_tags";

export function relationWorldSchema() {
  const author = s
    .model({
      tenant: s.string().map("tenant_key"),
      handle: s.string().map("author_handle"),
      name: s.string().map("display_name"),
      rank: s.int().map("author_rank"),
      score: s.number().nullable().map("author_score"),
      bio: s.string().nullable().map("author_bio"),
      mentorTenant: s.string().nullable().map("mentor_tenant_key"),
      mentorHandle: s.string().nullable().map("mentor_handle"),
      mentor: s
        .toOne(() => author)
        .fields("mentorTenant", "mentorHandle")
        .references("tenant", "handle")
        .name("mentorship"),
      mentees: s.toMany(() => author).name("mentorship"),
      posts: s.toMany(() => post),
      profile: s.toOne(() => profile),
      tags: s.toMany(() => tag).through(AUTHOR_TAG_TABLE),
    })
    .id(["tenant", "handle"])
    .map(AUTHOR_TABLE);

  const post = s
    .model({
      id: s.int().id(),
      slug: s.string().unique().map("post_slug"),
      title: s.string().map("post_title"),
      views: s.int().map("view_count"),
      rating: s.decimal({ precision: 8, scale: 2 }).nullable().map("post_rating"),
      authorTenant: s.string().nullable().map("author_tenant_key"),
      authorHandle: s.string().nullable().map("author_handle_key"),
      author: s
        .toOne(() => author)
        .fields("authorTenant", "authorHandle")
        .references("tenant", "handle"),
    })
    .map(POST_TABLE);

  const profile = s
    .model({
      id: s.int().id(),
      headline: s.string().map("headline_text"),
      ownerTenant: s.string().map("owner_tenant_key"),
      ownerHandle: s.string().map("owner_handle_key"),
      owner: s
        .toOne(() => author)
        .fields("ownerTenant", "ownerHandle")
        .references("tenant", "handle"),
    })
    .unique(["ownerTenant", "ownerHandle"])
    .map(PROFILE_TABLE);

  const tag = s
    .model({
      id: s.int().id(),
      label: s.string().unique().map("tag_label"),
      weight: s.int().map("tag_weight"),
      authors: s.toMany(() => author),
    })
    .map(TAG_TABLE);

  const board = s
    .model({
      id: s.int().id(),
      title: s.string().map("board_title"),
      items: s
        .toMany(
          { post: () => post, tag: () => tag },
          { values: { post: "item.post.v1", tag: "item.tag.v1" } }
        )
        .through({
          post: { table: BOARD_POST_TABLE, source: "board", target: "item" },
          tag: { table: BOARD_TAG_TABLE, source: "board", target: "item" },
        }),
    })
    .map(BOARD_TABLE);

  return { author, post, profile, tag, board };
}

export const LEDGER_TABLE = "g4_read_ledgers";

/** A schema-level default omit, so Q-S01's "unselected worlds" rule is visible. */
export function omitWorldSchema() {
  const ledger = s
    .model({
      id: s.int().id(),
      label: s.string().map("ledger_label"),
      secret: s.string().map("ledger_secret"),
      note: s.string().nullable().map("ledger_note"),
    })
    .omit({ secret: true })
    .map(LEDGER_TABLE);
  return { ledger };
}

export function seedLedgerWorld(database: Database.Database): void {
  database.exec(`
    INSERT INTO ${LEDGER_TABLE} (id, ledger_label, ledger_secret, ledger_note)
    VALUES (1,'first','hidden-one','note one'),(2,'second','hidden-two',NULL);
  `);
}

export type RelationWorldSchema = ReturnType<typeof relationWorldSchema>;

export function seedRelationWorld(database: Database.Database): void {
  database.exec(`
    INSERT INTO ${AUTHOR_TABLE}
      (tenant_key, author_handle, display_name, author_rank, author_score, author_bio, mentor_tenant_key, mentor_handle)
    VALUES
      ('acme','ada','Ada',1,4.5,'founder',NULL,NULL),
      ('acme','bob','Bob',2,NULL,NULL,'acme','ada'),
      ('acme','cy','Cy',3,2.5,'writer','acme','ada'),
      ('beta','ada','Ada Beta',1,9.5,NULL,NULL,NULL),
      ('beta','dee','Dee',4,0.5,'lurker','beta','ada');

    INSERT INTO ${POST_TABLE}
      (id, post_slug, post_title, view_count, post_rating, author_tenant_key, author_handle_key)
    VALUES
      (1,'p-one','One',10,'1250','acme','ada'),
      (2,'p-two','Two',20,'999','acme','ada'),
      (3,'p-three','Three',5,NULL,'acme','bob'),
      (4,'p-four','Four',30,'25000','beta','ada'),
      (5,'p-five','Five',0,NULL,NULL,NULL);

    INSERT INTO ${PROFILE_TABLE} (id, headline_text, owner_tenant_key, owner_handle_key)
    VALUES (1,'Ada writes','acme','ada'),(2,'Bob builds','acme','bob'),(3,'Beta Ada','beta','ada');

    INSERT INTO ${TAG_TABLE} (id, tag_label, tag_weight)
    VALUES (1,'alpha',5),(2,'beta',3),(3,'gamma',1);

    INSERT INTO ${BOARD_TABLE} (id, board_title) VALUES (1,'Main'),(2,'Spare');
  `);
}

/**
 * Junction membership is seeded by physical column position after the layout
 * pin below has asserted that layout, so the witness never guesses a name.
 */
export function seedJunctions(database: Database.Database): void {
  const authorTags = junctionColumns(database, AUTHOR_TAG_TABLE);
  const insertAuthorTag = database.prepare(
    `INSERT INTO ${AUTHOR_TAG_TABLE} (${authorTags.join(",")}) VALUES (${authorTags.map(() => "?").join(",")})`
  );
  for (const values of [
    ["acme", "ada", 1],
    ["acme", "ada", 2],
    ["acme", "bob", 2],
    ["beta", "ada", 3],
  ]) {
    insertAuthorTag.run(...values);
  }
  for (const [table, rows] of [
    [BOARD_POST_TABLE, [[1, 1], [1, 2]]],
    [BOARD_TAG_TABLE, [[1, 1]]],
  ] as const) {
    const columns = junctionColumns(database, table);
    const insert = database.prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
    );
    for (const values of rows) insert.run(...values);
  }
}

export function junctionColumns(
  database: Database.Database,
  table: string
): string[] {
  const info = database.prepare(`PRAGMA table_info(${table})`).all();
  const names: string[] = [];
  for (const column of info) {
    assert.ok(column && typeof column === "object" && "name" in column);
    names.push(String((column as { name: unknown }).name));
  }
  return names;
}

export function tableColumns(database: Database.Database): Record<string, string[]> {
  const layout: Record<string, string[]> = {};
  for (const table of [
    AUTHOR_TABLE,
    POST_TABLE,
    PROFILE_TABLE,
    TAG_TABLE,
    AUTHOR_TAG_TABLE,
    BOARD_TABLE,
    BOARD_POST_TABLE,
    BOARD_TAG_TABLE,
  ]) {
    layout[table] = junctionColumns(database, table);
  }
  return layout;
}
