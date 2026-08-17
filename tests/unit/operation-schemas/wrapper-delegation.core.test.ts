import { s } from "@schema";
import { createSchemaRegistry, parse, v } from "@validation";
import { restrictToScalarProjection } from "@validation/model/args/bulk-write-projection";
import {
  emptyOmitProjectionMessage,
  emptySelectedOmitProjectionMessage,
  withOmitProjection,
} from "@validation/model/args/omit";
import { rejectSelectInclude } from "@validation/model/args/select-include-exclusivity";
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
});
