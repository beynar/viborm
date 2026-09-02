/**
 * The corpus schemas (pattern-engine-ideal-state.md §13.3, unit A).
 *
 * Three small schemas that between them exercise every storage kind the cell
 * map (§4) distinguishes, so that every corpus payload has a home:
 *
 * - `fk`       — row-held ordinary references: child-held to-many and to-one
 *                (nullable and required), a compound reference on one edge, a
 *                parent-held owner, a database-generated key, a compound
 *                primary key, and both referential actions a key transition
 *                cares about (`cascade` and a non-cascading one).
 * - `junction` — the implicit junction (plural on both sides).
 * - `poly`     — a row-held polymorphic reference (`.optional()` and required)
 *                and a polymorphic collection with one plural and one singular
 *                inverse member.
 * - `keys`     — the three KEY shapes the other three lack, each of which a
 *                semantic refusal names: a float primary key (arithmetic on it
 *                is not portable), a NUMERIC foreign key (the only spelling
 *                that admits a non-literal relation-key write), and an edge
 *                whose foreign key IS the row key (a merge supplying it cannot
 *                resolve one final value).
 *
 * Each schema is hydrated and validated at module load, exactly as the client
 * would, so a corpus payload never meets an unvalidated topology.
 */
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";

export type CorpusSchema = Record<string, Model<any>>;

// ---------------------------------------------------------------------------
// fk — row-held ordinary references
// ---------------------------------------------------------------------------

export const fk = (() => {
  const org = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      name: s.string(),
      // child-held to-many, nullable reference, ON UPDATE CASCADE
      teams: s.toMany(() => team),
      // child-held to-one, nullable reference
      profile: s.toOne(() => profile),
      // child-held to-one, REQUIRED reference
      settings: s.toOne(() => settings),
    })
    .map("pc_orgs");

  const team = s
    .model({
      id: s.string().id(),
      label: s.string(),
      orgId: s.string().nullable(),
      // parent-held owner of a nullable reference
      org: s
        .toOne(() => org)
        .fields("orgId")
        .references("id")
        .onUpdate("cascade"),
      // child-held to-many whose reference is REQUIRED on the child
      tickets: s.toMany(() => ticket),
    })
    .map("pc_teams");

  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string(),
      orgId: s.string().nullable().unique(),
      org: s
        .toOne(() => org)
        .fields("orgId")
        .references("id"),
    })
    .map("pc_profiles");

  const settings = s
    .model({
      id: s.string().id(),
      theme: s.string(),
      orgId: s.string().unique(),
      org: s
        .toOne(() => org)
        .fields("orgId")
        .references("id"),
    })
    .map("pc_settings");

  const ticket = s
    .model({
      // database-generated key
      id: s.int().id().increment(),
      title: s.string(),
      teamId: s.string(),
      // parent-held owner of a REQUIRED reference
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
    })
    .map("pc_tickets");

  const zone = s
    .model({
      region: s.string(),
      code: s.string(),
      label: s.string(),
      spots: s.toMany(() => spot),
    })
    // compound primary key
    .id(["region", "code"])
    .map("pc_zones");

  const spot = s
    .model({
      id: s.string().id(),
      name: s.string(),
      zoneRegion: s.string().nullable(),
      zoneCode: s.string().nullable(),
      // compound reference, non-cascading action
      zone: s
        .toOne(() => zone)
        .fields("zoneRegion", "zoneCode")
        .references("region", "code")
        .onUpdate("restrict"),
    })
    .map("pc_spots");

  return { org, team, profile, settings, ticket, zone, spot };
})();

// ---------------------------------------------------------------------------
// junction — the implicit junction
// ---------------------------------------------------------------------------

export const junction = (() => {
  const student = s
    .model({
      id: s.string().id(),
      name: s.string(),
      email: s.string().unique(),
      courses: s.toMany(() => course),
    })
    .map("pc_students");

  const course = s
    .model({
      id: s.string().id(),
      title: s.string(),
      code: s.string().unique(),
      students: s.toMany(() => student),
    })
    .map("pc_courses");

  return { student, course };
})();

