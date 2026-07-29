/**
 * `omit` at the parse boundary (W5-U4).
 *
 * Pins the three things the surface promises and the engine relies on:
 *  1. `omit` DESUGARS to the `select` it denotes and disappears — the engine has
 *     one projection vocabulary, not two;
 *  2. `select` + `omit` is refused, on every operation and on nested relation
 *     nodes, and so is an `omit` that leaves nothing to return;
 *  3. model-level `.omit()` outranks both layers above it — the field has no
 *     `select` key and no `omit` key, so neither can bring it back.
 */

import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  posts: s.oneToMany(() => post).name("author"),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  draftNotes: s.string(),
  authorId: s.string(),
  author: s
    .manyToOne(() => user)
    .fields("authorId")
    .references("id")
    .name("author"),
});

const schemas = createSchemaRegistry({ user, post }).proxy;

const secretive = s
  .model({
    id: s.string().id(),
    label: s.string(),
    vaultKey: s.string(),
  })
  .omit({ vaultKey: true });

const secretiveSchemas = createSchemaRegistry({ secretive }).proxy;

const allHidden = s.model({
  id: s.string().id(),
  label: s.string(),
});
// Hydrated the way `createClient` hydrates, so the refusal below can be checked
// for the model NAME a real caller would see in the message.
hydrateSchemaNames({ allHidden });
const allHiddenSchemas = createSchemaRegistry({ allHidden }).proxy;

const value = (result: unknown): Record<string, unknown> =>
  (result as { value: Record<string, unknown> }).value;

const messages = (result: unknown): string =>
  ((result as { issues?: { message: string }[] }).issues ?? [])
    .map((entry) => entry.message)
    .join(" | ");

describe("omit desugars into the select it denotes", () => {
  test("findMany: the omitted scalar is the only one missing", () => {
    const result = parse(schemas.user.args.findMany, {
      omit: { passwordHash: true },
    });
    expect(result.issues).toBeUndefined();
    expect(value(result).select).toEqual({ id: true, email: true });
    expect(value(result)).not.toHaveProperty("omit");
  });

  test("omit: { field: false } keeps the field (the re-include spelling)", () => {
    const result = parse(schemas.user.args.findMany, {
      omit: { passwordHash: false },
    });
    expect(result.issues).toBeUndefined();
    expect(value(result).select).toEqual({
      id: true,
      email: true,
      passwordHash: true,
    });
  });

  test("include rides alongside the reduced scalar set", () => {
    const result = parse(schemas.user.args.findMany, {
      omit: { passwordHash: true },
      include: { posts: true },
    });
    expect(result.issues).toBeUndefined();
    expect(value(result).select).toEqual({ id: true, email: true });
    expect(value(result).include).toMatchObject({
      posts: { select: { id: true, title: true, draftNotes: true } },
    });
  });

  test("every returning operation accepts it", () => {
    const cases: [keyof typeof schemas.user.args, Record<string, unknown>][] = [
      ["findUnique", { where: { id: "u1" } }],
      ["findFirst", {}],
      ["findMany", {}],
      ["create", { data: { id: "u1", email: "a@b.c", passwordHash: "x" } }],
      ["update", { where: { id: "u1" }, data: { email: "n@b.c" } }],
      ["delete", { where: { id: "u1" } }],
      [
        "upsert",
        {
          where: { id: "u1" },
          create: { id: "u1", email: "a@b.c", passwordHash: "x" },
          update: { email: "n@b.c" },
        },
      ],
      [
        "createMany",
        { data: [{ id: "u1", email: "a@b.c", passwordHash: "x" }] },
      ],
      ["updateMany", { data: { email: "n@b.c" } }],
      ["deleteMany", {}],
    ];

    for (const [operation, args] of cases) {
      const schema = schemas.user.args[operation] as Parameters<
        typeof parse
      >[0];
      const result = parse(schema, {
        ...args,
        omit: { passwordHash: true },
      });
      expect(result.issues, `${operation} rejected omit`).toBeUndefined();
      expect(value(result).select, operation as string).toEqual({
        id: true,
        email: true,
      });
    }
  });
});

