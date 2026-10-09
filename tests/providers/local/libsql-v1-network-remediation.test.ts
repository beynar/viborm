import { randomUUID } from "node:crypto";
import { LibSQLDriver } from "@drivers/libsql";
import { UniqueConstraintError } from "@errors";
import { createClient as createTransport } from "@libsql/client";
import { createClient, s } from "@src/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const endpoint = process.env.VIBORM_LIBSQL_HTTP_TEST_URL;
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error(
      "The libSQL network fixture requires its isolated localhost server"
    );
}
const table = `viborm_network_${randomUUID().replace(/-/g, "")}`;

describe.skipIf(!endpoint)("libSQL native HTTP transaction lifecycle", () => {
  const transport = createTransport({
    url: endpoint ?? "http://127.0.0.1:1",
    intMode: "bigint",
  });
  const observer = createTransport({
    url: endpoint ?? "http://127.0.0.1:1",
    intMode: "bigint",
  });
  const db = createClient({
    schema: {
      evidence: s.model({ id: s.string().id(), value: s.int() }).map(table),
    },
    driver: new LibSQLDriver({ client: transport }),
  });
  beforeAll(async () => {
    await observer.execute(
      `CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)`
    );
  });
  afterAll(async () => {
    await db.$disconnect();
    transport.close();
    observer.close();
  });

  it("rolls back two callback writes on the actual HTTP connection", async () => {
    const failure = new Error("Owned callback failure");
    await expect(
      db.$transaction(async (tx) => {
        await tx.evidence.create({ data: { id: "callback-a", value: 1 } });
        await tx.evidence.create({ data: { id: "callback-b", value: 2 } });
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(
      (await observer.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0]
        ?.n
    ).toBe(0n);
  });

  it("rolls back an array prefix after its later constraint failure", async () => {
    await expect(
      db.$transaction([
        db.evidence.create({ data: { id: "array-a", value: 1 } }),
        db.evidence.create({ data: { id: "array-a", value: 2 } }),
      ])
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(
      (await observer.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0]
        ?.n
    ).toBe(0n);
  });

  it("commits once, then leaves the supplied HTTP client usable after disconnect", async () => {
    await db.$transaction(async (tx) => {
      await tx.evidence.create({ data: { id: "committed-a", value: 3 } });
      await tx.evidence.create({ data: { id: "committed-b", value: 4 } });
    });
    expect(await db.evidence.findMany({ orderBy: { id: "asc" } })).toEqual([
      { id: "committed-a", value: 3 },
      { id: "committed-b", value: 4 },
    ]);
    await db.$disconnect();
    expect(transport.closed).toBe(false);
    expect(
      (await transport.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0]
        ?.n
    ).toBe(2n);
  });
});
