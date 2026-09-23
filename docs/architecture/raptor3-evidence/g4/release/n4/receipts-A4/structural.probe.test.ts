/**
 * N4/A4 reachability probe, part 1 — STRUCTURAL.
 *
 * Rows 48 and 49 of the refusal census ask whether an ADMITTED SCHEMA, built
 * with the public `s.*` builder, can produce
 *  - a physical field that names neither a scalar nor a variant carrier's
 *    type/id column (`buildPhysicalFieldView`), or
 *  - a variant member name that resolves neither tagged nor untagged
 *    (`variantMember`).
 *
 * This file enumerates, for a corpus of admitted schemas covering the whole
 * declaration surface, EVERY (model, field) the engine can ask a physical
 * field for and EVERY (model, relation, variant) it can bind a membership
 * for, and asks for each one.
 */
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { describe, expect, it } from "vitest";

type Fixture = Record<string, AnyModel>;

// ---------------------------------------------------------------------------
// The corpus: every declaration shape the two factories admit.
// ---------------------------------------------------------------------------

/** FK (simple + compound + self), ordinary junction, mapped names everywhere. */
function ordinaryWorld(): Fixture {
  const author: any = s
    .model({
      tenant: s.string().map("tenant_key"),
      handle: s.string().map("author_handle"),
      name: s.string().map("display_name"),
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
      tags: s.toMany(() => tag).through("a4_author_tags"),
    })
    .id(["tenant", "handle"])
    .map("a4_authors");
  const post: any = s
    .model({
      id: s.int().id(),
      slug: s.string().unique().map("post_slug"),
      views: s.int().map("view_count"),
      authorTenant: s.string().nullable().map("author_tenant_key"),
      authorHandle: s.string().nullable().map("author_handle_key"),
      author: s
        .toOne(() => author)
        .fields("authorTenant", "authorHandle")
        .references("tenant", "handle"),
    })
    .map("a4_posts");
  const profile: any = s
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
    .map("a4_profiles");
  const tag: any = s
    .model({
      id: s.int().id(),
      label: s.string().unique().map("tag_label"),
      authors: s.toMany(() => author),
    })
    .map("a4_tags");
  return { author, post, profile, tag };
}

/** `s.toOne(map)` — a variant ROW carrier, in all four inverse cells. */
function rowCarrierWorld(options: {
  readonly optional: boolean;
  readonly inverse: "one" | "many" | "none";
  readonly mapped: boolean;
}): Fixture {
  const inverseSlot = (): any =>
    options.inverse === "one"
      ? s.toOne(() => comment).name("subject")
      : s.toMany(() => comment).name("subject");
  const post: any = s
    .model({
      id: s.string().id(),
      title: s.string().map(options.mapped ? "post_title" : "title"),
      ...(options.inverse === "none" ? {} : { back: inverseSlot() }),
    })
    .map("a4_row_posts");
  const video: any = s
    .model({
      id: s.string().id(),
      title: s.string(),
      ...(options.inverse === "none" ? {} : { back: inverseSlot() }),
    })
    .map("a4_row_videos");
  const carrier: any = { post: () => post, video: () => video };
  const comment: any = s
    .model({
      id: s.string().id(),
      body: s.string().map(options.mapped ? "comment_body" : "body"),
      subject: options.optional
        ? s
            .toOne(carrier, {
              values: { post: "content.post.v1", video: "content.video.v1" },
            })
            .name("subject")
            .optional()
        : s.toOne(carrier).name("subject"),
    })
    .map("a4_row_comments");
  return { post, video, comment };
}

/** `s.toMany(map)` — a variant JUNCTION carrier, generated and pinned names. */
function junctionCarrierWorld(options: {
  readonly inverse: "one" | "many" | "none";
  readonly through: boolean;
}): Fixture {
  const inverseSlot = (): any =>
    options.inverse === "one"
      ? s.toOne(() => board).name("items")
      : s.toMany(() => board).name("items");
  const post: any = s
    .model({
      id: s.int().id(),
      title: s.string().map("post_title"),
      ...(options.inverse === "none" ? {} : { shelves: inverseSlot() }),
    })
    .map("a4_j_posts");
  const tag: any = s
    .model({
      id: s.int().id(),
      label: s.string().map("tag_label"),
      ...(options.inverse === "none" ? {} : { shelves: inverseSlot() }),
    })
    .map("a4_j_tags");
  const map: any = { post: () => post, tag: () => tag };
  const board: any = s
    .model({
      id: s.int().id(),
      title: s.string().map("board_title"),
      items: options.through
        ? s
            .toMany(map, {
              values: { post: "item.post.v1", tag: "item.tag.v1" },
            })
            .name("items")
            .through({
              post: { table: "a4_board_posts", source: "board", target: "item" },
              tag: { table: "a4_board_tags", source: "board", target: "item" },
            })
        : s.toMany(map).name("items"),
    })
    .map("a4_boards");
  return { post, tag, board };
}

