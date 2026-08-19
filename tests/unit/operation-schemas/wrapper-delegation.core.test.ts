import { s } from "@schema";
import { createSchemaRegistry, parse, v } from "@validation";
import { restrictToScalarProjection } from "@validation/model/args/bulk-write-projection";
import {
  emptyOmitProjectionMessage,
  emptySelectedOmitProjectionMessage,
  withOmitProjection,
} from "@validation/model/args/omit";
import { rejectSelectInclude } from "@validation/model/args/select-include-exclusivity";
import { rejectVariantsOutsideOnly } from "@validation/relations/polymorphic/select-include";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  authorId: s.string(),
  author: s.manyToOne(() => user),
});

const projectionSchema = () =>
  v.object({
    select: v.object({
      id: v.boolean({ optional: true }),
      name: v.boolean({ optional: true }),
    }),
    include: v.object({ posts: v.boolean({ optional: true }) }),
    omit: v.object({
      id: v.boolean({ optional: true }),
      name: v.boolean({ optional: true }),
    }),
  });

describe("operation-schema wrapper delegation", () => {
  test("builds and validates lazy upsert and scalar-only projections", () => {
    const core = createSchemaRegistry({ user }).proxy.user.core;

    const upsertProjection = parse(core.upsertProjection, {
      select: { id: true, name: true },
      omit: { name: true },
    });
    expect(upsertProjection.issues).toBeUndefined();
    expect(
      "value" in upsertProjection ? upsertProjection.value?.select : undefined
    ).toEqual({ id: true });
    expect(parse(core.scalarSelect, { id: true }).issues).toBeUndefined();
  });

  test("select/include wrapper delegates types, JSON Schema, and validation", () => {
    const base = projectionSchema();
    const wrapped = rejectSelectInclude(base);

    expect(wrapped["~standard"].types).toBe(base["~standard"].types);
    expect(wrapped["~standard"].jsonSchema).toBe(base["~standard"].jsonSchema);
    expect(parse(wrapped, { select: { id: true } }).issues).toBeUndefined();
    expect(
      parse(wrapped, { select: { id: true }, include: { posts: true } })
        .issues?.[0]
    ).toEqual({
      message:
        "Mutually exclusive fields cannot be used together: select, include",
    });
    expect(parse(wrapped, null).issues?.[0]).toEqual({
      message: "Expected object",
    });
  });

  test("omit wrapper delegates metadata and rewrites trusted omit output", () => {
    const base = projectionSchema();
    const wrapped = withOmitProjection(base, user, "findMany");

    expect(wrapped["~standard"].types).toBe(base["~standard"].types);
    expect(wrapped["~standard"].jsonSchema).toBe(base["~standard"].jsonSchema);
    expect(parse(wrapped, { select: { id: true } }).issues).toBeUndefined();
    const omitted = parse(wrapped, { omit: { name: true } });
    expect("value" in omitted ? omitted.value.select : undefined).toEqual({
      id: true,
    });
    expect(
      parse(wrapped, { omit: { id: true, name: true } }).issues?.[0]?.message
    ).toBe(emptyOmitProjectionMessage(user, "findMany"));
    const combined = parse(wrapped, {
      omit: { name: true },
      select: { id: true },
    });
    expect("value" in combined ? combined.value.select : undefined).toEqual({
      id: true,
    });
    expect(
      parse(wrapped, { omit: { id: true }, select: { id: true } }).issues?.[0]
        ?.message
    ).toBe(emptySelectedOmitProjectionMessage(user, "findMany"));
    expect(parse(wrapped, { omit: "name" }).issues?.[0]).toEqual({
      message: "Expected object",
      path: ["omit"],
    });
  });

  test("bulk wrapper delegates metadata and names scalar-only refusals", () => {
    const base = projectionSchema();
    const wrapped = restrictToScalarProjection(base, user, "updateMany");

    expect(wrapped["~standard"].types).toBe(base["~standard"].types);
    expect(wrapped["~standard"].jsonSchema).toBe(base["~standard"].jsonSchema);
    expect(parse(wrapped, { select: { id: true } }).issues).toBeUndefined();
    expect(
      parse(wrapped, { include: { posts: true } }).issues?.[0]?.message
    ).toContain("'include' is not supported");
    expect(
      parse(wrapped, { select: { posts: true } }).issues?.[0]?.message
    ).toContain("'select.posts' is not supported");
    expect(
      parse(wrapped, { select: { _count: true } }).issues?.[0]?.message
    ).toContain("'select._count' is not supported");
    expect(parse(wrapped, null).issues?.[0]).toEqual({
      message: "Expected object",
    });
    expect(parse(wrapped, { select: "id" }).issues?.[0]).toEqual({
      message: "Expected object",
      path: ["select"],
    });
    expect(
      parse(wrapped, { select: { posts: undefined } }).issues?.[0]
    ).toEqual({
      message: "Unknown key: posts",
      path: ["select", "posts"],
    });
  });

  test("collection allow-list wrapper delegates metadata and names the stray arm", () => {
    // Same wrapper shape as `rejectSelectInclude`, and the same reason it is
    // tested against the BARE object rather than through a built relation
    // schema: the two accessors exist to keep introspection (types, JSON
    // Schema) reaching the wrapped schema, and nothing in a parse path touches
    // them.
    const base = v.object({
      only: v.array(v.string()),
      variants: v.object({ post: v.boolean({ optional: true }) }),
    });
    const wrapped = rejectVariantsOutsideOnly(base);

    expect(wrapped["~standard"].types).toBe(base["~standard"].types);
    expect(wrapped["~standard"].jsonSchema).toBe(base["~standard"].jsonSchema);
    expect(
      parse(wrapped, { only: ["post"], variants: { post: true } }).issues
    ).toBeUndefined();
    // `only` absent leaves `variants` unconstrained, and so does a `variants`
    // that is not an object — a malformed pair is the wrapped schema's refusal
    // to phrase, not this rule's.
    expect(parse(wrapped, { variants: { post: true } }).issues).toBeUndefined();
    expect(parse(wrapped, { only: ["post"] }).issues).toBeUndefined();
    // A non-object payload falls through to the wrapped schema's own refusal
    // rather than the cross-key one.
    expect(parse(wrapped, null).issues?.[0]).toEqual({
      message: "Expected object",
    });
    // The rule runs AFTER the wrapped schema, so a payload that fails for its
    // own reasons keeps its own message even with a well-formed pair.
    expect(
      parse(wrapped, { only: [1], variants: { post: true } }).issues?.[0]
        ?.message
    ).toBe("Expected string");
    expect(
      parse(wrapped, { only: [], variants: { post: true } }).issues?.[0]
    ).toEqual({
      message: "Variant 'post' is not in 'only'",
      path: ["variants", "post"],
    });
  });
});
