/**
 * A client extended with computed fields and a vocabulary extension keeps
 * exact rows through a nested include and `_aggregate`, never `any`.
 *
 * Folding `_aggregate` into the select and include mapped types (#199) lowered
 * the 50-model extended client from 648,853 to 515,906 instantiations and from
 * 120,545 to 80,109 types (`tests/package/type-floor-scale-smoke.mjs`). A drop
 * like that is also what a collapse to `any` looks like, recursive models
 * first; these probes falsify it: every row below is compared exactly, and a
 * typo on a nested row must still be an error.
 */

import { PGliteDriver } from "@drivers/pglite";
import {
  accepts,
  arg,
  args,
  createClient,
  extension,
  fields,
  rule,
  s,
} from "@src/index";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

const user = s.model({
  id: s.string().id(),
  firstName: s.string(),
  lastName: s.string(),
  orgId: s.string(),
  posts: s.toMany(() => post),
  // A self relation: the recursive shape that collapses first.
  managerId: s.string().nullable(),
  manager: s
    .toOne(() => user)
    .name("management")
    .fields("managerId")
    .references("id"),
  reports: s.toMany(() => user).name("management"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.int(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const schema = { user, post };

const extended = () =>
  createClient({ schema, driver: new PGliteDriver() })
    .$extends(
      extension(
        "names",
        fields({
          user: {
            fullName: {
              needs: { firstName: true, lastName: true },
              compute: (row) => `${row.firstName} ${row.lastName}`,
            },
          },
        })
      )
    )
    .$extends(
      extension(
        "tenant",
        args({ tenant: accepts(v.string()) }),
        rule({ user: { read: { where: { orgId: arg("tenant") } } } })
      )
    );

async function _nestedIncludeStaysExact() {
  const db = extended();
  const [row] = await db.post.findMany({
    tenant: "o",
    include: {
      author: {
        include: {
          reports: { select: { id: true, firstName: true } },
          _aggregate: { posts: { _sum: { views: true }, _count: true } },
        },
      },
    },
  });
  // The tenant rule hides users, so the author may read as absent.
  const author = row!.author!;
  expectTypeOf(author.fullName).toEqualTypeOf<string>();
  expectTypeOf(author.managerId).toEqualTypeOf<string | null>();
  expectTypeOf(author.reports).toEqualTypeOf<
    { id: string; firstName: string }[]
  >();
  expectTypeOf(author._aggregate).toEqualTypeOf<{
    posts: { _sum: { views: number | null }; _count: number };
  }>();
  expectTypeOf(row!.views).toEqualTypeOf<number>();
  // @ts-expect-error - a typo on a nested row is no member
  author.fulName;
  // @ts-expect-error - a field the nested select leaves out is not on the row
  author.reports[0]!.lastName;
  // @ts-expect-error - `_aggregate` holds the relations it named only
  author._aggregate.reports;
}

async function _selectedRecursionStaysExact() {
  const db = extended();
  const users = await db.user.findMany({
    tenant: "o",
    select: {
      fullName: true,
      manager: { select: { manager: { select: { id: true } } } },
      _aggregate: { reports: { _max: { lastName: true } } },
    },
  });
  expectTypeOf(users).toEqualTypeOf<
    {
      fullName: string;
      manager: { manager: { id: string } | null } | null;
      _aggregate: { reports: { _max: { lastName: string | null } } };
    }[]
  >();
}