describe("omit on a nested relation node", () => {
  test("include node: omit reduces the relation's own scalars", () => {
    const result = parse(schemas.user.args.findMany, {
      include: { posts: { omit: { draftNotes: true } } },
    });
    expect(result.issues).toBeUndefined();
    expect(value(result).include).toMatchObject({
      posts: { select: { id: true, title: true, authorId: true } },
    });
    expect(
      (value(result).include as { posts: Record<string, unknown> }).posts
    ).not.toHaveProperty("omit");
  });

  test("nested omit composes with a deeper include", () => {
    const result = parse(schemas.user.args.findMany, {
      include: {
        posts: { omit: { draftNotes: true }, include: { author: true } },
      },
    });
    expect(result.issues).toBeUndefined();
    const posts = (value(result).include as { posts: Record<string, unknown> })
      .posts;
    expect(posts.select).toEqual({ id: true, title: true, authorId: true });
    expect(posts.include).toMatchObject({ author: { select: { id: true } } });
  });

  test("nested omit survives a to-many node that also paginates", () => {
    const result = parse(schemas.user.args.findMany, {
      include: { posts: { take: 2, omit: { draftNotes: true, title: true } } },
    });
    expect(result.issues).toBeUndefined();
    const posts = (value(result).include as { posts: Record<string, unknown> })
      .posts;
    expect(posts.select).toEqual({ id: true, authorId: true });
    expect(posts.take).toBe(2);
  });
});

describe("refusals", () => {
  test("select + omit on the same node is refused by name", () => {
    const result = parse(schemas.user.args.findMany, {
      select: { id: true },
      omit: { passwordHash: true },
    });
    expect(messages(result)).toContain(
      "Mutually exclusive fields cannot be used together: select, omit"
    );
  });

  test("select + omit is refused on a nested relation node too", () => {
    const result = parse(schemas.user.args.findMany, {
      include: { posts: { select: { id: true }, omit: { title: true } } },
    });
    expect(messages(result)).toContain(
      "Mutually exclusive fields cannot be used together: select, omit"
    );
  });

  test("an omit that empties the projection is refused, not answered", () => {
    const result = parse(allHiddenSchemas.allHidden.args.findMany, {
      omit: { id: true, label: true },
    });
    expect(messages(result)).toContain("excluded every readable field");
    expect(messages(result)).toContain("allHidden");
  });

  test("an emptying omit on a nested node is refused too", () => {
    const result = parse(schemas.user.args.findMany, {
      include: {
        posts: {
          omit: {
            id: true,
            title: true,
            draftNotes: true,
            authorId: true,
          },
        },
      },
    });
    expect(messages(result)).toContain("excluded every readable field");
  });

  test("an unknown field in omit is refused", () => {
    const result = parse(schemas.user.args.findMany, {
      omit: { nope: true },
    });
    expect(messages(result)).toContain("nope");
  });
});

describe("model-level .omit() outranks the query", () => {
  test("the hidden scalar is absent from the default projection", () => {
    const result = parse(secretiveSchemas.secretive.args.findMany, {});
    expect(result.issues).toBeUndefined();
  });

  test("select cannot re-include it", () => {
    const result = parse(secretiveSchemas.secretive.args.findMany, {
      select: { id: true, vaultKey: true },
    });
    expect(messages(result)).toContain("vaultKey");
  });

  test("omit cannot re-include it either", () => {
    const result = parse(secretiveSchemas.secretive.args.findMany, {
      omit: { vaultKey: false },
    });
    expect(messages(result)).toContain("vaultKey");
  });

  test("an omit over the remaining fields still desugars correctly", () => {
    const result = parse(secretiveSchemas.secretive.args.findMany, {
      omit: { label: true },
    });
    expect(result.issues).toBeUndefined();
    expect(value(result).select).toEqual({ id: true });
  });
});