/** One model carrying BOTH carrier families beside ordinary storage. */
function mixedWorld(): Fixture {
  const post: any = s
    .model({
      id: s.int().id(),
      title: s.string().map("post_title"),
      notes: s.toMany(() => note).name("subject"),
      shelves: s.toMany(() => hub).name("items"),
    })
    .map("a4_mixed_posts");
  const video: any = s
    .model({
      id: s.int().id(),
      title: s.string(),
      notes: s.toMany(() => note).name("subject"),
      shelves: s.toMany(() => hub).name("items"),
    })
    .map("a4_mixed_videos");
  const note: any = s
    .model({
      id: s.int().id(),
      body: s.string(),
      subject: s
        .toOne({ post: () => post, video: () => video })
        .name("subject")
        .optional(),
      second: s
        .toOne({ post: () => post, video: () => video })
        .name("second")
        .optional(),
    })
    .map("a4_notes");
  const hub: any = s
    .model({
      id: s.int().id(),
      label: s.string(),
      items: s.toMany({ post: () => post, video: () => video }).name("items"),
    })
    .map("a4_hubs");
  return { post, video, note, hub };
}

const CORPUS: readonly (readonly [string, Fixture])[] = [
  ["ordinary", ordinaryWorld()],
  ["row-carrier optional, to-many inverse, mapped", rowCarrierWorld({ optional: true, inverse: "many", mapped: true })],
  ["row-carrier optional, to-one inverse", rowCarrierWorld({ optional: true, inverse: "one", mapped: false })],
  ["row-carrier required, no inverse", rowCarrierWorld({ optional: false, inverse: "none", mapped: false })],
  ["row-carrier required, to-many inverse", rowCarrierWorld({ optional: false, inverse: "many", mapped: false })],
  ["junction-carrier generated names, to-many inverse", junctionCarrierWorld({ inverse: "many", through: false })],
  ["junction-carrier pinned names, to-one inverse", junctionCarrierWorld({ inverse: "one", through: true })],
  ["junction-carrier no inverse", junctionCarrierWorld({ inverse: "none", through: false })],
  ["mixed carriers", mixedWorld()],
];

// ---------------------------------------------------------------------------
// The enumeration.
// ---------------------------------------------------------------------------

/** Every (model, field) a bound membership makes the engine ask about. */
function physicalAsks(edge: Membership): [AnyModel, string][] {
  const asks: [AnyModel, string][] = [];
  if (edge.kind === "reference") {
    for (const pair of edge.pairs) {
      asks.push([edge.source, pair.source]);
      asks.push([edge.target, pair.target]);
    }
    if (edge.discriminator)
      asks.push([
        edge.discriminator.side === "source" ? edge.source : edge.target,
        edge.discriminator.field,
      ]);
  } else {
    for (const side of [edge.sourceSide, edge.targetSide])
      for (const pair of side.members)
        asks.push([side.model as AnyModel, pair.referencedField]);
  }
  return asks;
}

