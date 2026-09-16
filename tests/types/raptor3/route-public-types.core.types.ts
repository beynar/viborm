/**
 * LX-18 — the private Raptor 3 route consumes the canonical public types.
 *
 * The claim this file checks is a NEGATIVE one: selecting the candidate route
 * changes nothing a caller can see in the type system. It is probed the way the
 * client contextual-typing gate probes the shipped client
 * (`tests/types/client/contextual-typing-gate.core.types.ts`) — through the real
 * public syntax, with a typo BESIDE A REAL KEY at every nesting level, with
 * variable-held and possibly-undefined clause values, and with
 * `@ts-expect-error` directives that fail (TS2578) the moment a surface stops
 * refusing. Nothing here is called; only the types matter.
 *
 * The first assertion is the whole unit in one line: the candidate client's
 * type is the shipped client's type.
 */

import { PGliteDriver } from "@drivers/pglite";
import { createCandidateClient } from "@query-engine/raptor3/route/client-route";
import { createClient, s } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  books: s.toMany(() => book),
});

const book = s.model({
  id: s.string().id(),
  title: s.string(),
  pages: s.int(),
  authorId: s.string(),
  writer: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});

const schema = { author, book };
const config = { driver: new PGliteDriver(), schema };

const shipped = createClient(config);
const candidate = createCandidateClient(config);

describe("the candidate client's public type is the shipped client's type", () => {
  test("one type, not two", () => {
    expectTypeOf(candidate).toEqualTypeOf<typeof shipped>();
    expectTypeOf(candidate.$schema).toEqualTypeOf<typeof schema>();
  });

  test("every operation answers the canonical result type", async () => {
    const rows = await candidate.book.findMany({ select: { title: true } });
    expectTypeOf(rows).toEqualTypeOf<{ title: string }[]>();

    const one = await candidate.book.findUnique({ where: { id: "b" } });
    expectTypeOf(one).toEqualTypeOf<{
      id: string;
      title: string;
      pages: number;
      authorId: string;
    } | null>();

    const created = await candidate.book.create({
      data: { authorId: "a", id: "b", pages: 1, title: "t" },
      select: { title: true },
    });
    expectTypeOf(created).toEqualTypeOf<{ title: string }>();

    const counted = await candidate.book.createMany({
      data: [{ authorId: "a", id: "b", pages: 1, title: "t" }],
    });
    expectTypeOf(counted).toEqualTypeOf<{ count: number }>();

    const returned = await candidate.book.createMany({
      data: [{ authorId: "a", id: "b", pages: 1, title: "t" }],
      select: { title: true },
    });
    expectTypeOf(returned).toEqualTypeOf<{ title: string }[]>();
  });
});

describe("candidate query args refuse a typo beside a real key at every level", () => {
  const _keyed = () =>
    candidate.book.findMany({
      cursor: { id: "1" },
      distinct: ["title"],
      orderBy: { title: "asc" },
      select: { id: true, writer: { select: { email: true } } },
      where: { title: { contains: "x" }, writer: { is: { email: "e" } } },
    });

  const _operationKeyTypoBesideReal = () =>
    // @ts-expect-error - "takee" is refused next to the real "take"
    candidate.book.findMany({ take: 1, takee: 1 });

  const _whereTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    candidate.book.findMany({ where: { title: "x", ttitle: "x" } });

  const _selectTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    candidate.book.findMany({ select: { title: true, ttitle: true } });

  /**
   * PINNED NEGATIVE, identical on both routes: the clause guard keys the
   * OPERATION-level clauses, and a relation's own nested `select` bag is one
   * level deeper than the guard reaches. It compiles here exactly as it
   * compiles on the shipped client, which is what this file claims.
   */
  const _nestedSelectTypoCompiles = () =>
    candidate.author.findMany({
      select: {
        books: { select: { title: true, titl: true } },
        email: true,
      },
    });

  const _includeTypoBesideReal = () =>
    candidate.author.findMany({
      // @ts-expect-error - "bokos" is refused next to the real "books"
      include: { bokos: true, books: true },
    });

  const _orderByTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    candidate.book.findMany({ orderBy: { title: "asc", ttitle: "asc" } });

  const _omitTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    candidate.book.findMany({ omit: { title: true, ttitle: true } });

  /** PINNED NEGATIVE: `data` is not one of the guarded clauses, on either route. */
  const _dataTypoCompiles = () =>
    candidate.book.create({
      data: { authorId: "a", id: "b", pages: 1, titel: "t", title: "t" },
    });

  /** PINNED NEGATIVE: the nested write bag is not guarded either. */
  const _nestedWriteTypoCompiles = () =>
    candidate.author.create({
      data: {
        books: {
          creat: [],
          create: [{ id: "b", pages: 1, title: "t" }],
        },
        email: "e",
        id: "a",
        passwordHash: "p",
      },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_operationKeyTypoBesideReal).toBeFunction();
    expectTypeOf(_whereTypoBesideReal).toBeFunction();
    expectTypeOf(_selectTypoBesideReal).toBeFunction();
    expectTypeOf(_nestedSelectTypoCompiles).toBeFunction();
    expectTypeOf(_includeTypoBesideReal).toBeFunction();
    expectTypeOf(_orderByTypoBesideReal).toBeFunction();
    expectTypeOf(_omitTypoBesideReal).toBeFunction();
    expectTypeOf(_dataTypoCompiles).toBeFunction();
    expectTypeOf(_nestedWriteTypoCompiles).toBeFunction();
  });
});

describe("candidate clauses stay keyed when the value is held or optional", () => {
  const _optionalWhereTypoBesideReal = (
    maybeWhere: { title: string; ttitle: string } | undefined
  ) =>
    // @ts-expect-error - "ttitle" is refused; `| undefined` does not disable the guard
    candidate.book.findMany({ where: maybeWhere });

  const _forwardedOptionalSelectTypo = (args: {
    select?: { title: true; ttitle: true };
  }) =>
    // @ts-expect-error - "ttitle" is refused through the forwarded optional too
    candidate.book.findMany({ select: args.select });

  const _explicitUndefinedIsStillAllowed = () =>
    candidate.book.findMany({ orderBy: undefined, where: undefined });

  const _correctOptionalClauseCompiles = (
    where: { title: string } | undefined
  ) => candidate.book.findMany({ where });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_optionalWhereTypoBesideReal).toBeFunction();
    expectTypeOf(_forwardedOptionalSelectTypo).toBeFunction();
    expectTypeOf(_explicitUndefinedIsStillAllowed).toBeFunction();
    expectTypeOf(_correctOptionalClauseCompiles).toBeFunction();
  });
});

describe("candidate transactions keep the canonical member and result types", () => {
  const _callback = async () =>
    candidate.$transaction(async (tx) => {
      const created = await tx.book.create({
        data: { authorId: "a", id: "b", pages: 1, title: "t" },
        select: { title: true },
      });
      expectTypeOf(created).toEqualTypeOf<{ title: string }>();
      // A transaction view owns no root lifecycle method.
      expectTypeOf(tx).not.toHaveProperty("$disconnect");
      return created;
    });

  const _arrayMembers = async () => {
    const results = await candidate.$transaction([
      candidate.book.findMany({ select: { title: true } }),
      candidate.book.createMany({
        data: [{ authorId: "a", id: "b", pages: 1, title: "t" }],
      }),
    ]);
    expectTypeOf(results).toEqualTypeOf<
      [{ title: string }[], { count: number }]
    >();
  };

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_callback).toBeFunction();
    expectTypeOf(_arrayMembers).toBeFunction();
  });
});
