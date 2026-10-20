/**
 * Public type falsifiers for `$extends({ result })` computed fields.
 *
 * Nothing in this file is called. Only the types matter: each probe enters
 * through `createClient` and `$extends`, as a caller would.
 */

import { PGliteDriver } from "@drivers/pglite";
import {
  createClient,
  defineExtension,
  type ExtendedOperationResult,
  s,
} from "@src/index";
import { expectTypeOf } from "vitest";

const user = s.model({
  id: s.string().id(),
  firstName: s.string(),
  lastName: s.string(),
  email: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const schema = { user, post };

const base = () => createClient({ schema, driver: new PGliteDriver() });

const names = () =>
  base().$extends({
    name: "names",
    result: {
      user: {
        fullName: {
          needs: { firstName: true, lastName: true },
          compute(row) {
            expectTypeOf(row).toEqualTypeOf<{
              firstName: string;
              lastName: string;
            }>();
            // @ts-expect-error - compute reads only what it needs
            row.email;
            return `${row.firstName} ${row.lastName}`;
          },
        },
      },
    },
  });

async function _readsCarryTheField() {
  const db = names();
  const rows = await db.user.findMany();
  expectTypeOf(rows).toEqualTypeOf<
    {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      fullName: string;
    }[]
  >();
  const one = await db.user.findUnique({
    where: { id: "u1" },
    select: { id: true, fullName: true },
  });
  expectTypeOf(one).toEqualTypeOf<{ id: string; fullName: string } | null>();
  const omitted = await db.user.findFirstOrThrow({
    omit: { fullName: true, email: true },
  });
  expectTypeOf(omitted).toEqualTypeOf<{
    id: string;
    firstName: string;
    lastName: string;
  }>();
  // @ts-expect-error - a computed field filters nothing
  await db.user.findMany({ where: { fullName: "x" } });
  // @ts-expect-error - a typo beside a computed field is still a typo
  await db.user.findMany({ select: { fullNmae: true } });
}

async function _nestedRowsCarryTheField() {
  const db = names();
  const posts = await db.post.findMany({ include: { author: true } });
  expectTypeOf(posts[0]!.author.fullName).toEqualTypeOf<string>();
  const users = await db.user.findMany({
    select: { id: true, posts: { select: { title: true } } },
  });
  expectTypeOf(users).toEqualTypeOf<
    { id: string; posts: { title: string }[] }[]
  >();
  const selected = await db.post.findFirst({
    select: { author: { select: { id: true } } },
  });
  expectTypeOf(selected).toEqualTypeOf<{ author: { id: string } } | null>();
}

async function _writesCarryTheField() {
  const db = names();
  const created = await db.user.create({
    data: { id: "u", firstName: "a", lastName: "b", email: "e" },
    select: { fullName: true },
  });
  expectTypeOf(created).toEqualTypeOf<{ fullName: string }>();
  const many = await db.user.updateMany({
    data: { lastName: "z" },
    select: { id: true, fullName: true },
  });
  expectTypeOf(many).toEqualTypeOf<{ id: string; fullName: string }[]>();
  const counted = await db.user.updateMany({ data: { lastName: "z" } });
  expectTypeOf(counted).toEqualTypeOf<{ count: number }>();
  expectTypeOf(await db.user.count()).toEqualTypeOf<number>();
}

async function _extensionsCompose() {
  const db = names().$extends({
    name: "greeting",
    result: {
      user: {
        greeting: {
          needs: { fullName: true },
          compute: (row) => `Hello, ${row.fullName}`,
        },
        email: {
          needs: { email: true },
          compute: (row) => row.email.length,
        },
      },
      $allModels: {
        ref: { needs: { id: true }, compute: (row) => String(row.id) },
      },
    },
  });
  const row = await db.user.findUniqueOrThrow({
    where: { id: "u1" },
    select: { greeting: true, email: true, ref: true },
  });
  expectTypeOf(row).toEqualTypeOf<{
    greeting: string;
    email: number;
    ref: string;
  }>();
  const [first] = await db.post.findMany({ select: { ref: true } });
  expectTypeOf(first!.ref).toEqualTypeOf<string>();
}

function _definitionsAreChecked() {
  base().$extends({
    name: "bad-need",
    result: {
      user: {
        x: {
          // @ts-expect-error - needs name the model's fields
          needs: { nope: true },
          compute: () => 1,
        },
      },
    },
  });
  base().$extends({
    name: "bad-model",
    result: {
      // @ts-expect-error - result names the schema's models
      nobody: { x: { compute: () => 1 } },
    },
  });
  const reusable = defineExtension<typeof schema>()({
    name: "reusable",
    result: {
      post: {
        shout: {
          needs: { title: true },
          compute: (row) => row.title.toUpperCase(),
        },
      },
    },
  });
  base()
    .$extends(reusable)
    .post.findMany({ select: { shout: true } })
    .then((rows) => expectTypeOf(rows).toEqualTypeOf<{ shout: string }[]>());
}

function _heldDefinitionsAreChecked() {
  const held = {
    name: "held",
    result: { nobody: { x: { compute: () => 1 } } },
  } as const;
  // @ts-expect-error - a held definition names the schema's models too
  base().$extends(held);
}

/**
 * Not typed yet (the runtime handles them): a nested `select` or `omit` that
 * names a computed field. `$withCache()` delegates and `ExtendedOperationResult`
 * type the core row: the computed fields are there at runtime, not in their
 * types.
 */
function _nestedComputedSelectionIsNotTypedYet() {
  const db = names();
  expectTypeOf<
    ExtendedOperationResult<
      typeof db,
      "user",
      "findFirst",
      { select: { id: true } }
    >
  >().toEqualTypeOf<{ id: string } | null>();
  // @ts-expect-error - a nested select names columns and relations only
  db.post.findMany({ select: { author: { select: { fullName: true } } } });
}

export const resultExtensionProbes = [
  _readsCarryTheField,
  _nestedRowsCarryTheField,
  _writesCarryTheField,
  _extensionsCompose,
  _definitionsAreChecked,
  _heldDefinitionsAreChecked,
  _nestedComputedSelectionIsNotTypedYet,
];

async function _omitSubtractsFromSelect() {
  const db = names();
  expectTypeOf(
    await db.user.findUnique({
      where: { id: "u1" },
      select: { fullName: true, firstName: true },
      omit: { firstName: true },
    })
  ).toEqualTypeOf<{ fullName: string } | null>();
  expectTypeOf(
    await db.user.findUnique({
      where: { id: "u1" },
      select: { id: true, fullName: true },
      omit: { fullName: true },
    })
  ).toEqualTypeOf<{ id: string } | null>();
}

/**
 * Two models whose scalar and relation keys are the same cannot be told
 * apart below the root (the public model types carry no identity), so a
 * nested row of either is typed without computed fields rather than with
 * the other model's.
 */
const writer = s.model({ id: s.string().id(), name: s.string() });
const reviewer = s.model({ id: s.string().id(), name: s.string() });
const article = s.model({
  id: s.string().id(),
  writerId: s.string(),
  reviewerId: s.string(),
  writer: s
    .toOne(() => writer)
    .fields("writerId")
    .references("id"),
  reviewer: s
    .toOne(() => reviewer)
    .fields("reviewerId")
    .references("id"),
});

async function _sameSurfaceTargetsAreNotMerged() {
  const db = createClient({
    schema: { writer, reviewer, article },
    driver: new PGliteDriver(),
  }).$extends({
    name: "display",
    result: {
      writer: {
        displayName: {
          needs: { name: true },
          compute: (row) => row.name.toUpperCase(),
        },
      },
      reviewer: {
        displayName: { needs: { id: true }, compute: (row) => row.id.length },
      },
    },
  });
  const [row] = await db.article.findMany({
    include: { writer: true, reviewer: true },
  });
  expectTypeOf(row!.reviewer).toEqualTypeOf<{
    id: string;
    name: string;
  } | null>();
  expectTypeOf(row!.writer).toEqualTypeOf<{
    id: string;
    name: string;
  } | null>();
  expectTypeOf(
    (await db.writer.findFirstOrThrow()).displayName
  ).toEqualTypeOf<string>();
  expectTypeOf(
    (await db.reviewer.findFirstOrThrow()).displayName
  ).toEqualTypeOf<number>();
}

export const resultExtensionFollowUpProbes = [
  _omitSubtractsFromSelect,
  _sameSurfaceTargetsAreNotMerged,
];
