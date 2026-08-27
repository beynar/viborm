/**
 * The format, both directions, over the WHOLE declaration surface.
 *
 * One schema exercises every scalar type, every chainable modifier, every
 * model-config slot and all four relation arms. The document below is written
 * out in full rather than snapshotted, because it is the format's contract: a
 * change to what a declaration serializes to has to be read as a change here.
 *
 * Three theorems are pinned:
 *  - the document is what the CODED schema denotes (`serializeSchema` twin);
 *  - the document is what the DOCUMENT denotes (parse ∘ serialize is identity
 *    on a canonical document);
 *  - `serializeSchema ∘ parseSchema` is idempotent — the canonical form (T2).
 */

import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import {
  parseSchema,
  type SchemaDocument,
  serializeSchema,
} from "@schema/json";
import { SCALAR_FACTORIES } from "@schema/json/factories";
import { describe, expect, it } from "vitest";

function completeSurface(): Schema {
  const user = s
    .model({
      id: s.string().id(),
      uid: s.string().uuid("u"),
      nano: s.string().nanoid(8, "n"),
      cuid: s.string().cuid("c"),
      // Two order pins. `.nullable()` installs `default: null` as a side
      // effect, so an explicit default must be applied AFTER it; `.id()`
      // installs a ULID, so a declared generator must be applied AFTER that.
      // The three tagged defaults below (`big`, `bytes`, `when`) are the
      // codec's leaves; `when` is a `Date`, which `$date` keeps apart from the
      // ISO string that spells it.
      anon: s.string().nullable().default("anonymous"),
      altId: s.string().id().uuid("a"),
      email: s.string({ db: "pg", type: "varchar(255)" }).unique(),
      bio: s.string().nullable().map("biography"),
      tags: s.string().array(),
      age: s.int().nullable(),
      seq: s.int().increment(),
      counter: s.bigInt().increment(),
      big: s.bigInt().default(5n),
      ratio: s.float().default(1.5),
      flag: s.boolean().default(false),
      created: s.dateTime().now(),
      updated: s.dateTime().updatedAt(),
      local: s.dateTime().withoutTimezone(),
      day: s.date().now(),
      clock: s.time().withoutTimezone(),
      price: s.decimal().default("1.5"),
      meta: s.json().default({ a: [1, null, true] }),
      blank: s.json().default(null),
      bytes: s.blob().default(new Uint8Array([1, 2, 3])),
      vec: s.vector().dimension(3),
      spot: s.point(),
      status: s.enum(["a", "b"]).name("st").default("a"),
      loose: s.enum(["x", "y"]).nullable(),
      when: s.dateTime().default(new Date("2020-01-02T03:04:05.000Z")),
      posts: s.toMany(() => post),
    })
    .map("users")
    .index(["email"], { unique: true, type: "btree" })
    .index(["age"], { name: "user_age_idx" })
    .unique(["email", "age"])
    .id(["uid", "email"], { name: "pk" })
    .omit({ bio: true });

  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .name("Post→Author")
      .fields("authorId")
      .references("id")
      .onDelete("cascade")
      .onUpdate("restrict"),
    tags: s
      .toMany(() => tag)
      .through("post_tags")
      .source("p")
      .target("t")
      .onDelete("cascade")
      .onUpdate("noAction"),
    topic: s
      .toOne(
        { thread: () => tag, review: () => user },
        {
          values: { thread: "topic.thread.v1", review: "topic.review.v1" },
        }
      )
      .name("topic")
      .optional(),
    shelf: s
      .toMany({ book: () => tag })
      .name("shelf")
      .through({ book: { table: "j", source: "a", target: "b" } }),
  });

  const tag = s.model({ id: s.string().id() });
  return { user, post, tag };
}

