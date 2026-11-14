/**
 * Step 8 review (judge/projection moved out of the engine): what a chain
 * states must still reach the engine wherever the parts come from. A
 * confinement bounds the sets a statement computes over a whole table
 * whichever extension brings the filters, in either order, under a mode
 * other than the default (the defaults domain); a judged write is judged
 * where the verbs come from a second extension; a gated field stays gated
 * there too.
 */
import { defineExtension, defineFilters } from "@extensions/define";
import { s } from "@schema";
import { v } from "@src/validation";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { beforeEach, describe, expect, test } from "vitest";

describe("step 8: a confinement, a judgement and a gate reach the engine from any chain", () => {
  const page = s.model({
    id: s.string().id(),
    note: s.string().default(""),
    grants: s.toMany(() => grant),
  });
  const grant = s.model({
    id: s.string().id(),
    tenant: s.string(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    userId: s.string(),
  });
  const family = usePGliteSchemaFamily({ page, grant });
  let base: ReturnType<typeof family>["client"];
  const granted = { grants: { some: { userId: { control: "user" } } } };
  const sharing = defineExtension({
    name: "sharing",
    controls: {
      user: { schema: v.string(), required: true },
      tenant: { schema: v.string() },
    },
    rows: {
      control: "as",
      default: "default",
      models: { page: { default: {}, other: {} } },
      verbs: {
        page: {
          predicates: {
            seen: {
              OR: [
                { AND: [granted, { id: { not: "x" } }] },
                { AND: [granted, { id: { not: "y" } }] },
              ],
            },
            mine: { id: { startsWith: "p" } },
          },
          read: "seen",
          update: "seen",
          place: "mine",
          reads: { note: "mine" },
        },
      },
      confine: { grant: { tenant: { control: "tenant" } } },
    },
  });
  const filtering = defineFilters({
    name: "filtering",
    rows: {
      control: "scope",
      default: "all",
      models: { grant: { all: { root: {} } } },
    },
  });

  beforeEach(async () => {
    base = family().client;
    await base.page.create({ data: { id: "p", note: "n" } });
    await base.page.create({ data: { id: "q", note: "hidden" } });
    for (const id of ["p", "q"])
      await base.grant.create({
        data: { id: `g${id}`, tenant: "b", pageId: id, userId: "ada" },
      });
  });

  const chains = {
    "confine alone": () => base.$extends(sharing),
    "filters, then confine": () => base.$extends(filtering).$extends(sharing),
    "confine, then filters": () => base.$extends(sharing).$extends(filtering),
  };
  for (const [name, chain] of Object.entries(chains)) {
    test(`${name}: another tenant's grants grant nothing, under each mode`, async () => {
      const db = chain();
      for (const as of ["default", "other"] as const) {
        const pages = (args: object) =>
          db.page.findMany({ as, ...args, select: { id: true } });
        expect(await pages({ user: "ada", tenant: "b" })).toEqual([
          { id: "p" },
          { id: "q" },
        ]);
        expect(await pages({ user: "ada", tenant: "a" })).toEqual([]);
      }
    });

    test(`${name}: a created row is judged and a gated field read as absent`, async () => {
      const db = chain();
      await expect(
        db.page.create({ data: { id: "z" }, user: "ada" })
      ).rejects.toThrow("not permitted");
      const rows = await db.page.findMany({
        user: "ada",
        orderBy: { id: "asc" },
      });
      expect(rows.map((row) => row.note ?? null)).toEqual(["n", null]);
      const groups = await db.page.groupBy({
        user: "ada",
        by: ["note"],
        _count: { _all: true },
        having: { note: { equals: "hidden" } },
      });
      expect(groups).toEqual([]);
      const counted = await db.page.aggregate({
        user: "ada",
        where: { note: "hidden" },
        _count: { _all: true },
      });
      expect(counted).toEqual({ _count: { _all: 0 } });
    });
  }
});
