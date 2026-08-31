import { createClient as createPGliteClient } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { TransactionError } from "@errors";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id() });
const schema = { record };

describe("single-connection root client during a callback transaction", () => {
  /**
   * A root-client operation issued inside a callback transaction must be
   * refused, not silently join a transaction it was never handed.
   */
  test("refuses a root-client operation while the connection is transaction-bound", async () => {
    const pglite = new PGlite();
    const client = await createPGliteClient({
      schema,
      client: pglite,
    });
    try {
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
      expect(failure.message).toMatch(/cannot use the originating client/);
      expect(failure.meta).toMatchObject({
        driver: "pglite",
        method: "$transaction(callback)",
      });
    } finally {
      try {
        await client.$disconnect();
      } finally {
        await pglite.close();
      }
    }
  });
});