const COMPLETE_SURFACE: SchemaDocument = {
  version: 1,
  models: {
    user: {
      fields: {
        id: { type: "string", id: true, generate: { kind: "ulid" } },
        uid: { type: "string", generate: { kind: "uuid", prefix: "u" } },
        nano: {
          type: "string",
          generate: { kind: "nanoid", prefix: "n", length: 8 },
        },
        cuid: { type: "string", generate: { kind: "cuid", prefix: "c" } },
        anon: { type: "string", nullable: true, default: "anonymous" },
        altId: {
          type: "string",
          id: true,
          generate: { kind: "uuid", prefix: "a" },
        },
        email: {
          type: "string",
          native: { db: "pg", type: "varchar(255)" },
          unique: true,
        },
        bio: { type: "string", nullable: true, column: "biography" },
        tags: { type: "string", array: true },
        age: { type: "int", nullable: true },
        seq: { type: "int", generate: { kind: "increment" } },
        counter: { type: "bigint", generate: { kind: "increment" } },
        big: { type: "bigint", default: { $bigint: "5" } },
        ratio: { type: "float", default: 1.5 },
        flag: { type: "boolean", default: false },
        created: { type: "datetime", generate: { kind: "now" } },
        updated: { type: "datetime", generate: { kind: "updatedAt" } },
        local: { type: "datetime", withoutTimezone: true },
        day: { type: "date", generate: { kind: "now" } },
        clock: { type: "time", withoutTimezone: true },
        price: { type: "decimal", default: "1.5" },
        meta: { type: "json", default: { a: [1, null, true] } },
        blank: { type: "json", default: null },
        bytes: { type: "blob", default: { $bytes: "AQID" } },
        vec: { type: "vector", dimension: 3 },
        spot: { type: "point" },
        status: { type: "enum", enum: "st", default: "a" },
        loose: { type: "enum", nullable: true, enum: ["x", "y"] },
        when: {
          type: "datetime",
          default: { $date: "2020-01-02T03:04:05.000Z" },
        },
        posts: { type: "toMany", target: "post" },
      },
      table: "users",
      indexes: [
        { fields: ["email"], unique: true, type: "btree" },
        { fields: ["age"], name: "user_age_idx" },
      ],
      ids: [{ fields: ["uid", "email"], name: "pk" }],
      uniques: [{ fields: ["email", "age"] }],
      omit: ["bio"],
    },
    post: {
      fields: {
        id: { type: "string", id: true, generate: { kind: "ulid" } },
        authorId: { type: "string" },
        author: {
          type: "toOne",
          name: "Post→Author",
          target: "user",
          fields: ["authorId"],
          references: ["id"],
          onDelete: "cascade",
          onUpdate: "restrict",
        },
        tags: {
          type: "toMany",
          target: "tag",
          junction: {
            table: "post_tags",
            source: "p",
            target: "t",
            onDelete: "cascade",
            onUpdate: "noAction",
          },
        },
        topic: {
          type: "toOne",
          name: "topic",
          variants: { thread: "tag", review: "user" },
          values: { thread: "topic.thread.v1", review: "topic.review.v1" },
          optional: true,
        },
        shelf: {
          type: "toMany",
          name: "shelf",
          variants: { book: "tag" },
          through: { book: { table: "j", source: "a", target: "b" } },
        },
      },
    },
    tag: {
      fields: { id: { type: "string", id: true, generate: { kind: "ulid" } } },
    },
  },
  enums: { st: { values: ["a", "b"], name: "st" } },
};

/**
 * Edit every container reachable in a document, in place. A `$` key and a
 * sentinel string are values no declaration produces, so anything the schema
 * still shares with this document becomes visible the next time it is
 * serialized. The document is a finite tree — the codec detaches defaults and
 * refuses cycles — so the walk terminates without a seen-set.
 */
function vandalize(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) vandalize(item);
    node.push("vandal");
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    vandalize(value);
    if (typeof value === "string") {
      Reflect.set(node, key, "vandal");
    }
  }
  Reflect.set(node, "$vandal", true);
}

