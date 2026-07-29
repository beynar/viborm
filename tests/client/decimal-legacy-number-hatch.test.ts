import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, describe, expect, test } from "vitest";
import { createInMemoryPGliteDriver } from "../fixtures/drivers/pglite";

/**
 * The `decimal: "number"` transitional hatch (W6-U1).
 *
 * These tests pin two things at once: that the hatch DOES restore the old
 * runtime shape, and that it restores the old runtime DEFECT along with it.
 * The second half is the point — the hatch is documented as a way to unblock a
 * deploy, not as a mode to stay on, and a test that only proved "it returns
 * numbers" would make it look like a supported alternative.
 */

const ledger = s
  .model({
    id: s.string().id(),
    amount: s.decimal(),
    amounts: s.decimal().array(),
    maybe: s.decimal().nullable(),
  })
  .map("decimal_hatch_ledger");

const schema = { ledger };

const EXACT = "1.000000000000000000000000000001";

describe("decimal: 'number' legacy hatch", () => {
  let disconnect: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await disconnect?.();
    disconnect = undefined;
  });

  const clientWith = async (decimal?: "string" | "number") => {
    const client = createClient({
      schema,
      driver: createInMemoryPGliteDriver(),
      ...(decimal ? { decimal } : {}),
    });
    disconnect = () => client.$disconnect();
    await push(client, { force: true });
    await client.ledger.create({
      data: { id: "l-1", amount: EXACT, amounts: ["0.1", "2.5"], maybe: null },
    });
    return client;
  };

  test("default is exact strings — the hatch is opt-in, not the fallback", async () => {
    const client = await clientWith();

    const row = await client.ledger.findUnique({ where: { id: "l-1" } });
    expect(typeof row?.amount).toBe("string");
    expect(row?.amount).toBe(EXACT);
  });

  test("'number' restores the pre-W6 runtime decode", async () => {
    const client = await clientWith("number");

    const row = await client.ledger.findUnique({ where: { id: "l-1" } });
    expect(typeof row?.amount).toBe("number");
  });

  test("and restores the precision loss that came with it", async () => {
    const client = await clientWith("number");

    const row = await client.ledger.findUnique({ where: { id: "l-1" } });
    // The stored value is exact; the hatch hands back a double, so the 30th
    // digit is gone. This is the defect W6-U1 fixed, deliberately reinstated
    // for one release — asserted here so nobody mistakes it for a safe mode.
    expect(row?.amount).toBe(1);
    expect(row?.amount).not.toBe(EXACT);
  });

  test("the hatch is runtime-only: WRITES still take exact strings", async () => {
    const client = await clientWith("number");

    // Storage stays exact under the hatch — only the read is re-lossified, so
    // turning the hatch off later recovers every digit from the database.
    await client.ledger.update({
      where: { id: "l-1" },
      data: { amount: "2.000000000000000000000000000002" },
    });

    const row = await client.ledger.findUnique({ where: { id: "l-1" } });
    expect(row?.amount).toBe(2);

    // Proof the digits are still IN the database, not just rounded on read: an
    // exact-equality filter on the full 30-digit value still finds the row.
    const stillExact = await client.ledger.findMany({
      where: { amount: "2.000000000000000000000000000002" },
    });
    expect(stillExact).toHaveLength(1);
  });

  test("lists and nulls follow the same rule", async () => {
    const client = await clientWith("number");

    const row = await client.ledger.findUnique({ where: { id: "l-1" } });
    expect(row?.amounts).toEqual([0.1, 2.5]);
    expect(row?.maybe).toBeNull();
  });

  test("filters keep comparing exactly even under the hatch", async () => {
    const client = await clientWith("number");

    // The hatch touches the DECODE only. The comparison still happens in the
    // database against the exact stored value, so a filter that a double could
    // not distinguish still answers correctly.
    const hit = await client.ledger.findMany({ where: { amount: EXACT } });
    expect(hit).toHaveLength(1);

    const miss = await client.ledger.findMany({ where: { amount: "1" } });
    expect(miss).toEqual([]);
  });
});
