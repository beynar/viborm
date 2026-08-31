import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * Set membership on binary columns (`in` / `notIn`).
 *
 * Prisma's `BytesFilter` carries in/notIn; viborm's blob filter used to fall
 * back to the `{ equals, not }` base set, so a byte-array list had no spelling
 * at all. Adding it is only half the job — the other half is that each dialect
 * has to bind a LIST of byte arrays as parameters (`bytea` on postgres, `BLOB`
 * on sqlite/libsql, `BLOB` on mysql), which is exactly the kind of thing that
 * works for a single `equals` parameter and quietly breaks for N of them.
 * Hence a driver behavior suite rather than a SQL-text assertion: every
 * dialect must return the same rows for the same list.
 *
 * The fixtures are chosen so a length-only or prefix-only comparison would
 * fail: ALPHA and DECOY are the same length and differ only in the last byte.
 */

const blobRow = s
  .model({
    id: s.string().id(),
    payload: s.blob(),
    optionalPayload: s.blob().nullable(),
  })
  .map("blob_filter_rows");

const schema = { blobRow };

type BlobFilterClientConfig = VibORMConfig<typeof schema>;

type BlobFilterClient = VibORMClient<BlobFilterClientConfig>;

export interface BlobFilterBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

const ALPHA = new Uint8Array([1, 2, 3, 4]);
const BETA = new Uint8Array([5, 6, 7, 8]);
const GAMMA = new Uint8Array([9, 10, 11, 12]);
// Same length as ALPHA, differs only in the last byte: catches any comparison
// that degrades to length or prefix.
const DECOY = new Uint8Array([1, 2, 3, 5]);
const ABSENT = new Uint8Array([200, 201]);

export function runBlobFilterBehavior({
  driverName,
  createDriver,
}: BlobFilterBehaviorOptions) {
  describe(`${driverName} blob in/notIn filters`, () => {
    let client: BlobFilterClient;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await syncLiveSchema(client);
      await client.blobRow.createMany({
        data: [
          { id: "alpha", payload: ALPHA, optionalPayload: ALPHA },
          { id: "beta", payload: BETA, optionalPayload: BETA },
          { id: "gamma", payload: GAMMA, optionalPayload: null },
          { id: "decoy", payload: DECOY, optionalPayload: DECOY },
        ],
      });
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    async function findIds(
      where: NonNullable<
        NonNullable<
          Parameters<BlobFilterClient["blobRow"]["findMany"]>[0]
        >["where"]
      >
    ) {
      const rows = await client.blobRow.findMany({ where });
      return rows.map((row) => row.id).sort();
    }

    test("in matches exactly the listed byte arrays", async () => {
      expect(await findIds({ payload: { in: [ALPHA, BETA] } })).toEqual([
        "alpha",
        "beta",
      ]);
    });

    test("in compares bytes, not length — the one-byte decoy stays out", async () => {
      expect(await findIds({ payload: { in: [ALPHA] } })).toEqual(["alpha"]);
      expect(await findIds({ payload: { in: [DECOY] } })).toEqual(["decoy"]);
    });

    test("in with no matching member returns nothing", async () => {
      expect(await findIds({ payload: { in: [ABSENT] } })).toEqual([]);
    });

    test("empty in matches nothing (Prisma semantics)", async () => {
      expect(await findIds({ payload: { in: [] } })).toEqual([]);
    });

    test("notIn excludes exactly the listed byte arrays", async () => {
      expect(await findIds({ payload: { notIn: [ALPHA, BETA] } })).toEqual([
        "decoy",
        "gamma",
      ]);
    });

    test("empty notIn matches everything (Prisma semantics)", async () => {
      expect(await findIds({ payload: { notIn: [] } })).toEqual([
        "alpha",
        "beta",
        "decoy",
        "gamma",
      ]);
    });

    test("notIn on a nullable column excludes NULL rows", async () => {
      // `NULL NOT IN (…)` is NULL, not TRUE — 'gamma' is absent even though its
      // NULL payload is obviously "not in" the list. Prisma behaves the same.
      expect(await findIds({ optionalPayload: { notIn: [ALPHA] } })).toEqual([
        "beta",
        "decoy",
      ]);
    });

    test("in on a nullable column excludes NULL rows", async () => {
      expect(
        await findIds({ optionalPayload: { in: [ALPHA, BETA, GAMMA] } })
      ).toEqual(["alpha", "beta"]);
    });

    test("empty notIn on a nullable column keeps the NULL row", async () => {
      // Empty notIn compiles to the dialect's TRUE literal, which matches every
      // row INCLUDING the NULL one — there is no column reference to be NULL.
      // This is the one case where notIn does NOT drop NULLs.
      expect(await findIds({ optionalPayload: { notIn: [] } })).toEqual([
        "alpha",
        "beta",
        "decoy",
        "gamma",
      ]);
    });

    test("Buffer members are accepted alongside Uint8Array", async () => {
      // Node Buffer is a Uint8Array subclass; it must bind identically.
      expect(
        await findIds({ payload: { in: [Buffer.from([5, 6, 7, 8])] } })
      ).toEqual(["beta"]);
    });

    test("in composes with not", async () => {
      expect(
        await findIds({ payload: { not: { in: [ALPHA, BETA] } } })
      ).toEqual(["decoy", "gamma"]);
    });

    test("in composes with arbitrarily nested not", async () => {
      expect(
        await findIds({ payload: { not: { not: { in: [ALPHA, BETA] } } } })
      ).toEqual(["alpha", "beta"]);
    });

    test("in composes with the boolean wrappers", async () => {
      expect(
        await findIds({
          AND: [
            { payload: { in: [ALPHA, BETA, DECOY] } },
            { payload: { notIn: [DECOY] } },
          ],
        })
      ).toEqual(["alpha", "beta"]);

      expect(
        await findIds({
          NOT: { payload: { in: [ALPHA, BETA] } },
        })
      ).toEqual(["decoy", "gamma"]);
    });

    test("in drives deleteMany, not just reads", async () => {
      const result = await client.blobRow.deleteMany({
        where: { payload: { in: [ALPHA, GAMMA] } },
      });

      expect(result.count).toBe(2);
      expect(await findIds({})).toEqual(["beta", "decoy"]);
    });
  });
}

export const blobFilterContract = defineContract({
  id: "drivers.blob-filter",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runBlobFilterBehavior,
});
