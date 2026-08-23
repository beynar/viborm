import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { describe, expect, test } from "vitest";

/**
 * B3 PROVIDER CONTRACT — a polymorphic collection's MEMBER JUNCTION TABLES
 * against a real database.
 *
 * A collection group stores each variant's membership in its own junction
 * table. Nothing can read or write those tables through the client yet (the
 * operation-schema families are omitted until Package C), so what this contract
 * proves is exactly what B3 claims: the DDL is real, the database enforces it,
 * and pushing twice converges.
 *
 * Membership rows are therefore written with raw SQL. That is not a workaround
 * — it is the only honest way to test DDL whose client surface does not exist
 * yet, and it means the enforcement assertions below measure the DATABASE, not
 * VibORM's own query builder.
 *
 * The schema is chosen to exercise every axis at once:
 * - COMPOUND owner row key (tenantId, code) and COMPOUND target row key
 *   (region, isbn), so multi-column FK groups and their ordering are live;
 * - a SINGULAR inverse (`book.shelf`, a fields-less optional manyToOne), which
 *   makes that member's target side UNIQUE — one shelf per book;
 * - a PLURAL inverse (`video.shelves`, a fields-less manyToMany), which leaves
 *   its member's target side non-unique — a video may sit on many shelves;
 * - explicit `.through()` naming on both, so the identifiers are deterministic
 *   across all three dialects. (Default naming is pinned per dialect in the
 *   serializer's DDL matrix; this contract is about database behaviour.)
 */
const memberJunctionProviderSchema = (() => {
  const book = s
    .model({
      region: s.string(),
      isbn: s.string(),
      title: s.string(),
      // SINGULAR inverse → unique target side on the member table.
      shelf: s.toOne(() => shelf),
    })
    .id(["region", "isbn"])
    .map("provider_pmj_books");

  const video = s
    .model({
      id: s.string().id(),
      title: s.string(),
      // PLURAL inverse → no unique constraint on that member table.
      shelves: s.toMany(() => shelf),
    })
    .map("provider_pmj_videos");

  const shelf = s
    .model({
      tenantId: s.string(),
      code: s.string(),
      label: s.string(),
      items: s
        .toMany(
          { book: () => book, video: () => video },
          { values: { book: "pmj.book.v1", video: "pmj.video.v1" } }
        )
        .through({
          book: {
            table: "provider_pmj_shelf_book",
            source: "shelf",
            target: "book",
          },
          video: {
            table: "provider_pmj_shelf_video",
            source: "shelf",
            target: "video",
          },
        }),
    })
    .id(["tenantId", "code"])
    .map("provider_pmj_shelves");

  return { book, video, shelf };
})();

const BOOK_MEMBER_TABLE = "provider_pmj_shelf_book";
const VIDEO_MEMBER_TABLE = "provider_pmj_shelf_video";

export interface PolymorphicMemberJunctionBehaviorOptions {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
}