describe("N4/A4 rows 48+49 — what an admitted schema can ask for", () => {
  it.each(CORPUS.map(([name]) => name))(
    "%s: every physical field the engine asks for resolves",
    (name) => {
      const fixture = CORPUS.find(([label]) => label === name)![1];
      const engine = new EngineSchema(fixture as any);
      const asked: string[] = [];
      for (const model of Object.values(fixture)) {
        // (a) everything the model stores.
        for (const field of engine.storedFields(model)) {
          expect(() => engine.physicalField(model, field)).not.toThrow();
          asked.push(`${model["~"].names.sql}.${field}`);
        }
        // (b) every row-key field.
        for (const field of engine.keys(model))
          expect(() => engine.physicalField(model, field)).not.toThrow();
        // (c) every field any bound membership names, on either endpoint.
        for (const [relation, resolved] of engine.index.get(model)!) {
          const carrier =
            resolved.member === undefined &&
            (resolved.edge.kind === "variantRowCarrier" ||
              resolved.edge.kind === "variantJunctionCarrier")
              ? resolved.edge
              : undefined;
          const edges = carrier
            ? carrier.members.map((member) =>
                engine.membership(model, relation, member.variant)
              )
            : [engine.membership(model, relation)];
          for (const edge of edges)
            for (const [target, field] of physicalAsks(edge)) {
              expect(() =>
                engine.physicalField(target, field)
              ).not.toThrow();
              asked.push(`${target["~"].names.sql}.${field}`);
            }
        }
      }
      expect(asked.length).toBeGreaterThan(0);
    }
  );

  it.each(CORPUS.map(([name]) => name))(
    "%s: every variant membership an arm names resolves",
    (name) => {
      const fixture = CORPUS.find(([label]) => label === name)![1];
      const engine = new EngineSchema(fixture as any);
      let carriers = 0;
      let members = 0;
      for (const model of Object.values(fixture))
        for (const [relation, resolved] of engine.index.get(model)!) {
          if (
            resolved.edge.kind !== "variantRowCarrier" &&
            resolved.edge.kind !== "variantJunctionCarrier"
          ) {
            expect(() => engine.membership(model, relation)).not.toThrow();
            continue;
          }
          if (resolved.member) {
            // A bound inverse: the untagged resolution answers with no variant.
            expect(() => engine.membership(model, relation)).not.toThrow();
            members++;
            continue;
          }
          carriers++;
          for (const member of resolved.edge.members) {
            expect(() =>
              engine.membership(model, relation, member.variant)
            ).not.toThrow();
            members++;
          }
        }
      if (name !== "ordinary") expect(carriers + members).toBeGreaterThan(0);
    }
  );

  it("the only unresolvable membership is a carrier addressed with no arm", () => {
    const fixture = mixedWorld();
    const engine = new EngineSchema(fixture as any);
    const note = fixture.note!;
    const hub = fixture.hub!;
    // The carrier slot itself, with no variant: the state the sentence guards.
    expect(() => engine.membership(note, "subject")).toThrow();
    expect(() => engine.membership(hub, "items")).toThrow();
    // And with an arm that the schema does not declare.
    expect(() => engine.membership(note, "subject", "absent")).toThrow();
  });

  it("a scalar KEY spelled like a carrier column shadows it (no refusal)", () => {
    // `reservedColumns` compares SQL names, so a scalar MAPPED to
    // `subject_type` is refused (P008) while a scalar whose FIELD KEY is
    // `subject_type` and whose column is elsewhere is admitted. The resolver
    // answers with the scalar; it does not reach the sentence.
    const post: any = s
      .model({ id: s.int().id(), title: s.string() })
      .map("a4_shadow_posts");
    const note: any = s
      .model({
        id: s.int().id(),
        subject_type: s.string().map("shadow_column"),
        subject: s.toOne({ post: () => post }).name("subject").optional(),
      })
      .map("a4_shadow_notes");
    const engine = new EngineSchema({ post, note } as any);
    expect(engine.physicalField(note, "subject_type").name).toBe(
      "shadow_column"
    );
    expect(engine.storedFields(note)).toContain("subject_id");
  });

  it("a scalar MAPPED onto a carrier column is refused by the schema gate", () => {
    const post: any = s
      .model({ id: s.int().id(), title: s.string() })
      .map("a4_clash_posts");
    const note: any = s
      .model({
        id: s.int().id(),
        label: s.string().map("subject_type"),
        subject: s.toOne({ post: () => post }).name("subject").optional(),
      })
      .map("a4_clash_notes");
    expect(() => new EngineSchema({ post, note } as any)).toThrow();
  });

  it("the only unresolvable physical field is a name the model does not store", () => {
    const fixture = mixedWorld();
    const engine = new EngineSchema(fixture as any);
    const note = fixture.note!;
    expect(engine.storedFields(note)).toEqual([
      "id",
      "body",
      "subject_type",
      "subject_id",
      "second_type",
      "second_id",
    ]);
    expect(() => engine.physicalField(note, "subject")).toThrow();
    expect(() => engine.physicalField(note, "nope")).toThrow();
  });
});
