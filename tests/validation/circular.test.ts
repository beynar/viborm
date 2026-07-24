import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("circular references with thunks", () => {
  describe("self-reference", () => {
    test("works with optional self-reference (thunk at key level)", () => {
      // Thunk at key level returns optional(schema)
      const selfRef = v.object({
        name: v.string(),
        self: () => v.optional(selfRef),
      });

      const result = parse(selfRef, {
        name: "root",
        self: { name: "child" },
      });
      expect(result.issues).toBeUndefined();
    });

    test("works with required self-reference", () => {
      const selfRef = v.object({
        value: v.string(),
        next: () => selfRef,
      });

      const result = parse(selfRef, {
        value: "a",
        next: { value: "b", next: { value: "c", next: { value: "d" } } },
      });
      expect(result.issues).toBeUndefined();
    });

    test("type inference with self-reference", () => {
      const user = v.object({
        name: v.string(),
        friend: () => user,
      });

      type UserOutput = StandardSchemaV1.InferOutput<typeof user>;

      // This should not be `any`
      type IsAny<T> = 0 extends 1 & T ? true : false;
      type _CheckNotAny = IsAny<UserOutput> extends false ? true : never;
      const _check: _CheckNotAny = true;

      // Should be able to access nested properties
      type FriendName = UserOutput["friend"] extends { name: infer N }
        ? N
        : never;
      expectTypeOf<FriendName>().toMatchTypeOf<string>();
    });
  });

  describe("mutual references", () => {
    test("forward and back references work", () => {
      // Thunk at key level returns array(schema)
      const user = v.object({
        name: v.string(),
        posts: () => v.array(post),
      });

      const post = v.object({
        title: v.string(),
        author: () => user,
      });

      const result = parse(user, {
        name: "Alice",
        posts: [
          {
            title: "Hello",
            author: { name: "Alice", posts: [] },
          },
        ],
      });
      expect(result.issues).toBeUndefined();
    });

    test("deep nesting works", () => {
      // Thunk at key level returns array(schema)
      const node = v.object({
        value: v.string(),
        children: () => v.array(node),
      });

      const result = parse(node, {
        value: "root",
        children: [
          {
            value: "child1",
            children: [{ value: "grandchild", children: [] }],
          },
          { value: "child2", children: [] },
        ],
      });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("type inference with circular references", () => {
    test("nested access works", () => {
      // Thunk at key level returns optional(schema)
      const user = v.object({
        name: v.string(),
        bestFriend: () => v.optional(user),
      });

      type UserOutput = StandardSchemaV1.InferOutput<typeof user>;
      type BestFriend = UserOutput["bestFriend"];
      expectTypeOf<BestFriend>().toMatchTypeOf<{ name?: string } | undefined>();
    });

    test("deep recursion works", () => {
      const user = v.object({
        name: v.string(),
        friend: () => user,
      });

      type UserOutput = StandardSchemaV1.InferOutput<typeof user>;
      type Friend = UserOutput["friend"];
      type FriendFriend = Friend extends { friend: infer F } ? F : never;
      type FriendFriendFriend = FriendFriend extends { friend: infer F }
        ? F
        : never;
      type DeepFriendName = FriendFriendFriend extends { name: infer N }
        ? N
        : never;
      expectTypeOf<DeepFriendName>().toMatchTypeOf<string>();
    });
  });
});