export function runPolymorphicMemberJunctionBehavior({
  driverName,
  createDriver,
}: PolymorphicMemberJunctionBehaviorOptions): void {
  describe(`${driverName} polymorphic member junction storage`, () => {
    test("creates, enforces and converges the member tables", async () => {
      const client = createClient({
        schema: memberJunctionProviderSchema,
        driver: createDriver(),
      });
      const dialect = client.$driver.dialect;
      // MySQL quotes identifiers with backticks; PostgreSQL and SQLite with
      // double quotes. The owner's row-key columns are camelCase, so quoting is
      // required, not cosmetic.
      const q = (name: string) =>
        dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
      // PostgreSQL takes positional `$n`; MySQL and SQLite take `?`.
      const holes = (count: number) =>
        Array.from({ length: count }, (_, index) =>
          dialect === "postgresql" ? `$${index + 1}` : "?"
        ).join(", ");
      const insertMember = (
        table: string,
        columns: readonly string[],
        values: readonly string[]
      ) =>
        client.$executeRawUnsafe(
          `INSERT INTO ${q(table)} (${columns.map(q).join(", ")}) VALUES (${holes(columns.length)})`,
          ...values
        );
      const countMembers = async (table: string) => {
        const rows = await client.$queryRawUnsafe<{ total: number | bigint }>(
          `SELECT COUNT(*) AS total FROM ${q(table)}`
        );
        return Number(rows[0]?.total ?? -1);
      };

      try {
        const first = await push(client, { force: true });
        expect(
          new Set(
            first.operations
              .filter((operation) => operation.type === "createTable")
              .map((operation) => operation.table.name)
          )
        ).toEqual(
          new Set([
            "provider_pmj_books",
            "provider_pmj_videos",
            "provider_pmj_shelves",
            BOOK_MEMBER_TABLE,
            VIDEO_MEMBER_TABLE,
          ])
        );

        await client.shelf.create({
          data: { tenantId: "tenant-a", code: "main", label: "Main" },
        });
        await client.shelf.create({
          data: { tenantId: "tenant-a", code: "spare", label: "Spare" },
        });
        await client.book.create({
          data: { region: "eu", isbn: "111", title: "Selected" },
        });
        await client.video.create({ data: { id: "v1", title: "Clip" } });

        // The member table accepts a membership row written directly.
        await insertMember(
          BOOK_MEMBER_TABLE,
          ["book_1", "book_2", "shelf_1", "shelf_2"],
          ["eu", "111", "tenant-a", "main"]
        );
        expect(await countMembers(BOOK_MEMBER_TABLE)).toBe(1);

        // SINGULAR INVERSE ENFORCED BY THE DATABASE: the unique constraint sits
        // on the TARGET side, so the same book cannot join a second shelf. This
        // is the whole point of deriving `inverseCardinality` per member — and
        // it is the assertion that would fail if the unique side were spelled
        // on the owner columns, or omitted, or (subtly) if it were emitted as
        // the reverse index flipped rather than the complete target group.
        await expect(
          insertMember(
            BOOK_MEMBER_TABLE,
            ["book_1", "book_2", "shelf_1", "shelf_2"],
            ["eu", "111", "tenant-a", "spare"]
          )
        ).rejects.toThrow();
        expect(await countMembers(BOOK_MEMBER_TABLE)).toBe(1);

        // PLURAL INVERSE: the same video sits on both shelves happily. Without
        // this arm the pin above would also pass on a schema that made EVERY
        // member's target side unique.
        await insertMember(
          VIDEO_MEMBER_TABLE,
          ["shelf_1", "shelf_2", "video"],
          ["tenant-a", "main", "v1"]
        );
        await insertMember(
          VIDEO_MEMBER_TABLE,
          ["shelf_1", "shelf_2", "video"],
          ["tenant-a", "spare", "v1"]
        );
        expect(await countMembers(VIDEO_MEMBER_TABLE)).toBe(2);

        // CASCADE FROM THE OWNER: both member FKs are fixed `cascade`, so
        // deleting a shelf takes its membership rows with it and leaves the
        // other shelf's rows alone.
        await client.shelf.delete({
          where: { tenantId_code: { tenantId: "tenant-a", code: "spare" } },
        });
        expect(await countMembers(VIDEO_MEMBER_TABLE)).toBe(1);
        expect(await countMembers(BOOK_MEMBER_TABLE)).toBe(1);

        // CASCADE FROM THE TARGET: deleting the book clears its membership.
        await client.book.delete({
          where: { region_isbn: { region: "eu", isbn: "111" } },
        });
        expect(await countMembers(BOOK_MEMBER_TABLE)).toBe(0);

        // CONVERGENCE: a second forced push must introspect the compound PKs,
        // the dual FK groups, the reverse indexes and the singular member's
        // unique side and find all of it stable. Any spelling the database
        // reports differently from what the serializer emits shows up here as a
        // non-empty operation list.
        const secondPush = await push(client, { force: true });
        expect(secondPush.operations).toEqual([]);
        // ...and the surviving membership row is untouched by the second push.
        expect(await countMembers(VIDEO_MEMBER_TABLE)).toBe(1);
      } finally {
        await client.$disconnect();
      }
    });
  });
}

export const polymorphicMemberJunctionContract = defineContract({
  id: "drivers.polymorphic-member-junction",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runPolymorphicMemberJunctionBehavior,
});
