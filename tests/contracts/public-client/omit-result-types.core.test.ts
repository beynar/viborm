/**
 * Type-level `omit` (W5-U4).
 *
 * The runtime drops the column; this file pins that the TYPE drops the key too,
 * because the whole point of `omit` on a secret is that a caller cannot then
 * write `user.passwordHash` and be told it is a `string`.
 *
 * The three claims:
 *  1. `omit: { f: true }` removes `f` from the result, at the top level, inside
 *     `include`, and on the row arm of a bulk write;
 *  2. `omit: { f: false }` (and an absent key) keeps it;
 *  3. a WIDENED `boolean` flag makes the key OPTIONAL rather than guessing —
 *     only the runtime value decides, and claiming presence would be a lie in
 *     exactly the case the caller wrote the flag for.
 *
 * `select` + `omit` is set subtraction: select chooses the candidate shape and
 * omit removes any selected scalar flagged true.
 */

import type { OperationPayload, OperationResult } from "@client/types";
import { s } from "@schema";
import { describe, expectTypeOf, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  books: s.toMany(() => book).name("writer"),
});

const book = s.model({
  id: s.string().id(),
  title: s.string(),
  draft: s.string(),
  authorId: s.string(),
  writer: s
    .toOne(() => author)
    .fields("authorId")
    .references("id")
    .name("writer"),
});

type AuthorModel = typeof author;

const vaulted = s
  .model({
    id: s.string().id(),
    label: s.string(),
    secret: s.string(),
  })
  .omit({ secret: true });

type VaultedModel = typeof vaulted;

// @ts-expect-error - the retired public merged-args generic is internal now
type _RetiredMergedArgs = OperationResult<
  "findMany",
  AuthorModel,
  Record<never, never>,
  undefined,
  { select: { id: true } }
>;

describe("query-level omit at the top level", () => {
  test("a true flag removes the key", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      { omit: { passwordHash: true } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }[]>();
  });

  test("a false flag keeps the key", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      { omit: { passwordHash: false } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<
      { id: string; email: string; passwordHash: string }[]
    >();
  });

  test("no omit is the full row", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      Record<never, never>
    >;
    expectTypeOf<Result>().toEqualTypeOf<
      { id: string; email: string; passwordHash: string }[]
    >();
  });

  test("a widened boolean makes the key optional, never absent-or-present-by-guess", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      { omit: { passwordHash: boolean } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<
      { id: string; email: string; passwordHash?: string }[]
    >();
  });

  test("findUnique keeps its null arm around the reduced row", () => {
    type Result = OperationResult<
      "findUnique",
      AuthorModel,
      { where: { id: string }; omit: { passwordHash: true } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{
      id: string;
      email: string;
    } | null>();
  });

  test("create returns one reduced row", () => {
    type Result = OperationResult<
      "create",
      AuthorModel,
      { data: Record<never, never>; omit: { passwordHash: true; email: true } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string }>();
  });

  test("a disjoint omit leaves a selected result unchanged", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      { select: { id: true }; omit: { passwordHash: true } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string }[]>();
  });

  test("an overlapping omit removes the selected key", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      {
        select: { id: true; email: true; passwordHash: true };
        omit: { passwordHash: true };
      }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }[]>();
  });
});

describe("omit and include", () => {
  test("omit reduces the scalars while include adds the relation", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      { omit: { passwordHash: true }; include: { books: true } }
    >;
    expectTypeOf<Result[number]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Result[number]["email"]>().toEqualTypeOf<string>();
    expectTypeOf<Result[number]["books"]>().toEqualTypeOf<
      { id: string; title: string; draft: string; authorId: string }[]
    >();
    expectTypeOf<Extract<keyof Result[number], "passwordHash">>().toBeNever();
  });

  test("a nested omit reduces the relation payload only", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      { include: { books: { omit: { draft: true } } } }
    >;
    expectTypeOf<Result[number]["passwordHash"]>().toEqualTypeOf<string>();
    expectTypeOf<Result[number]["books"]>().toEqualTypeOf<
      { id: string; title: string; authorId: string }[]
    >();
  });

  test("a nested omit composes with a deeper include", () => {
    type Result = OperationResult<
      "findMany",
      AuthorModel,
      {
        include: {
          books: { omit: { draft: true }; include: { writer: true } };
        };
      }
    >;
    type Book = Result[number]["books"][number];
    expectTypeOf<Book["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<keyof Book, "draft">>().toBeNever();
    expectTypeOf<Book["writer"]["email"]>().toEqualTypeOf<string>();
  });
});

describe("omit on a bulk write", () => {
  test("omit alone flips the result from { count } to rows", () => {
    type Result = OperationResult<
      "updateMany",
      AuthorModel,
      { data: Record<never, never>; omit: { passwordHash: true } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }[]>();
  });

  test("no projection is still { count }", () => {
    type Result = OperationResult<
      "updateMany",
      AuthorModel,
      { data: Record<never, never> }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ count: number }>();
  });

  test("an omit that MAY be undefined is the honest union of both arms", () => {
    type Result = OperationResult<
      "deleteMany",
      AuthorModel,
      { omit: { passwordHash: true } | undefined }
    >;
    expectTypeOf<Result>().toEqualTypeOf<
      { count: number } | { id: string; email: string }[]
    >();
  });

  test("select and omit compose on the row arm", () => {
    type Result = OperationResult<
      "updateMany",
      AuthorModel,
      {
        data: Record<never, never>;
        select: { id: true; email: true; passwordHash: true };
        omit: { passwordHash: true };
      }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }[]>();
  });

  test("a definite omit keeps a maybe-select payload on the row arm", () => {
    type Result = OperationResult<
      "updateMany",
      AuthorModel,
      {
        data: Record<never, never>;
        select: { id: true; email: true } | undefined;
        omit: { passwordHash: true };
      }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }[]>();
  });
});

describe("model-level .omit() is above the query", () => {
  test("the hidden scalar is not in the default result", () => {
    type Result = OperationResult<
      "findMany",
      VaultedModel,
      Record<never, never>
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string; label: string }[]>();
  });

  test("query-level omit still reduces what remains", () => {
    type Result = OperationResult<
      "findMany",
      VaultedModel,
      { omit: { label: true } }
    >;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string }[]>();
  });
});

describe("the args surface", () => {
  test("every returning operation declares an omit key", () => {
    type Returning =
      | "findUnique"
      | "findUniqueOrThrow"
      | "findFirst"
      | "findFirstOrThrow"
      | "findMany"
      | "create"
      | "update"
      | "upsert"
      | "delete"
      | "createMany"
      | "updateMany"
      | "deleteMany";

    type Missing = {
      [O in Returning]: "omit" extends keyof NonNullable<
        OperationPayload<O, AuthorModel>
      >
        ? never
        : O;
    }[Returning];
    expectTypeOf<Missing>().toBeNever();
  });

  test("the aggregating operations declare none", () => {
    type NonReturning = "count" | "aggregate" | "groupBy" | "exist";
    type Unexpected = {
      [O in NonReturning]: "omit" extends keyof NonNullable<
        OperationPayload<O, AuthorModel>
      >
        ? O
        : never;
    }[NonReturning];
    expectTypeOf<Unexpected>().toBeNever();
  });

  test("a model-level omitted field is not nameable in omit", () => {
    type VaultedOmit = NonNullable<
      NonNullable<OperationPayload<"findMany", VaultedModel>>["omit"]
    >;
    expectTypeOf<Extract<keyof VaultedOmit, "secret">>().toBeNever();
    expectTypeOf<
      Extract<keyof VaultedOmit, "label">
    >().toEqualTypeOf<"label">();
  });
});
