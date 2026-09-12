/**
 * A declared identifier, stored compactly, against a real database.
 *
 * Everything below the public API changed for these fields — the column type
 * the migration creates, the parameter the write binds, the projection the read
 * asks for, and the decode that turns it back into a string — and every one of
 * those is a claim no recording adapter can settle. So this suite asserts the
 * three things only a live provider can show:
 *
 *  1. the CATALOG agrees (`information_schema` / `PRAGMA`): the column really is
 *     `uuid`, `bytea`, `BINARY(16|20)` or `BLOB`, and a text-stored format
 *     really is still text;
 *  2. the BYTES agree: `$queryRaw` stays physical by contract, so reading the
 *     same row through it shows the payload the codec wrote — prefix absent,
 *     exact width — while the ORM read shows the public string;
 *  3. the ORDER agrees: a byte column sorts the way the canonical text sorts,
 *     which is what makes `orderBy` and cursor pagination mean the same thing
 *     they meant when the column was text.
 *
 * Around those, the ordinary surface: create, createMany, findUnique, findMany
 * with `in`/`notIn`/`lt`/`gt`, cursor pagination, a nested `include` (whose JSON
 * carrier is the other half of the projection seam), connect, connectOrCreate,
 * upsert, update and delete — over a schema that has a prefixed uuid key, an
 * unprefixed one, a uuidv7, a ulid, a ksuid, a nanoid, a foreign key, a
 * self-relation, a compound key and a many-to-many junction.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// =============================================================================
// THE SCHEMA
// =============================================================================

export const identifierStorageSchema = (() => {
  const account = s
    .model({
      id: s.string().id().uuid("usr"),
      handle: s.string().nanoid(12).unique(),
      posts: s.toMany(() => post),
      /** The self-relation: an account may name the one that invited it. */
      invitedById: s.string().nullable(),
      invitedBy: s
        .toOne(() => account)
        .name("invite")
        .fields("invitedById")
        .references("id"),
      invited: s.toMany(() => account).name("invite"),
    })
    .map("idp_accounts");

  const post = s
    .model({
      id: s.string().id().ksuid(),
      title: s.string(),
      /** Unprefixed, and a different format from its own key. */
      revision: s.string().uuidv7(),
      authorId: s.string(),
      author: s
        .toOne(() => account)
        .fields("authorId")
        .references("id"),
      tags: s.toMany(() => tag),
    })
    .map("idp_posts");

  const tag = s
    .model({
      id: s.string().id().ulid(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("idp_tags");

  /** The compound key: two identifier members, two different formats. */
  const seat = s
    .model({
      roomId: s.string().uuid(),
      slotId: s.string().ulid(),
      label: s.string(),
    })
    .id(["roomId", "slotId"])
    .map("idp_seats");

  return { account, post, tag, seat };
})();

// =============================================================================
// VALUES
// =============================================================================

const UUID_A = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_B = "b1ffcd88-8d1a-4fe7-aa5c-5aa8ac291b22";
const UUID_C = "c2ffde77-7e2b-4dd6-995b-49a79ba82c33";
const ACCOUNT_A = `usr-${UUID_A}`;
const ACCOUNT_B = `usr-${UUID_B}`;
const ACCOUNT_C = `usr-${UUID_C}`;

/** Three KSUIDs in ascending canonical-text order. */
const POST_1 = "0ujtsYcgvSTl8PAuAdqWYSMnLOv";
const POST_2 = "1srOrx2ZWZBpBUvZwXKQmoEYga2";
const POST_3 = "2Hg5JeMVxLVfDLdDLZJMYPRGrqp";

/** Three ULIDs in ascending canonical-text order. */
const TAG_1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TAG_2 = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const TAG_3 = "01CDEF0123456789ABCDEFGHJK";

const REVISION_1 = "018f0c5e-1f3a-7c1d-8b4e-2a6f9c7d1e00";
const REVISION_2 = "018f0c5e-1f3a-7c1d-8b4e-2a6f9c7d1e01";

const HANDLE_A = "V1StGXR8_Z5j";
const HANDLE_B = "dHi6BmyTV1St";
const HANDLE_C = "GXR8Z5jdHi6B";

const SLOT_1 = "01DEF0123456789ABCDEFGHJKM";
const SLOT_2 = "01EF0123456789ABCDEFGHJKMN";

// =============================================================================
// CATALOG PROBES
// =============================================================================

export type IdentifierDialect = "postgresql" | "mysql" | "sqlite";

interface ColumnTypes {
  readonly [column: string]: string;
}

/** The catalog's own answer for one table's columns, lowercased. */
async function columnTypes(
  client: { $queryRaw: <T>(...args: never[]) => Promise<T[]> },
  dialect: IdentifierDialect,
  table: string
): Promise<ColumnTypes> {
  const raw = client.$queryRaw as unknown as <T>(
    fragment: unknown
  ) => Promise<T[]>;
  if (dialect === "sqlite") {
    const rows = await raw<{ name: string; type: string }>(
      sql`SELECT name, type FROM pragma_table_info(${table})`
    );
    return Object.fromEntries(
      rows.map((row) => [row.name, String(row.type).toLowerCase()])
    );
  }
  if (dialect === "mysql") {
    const rows = await raw<{ COLUMN_NAME: string; COLUMN_TYPE: string }>(
      sql`SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_NAME = ${table} AND TABLE_SCHEMA = DATABASE()`
    );
    return Object.fromEntries(
      rows.map((row) => [
        String(row.COLUMN_NAME),
        String(row.COLUMN_TYPE).toLowerCase(),
      ])
    );
  }
  const rows = await raw<{ column_name: string; data_type: string }>(
    sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ${table}`
  );
  return Object.fromEntries(
    rows.map((row) => [
      String(row.column_name),
      String(row.data_type).toLowerCase(),
    ])
  );
}

/** The hex of one stored identifier, read through the RAW (physical) boundary. */
async function storedHex(
  client: { $queryRaw: unknown },
  dialect: IdentifierDialect,
  statement: unknown
): Promise<string> {
  const raw = client.$queryRaw as <T>(fragment: unknown) => Promise<T[]>;
  const rows = await raw<Record<string, unknown>>(statement);
  const value = Object.values(rows[0] ?? {})[0];
  if (typeof value === "string") {
    return value.replace(/^\\x/, "").toLowerCase();
  }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return [...(value as Iterable<number>)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  if (value instanceof ArrayBuffer) {
    return [...new Uint8Array(value)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return String(value);
}

const hexOf = (text: string): string => text.replaceAll("-", "").toLowerCase();

// =============================================================================
// THE SUITE
// =============================================================================

export function runIdentifierStorageBehavior(options: {
  readonly name: string;
  readonly dialect: IdentifierDialect;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} identifier storage`, () => {
    const driver = options.createDriver();
    // biome-ignore lint/suspicious/noExplicitAny: the client's generic surface is the subject, not the assertion.
    const client: any = createClient({
      schema: identifierStorageSchema,
      driver,
    });

    afterAll(async () => {
      await client.$disconnect();
    });

    beforeAll(async () => {
      await syncLiveSchema(client, { force: true, forceReset: true });

      await client.account.createMany({
        data: [
          { id: ACCOUNT_A, handle: HANDLE_A },
          { id: ACCOUNT_B, handle: HANDLE_B },
        ],
      });
      // A self-relation written through `connect`, not through the raw key.
      await client.account.create({
        data: {
          id: ACCOUNT_C,
          handle: HANDLE_C,
          invitedBy: { connect: { id: ACCOUNT_A } },
        },
      });

      await client.tag.createMany({
        data: [
          { id: TAG_1, name: "alpha" },
          { id: TAG_2, name: "beta" },
          { id: TAG_3, name: "gamma" },
        ],
      });

      await client.post.create({
        data: {
          id: POST_1,
          title: "first",
          revision: REVISION_1,
          author: { connect: { id: ACCOUNT_A } },
          tags: { connect: [{ id: TAG_1 }, { id: TAG_2 }] },
        },
      });
      await client.post.create({
        data: {
          id: POST_2,
          title: "second",
          revision: REVISION_2,
          authorId: ACCOUNT_B,
        },
      });
      await client.post.create({
        data: {
          id: POST_3,
          title: "third",
          revision: REVISION_1,
          author: {
            connectOrCreate: {
              where: { id: ACCOUNT_A },
              create: { id: ACCOUNT_A, handle: "unused000000" },
            },
          },
        },
      });

      await client.seat.createMany({
        data: [
          { roomId: UUID_A, slotId: SLOT_1, label: "front" },
          { roomId: UUID_A, slotId: SLOT_2, label: "back" },
        ],
      });
    });

    // -----------------------------------------------------------------------
    // 1 — the catalog
    // -----------------------------------------------------------------------

    test("the column the migration created is the compact one", async () => {
      const accounts = await columnTypes(
        client,
        options.dialect,
        "idp_accounts"
      );
      const posts = await columnTypes(client, options.dialect, "idp_posts");
      const tags = await columnTypes(client, options.dialect, "idp_tags");

      if (options.dialect === "postgresql") {
        expect(accounts.id).toBe("uuid");
        // A foreign key is the column it references.
        expect(posts.authorId).toBe("uuid");
        expect(posts.revision).toBe("uuid");
        expect(posts.id).toBe("bytea");
        expect(tags.id).toBe("bytea");
        // A text format keeps the text column it always had.
        expect(accounts.handle).toBe("text");
      } else if (options.dialect === "mysql") {
        expect(accounts.id).toBe("binary(16)");
        expect(posts.authorId).toBe("binary(16)");
        expect(posts.revision).toBe("binary(16)");
        expect(posts.id).toBe("binary(20)");
        expect(tags.id).toBe("binary(16)");
        // Keyed TEXT widens to VARCHAR(191); the binary key beside it does not.
        expect(accounts.handle).toBe("varchar(191)");
      } else {
        expect(accounts.id).toBe("blob");
        expect(posts.authorId).toBe("blob");
        expect(posts.id).toBe("blob");
        expect(tags.id).toBe("blob");
        expect(accounts.handle).toBe("text");
      }
    });

    // -----------------------------------------------------------------------
    // 2 — the bytes
    // -----------------------------------------------------------------------

    test("the stored value is the payload, with the prefix nowhere in it", async () => {
      const account = await client.account.findUnique({
        where: { id: ACCOUNT_A },
      });
      expect(account?.id).toBe(ACCOUNT_A);

      const stored = await storedHex(
        client,
        options.dialect,
        options.dialect === "postgresql"
          ? sql`SELECT encode(decode(replace("id"::text, '-', ''), 'hex'), 'hex') AS raw FROM idp_accounts WHERE "handle" = ${HANDLE_A}`
          : sql`SELECT HEX(id) AS raw FROM idp_accounts WHERE handle = ${HANDLE_A}`
      );
      expect(stored).toBe(hexOf(UUID_A));
      // Sixteen bytes, not the 40 characters of `usr-a0eebc99-…`.
      expect(stored).toHaveLength(32);
    });

    test("a ksuid stores twenty bytes and a ulid sixteen", async () => {
      if (options.dialect === "postgresql") {
        const post = await storedHex(
          client,
          options.dialect,
          sql`SELECT encode("id", 'hex') AS raw FROM idp_posts WHERE "title" = ${"first"}`
        );
        expect(post).toHaveLength(40);
        const tag = await storedHex(
          client,
          options.dialect,
          sql`SELECT encode("id", 'hex') AS raw FROM idp_tags WHERE "name" = ${"alpha"}`
        );
        expect(tag).toHaveLength(32);
      } else {
        const post = await storedHex(
          client,
          options.dialect,
          sql`SELECT HEX(id) AS raw FROM idp_posts WHERE title = ${"first"}`
        );
        expect(post).toHaveLength(40);
        const tag = await storedHex(
          client,
          options.dialect,
          sql`SELECT HEX(id) AS raw FROM idp_tags WHERE name = ${"alpha"}`
        );
        expect(tag).toHaveLength(32);
      }
    });

    // -----------------------------------------------------------------------
    // 3 — the ordinary surface
    // -----------------------------------------------------------------------

    test("findUnique addresses a row by its public identifier", async () => {
      const post = await client.post.findUnique({ where: { id: POST_2 } });
      expect(post).toMatchObject({
        id: POST_2,
        title: "second",
        revision: REVISION_2,
        authorId: ACCOUNT_B,
      });
    });

    test("an alias addresses the same row as the canonical spelling", async () => {
      const shouted = await client.account.findUnique({
        where: { id: `usr-${UUID_A.toUpperCase()}` },
      });
      expect(shouted?.id).toBe(ACCOUNT_A);
    });

    test("in / notIn / lt / gt read the column as the identifier it holds", async () => {
      const chosen = await client.post.findMany({
        where: { id: { in: [POST_1, POST_3] } },
        orderBy: { id: "asc" },
      });
      expect(chosen.map((row: { id: string }) => row.id)).toEqual([
        POST_1,
        POST_3,
      ]);

      const rest = await client.post.findMany({
        where: { id: { notIn: [POST_1] } },
        orderBy: { id: "asc" },
      });
      expect(rest.map((row: { id: string }) => row.id)).toEqual([
        POST_2,
        POST_3,
      ]);

      const above = await client.post.findMany({
        where: { id: { gt: POST_1 } },
        orderBy: { id: "asc" },
      });
      expect(above.map((row: { id: string }) => row.id)).toEqual([
        POST_2,
        POST_3,
      ]);

      const below = await client.post.findMany({
        where: { id: { lt: POST_3 } },
        orderBy: { id: "asc" },
      });
      expect(below.map((row: { id: string }) => row.id)).toEqual([
        POST_1,
        POST_2,
      ]);
    });

    test("byte order IS canonical text order, ascending and descending", async () => {
      const ascending = await client.tag.findMany({ orderBy: { id: "asc" } });
      const descending = await client.tag.findMany({ orderBy: { id: "desc" } });
      const ids = ascending.map((row: { id: string }) => row.id);
      expect(ids).toEqual([TAG_1, TAG_2, TAG_3]);
      expect(ids).toEqual([...ids].sort());
      expect(descending.map((row: { id: string }) => row.id)).toEqual([
        TAG_3,
        TAG_2,
        TAG_1,
      ]);
    });

    test("cursor pagination walks that same order", async () => {
      const first = await client.post.findMany({
        orderBy: { id: "asc" },
        take: 1,
      });
      expect(first[0]?.id).toBe(POST_1);
      const next = await client.post.findMany({
        orderBy: { id: "asc" },
        cursor: { id: POST_1 },
        skip: 1,
        take: 2,
      });
      expect(next.map((row: { id: string }) => row.id)).toEqual([
        POST_2,
        POST_3,
      ]);
    });

    test("a nested include decodes through the JSON carrier", async () => {
      const account = await client.account.findUnique({
        where: { id: ACCOUNT_A },
        include: { posts: { orderBy: { id: "asc" } }, invited: true },
      });
      expect(account?.id).toBe(ACCOUNT_A);
      expect(
        account?.posts.map((row: { id: string; authorId: string }) => [
          row.id,
          row.authorId,
        ])
      ).toEqual([
        [POST_1, ACCOUNT_A],
        [POST_3, ACCOUNT_A],
      ]);
      // The self-relation, read through the same carrier.
      expect(account?.invited.map((row: { id: string }) => row.id)).toEqual([
        ACCOUNT_C,
      ]);
    });

    test("a many-to-many junction stores the two keys compactly", async () => {
      const post = await client.post.findUnique({
        where: { id: POST_1 },
        include: { tags: { orderBy: { id: "asc" } } },
      });
      expect(post?.tags.map((row: { id: string }) => row.id)).toEqual([
        TAG_1,
        TAG_2,
      ]);

      await client.post.update({
        where: { id: POST_1 },
        data: { tags: { connect: [{ id: TAG_3 }] } },
      });
      const widened = await client.post.findUnique({
        where: { id: POST_1 },
        include: { tags: { orderBy: { id: "asc" } } },
      });
      expect(widened?.tags.map((row: { id: string }) => row.id)).toEqual([
        TAG_1,
        TAG_2,
        TAG_3,
      ]);
    });

    test("a compound identifier key addresses and reads back", async () => {
      const seat = await client.seat.findUnique({
        where: { roomId_slotId: { roomId: UUID_A, slotId: SLOT_1 } },
      });
      expect(seat).toMatchObject({
        roomId: UUID_A,
        slotId: SLOT_1,
        label: "front",
      });
      const room = await client.seat.findMany({
        where: { roomId: UUID_A },
        orderBy: { slotId: "asc" },
      });
      expect(room.map((row: { slotId: string }) => row.slotId)).toEqual([
        SLOT_1,
        SLOT_2,
      ]);
    });

    test("upsert takes both arms on an identifier key", async () => {
      const created = await client.tag.upsert({
        where: { id: "01FGHJKMNPQRSTVWXYZ012345A" },
        create: { id: "01FGHJKMNPQRSTVWXYZ012345A", name: "delta" },
        update: { name: "never" },
      });
      expect(created).toMatchObject({
        id: "01FGHJKMNPQRSTVWXYZ012345A",
        name: "delta",
      });

      const updated = await client.tag.upsert({
        where: { id: "01FGHJKMNPQRSTVWXYZ012345A" },
        create: { id: "01FGHJKMNPQRSTVWXYZ012345A", name: "never" },
        update: { name: "epsilon" },
      });
      expect(updated).toMatchObject({
        id: "01FGHJKMNPQRSTVWXYZ012345A",
        name: "epsilon",
      });

      await client.tag.delete({
        where: { id: "01FGHJKMNPQRSTVWXYZ012345A" },
      });
      expect(
        await client.tag.findUnique({
          where: { id: "01FGHJKMNPQRSTVWXYZ012345A" },
        })
      ).toBeNull();
    });

    test("update re-points a foreign key through connect", async () => {
      await client.post.update({
        where: { id: POST_2 },
        data: { author: { connect: { id: ACCOUNT_C } } },
      });
      expect(
        (await client.post.findUnique({ where: { id: POST_2 } }))?.authorId
      ).toBe(ACCOUNT_C);
      await client.post.update({
        where: { id: POST_2 },
        data: { authorId: ACCOUNT_B },
      });
      expect(
        (await client.post.findUnique({ where: { id: POST_2 } }))?.authorId
      ).toBe(ACCOUNT_B);
    });

    test("a generated identifier round-trips without ever being spelled", async () => {
      const created = await client.tag.create({ data: { name: "generated" } });
      expect(created.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      const read = await client.tag.findUnique({ where: { id: created.id } });
      expect(read?.id).toBe(created.id);
      await client.tag.delete({ where: { id: created.id } });
    });

    test("a text-stored format keeps its whole public string in the column", async () => {
      const account = await client.account.findUnique({
        where: { handle: HANDLE_A },
      });
      expect(account?.handle).toBe(HANDLE_A);
      const matched = await client.account.findMany({
        where: { handle: { contains: "StGXR8" } },
      });
      expect(matched.map((row: { id: string }) => row.id)).toEqual([ACCOUNT_A]);
    });

    test("_min and _max answer with the earliest and latest identifier", async () => {
      // Byte order IS canonical text order, so MIN/MAX over the column answer
      // the same question they answered when it was text — and they answer it
      // as the PUBLIC string, prefix included.
      const aggregate = await client.post.aggregate({
        _count: true,
        _min: { id: true },
        _max: { id: true },
      });
      expect(aggregate._count).toBe(3);
      expect(aggregate._min.id).toBe(POST_1);
      expect(aggregate._max.id).toBe(POST_3);

      const prefixed = await client.account.aggregate({ _min: { id: true } });
      expect(prefixed._min.id).toBe(ACCOUNT_A);

      // An aggregate over NO rows is null, which the hex transport has to
      // preserve — SQLite's `hex(NULL)` is the empty string.
      const empty = await client.post.aggregate({
        where: { title: "nothing matches this" },
        _min: { id: true },
      });
      expect(empty._min.id).toBeNull();
    });

    test("groupBy groups by the public identifier", async () => {
      const groups = await client.tag.groupBy({
        by: ["id"],
        _count: true,
        orderBy: { id: "asc" },
      });
      expect(groups.map((row: { id: string }) => row.id)).toEqual([
        TAG_1,
        TAG_2,
        TAG_3,
      ]);
    });

    test("a value outside the declared domain is refused, not stored", async () => {
      await expect(
        client.tag.create({ data: { id: "not-a-ulid", name: "bad" } })
      ).rejects.toThrow();
      await expect(
        client.account.findUnique({ where: { id: UUID_A } })
      ).rejects.toThrow();
    });
  });
}
