import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, object, string, array, optional } from "../../src/validation";

describe("circular references with thunks", () => {
  describe("self-reference", () => {
    test("works with optional self-reference", () => {
      const selfRef = object({
        name: string(),
        self: optional(() => selfRef),
      });

      const result = selfRef["~standard"].validate({
        name: "root",
        self: { name: "child" },
      });
      expect(result.issues).toBeUndefined();
    });

    test("works with required self-reference", () => {
      const selfRef = object({
        value: string(),
        next: () => selfRef,
      });

      const result = selfRef["~standard"].validate({
        value: "a",
        next: { value: "b", next: { value: "c", next: { value: "d" } } },
      });
      expect(result.issues).toBeUndefined();
    });

    test("type inference with self-reference", () => {
      const user = object({
        name: string(),
        friend: () => user,
      });

      type UserOutput = StandardSchemaV1.InferOutput<typeof user>;

      // This should not be `any`
      type IsAny<T> = 0 extends 1 & T ? true : false;
      type _CheckNotAny = IsAny<UserOutput> extends false ? true : never;
      const _check: _CheckNotAny = true;

      // Should be able to access nested properties
      type FriendName = UserOutput["friend"] extends { name: infer N } ? N : never;
      expectTypeOf<FriendName>().toEqualTypeOf<string>();
    });
  });

  describe("mutual references", () => {
    test("forward and back references work", () => {
      const user = object({
        name: string(),
        posts: array(() => post),
      });

      const post = object({
        title: string(),
        author: () => user,
      });

      const result = user["~standard"].validate({
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
      const node = object({
        value: string(),
        children: array(() => node),
      });

      const result = node["~standard"].validate({
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
      const user = object({
        name: string(),
        bestFriend: optional(() => user),
      });

      type UserOutput = StandardSchemaV1.InferOutput<typeof user>;
      type BestFriend = UserOutput["bestFriend"];
      type BestFriendName = BestFriend extends { name: infer N } ? N : never;
      expectTypeOf<BestFriendName>().toEqualTypeOf<string | undefined>();
    });

    test("deep recursion works", () => {
      const user = object({
        name: string(),
        friend: () => user,
      });

      type UserOutput = StandardSchemaV1.InferOutput<typeof user>;
      type Friend = UserOutput["friend"];
      type FriendFriend = Friend extends { friend: infer F } ? F : never;
      type FriendFriendFriend = FriendFriend extends { friend: infer F } ? F : never;
      type DeepFriendName = FriendFriendFriend extends { name: infer N } ? N : never;
      expectTypeOf<DeepFriendName>().toEqualTypeOf<string>();
    });
  });
});

