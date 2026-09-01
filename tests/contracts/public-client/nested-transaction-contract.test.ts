import { TransactionError } from "@errors";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id() });
const schema = { record };

const ORIGINATING_CLIENT = /cannot use the originating client/;

const getFamily = usePGliteSchemaFamily(schema);

describe("single-connection root client during a callback transaction", () => {
  /**
   * A root-client operation issued inside a callback transaction must be
   * refused, not silently join a transaction it was never handed.
   */
  test("refuses a root-client operation while the connection is transaction-bound", async () => {
    const { client } = getFamily();
    const failure = await client
      .$transaction(async (_tx) => {
        await client.record.create({ data: { id: "escapee" } });
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(TransactionError);
    if (!(failure instanceof TransactionError)) throw failure;
    expect(failure.message).toMatch(ORIGINATING_CLIENT);
    expect(failure.meta).toMatchObject({
      driver: "pglite",
      method: "$transaction(callback)",
    });
  });
});