describe("format", () => {
  it("serializes the complete declaration surface", () => {
    expect(serializeSchema(completeSurface())).toEqual(COMPLETE_SURFACE);
  });

  it("parses that document back into the same declarations", () => {
    expect(serializeSchema(parseSchema(COMPLETE_SURFACE))).toEqual(
      COMPLETE_SURFACE
    );
  });

  it("reads JSON text and a plain object the same way", () => {
    const text = JSON.stringify(COMPLETE_SURFACE);
    expect(serializeSchema(parseSchema(text))).toEqual(
      serializeSchema(parseSchema(COMPLETE_SURFACE))
    );
  });

  it("preserves declaration order, which is DDL column order", () => {
    const document = serializeSchema(parseSchema(COMPLETE_SURFACE));
    expect(Object.keys(document.models.user?.fields ?? {})).toEqual(
      Object.keys(COMPLETE_SURFACE.models.user?.fields ?? {})
    );
    expect(Object.keys(document.models)).toEqual(["user", "post", "tag"]);
  });

  /**
   * T2. The canonical form of a document IS `serializeSchema ∘ parseSchema`,
   * so running the pair twice must answer what running it once did. Nothing
   * else knows every builder coupling; a second normalizer would be a parallel
   * representation of them.
   */
  it("is idempotent through parse ∘ serialize (T2)", () => {
    const once = serializeSchema(parseSchema(COMPLETE_SURFACE));
    const twice = serializeSchema(parseSchema(once));
    expect(twice).toEqual(once);
  });

  it("normalizes a non-canonical document to the canonical one", () => {
    const once = serializeSchema(
      parseSchema({
        version: 1,
        // A ref that is not the DB enum name, a `values` bag that echoes its
        // keys, and a compound name equal to the default: three spellings that
        // collapse to the same state.
        enums: { role: { values: ["a", "b"], name: "role_type" } },
        models: {
          user: {
            fields: {
              id: { type: "string", id: true },
              role: { type: "enum", enum: "role" },
              posts: { type: "toMany", target: "post" },
            },
            uniques: [{ fields: ["id"], name: "id" }],
          },
          post: {
            fields: {
              id: { type: "string", id: true },
              topic: {
                type: "toOne",
                variants: { a: "user" },
                values: { a: "a" },
              },
            },
          },
        },
      })
    );
    expect(once.enums).toEqual({
      role_type: { values: ["a", "b"], name: "role_type" },
    });
    expect(once.models.user?.fields.role).toEqual({
      type: "enum",
      enum: "role_type",
    });
    expect(once.models.user?.uniques).toEqual([{ fields: ["id"] }]);
    expect(once.models.post?.fields.topic).toEqual({
      type: "toOne",
      variants: { a: "user" },
    });
    expect(serializeSchema(parseSchema(once))).toEqual(once);
  });

  /**
   * The document is the CALLER's value — it is handed out to be read, edited and
   * written — and the declarations it came from are not. So no container in it
   * may be a container the schema still holds: `native`, an enum's `values`, a
   * foreign key's `fields`, a junction, a variant bag. The review found `native`
   * aliased (mutating `document…native.type` changed the scalar); this is that
   * finding stated as the whole invariant, over the surface that has one of
   * every container, rather than one site at a time.
   *
   * The vandal edits every array and record the document holds; a schema still
   * entangled with any of them serializes differently afterwards.
   */
  it("hands out a document detached from every declaration it came from", () => {
    const schema = completeSurface();
    const before = serializeSchema(schema);
    vandalize(serializeSchema(schema));
    expect(serializeSchema(schema)).toEqual(before);
  });

  /**
   * The one table this module owns. `ScalarType` and the factory names disagree
   * in two places, so each entry is proven to build a scalar of its own key.
   */
  it("names the factory that builds each scalar type", () => {
    for (const [type, factory] of Object.entries(SCALAR_FACTORIES)) {
      expect(factory()["~"].state.type).toBe(type);
    }
  });

  it("produces a fresh object graph on every parse", () => {
    const first = parseSchema(COMPLETE_SURFACE);
    const second = parseSchema(COMPLETE_SURFACE);
    expect(first.user).not.toBe(second.user);
    expect(first.user?.["~"].state.scalars.id).not.toBe(
      second.user?.["~"].state.scalars.id
    );
    expect(first.post?.["~"].state.relations.author).not.toBe(
      second.post?.["~"].state.relations.author
    );
  });

  it("resolves a relation target to the registered model by identity", () => {
    const schema = parseSchema(COMPLETE_SURFACE);
    const author = schema.post?.["~"].relationNames.includes("author");
    expect(author).toBe(true);
    expect(
      schema.post?.["~"].state.relations.author?.["~"].settleTarget()
    ).toBe(schema.user);
  });
});
