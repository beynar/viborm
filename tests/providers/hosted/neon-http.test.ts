import { createClient } from "@src/client/client";
import { NeonHTTPDriver } from "@src/drivers/neon-http";
import { Decimal, s } from "@src/index";

const databaseUrl = process.env.NEON_TEST_DATABASE_URL;
const DECIMAL_DOMAIN = { precision: 16, scale: 2 } as const;
const PAST_DOUBLE = "99999999999999.99";
const PAST_DOUBLE_NEIGHBOUR = "99999999999999.98";

const decimalEvidence = s
  .model({
    id: s.string().id(),
    amount: s.decimal(DECIMAL_DOMAIN),
    amounts: s.decimal(DECIMAL_DOMAIN).array(),
  })
  .map("neon_http_decimal_evidence");

const decimalResponse = {
  fields: [
    { name: "id", dataTypeID: 25 },
    { name: "amount", dataTypeID: 25 },
    { name: "amounts", dataTypeID: 1009 },
  ],
  command: "SELECT",
  rowCount: 2,
  rows: [
    ["neighbour", PAST_DOUBLE_NEIGHBOUR, "{}"],
    ["exact", PAST_DOUBLE, `{${PAST_DOUBLE},-0.03}`],
  ],
};

describe("Neon HTTP deterministic SDK transport", () => {
  it("materializes fresh typed decimals from the real Neon response decoder", async () => {
    const requests: string[] = [];
    const deterministicFetch = Object.assign(
      async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        if (typeof init?.body === "string") requests.push(init.body);
        return new Response(JSON.stringify(decimalResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: () => undefined }
    ) satisfies typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = deterministicFetch;

    try {
      const client = createClient({
        schema: { decimalEvidence },
        driver: new NeonHTTPDriver({
          databaseUrl: "postgresql://fixture:fixture@fixture.invalid/fixture",
        }),
      });

      try {
        // This fixture owns the SDK decoder and typed-result crossing only. It
        // deliberately does not fake PostgreSQL comparison or arithmetic;
        // those semantics stay with the shared PostgreSQL exactness contract.
        const first = await client.decimalEvidence.findMany();
        const second = await client.decimalEvidence.findMany();

        expect(requests).toHaveLength(2);
        expect(first.map((row) => row.id)).toEqual(["neighbour", "exact"]);
        expect(first[0]?.amount).toBeInstanceOf(Decimal);
        expect(first[0]?.amount.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);
        expect(first[1]?.amount).toBeInstanceOf(Decimal);
        expect(first[1]?.amount.eq(PAST_DOUBLE)).toBe(true);
        expect(first[1]?.amounts).toHaveLength(2);
        expect(first[1]?.amounts[0]).toBeInstanceOf(Decimal);
        expect(first[1]?.amounts[0]?.eq(PAST_DOUBLE)).toBe(true);
        expect(first[1]?.amounts[1]?.eq("-0.03")).toBe(true);
        expect(first[1]?.amount).not.toBe(second[1]?.amount);
        expect(first[1]?.amounts[0]).not.toBe(second[1]?.amounts[0]);
      } finally {
        await client.$disconnect();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps null and malformed text-array members on the refusal path", async () => {
    const originalFetch = globalThis.fetch;

    try {
      for (const amounts of ["{1.20,NULL}", "{1.20"]) {
        const refusalResponse = {
          ...decimalResponse,
          rowCount: 1,
          rows: [["invalid", "1.20", amounts]],
        };
        const deterministicFetch = Object.assign(
          async () =>
            new Response(JSON.stringify(refusalResponse), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          { preconnect: () => undefined }
        ) satisfies typeof fetch;
        globalThis.fetch = deterministicFetch;

        const client = createClient({
          schema: { decimalEvidence },
          driver: new NeonHTTPDriver({
            databaseUrl: "postgresql://fixture:fixture@fixture.invalid/fixture",
          }),
        });
        try {
          await expect(client.decimalEvidence.findMany()).rejects.toThrow();
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * This credential-gated endpoint is connectivity-only. The repository has no
 * pre-provisioned Neon decimal model table and does not mutate the endpoint;
 * raw NUMERIC text would prove provider transport but not VibORM's typed
 * Decimal materialization, so this file deliberately makes no decimal claim.
 */
describe.skipIf(!databaseUrl)("Neon HTTP provider", () => {
  it("executes a connectivity-only read through the dedicated endpoint", async () => {
    const driver = new NeonHTTPDriver({ databaseUrl });

    try {
      const selected = await driver._executeRaw<{ value: number }>(
        "SELECT 1 AS value"
      );
      expect(selected.rows).toEqual([{ value: 1 }]);
      expect(selected.rowCount).toBe(1);
    } finally {
      await driver._disconnect();
    }
  });
});
