import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { NotFoundError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// All identifiers are lowercase single words so the raw SQL strings need no
// dialect-specific quoting (double quotes vs backticks).
const item = s
  .model({
    id: s.string().id(),
    label: s.string(),
    qty: s.int().default(0),
  })
  .map("client_raw_items");

const schema = { item };

type ClientRawClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ClientRawClient = VibORMClient<ClientRawClientConfig>;

export interface ClientRawBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Client surface that had no cross-driver execution coverage:
 * - $queryRaw (raw string + params, in each driver's placeholder style)
 * - $executeRaw (sql`` template; the client renders placeholders per adapter)
 * - findFirstOrThrow / findUniqueOrThrow (found + NotFoundError)
 * - exist (true / false)
 */
export function runClientRawBehavior({
  driverName,
  createDriver,
}: ClientRawBehaviorOptions) {
  describe(`${driverName} client raw/orThrow/exist behavior`, () => {
    let client: ClientRawClient;
    // $queryRaw takes a plain SQL string, so the test supplies the driver's
    // native placeholder style ($n for postgres wire protocol, ? elsewhere).
    let placeholder: (index: number) => string;

    beforeEach(async () => {
      const driver = createDriver();
      placeholder =
        driver.dialect === "postgresql" ? (i) => `$${i}` : () => "?";
      client = createClient({ schema, driver });
      await push(client, { force: true });

      await client.item.createMany({
        data: [
          { id: "i1", label: "Alpha", qty: 1 },
          { id: "i2", label: "Beta", qty: 5 },
          { id: "i3", label: "Gamma", qty: 9 },
        ],
      });
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    describe("$queryRaw", () => {
      test("selects with a parameter and rows round-trip", async () => {
        const result = await client.$queryRaw<{
          id: string;
          label: string;
          qty: number | bigint;
        }>(
          `SELECT id, label, qty FROM client_raw_items WHERE qty >= ${placeholder(
            1
          )} ORDER BY id`,
          [5]
        );

        // Raw rows are driver-native: most drivers hand INTEGER columns back
        // as JS numbers, but LibSQL reads with intMode "bigint" so they
        // arrive as BigInt (the ORM's typed read path normalizes int fields;
        // $queryRaw deliberately does not). Normalize before comparing.
        expect(result.rows.map((r) => ({ ...r, qty: Number(r.qty) }))).toEqual([
          { id: "i2", label: "Beta", qty: 5 },
          { id: "i3", label: "Gamma", qty: 9 },
        ]);
      });

      test("binds multiple parameters in order", async () => {
        const result = await client.$queryRaw<{ id: string }>(
          `SELECT id FROM client_raw_items WHERE qty > ${placeholder(
            1
          )} AND label = ${placeholder(2)}`,
          [1, "Beta"]
        );

        expect(result.rows).toEqual([{ id: "i2" }]);
      });
    });

    describe("$executeRaw", () => {
      test("selects through the sql template with bound values", async () => {
        const result = await client.$executeRaw<{ label: string }>(
          sql`SELECT label FROM client_raw_items WHERE qty >= ${5} ORDER BY label`
        );

        expect(result.rows).toEqual([{ label: "Beta" }, { label: "Gamma" }]);
      });

      test("mutates and reports rowCount, visible to the ORM read path", async () => {
        const result = await client.$executeRaw(
          sql`UPDATE client_raw_items SET qty = ${100} WHERE qty >= ${5}`
        );
        expect(result.rowCount).toBe(2);

        const bumped = await client.item.findMany({
          where: { qty: 100 },
          orderBy: { id: "asc" },
        });
        expect(bumped.map((i) => i.id)).toEqual(["i2", "i3"]);
      });
    });

    describe("direct mutation misses", () => {
      test("update reports NotFoundError", async () => {
        await expect(
          client.item.update({
            where: { id: "missing" },
            data: { label: "Missing" },
          })
        ).rejects.toBeInstanceOf(NotFoundError);
      });

      test("delete reports NotFoundError", async () => {
        await expect(
          client.item.delete({ where: { id: "missing" } })
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe("findFirstOrThrow", () => {
      test("returns the matching row when found", async () => {
        const found = await client.item.findFirstOrThrow({
          where: { qty: { gt: 1 } },
          orderBy: { qty: "desc" },
        });
        expect(found).toMatchObject({ id: "i3", label: "Gamma", qty: 9 });
      });

      test("throws NotFoundError when nothing matches", async () => {
        const pending = client.item.findFirstOrThrow({
          where: { label: "Missing" },
        });
        await expect(pending).rejects.toBeInstanceOf(NotFoundError);
        await expect(pending).rejects.toMatchObject({
          name: "NotFoundError",
        });
      });
    });

    describe("findUniqueOrThrow", () => {
      test("returns the matching row when found", async () => {
        const found = await client.item.findUniqueOrThrow({
          where: { id: "i1" },
        });
        expect(found).toMatchObject({ id: "i1", label: "Alpha", qty: 1 });
      });

      test("throws NotFoundError when the id does not exist", async () => {
        const pending = client.item.findUniqueOrThrow({
          where: { id: "nope" },
        });
        await expect(pending).rejects.toBeInstanceOf(NotFoundError);
        await expect(pending).rejects.toMatchObject({
          name: "NotFoundError",
        });
      });
    });

    describe("exist", () => {
      test("returns true when a matching row exists", async () => {
        const exists = await client.item.exist({ where: { label: "Alpha" } });
        expect(exists).toBe(true);
      });

      test("returns false when no row matches", async () => {
        const exists = await client.item.exist({
          where: { label: "Missing" },
        });
        expect(exists).toBe(false);
      });
    });
  });
}
