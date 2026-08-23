import { s } from "@schema";
import {
  createModelFieldRefs,
  FIELD_REF_BRAND,
  fieldRefPayload,
  formatFieldRef,
  isFieldRef,
} from "@schema/field-ref";
import { describe, expect, test } from "vitest";

const target = s.model({ id: s.string().id() });
const post = s.model({
  id: s.string().id(),
  likes: s.int(),
  tags: s.string().array(),
  author: s
    .toOne(() => target)
    .fields("id")
    .references("id"),
});
const UNKNOWN_FIELD_REFUSAL = /Unknown scalar field "unknown" on model 'post'/;

describe("a model's field-reference table", () => {
  test("creates frozen, branded, identity-stable scalar references", () => {
    const refs = createModelFieldRefs("post", post);
    const first = refs.likes;
    const second = refs.likes;

    expect(isFieldRef(first)).toBe(true);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);

    const payload = fieldRefPayload(first);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(payload).toEqual({
      model: "post",
      field: "likes",
      type: "int",
      list: false,
    });
    expect(fieldRefPayload(refs.tags).list).toBe(true);
    expect(formatFieldRef(first)).toBe("post.likes");
  });

  test("recognizes only tokens with an object payload under the shared brand", () => {
    expect(isFieldRef("post.likes")).toBe(false);
    expect(isFieldRef(null)).toBe(false);
    expect(isFieldRef({})).toBe(false);
    expect(isFieldRef({ [FIELD_REF_BRAND]: null })).toBe(false);
    expect(isFieldRef(createModelFieldRefs("post", post).id)).toBe(true);
  });

  test("reflects exactly the model's scalar fields", () => {
    const refs = createModelFieldRefs("post", post);

    expect(Object.keys(refs)).toEqual(["id", "likes", "tags"]);
    expect("likes" in refs).toBe(true);
    expect("author" in refs).toBe(false);
    expect(Reflect.has(refs, Symbol.iterator)).toBe(false);
    expect(Reflect.get(refs, Symbol.iterator)).toBeUndefined();
    expect(Object.hasOwn(refs, "likes")).toBe(true);
    expect(Object.hasOwn(refs, "author")).toBe(false);
    expect(Object.getOwnPropertyDescriptor(refs, "likes")).toMatchObject({
      enumerable: true,
      configurable: true,
    });
    expect(
      Object.getOwnPropertyDescriptor(refs, Symbol.iterator)
    ).toBeUndefined();
  });

  test("names unknown fields for untyped callers", () => {
    const refs = createModelFieldRefs("post", post) as unknown as Record<
      string,
      unknown
    >;

    expect(() => refs.unknown).toThrow(UNKNOWN_FIELD_REFUSAL);
  });

  test("reads model state once and creates field tokens lazily", () => {
    let stateReads = 0;
    const probeModel = {
      "~": {
        get state() {
          stateReads++;
          return post["~"].state;
        },
      },
    } as unknown as typeof post;

    const refs = createModelFieldRefs("post", probeModel);
    expect(stateReads).toBe(1);
    expect(fieldRefPayload(refs.likes).field).toBe("likes");
    expect(stateReads).toBe(1);
  });
});
