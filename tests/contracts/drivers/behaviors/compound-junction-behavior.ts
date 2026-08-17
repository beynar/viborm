import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { describe, expect, test } from "vitest";

const compoundJunctionProviderSchema = (() => {
  const author = s
    .model({
      tenantId: s.string(),
      slug: s.string(),
      name: s.string(),
      books: s
        .manyToMany(() => book)
        .through("provider_compound_author_book")
        .A("author")
        .B("book")
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
      authors: s
        .manyToMany(() => author)
        .through("provider_compound_author_book")
        .A("book")
        .B("author")
        .onDelete("cascade")
        .onUpdate("cascade"),
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
        await push(client, { force: true });
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
        const secondPush = await push(client, { force: true });
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
