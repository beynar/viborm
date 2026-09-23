/**
 * N4/A4 reachability probe, part 2 — EXECUTED.
 *
 * Every ask the candidate engine makes of `EngineSchema.physicalField` and
 * `EngineSchema.membership` is recorded while a corpus of ADMITTED public
 * payloads runs against a migrated SQLite database. Rows 48 and 49 are
 * reachable only if one of those asks lands on the throwing branch.
 */
import type { Operations } from "@client/types";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import {
  createWitnessWorld,
  type WitnessWorld,
} from "@tests/raptor3/g4/witness-world";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

interface FieldAsk {
  readonly model: string;
  readonly field: string;
  readonly failed?: string;
}
interface MemberAsk {
  readonly model: string;
  readonly relation: string;
  readonly variant?: string;
  readonly failed?: string;
}

const fieldAsks: FieldAsk[] = [];
const memberAsks: MemberAsk[] = [];

const realPhysicalField = EngineSchema.prototype.physicalField;
const realMembership = EngineSchema.prototype.membership;

beforeAll(() => {
  EngineSchema.prototype.physicalField = function (
    this: EngineSchema,
    model: AnyModel,
    field: string
  ) {
    try {
      return realPhysicalField.call(this, model, field);
    } catch (failure) {
      fieldAsks.push({
        model: String(model["~"].names.sql),
        field,
        failed: failure instanceof Error ? failure.message : String(failure),
      });
      throw failure;
    } finally {
      // Recorded on the success path too; the failure path pushed already.
    }
  } as typeof realPhysicalField;
  const recordingPhysical = EngineSchema.prototype.physicalField;
  EngineSchema.prototype.physicalField = function (
    this: EngineSchema,
    model: AnyModel,
    field: string
  ) {
    const view = recordingPhysical.call(this, model, field);
    fieldAsks.push({ model: String(model["~"].names.sql), field });
    return view;
  } as typeof realPhysicalField;
  EngineSchema.prototype.membership = function (
    this: EngineSchema,
    model: AnyModel,
    relation: string,
    variant?: string
  ) {
    try {
      const view = realMembership.call(this, model, relation, variant);
      memberAsks.push({
        model: String(model["~"].names.sql),
        relation,
        variant,
      });
      return view;
    } catch (failure) {
      memberAsks.push({
        model: String(model["~"].names.sql),
        relation,
        variant,
        failed: failure instanceof Error ? failure.message : String(failure),
      });
      throw failure;
    }
  } as typeof realMembership;
});

afterAll(() => {
  EngineSchema.prototype.physicalField = realPhysicalField;
  EngineSchema.prototype.membership = realMembership;
});

// ---------------------------------------------------------------------------
// The world: a row carrier and a junction carrier beside ordinary storage.
// ---------------------------------------------------------------------------

function world() {
  const author: any = s
    .model({
      id: s.int().id().increment(),
      name: s.string().map("author_name"),
      posts: s.toMany(() => post),
    })
    .map("a4x_authors");
  const post: any = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique().map("post_slug"),
      title: s.string().map("post_title"),
      views: s.int(),
      authorId: s.int().nullable().map("author_key"),
      author: s.toOne(() => author).fields("authorId").references("id"),
      notes: s.toMany(() => note).name("subject"),
      shelves: s.toMany(() => board).name("items"),
      tags: s.toMany(() => tag).through("a4x_post_tags"),
    })
    .map("a4x_posts");
  const video: any = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
      notes: s.toMany(() => note).name("subject"),
      shelves: s.toMany(() => board).name("items"),
    })
    .map("a4x_videos");
  const tag: any = s
    .model({
      id: s.int().id().increment(),
      label: s.string().unique().map("tag_label"),
      posts: s.toMany(() => post),
    })
    .map("a4x_tags");
  const note: any = s
    .model({
      id: s.int().id().increment(),
      body: s.string().map("note_body"),
      subject: s
        .toOne(
          { post: () => post, video: () => video },
          { values: { post: "c.post.v1", video: "c.video.v1" } }
        )
        .name("subject")
        .optional(),
    })
    .map("a4x_notes");
  const board: any = s
    .model({
      id: s.int().id().increment(),
      title: s.string().map("board_title"),
      items: s
        .toMany(
          { post: () => post, video: () => video },
          { values: { post: "i.post.v1", video: "i.video.v1" } }
        )
        .name("items")
        .through({
          post: { table: "a4x_board_posts", source: "board", target: "item" },
          video: { table: "a4x_board_videos", source: "board", target: "item" },
        }),
    })
    .map("a4x_boards");
  return { author, post, video, tag, note, board };
}

