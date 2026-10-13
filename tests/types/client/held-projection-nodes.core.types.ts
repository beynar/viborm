/**
 * Held projection nodes: a whole relation node, or a nested `select` /
 * `include` map, typed as the client's own payload (read through
 * `Parameters<…>`) and passed back into a literal.
 *
 * A held to-many node is the union of the ordinary node and the recursive one,
 * and the recursive node's projection carries the asking key (`books` below)
 * as an optional refused member nobody wrote. 1.2.0 sealed a nested
 * projection against every key of every arm, so it refused that key as
 * unknown (TS2322) on every such node; 1.2.1 sealed only the keys a value
 * requires. The seal refuses every unknown key as `?: undefined`, which that
 * member is: a misspelling a caller writes out is refused, and so is one under
 * an optional key (contextual-typing-gate).
 */

import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  email: s.string(),
  books: s.toMany(() => book).name("writer"),
});

const book = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  writer: s
    .toOne(() => author)
    .fields("authorId")
    .references("id")
    .name("writer"),
});

const client = createClient({
  schema: { author, book },
  driver: new PGliteDriver(),
});

type Client = typeof client;
type Args<M extends keyof Client & ("author" | "book")> = NonNullable<
  Parameters<Client[M]["findMany"]>[0]
>;
type AuthorSelect = NonNullable<Args<"author">["select"]>;
type AuthorInclude = NonNullable<Args<"author">["include"]>;
type BookSelect = NonNullable<Args<"book">["select"]>;
type BooksNode = Exclude<NonNullable<AuthorSelect["books"]>, boolean>;
type BooksIncludeNode = Exclude<NonNullable<AuthorInclude["books"]>, boolean>;
type IsAny<Value> = 0 extends 1 & Value ? true : false;

describe("a held projection node is passed back as it was read", () => {
  const selected = (books: BooksNode) =>
    client.author.findMany({ select: { id: true, books } });
  const included = (books: BooksIncludeNode) =>
    client.author.findMany({ include: { books } });
  const besideWhere = (select: BookSelect) =>
    client.author.findMany({
      select: { id: true, books: { where: { title: "x" }, select } },
    });
  const heldSelfMap = (select: AuthorSelect) =>
    client.book.findMany({ select: { id: true, writer: { select } } });

  type Selected = Awaited<ReturnType<typeof selected>>[number];
  type Included = Awaited<ReturnType<typeof included>>[number];
  type BesideWhere = Awaited<ReturnType<typeof besideWhere>>[number];

  test("each compiles, and its result stays a typed row", () => {
    expectTypeOf<IsAny<Selected>>().toEqualTypeOf<false>();
    expectTypeOf<Selected["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Included["email"]>().toEqualTypeOf<string>();
    // A held projection may name any field, so each one is optional.
    expectTypeOf<Included["books"][number]["title"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<Selected["books"][number]["title"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<BesideWhere["id"]>().toEqualTypeOf<string>();
    expectTypeOf<IsAny<BesideWhere["books"][number]>>().toEqualTypeOf<false>();
    expectTypeOf(heldSelfMap).toBeFunction();
  });
});

describe("a misspelling written out below a node is still refused", () => {
  const _literalSelectTypo = () =>
    client.author.findMany({
      // @ts-expect-error "ttitle" is not a field of book
      select: { id: true, books: { select: { title: true, ttitle: true } } },
    });
  const _literalIncludeTypo = () =>
    client.book.findMany({
      // @ts-expect-error "bokos" is not a relation of author
      include: { writer: { include: { books: true, bokos: true } } },
    });
  const _heldRequiredTypo = (books: {
    select: { title: true; ttitle: true };
  }) =>
    // @ts-expect-error a key the held value's type requires is keyed
    client.author.findMany({ select: { id: true, books } });

  test("probes", () => {
    expectTypeOf(_literalSelectTypo).toBeFunction();
    expectTypeOf(_literalIncludeTypo).toBeFunction();
    expectTypeOf(_heldRequiredTypo).toBeFunction();
  });
});