// ---------------------------------------------------------------------------
// poly — polymorphic row-held references and collections
// ---------------------------------------------------------------------------

export const poly = (() => {
  const post = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
      // plural inverse of the optional row-held reference
      comments: s.toMany(() => comment).name("commentable"),
      // singular inverse of the REQUIRED row-held reference
      spotlight: s.toOne(() => spotlight).name("subject"),
      // plural inverse member of the collection
      shelves: s.toMany(() => shelf),
    })
    .map("pc_posts");

  const video = s
    .model({
      // row-held variants must share one portable key representation (P002)
      id: s.int().id().increment(),
      title: s.string(),
      comments: s.toMany(() => comment).name("commentable"),
      spotlight: s.toOne(() => spotlight).name("subject"),
    })
    .map("pc_videos");

  const comment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      // row-held polymorphic reference, OPTIONAL
      commentable: s
        .toOne(
          { post: () => post, video: () => video },
          { values: { post: "pc.post.v1", video: "pc.video.v1" } }
        )
        .name("commentable")
        .optional(),
    })
    .map("pc_comments");

  const spotlight = s
    .model({
      id: s.string().id(),
      caption: s.string(),
      // row-held polymorphic reference, REQUIRED
      subject: s
        .toOne(
          { post: () => post, video: () => video },
          { values: { post: "pc.spot.post.v1", video: "pc.spot.video.v1" } }
        )
        .name("subject"),
    })
    .map("pc_spotlights");

  const clip = s
    .model({
      id: s.int().id(),
      title: s.string(),
      // SINGULAR inverse member of the collection
      shelf: s.toOne(() => shelf),
    })
    .map("pc_clips");

  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      // polymorphic collection: `post` has a plural inverse, `clip` a singular one
      items: s.toMany(
        { post: () => post, clip: () => clip },
        { values: { post: "pc.shelf.post.v1", clip: "pc.shelf.clip.v1" } }
      ),
    })
    .map("pc_shelves");

  return { post, video, comment, spotlight, clip, shelf };
})();

// ---------------------------------------------------------------------------
// keys — the key shapes a semantic refusal names
// ---------------------------------------------------------------------------

export const keys = (() => {
  const reading = s
    .model({
      // FLOAT primary key: `{ increment }` on it is refused as non-portable.
      id: s.number().id(),
      label: s.string(),
      samples: s.toMany(() => sample),
    })
    .map("pc_readings");

  const sample = s
    .model({
      id: s.int().id(),
      value: s.string(),
      // NUMERIC foreign key: the int update grammar admits `{ increment }`,
      // which is the non-literal relation-key write nothing else can spell.
      readingId: s.number().nullable(),
      reading: s
        .toOne(() => reading)
        .fields("readingId")
        .references("id"),
    })
    .map("pc_samples");

  const device = s
    .model({
      // DATABASE-generated key, so a merge's missing arm cannot spell it.
      id: s.int().id().increment(),
      name: s.string(),
      calibration: s.toOne(() => calibration),
    })
    .map("pc_devices");

  const calibration = s
    .model({
      // The reference IS this row's key: a merge that supplies it has to
      // resolve one final value for the record's own primary key, and a fresh
      // device's key is not one until it is written.
      deviceId: s.int().id(),
      offset: s.string(),
      device: s
        .toOne(() => device)
        .fields("deviceId")
        .references("id"),
    })
    .map("pc_calibrations");

  return { reading, sample, device, calibration };
})();

for (const schema of [fk, junction, poly, keys]) {
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
}

/** The corpus schemas by name, as `payloads.ts` addresses them. */
export const schemas = { fk, junction, poly, keys } as const;

export type SchemaName = keyof typeof schemas;
