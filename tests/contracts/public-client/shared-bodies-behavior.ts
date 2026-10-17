import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { sql } from "@sql";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

/** Shared bodies preserve policy parameter tuples and native list members. */
export function runSharedBodiesBehavior({
  name: provider,
  createDriver,
}: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}) {
  describe(`${provider}: relation body parameter identity`, () => {
    const clients: { $disconnect(): Promise<void> }[] = [];
    afterEach(async () => {
      for (const client of clients.splice(0)) await client.$disconnect();
    });
    for (const shared of [false, true]) {
      test(`${provider}: sharing=${shared} preserves physical fields that resemble aliases`, async () => {
        const container = s.model({
          id: s.int().id(),
          entries: s.toMany(() => entry),
        });
        const entry = s.model({
          id: s.int().id(),
          containerId: s.int(),
          container: s
            .toOne(() => container)
            .fields("containerId")
            .references("id"),
          first: s.string().map("q98"),
          second: s.string().map("q99"),
          embeddedFirst: s.string().map("prefix_q98_suffix"),
          embeddedSecond: s.string().map("prefix_q99_suffix"),
        });
        const driver = createDriver();
        driver.adapter.capabilities.sharesRelationBodies = shared;
        const base = createClient({ schema: { container, entry }, driver });
        clients.push(base);
        await syncLiveSchema(base);
        await base.container.create({ data: { id: 1 } });
        await base.entry.create({
          data: {
            id: 1,
            containerId: 1,
            first: "yes",
            second: "no",
            embeddedFirst: "yes",
            embeddedSecond: "no",
          },
        });
        for (const fields of [
          ["first", "second"],
          ["embeddedFirst", "embeddedSecond"],
        ]) {
          const governed = base.$extends({
            name: "physical-name-policy",
            rows: {
              control: "scope",
              default: "all",
              models: {},
              verbs: {
                container: {
                  predicates: {
                    permitted: {
                      AND: fields.map((field) => ({
                        entries: { some: { [field]: "yes" } },
                      })),
                    },
                  },
                  read: "permitted",
                },
              },
            },
          });
          expect(await governed.container.findMany()).toEqual([]);
        }
      });

      // ENG-4 (review 2): a caller's `sql` text is not the engine's. Two
      // bodies that differ only in alias-shaped caller text ('_q1_' against
      // '_q2_') were one key set, and both arms read the first's rows.
      test(`${provider}: sharing=${shared} keeps alias-shaped text in a caller's SQL operand`, async () => {
        const doc = s.model({
          id: s.string().id(),
          grants: s.toMany(() => grant),
        });
        const grant = s.model({
          id: s.string().id(),
          docId: s.string(),
          doc: s
            .toOne(() => doc)
            .fields("docId")
            .references("id"),
          level: s.string(),
        });
        const driver = createDriver();
        driver.adapter.capabilities.sharesRelationBodies = shared;
        const base = createClient({ schema: { doc, grant }, driver });
        clients.push(base);
        await syncLiveSchema(base);
        await base.doc.createMany({
          data: [{ id: "d1" }, { id: "d2" }, { id: "d3" }],
        });
        await base.grant.createMany({
          data: [
            { id: "g1", docId: "d1", level: "_q1_" },
            { id: "g2", docId: "d2", level: "_q2_" },
          ],
        });
        const governed = base
          .$extends(
            permissions({
              actor: v.object({ userId: v.string() }),
              models: { doc: { read: true }, grant: { read: true } },
            })
          )
          .$as({ userId: "u1" });
        const where = {
          OR: [
            { grants: { some: { level: { equals: sql`'_q1_'` } } } },
            { grants: { some: { level: { equals: sql`'_q2_'` } } } },
          ],
        };
        for (const client of [base, governed])
          expect(
            await client.doc.findMany({
              where,
              select: { id: true },
              orderBy: { id: "asc" },
            })
          ).toEqual([{ id: "d1" }, { id: "d2" }]);
      });

      test(`${provider}: sharing=${shared} preserves distinct policy parameter tuples and array members`, async () => {
        const container = s.model({
          id: s.int().id(),
          entries: s.toMany(() => entry),
        });
        const entry = s.model({
          id: s.int().id(),
          containerId: s.int(),
          container: s
            .toOne(() => container)
            .fields("containerId")
            .references("id"),
          a: s.string(),
          b: s.string(),
          tags: s.string().array(),
        });
        const driver = createDriver();
        driver.adapter.capabilities.sharesRelationBodies = shared;
        const base = createClient({ schema: { container, entry }, driver });
        clients.push(base);
        await syncLiveSchema(base);
        await base.container.create({ data: { id: 1 } });
        await base.entry.create({
          data: {
            id: 1,
            containerId: 1,
            a: "a\u0002string:b",
            b: "c",
            tags: ["a,string:b"],
          },
        });
        const governed = base.$extends({
          name: "collision-policy",
          rows: {
            control: "scope",
            default: "all",
            models: {},
            verbs: {
              container: {
                predicates: {
                  permitted: {
                    AND: [
                      { entries: { some: { a: "a\u0002string:b", b: "c" } } },
                      { entries: { some: { a: "a", b: "b\u0002string:c" } } },
                    ],
                  },
                },
                read: "permitted",
              },
            },
          },
        });
        const arrayQuery = () =>
          base.container.findMany({
            where: {
              AND: [
                { entries: { some: { tags: { hasEvery: ["a,string:b"] } } } },
                { entries: { some: { tags: { hasEvery: ["a", "b"] } } } },
              ],
            },
          });
        expect(await governed.container.findMany()).toEqual([]);
        expect(await arrayQuery()).toEqual([]);
        // Both conjuncts become true only after a second entry satisfies the
        // distinct tuple and array. Equal-looking encodings prove nothing.
        await base.entry.create({
          data: {
            id: 2,
            containerId: 1,
            a: "a",
            b: "b\u0002string:c",
            tags: ["a", "b"],
          },
        });
        expect(await governed.container.findMany()).toEqual([{ id: 1 }]);
        expect(await arrayQuery()).toEqual([{ id: 1 }]);
      });
    }
  });
}
