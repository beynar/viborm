import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";

import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const compoundJunctionProviderSchema = (() => {
  const author = s
    .model({
      tenantId: s.string(),
      slug: s.string(),
      name: s.string(),
      books: s
        .toMany(() => book)
        .through("provider_compound_author_book")
        .source("author")
        .target("book")
        .onDelete("cascade")
        .onUpdate("cascade"),
    })
    .id(["tenantId", "slug"])
    .map("provider_compound_authors");

  const book = s
    .model({
      region: s.string(),
      code: s.string(),
      title: s.string(),
      // §6.6/D2: `author.books` above owns every override for this junction and
      // this side reads the mirrored view — the same table, the same two
      // tokens, the same actions. Restating them is a second owner (R011).
      authors: s.toMany(() => author),
    })
    .id(["region", "code"])
    .map("provider_compound_books");

  return { author, book };
})();

export interface CompoundJunctionBehaviorOptions {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
}

export function runCompoundJunctionBehavior({
  driverName,
  createDriver,
}: CompoundJunctionBehaviorOptions): void {
  describe(`${driverName} compound junction storage`, () => {
    test("round-trips two complete string-key sides and their cascade", async () => {
      const client = createClient({
        schema: compoundJunctionProviderSchema,
        driver: createDriver(),
      });

      try {
        await syncLiveSchema(client);
        await client.author.create({
          data: {
            tenantId: "tenant-a",
            slug: "same",
            name: "selected",
            books: {
              create: { region: "eu", code: "same", title: "selected" },
            },
          },
        });
        await client.author.create({
          data: { tenantId: "tenant-b", slug: "same", name: "decoy" },
        });
        await client.book.create({
          data: { region: "us", code: "same", title: "decoy" },
        });

        await expect(
          client.author.findUnique({
            where: {
              tenantId_slug: { tenantId: "tenant-a", slug: "same" },
            },
            include: { books: true },
          })
        ).resolves.toMatchObject({
          books: [{ region: "eu", code: "same", title: "selected" }],
        });

        await client.book.update({
          where: { region_code: { region: "eu", code: "same" } },
          data: { region: "ap", code: "moved" },
        });
        await expect(
          client.author.findUnique({
            where: {
              tenantId_slug: { tenantId: "tenant-a", slug: "same" },
            },
            include: { books: true },
          })
        ).resolves.toMatchObject({
          books: [{ region: "ap", code: "moved", title: "selected" }],
        });

        // A second push must introspect the ordered composite PK/FK groups and
        // find the schema stable instead of recreating or truncating a side.
        const secondPush = await syncLiveSchema(client);
        expect(secondPush.operations).toEqual([]);
        await expect(
          client.author.findUnique({
            where: {
              tenantId_slug: { tenantId: "tenant-a", slug: "same" },
            },
            include: { books: true },
          })
        ).resolves.toMatchObject({
          books: [{ region: "ap", code: "moved", title: "selected" }],
        });
      } finally {
        await client.$disconnect();
      }
    });
  });
}

export const compoundJunctionContract = defineContract({
  id: "drivers.compound-junction",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runCompoundJunctionBehavior,
});
