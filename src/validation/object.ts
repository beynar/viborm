import { type } from "arktype";
import { inferred } from "./inferred";
import { StandardSchemaV1 } from "@standard-schema";

// =============================================================================
// VibORM Schema Validation - Circular Reference Support
// =============================================================================
//
// SUPPORTED PATTERNS:
// 1. Forward/back references: a -> b, b -> a (works perfectly)
// 2. Scope-based definitions with string references (recommended for complex cases)
//
// LIMITATION:
// When a single object has BOTH self-reference AND forward-reference,
// TypeScript's inference can fail on the back-reference. This is a TypeScript
// limitation, not specific to this library (ArkType has the same issue).
//
// For complex recursive structures, use the scope pattern (defineScope).
//
// =============================================================================

// =============================================================================
// Core Schema Interface
// =============================================================================

export interface VibSchema<T = unknown> {
  [inferred]: T;
  t: T;
}

interface Cast<T> {
  [inferred]?: T;
}

type ThunkCast<T = unknown> = () => Cast<T>;

type InferDef<Def> = Def extends Cast<infer T>
  ? T
  : Def extends ThunkCast<infer T>
  ? T
  : never;

type InferShape<Defs extends Record<string, Cast<any> | ThunkCast>> = {
  [K in keyof Defs]: InferDef<Defs[K]>;
};

// =============================================================================
// Schema Builders
// =============================================================================

export declare function string(): VibSchema<string>;
export declare function number(): VibSchema<number>;
export declare function boolean(): VibSchema<boolean>;

export declare function object<
  const Def extends Record<string, Cast<any> | ThunkCast>,
  R = VibSchema<InferShape<Def>>
>(fields: Def): R extends infer _ ? _ : never;

// =============================================================================
// Scope-based definitions for complex circular references
// =============================================================================

type ScopeDef = Record<string, Record<string, VibSchema<any> | string>>;

type ResolveField<F, Scope> = F extends keyof Scope
  ? Scope[F]
  : F extends VibSchema<infer T>
  ? T
  : never;

type InferModel<Def, Scope> = {
  [K in keyof Def]: ResolveField<Def[K], Scope>;
};

type ComputeScope<Defs extends ScopeDef> = {
  [K in keyof Defs]: InferModel<Defs[K], ComputeScope<Defs>>;
};

type ScopeResult<Defs extends ScopeDef> = {
  [K in keyof Defs]: VibSchema<ComputeScope<Defs>[K]>;
};

export declare function defineScope<Defs extends ScopeDef>(
  defs: Defs
): ScopeResult<Defs>;

// =============================================================================
// TESTS
// =============================================================================

// -----------------------------------------------------------------------------
// TEST 1: Forward/back reference (WORKS)
// -----------------------------------------------------------------------------

const a = object({
  name: string(),
  toB: () => b,
});

const b = object({
  name: string(),
  toA: () => a,
});

type A = typeof a.t;
type B = typeof b.t;

const _testAtoB: string = {} as A["toB"]["name"];
const _testBtoA: string = {} as B["toA"]["name"];

// -----------------------------------------------------------------------------
// TEST 2: Scope-based for complex circular references (WORKS)
// -----------------------------------------------------------------------------

const models = defineScope({
  user: {
    name: string(),
    age: number(),
    bestFriend: "user", // Self-reference via string
    favoritePost: "post", // Cross-reference via string
  },
  post: {
    title: string(),
    published: boolean(),
    author: "user", // Back-reference via string
  },
});

type User = typeof models.user.t;
type Post = typeof models.post.t;

const _testUser: string = {} as User["name"];
const _testBestFriend: string = {} as User["bestFriend"]["name"];
const _testFavoritePost: string = {} as User["favoritePost"]["title"];
const _testAuthor: string = {} as Post["author"]["name"];

// Deep recursion
const _deepTest: string =
  {} as User["bestFriend"]["bestFriend"]["bestFriend"]["name"];

const arkModel1 = type({
  name: type("string"),
  age: type("number"),
  friend: () => arkModel2,
});

const arkModel2 = type({
  name: type("string"),
  age: type("number"),
  friend: () => arkModel1,
});

type input = StandardSchemaV1.InferInput<typeof arkModel1>;

// how is arktype able to let us define recursive types like this const arkModel1 = type({ name: type("string"), age: type("number"), friend: () => arkModel2, }); const arkModel2 = type({ name: type("string"), age: type("number"), friend: () => arkModel1, }); and still be able to infer types properly without breaking typescript into a circular reference loop type input = StandardSchemaV1.InferInput<typeof arkModel1>; type input = { name: string; age: number; friend: { name: string; age: number; friend: ...; }; } this should not be possible and yet this is working. I need to understand how and a complete report on the structure of internal arktype types that allow it do that. Also make a summary at the end of your answer including pseudo code or mermaid diagram to explain clearly how types flow where they are "cut" and why typescript is able to work with such circular references
