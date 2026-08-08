/**
 * Prisma-parity validation tests
 *
 * Covers validation-layer parity fixes:
 * - create() does not require optional to-one relations (top-level and nested)
 * - where: { relation: null } normalizes to { is: null } for optional relations
 * - include/select: { relation: false } stays false so the relation is omitted
 * - select: { relation: { include: ... } } is accepted (select/include alternate)
 * - nested select+include on the same relation node is rejected
 */

import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => post).name("author"),
  editedPosts: s.oneToMany(() => post).name("editor"),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string().nullable(),
  editorId: s.string().nullable(),
  author: s
    .manyToOne(() => user)
    .fields("authorId")
    .references("id")
    .optional()
    .name("author"),
  editor: s
    .manyToOne(() => user)
    .fields("editorId")
    .references("id")
    .optional()
    .name("editor"),
});

const optionalSchemas = createSchemaRegistry({ user, post }).proxy;

const strictUser = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => strictPost),
});

const strictPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .manyToOne(() => strictUser)
    .fields("authorId")
    .references("id"),
});

const requiredSchemas = createSchemaRegistry({
  user: strictUser,
  post: strictPost,
}).proxy;

describe("create: optional to-one relations are not required", () => {
  test("top-level create omitting all optional relations passes", () => {
    const result = parse(optionalSchemas.post.core.create, {
      id: "p1",
      title: "hello",
    });
    expect(result.issues).toBeUndefined();
  });

  test("nested create does not demand other optional relations", () => {
    const result = parse(optionalSchemas.user.args.create, {
      data: {
        id: "u1",
        name: "A",
        // nested post omits both authorId (derived) and the optional editor
        posts: { create: [{ id: "p1", title: "t" }] },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("required to-one relation still demands FK or relation", () => {
    const result = parse(requiredSchemas.post.core.create, {
      id: "p1",
      title: "hello",
    });
    expect(result.issues).toBeDefined();
    expect(result.issues?.[0]?.message).toContain("authorId");
  });
});

describe("where: relation null shorthand", () => {
  test("null on optional relation normalizes to { is: null }", () => {
    const result = parse(optionalSchemas.post.args.findMany, {
      where: { author: null },
    });
    expect(result.issues).toBeUndefined();
    const where = (result as { value: { where: { author: unknown } } }).value
      .where;
    expect(where.author).toEqual({ is: null });
  });

  test("explicit { is: null } still accepted", () => {
    const result = parse(optionalSchemas.post.args.findMany, {
      where: { author: { is: null } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("null on required relation is rejected", () => {
    const result = parse(requiredSchemas.post.args.findMany, {
      where: { author: null },
    });
    expect(result.issues).toBeDefined();
  });
});

describe("include/select: false means omit", () => {
  test("include: { rel: false } validates to false", () => {
    const result = parse(optionalSchemas.user.args.findMany, {
      include: { posts: false },
    });
    expect(result.issues).toBeUndefined();
    const include = (result as { value: { include: { posts: unknown } } }).value
      .include;
    expect(include.posts).toBe(false);
  });

  test("include: { rel: true } still expands to full select", () => {
    const result = parse(optionalSchemas.user.args.findMany, {
      include: { posts: true },
    });
    expect(result.issues).toBeUndefined();
    const include = (result as { value: { include: { posts: unknown } } }).value
      .include;
    expect(include.posts).toMatchObject({ select: { id: true, title: true } });
  });
});

describe("select/include alternation on relations", () => {
  test("select: { rel: { include } } is accepted", () => {
    const result = parse(optionalSchemas.user.args.findMany, {
      select: { id: true, posts: { include: { author: true } } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("include: { rel: { select } } is accepted", () => {
    const result = parse(optionalSchemas.user.args.findMany, {
      include: { posts: { select: { id: true } } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("nested select+include on the same node is rejected", () => {
    const result = parse(optionalSchemas.user.args.findMany, {
      include: {
        posts: { select: { id: true }, include: { author: true } },
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("nested select+include inside a select tree is rejected", () => {
    const result = parse(optionalSchemas.user.args.findMany, {
      select: {
        posts: { select: { id: true }, include: { author: true } },
      },
    });
    expect(result.issues).toBeDefined();
  });
});
