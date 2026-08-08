import { defineContract } from "@tests/contracts/contract";
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
 * - $queryRaw (tagged template; the client binds and renders per adapter)
 * - $queryRawUnsafe (hand-written statement + positional params)
 * - $executeRaw / $executeRawUnsafe (affected-row count)
 * - findFirstOrThrow / findUniqueOrThrow (found + NotFoundError)
 * - exist (true / false)
 */
export function runClientRawBehavior({
  driverName,
  createDriver,
}: ClientRawBehaviorOptions) {
  describe(`${driverName} client raw/orThrow/exist behavior`, () => {
    let client: ClientRawClient;
    // The Unsafe variants take a hand-written statement, so those tests supply
    // the driver's native placeholder style ($n for the postgres wire
    // protocol, ? elsewhere). The tagged forms need no such knowledge.
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
      test("binds a tagged interpolation and rows round-trip", async () => {
        const rows = await client.$queryRaw<{
          id: string;
          label: string;
          qty: number | bigint;
        }>`SELECT id, label, qty FROM client_raw_items WHERE qty >= ${5} ORDER BY id`;

        // Raw rows are driver-native, and "native" is not one type. The TAGGED
        // form routes through driver._execute — the same path that opts sqlite3
        // and bun-sqlite into safeIntegers(true) — so INTEGER columns arrive as
        // BigInt on the whole sqlite3 family, and LibSQL does the same via
        // intMode "bigint". Postgres and MySQL hand back JS numbers. Either way
        // nothing here normalizes: the ORM's typed read path converts int
        // fields, $queryRaw deliberately does not. Normalize before comparing.
        // (Only $queryRawUnsafe and the legacy string form take _executeRaw,
        // which deliberately stays off the safe-integer opt-in.)
        expect(rows.map((r) => ({ ...r, qty: Number(r.qty) }))).toEqual([
          { id: "i2", label: "Beta", qty: 5 },
          { id: "i3", label: "Gamma", qty: 9 },
        ]);
      });

      test("binds multiple tagged interpolations in order", async () => {
        const rows = await client.$queryRaw<{
          id: string;
        }>`SELECT id FROM client_raw_items WHERE qty > ${1} AND label = ${"Beta"}`;

        expect(rows).toEqual([{ id: "i2" }]);
      });

      test("accepts a prebuilt sql`` fragment", async () => {
        const rows = await client.$queryRaw<{ label: string }>(
          sql`SELECT label FROM client_raw_items WHERE qty >= ${5} ORDER BY label`
        );

        expect(rows).toEqual([{ label: "Beta" }, { label: "Gamma" }]);
      });
    });

    describe("$queryRawUnsafe", () => {
      test("splices the statement verbatim and binds positional params", async () => {
        const rows = await client.$queryRawUnsafe<{ id: string }>(
          `SELECT id FROM client_raw_items WHERE qty > ${placeholder(
            1
          )} AND label = ${placeholder(2)}`,
          1,
          "Beta"
        );

        expect(rows).toEqual([{ id: "i2" }]);
      });
    });

    describe("$executeRaw", () => {
      test("mutates and answers the affected count, visible to the ORM read path", async () => {
        const affected =
          await client.$executeRaw`UPDATE client_raw_items SET qty = ${100} WHERE qty >= ${5}`;
        expect(affected).toBe(2);

        const bumped = await client.item.findMany({
          where: { qty: 100 },
          orderBy: { id: "asc" },
        });
        expect(bumped.map((i) => i.id)).toEqual(["i2", "i3"]);
      });
    });

    describe("$executeRawUnsafe", () => {
      test("mutates through a hand-written statement", async () => {
        const affected = await client.$executeRawUnsafe(
          `UPDATE client_raw_items SET qty = ${placeholder(
            1
          )} WHERE label = ${placeholder(2)}`,
          42,
          "Alpha"
        );
        expect(affected).toBe(1);

        const alpha = await client.item.findUniqueOrThrow({
          where: { id: "i1" },
        });
        expect(alpha.qty).toBe(42);
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

export const clientRawContract = defineContract({
  id: "drivers.client-raw",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runClientRawBehavior,
});
