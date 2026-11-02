/**
 * A list's recursive projection is read for its whole page (one `WITH`
 * member for the page, one walk seeded by it) only where no physical name
 * resembles an alias: a column or table named like the page's members or
 * carried columns would be shadowed by them. There it keeps one walk per row,
 * and answers as that form does (Sol's review of V4, 2026-11-03).
 */

import { createClient } from "@client/client";
import type { Driver } from "@drivers/driver";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const PAGE_MEMBER = /AS "?__q\d+_page"?/;

export function describeRecursivePageAliases(
  provider: string,
  open: () => Driver<any, any>
) {
  for (const [what, mapping] of [
    ["a column named like a carried order term", { column: "__q0_order_0" }],
    ["a table named like the page member", { table: "__q0_page" }],
  ] as const) {
    test(`${provider}: ${what} keeps one walk per row, and its answer`, async () => {
      const id =
        "column" in mapping
          ? s.string().id().map(mapping.column)
          : s.string().id();
      const base = s.model({
        id,
        rank: s.int(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => node)
          .fields("parentId")
          .references("id"),
        children: s.toMany(() => node),
      });
      const node = "table" in mapping ? base.map(mapping.table) : base;
      const driver = open();
      const client = createClient({ schema: { node }, driver });
      try {
        await syncLiveSchema(client);
        await client.node.createMany({
          data: [
            { id: "a", rank: 3 },
            { id: "b", rank: 1 },
            { id: "c", rank: 2, parentId: "a" },
          ],
        });
        const statements: string[] = [];
        const db = client.$extends({
          name: "statements",
          statement(context) {
            statements.push(context.statement.toStatement());
            return context.statement;
          },
        });
        const rows = await db.node.findMany({
          orderBy: { rank: "desc" },
          select: {
            id: true,
            children: { recurse: { depth: 1 }, select: { id: true } },
          },
        });
        expect(statements.at(-1)).not.toMatch(PAGE_MEMBER);
        expect(rows).toEqual([
          { id: "a", children: [{ id: "c" }] },
          { id: "c", children: [] },
          { id: "b", children: [] },
        ]);
      } finally {
        await client.$disconnect();
      }
    });
  }
}