describe("N4/A4 rows 48+49 — what an admitted PAYLOAD reaches", () => {
  let live: WitnessWorld;

  beforeAll(async () => {
    live = await createWitnessWorld(world() as never, { foreignKeys: false });
  });

  afterAll(async () => {
    await live?.close();
  });

  const run = async (model: string, operation: string, args: unknown) => {
    try {
      await live.candidate.execute(model, operation as Operations, args);
    } catch (failure) {
      throw new Error(
        `${model}.${operation} ${JSON.stringify(args)} -> ${
          failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)
        }`
      );
    }
  };

  it("runs the admitted corpus without reaching either sentence", async () => {
    // --- writes that build the world -------------------------------------
    await run("author", "create", { data: { name: "Ada" } });
    await run("post", "create", {
      data: { slug: "p1", title: "One", views: 10, author: { connect: { id: 1 } } },
    });
    await run("post", "create", {
      data: { slug: "p2", title: "Two", views: 20, authorId: 1 },
    });
    await run("video", "create", { data: { slug: "v1", title: "Vid" } });
    await run("tag", "create", { data: { label: "alpha" } });
    await run("board", "create", { data: { title: "Main" } });

    // --- the variant ROW carrier, every to-one verb -----------------------
    await run("note", "create", {
      data: { body: "n1", subject: { connect: { type: "post", where: { slug: "p1" } } } },
    });
    await run("note", "create", {
      data: { body: "n2", subject: { create: { type: "video", data: { slug: "v2", title: "V2" } } } },
    });
    await run("note", "create", {
      data: {
        body: "n3",
        subject: { connectOrCreate: { type: "post", where: { slug: "p9" }, create: { slug: "p9", title: "Nine", views: 1 } } },
      },
    });
    await run("note", "update", {
      where: { id: 1 },
      data: { subject: { connect: { type: "video", where: { slug: "v1" } } } },
    });
    await run("note", "update", {
      where: { id: 1 },
      data: { subject: { update: { type: "video", data: { title: "Vid!" } } } },
    });
    await run("note", "update", {
      where: { id: 1 },
      data: { subject: { upsert: { type: "video", create: { slug: "v3", title: "V3" }, update: { title: "Vid!!" } } } },
    });
    await run("note", "update", { where: { id: 1 }, data: { subject: { disconnect: true } } });
    await run("note", "update", {
      where: { id: 3 },
      data: { subject: { delete: { type: "post" } } },
    });

    // --- the variant JUNCTION carrier, the eleven collection verbs --------
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { connect: [{ type: "post", where: { slug: "p1" } }, { type: "video", where: { slug: "v1" } }] } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { create: { type: "post", data: { slug: "p3", title: "Three", views: 3 } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { createMany: { type: "post", data: [{ slug: "p4", title: "Four", views: 4 }] } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { connectOrCreate: { type: "video", where: { slug: "v9" }, create: { slug: "v9", title: "Nine" } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { update: { type: "post", where: { slug: "p1" }, data: { title: "One!" } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { updateMany: { type: "post", where: { views: { gt: 0 } }, data: { views: { increment: 1 } } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { upsert: { type: "post", where: { slug: "p5" }, create: { slug: "p5", title: "Five", views: 5 }, update: { title: "Five!" } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { disconnect: { type: "post", where: { slug: "p4" } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { delete: { type: "post", where: { slug: "p5" } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { deleteMany: { type: "video", where: { slug: { equals: "v9" } } } } },
    });
    await run("board", "update", {
      where: { id: 1 },
      data: { items: { set: [{ type: "post", where: { slug: "p1" } }, { type: "video", where: { slug: "v1" } }] } },
    });

    // --- reads: filters, projections, ordering, counts, aggregates --------
    await run("note", "findMany", {
      where: { subject: { type: "post", is: { views: { gt: 1 } } } },
      include: { subject: { post: { select: { title: true } }, video: true } },
    });
    await run("note", "findMany", { where: { subject: { is: null } } });
    await run("note", "findMany", { where: { subject: { isNot: null } } });
    await run("note", "findMany", { where: { subject: null } });
    await run("note", "findMany", { where: { subject: { type: "video", isNot: { title: "x" } } } });
    await run("board", "findMany", {
      where: { items: { some: { type: "post", is: { views: { gt: 1 } } } } },
      select: { id: true, items: { variants: { post: { select: { title: true } }, video: true } } },
    });
    await run("board", "findMany", { where: { items: { every: { type: "post" } } } });
    await run("board", "findMany", { where: { items: { none: { type: "video" } } } });
    await run("board", "findMany", { select: { id: true, items: { only: ["post"] } } });
    await run("board", "findMany", { select: { id: true, items: { only: [] } } });
    await run("board", "findMany", { orderBy: [{ items: { _count: "desc" } }, { id: "asc" }] });
    await run("board", "findMany", { select: { id: true, _count: { select: { items: true } } } });
    await run("post", "findMany", {
      where: { notes: { some: { body: { contains: "n" } } }, tags: { some: { label: "alpha" } } },
      include: { notes: true, shelves: true, author: true, tags: true },
      orderBy: { views: "desc" },
      take: 5,
    });
    await run("post", "aggregate", { _count: true, _sum: { views: true }, _avg: { views: true } });
    await run("post", "groupBy", { by: ["authorId"], _count: true });
    await run("video", "findMany", { include: { notes: true, shelves: true } });
    await run("note", "count", { where: { subject: { type: "post" } } });

    // --- the inverse (member) side of both carriers -----------------------
    await run("post", "update", {
      where: { slug: "p1" },
      data: { notes: { create: { body: "inverse" } } },
    });
    await run("post", "update", {
      where: { slug: "p1" },
      data: { shelves: { connect: { id: 1 } } },
    });
    await run("post", "update", {
      where: { slug: "p1" },
      data: { shelves: { disconnect: { id: 1 } } },
    });
    await run("video", "update", {
      where: { slug: "v1" },
      data: { notes: { updateMany: { where: {}, data: { body: "bulk" } } } },
    });

    // --- deletes ----------------------------------------------------------
    await run("note", "deleteMany", { where: { body: { contains: "bulk" } } });
    await run("board", "delete", { where: { id: 1 } });

    // ----------------------------------------------------------------------
    const distinctFields = [
      ...new Set(fieldAsks.map((ask) => `${ask.model}.${ask.field}`)),
    ].sort();
    const distinctMembers = [
      ...new Set(
        memberAsks.map(
          (ask) => `${ask.model}.${ask.relation}${ask.variant ? `#${ask.variant}` : " (untagged)"}`
        )
      ),
    ].sort();
    writeFileSync(
      "/private/tmp/viborm-n4-A4-tmp/asks.json",
      JSON.stringify(
        {
          fieldAskCount: fieldAsks.length,
          memberAskCount: memberAsks.length,
          distinctFields,
          distinctMembers,
        },
        null,
        2
      )
    );
    expect(fieldAsks.length).toBeGreaterThan(50);
    expect(memberAsks.length).toBeGreaterThan(20);
    expect(fieldAsks.filter((ask) => ask.failed)).toEqual([]);
    expect(memberAsks.filter((ask) => ask.failed)).toEqual([]);
    // Every carrier ask named an arm; no ask addressed a carrier bare.
    const carrierAsks = memberAsks.filter(
      (ask) => ask.relation === "subject" || ask.relation === "items"
    );
    expect(carrierAsks.length).toBeGreaterThan(0);
    for (const ask of carrierAsks)
      if (ask.model === "a4x_notes" || ask.model === "a4x_boards")
        expect(ask.variant, JSON.stringify(ask)).toBeDefined();
  });
});
