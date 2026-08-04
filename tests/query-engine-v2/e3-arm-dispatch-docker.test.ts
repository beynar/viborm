import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { UnsupportedOperationError } from "../../src/query-engine/write-engine/shared";
import { armDispatchSchema, armUpdate } from "./e3-arm-dispatch-behavior";

/**
 * E3 on the live servers. Two things need a real driver rather than PGlite:
 *
 *  · **M5, the mysql2 leg.** An arm named by a NON-primary-key unique gives its deeper
 *    writes a `planned` parent source, so the arm's probe publishes its captured key as
 *    an OPTIONAL `firstRowField` and the deeper planning reads `Ref` it in SQL. When the
 *    arm takes its CREATE branch that probe is empty, so the Ref has no value — and the
 *    D-wave's D2 fix is what makes that bind NULL instead of `undefined`, which mysql2's
 *    binder rejects outright. Every kind E3 opened that plans a correlated read (`update`,
 *    `delete`, `disconnect`, `set`, the junction's membership reads) reaches that bind for
 *    the first time here, so the leg is measured on mysql2 specifically.
 *  · the absorbed writes themselves, on both server dialects.
 *
 * Requires the Docker test databases:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;

function suite(name: string, makeDriver: () => any, enabled: boolean): void {
  const target = enabled ? describe : describe.skip;
  target(`E3 upsert update-arm dispatch (${name})`, () => {
    const seeded = async () => {
      const client = createClient({
        schema: armDispatchSchema,
        driver: makeDriver(),
      }) as any;
      await push(client, { force: true });
      await client.note.deleteMany({});
      await client.team.deleteMany({});
      await client.tag.deleteMany({});
      await client.owner.deleteMany({});
      await client.org.deleteMany({});
      await client.org.create({ data: { id: "o1", name: "Org" } });
      await client.owner.create({ data: { id: "w1", name: "Owner" } });
      await client.tag.create({ data: { id: "g1", name: "Tag" } });
      await client.team.create({
        data: { id: "t1", label: "T1", slug: "team-1", orgId: "o1" },
      });
      await client.team.create({
        data: { id: "tDecoy", label: "DECOY", slug: "team-decoy", orgId: "o1" },
      });
      await client.note.create({
        data: { id: "n1", body: "old", tagName: "nt1", teamId: "t1" },
      });
      await client.note.create({
        data: { id: "nDecoy", body: "decoy", tagName: "ntD", teamId: "tDecoy" },
      });
      return client;
    };

    const notes = async (client: any) =>
      (await client.note.findMany({
        orderBy: { id: "asc" },
        select: { id: true, body: true, teamId: true },
      })) as { id: string; body: string; teamId: string | null }[];

    test("M5: the CREATE arm binds the absent optional Ref, with a deeper correlated read", async () => {
      const client = await seeded();
      // `slug: team-absent` names no row, so the arm INSERTs — and the deeper `update`'s
      // planning probe still runs, correlating on the arm probe's now-empty published key.
      await client.org.update(
        armUpdate(
          { notes: { update: [{ where: { id: "n1" }, data: { body: "X" } }] } },
          { slug: "team-absent" }
        )
      );
      expect(
        (await client.team.findMany({ where: { slug: "team-absent" } })).length
      ).toBe(1);
      // The update arm never ran, so nothing deeper moved.
      expect(await notes(client)).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("M5: the same shape with a deeper disconnect (its probe Refs the arm too)", async () => {
      const client = await seeded();
      await client.org.update(
        armUpdate(
          { notes: { disconnect: [{ id: "n1" }] } },
          { slug: "team-absent2" }
        )
      );
      expect(await notes(client)).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("M5: the same shape with a deeper junction membership read", async () => {
      const client = await seeded();
      await client.org.update(
        armUpdate(
          { tags: { disconnect: [{ id: "g1" }] } },
          { slug: "team-absent3" }
        )
      );
      const fresh = await client.team.findUnique({
        where: { slug: "team-absent3" },
        include: { tags: true },
      });
      expect(fresh.tags).toEqual([]);
    });

    test("the absorbed kinds land on the located row, not the decoy", async () => {
      const client = await seeded();
      await client.org.update(
        armUpdate({
          notes: {
            update: [{ where: { id: "n1" }, data: { body: "new" } }],
          },
        })
      );
      expect(await notes(client)).toEqual([
        { id: "n1", body: "new", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("the multi-kind payload runs both kinds on the server", async () => {
      const client = await seeded();
      await client.org.update(
        armUpdate({
          notes: {
            disconnect: [{ id: "n1" }],
            create: [{ id: "nNew", body: "fresh", tagName: "ntN" }],
          },
        })
      );
      expect(await notes(client)).toEqual([
        { id: "n1", body: "old", teamId: null },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
        { id: "nNew", body: "fresh", teamId: "t1" },
      ]);
    });

    test("the m2m edge is written through the junction on the server", async () => {
      const client = await seeded();
      await client.org.update(armUpdate({ tags: { connect: [{ id: "g1" }] } }));
      const team = await client.team.findUnique({
        where: { id: "t1" },
        include: { tags: true },
      });
      expect(team.tags.map((tag: { id: string }) => tag.id)).toEqual(["g1"]);
    });

    test("the parent-held carve-out refuses identically on the server", async () => {
      const client = await seeded();
      const error = await client.org
        .update(armUpdate({ owner: { connect: { id: "w1" } } }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown
        );
      expect(error).toBeInstanceOf(UnsupportedOperationError);
    });
  });
}

suite(
  "Docker postgres",
  () => new PgDriver({ databaseUrl: PG as string }),
  Boolean(PG)
);
suite(
  "Docker mysql2",
  () => new MySQL2Driver({ databaseUrl: MYSQL as string }),
  Boolean(MYSQL)
);
