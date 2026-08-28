/**
 * Raw SQL client surface (W5-U1).
 *
 * What is proven here, on two real dialects (PGlite = $n placeholders,
 * better-sqlite3 = ? placeholders):
 *
 *  - a tagged interpolation reaches the driver as a BOUND PARAMETER: the
 *    statement text carries a placeholder and the value travels in the params
 *    list. The probe reads the real query log, so a splice would show up as
 *    the literal in `sql` and an empty `params`.
 *  - the Unsafe variants splice the statement verbatim.
 *  - raw inside an interactive transaction sees the transaction's own
 *    uncommitted writes and disappears with a rollback.
 *  - `join` / `empty` / `raw` compose the way Prisma's do.
 *  - the deprecated `(string, params?)` form still runs and announces itself
 *    once per method on the `warning` channel.
 *  - raw calls are lazy, promise-compatible transaction operations.
 *  - raw and model operations share one atomic array transaction in order.
 */

import { createClient } from "@client/client";
import type { RawOperation } from "@client/raw";
import type { AnyDriver } from "@drivers";
import { PendingOperationError, VibORMErrorCode } from "@errors";
import { instrumentation } from "@instrumentation/extension";

import { s } from "@schema";
import { empty, join, raw, sql } from "@sql";
import {
  BatchOnlyPGliteDriver,
  createInMemoryPGliteDriver,
} from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { captureLogs } from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

// Lowercase single-word identifiers need no dialect-specific quoting.
const item = s
  .model({
    id: s.string().id(),
    label: s.string(),
    qty: s.int().default(0),
  })
  .map("raw_sql_items");

const schema = { item };

const DIALECTS: Array<{ name: string; createDriver: () => AnyDriver }> = [
  { name: "pglite", createDriver: createInMemoryPGliteDriver },
  { name: "sqlite3", createDriver: createInMemorySQLite3Driver },
];

/** A bound comparison, in either dialect's placeholder style. */
const BOUND_LABEL_COMPARISON = /label = (\$1|\?)/;

type Probe = ReturnType<typeof captureLogs>;

function createProbedClient(createDriver: () => AnyDriver) {
  const probe = captureLogs();
  const client = createClient({
    schema,
    driver: createDriver(),
  }).$extends(
    instrumentation({
      diagnostics: { includeParams: true, includeSql: true },
      logging: {
        includeParams: true,
        includeSql: true,
        query: probe.callback,
        warning: probe.callback,
      },
    })
  );
  return { client, probe };
}

/** The last statement the driver actually ran, as the query log saw it. */
function lastStatement(probe: Probe) {
  const queries = probe.events.filter((event) => event.level === "query");
  const last = queries.at(-1);
  if (!last) throw new Error("no query was logged");
  return { sql: last.sql ?? "", params: last.params ?? [] };
}

function warnings(probe: Probe) {
  return probe.events.filter((event) => event.level === "warning");
}

type ProbedClient = ReturnType<typeof createProbedClient>["client"];

async function seed(client: ProbedClient) {
  await client.item.createMany({
    data: [
      { id: "i1", label: "Alpha", qty: 1 },
      { id: "i2", label: "Beta", qty: 5 },
      { id: "i3", label: "Gamma", qty: 9 },
    ],
  });
}

for (const { name, createDriver } of DIALECTS) {
  describe(`raw SQL surface (${name})`, () => {
    let disconnect: (() => Promise<void>) | undefined;

    afterEach(async () => {
      await disconnect?.();
      disconnect = undefined;
    });

    const setup = async () => {
      const { client, probe } = createProbedClient(createDriver);
      disconnect = () => client.$disconnect();
      await syncLiveSchema(client);
      await seed(client);
      probe.events.length = 0;
      return { client, probe };
    };

    describe("tagged templates bind, never splice", () => {
      test("$queryRaw sends the value as a parameter", async () => {
        const { client, probe } = await setup();

        const rows = await client.$queryRaw<{
          id: string;
        }>`SELECT id FROM raw_sql_items WHERE label = ${"Beta"}`;

        expect(rows).toEqual([{ id: "i2" }]);
        const statement = lastStatement(probe);
        expect(statement.params).toEqual(["Beta"]);
        // The literal never reaches the statement text.
        expect(statement.sql).not.toContain("Beta");
        expect(statement.sql).toMatch(BOUND_LABEL_COMPARISON);
      });

      test("$executeRaw binds every interpolation in order", async () => {
        const { client, probe } = await setup();

        const affected =
          await client.$executeRaw`UPDATE raw_sql_items SET qty = ${100} WHERE qty >= ${5}`;

        expect(affected).toBe(2);
        const statement = lastStatement(probe);
        expect(statement.params).toEqual([100, 5]);
        expect(statement.sql).not.toContain("100");
      });

      test("a value that looks like SQL stays a value", async () => {
        const { client, probe } = await setup();

        const injection = "Beta' OR '1'='1";
        const rows = await client.$queryRaw<{
          id: string;
        }>`SELECT id FROM raw_sql_items WHERE label = ${injection}`;

        // Bound, so it matches nothing rather than opening the table.
        expect(rows).toEqual([]);
        expect(lastStatement(probe).params).toEqual([injection]);
      });

      test("a prebuilt sql`` fragment is accepted and still binds", async () => {
        const { client, probe } = await setup();

        const fragment = sql`SELECT id FROM raw_sql_items WHERE qty > ${4} ORDER BY id`;
        const rows = await client.$queryRaw<{ id: string }>(fragment);

        expect(rows).toEqual([{ id: "i2" }, { id: "i3" }]);
        expect(lastStatement(probe).params).toEqual([4]);
      });

      test("a fragment plus extra values is refused, not silently ignored", async () => {
        const { client } = await setup();

        await expect(
          client.$queryRaw(sql`SELECT 1`, "stray")
        ).rejects.toMatchObject({ code: VibORMErrorCode.INVALID_INPUT });
      });
    });

    describe("Unsafe variants splice verbatim", () => {
      test("$queryRawUnsafe uses the statement as written", async () => {
        const { client, probe } = await setup();
        const placeholder =
          client.$driver.dialect === "postgresql" ? "$1" : "?";

        const rows = await client.$queryRawUnsafe<{ id: string }>(
          `SELECT id FROM raw_sql_items WHERE label = ${placeholder}`,
          "Gamma"
        );

        expect(rows).toEqual([{ id: "i3" }]);
        const statement = lastStatement(probe);
        expect(statement.sql).toBe(
          `SELECT id FROM raw_sql_items WHERE label = ${placeholder}`
        );
        expect(statement.params).toEqual(["Gamma"]);
      });

      test("$executeRawUnsafe returns the affected count", async () => {
        const { client } = await setup();

        const affected = await client.$executeRawUnsafe(
          "UPDATE raw_sql_items SET qty = qty + 1"
        );

        expect(affected).toBe(3);
      });

      test("an interpolated identifier really is spliced (the unsafe part)", async () => {
        const { client, probe } = await setup();

        const column = "label";
        const rows = await client.$queryRawUnsafe<{ label: string }>(
          `SELECT ${column} FROM raw_sql_items ORDER BY id LIMIT 1`
        );

        expect(rows).toEqual([{ label: "Alpha" }]);
        expect(lastStatement(probe).sql).toContain("SELECT label FROM");
      });
    });

    describe("inside an interactive transaction", () => {
      test("raw sees the transaction's uncommitted writes", async () => {
        const { client } = await setup();

        const seen = await client.$transaction(async (tx) => {
          await tx.item.create({
            data: { id: "i4", label: "Delta", qty: 40 },
          });
          return tx.$queryRaw<{
            id: string;
          }>`SELECT id FROM raw_sql_items WHERE label = ${"Delta"}`;
        });

        expect(seen).toEqual([{ id: "i4" }]);
      });

      test("a raw write rolls back with the transaction", async () => {
        const { client } = await setup();

        await expect(
          client.$transaction(async (tx) => {
            const affected =
              await tx.$executeRaw`UPDATE raw_sql_items SET qty = ${999}`;
            expect(affected).toBe(3);
            throw new Error("abort the transaction");
          })
        ).rejects.toThrow("abort the transaction");

        const survivors = await client.item.findMany({
          where: { qty: 999 },
        });
        expect(survivors).toEqual([]);
      });

      test("a model write is visible to tx raw and vice versa", async () => {
        const { client } = await setup();

        await client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "UPDATE raw_sql_items SET label = 'Renamed' WHERE id = 'i1'"
          );
          const found = await tx.item.findUniqueOrThrow({
            where: { id: "i1" },
          });
          expect(found.label).toBe("Renamed");
        });

        const committed = await client.item.findUniqueOrThrow({
          where: { id: "i1" },
        });
        expect(committed.label).toBe("Renamed");
      });

      test("raw and model operations mix in a nested array transaction", async () => {
        const { client } = await setup();

        await client.$transaction(async (tx) => {
          const [affected, found] = await tx.$transaction([
            tx.$executeRaw`
              UPDATE raw_sql_items SET label = ${"Nested"} WHERE id = ${"i1"}
            `,
            tx.item.findUniqueOrThrow({ where: { id: "i1" } }),
          ]);

          expect(affected).toBe(1);
          expect(found.label).toBe("Nested");
        });
      });
    });

    describe("composition helpers", () => {
      test("join binds plain values, Prisma-style", async () => {
        const { client, probe } = await setup();

        const ids = ["i1", "i3"];
        const rows = await client.$queryRaw<{ id: string }>(
          sql`SELECT id FROM raw_sql_items WHERE id IN (${join(
            ids
          )}) ORDER BY id`
        );

        expect(rows).toEqual([{ id: "i1" }, { id: "i3" }]);
        expect(lastStatement(probe).params).toEqual(["i1", "i3"]);
      });

      test("join splices nested fragments and binds their values", async () => {
        const { client, probe } = await setup();

        const conditions = [sql`qty >= ${5}`, sql`label <> ${"Gamma"}`];
        const rows = await client.$queryRaw<{ id: string }>(
          sql`SELECT id FROM raw_sql_items WHERE ${join(conditions, " AND ")}`
        );

        expect(rows).toEqual([{ id: "i2" }]);
        expect(lastStatement(probe).params).toEqual([5, "Gamma"]);
      });

      test("empty contributes no text and no parameters", async () => {
        const { client, probe } = await setup();

        const rows = await client.$queryRaw<{ id: string }>(
          sql`SELECT id FROM raw_sql_items ${empty} WHERE id = ${"i2"}`
        );

        expect(rows).toEqual([{ id: "i2" }]);
        expect(lastStatement(probe).params).toEqual(["i2"]);
      });

      test("raw(string) splices text with no binding", async () => {
        const { client, probe } = await setup();

        const rows = await client.$queryRaw<{ id: string }>(
          sql`SELECT id FROM raw_sql_items ${raw("ORDER BY id DESC")} LIMIT 1`
        );

        expect(rows).toEqual([{ id: "i3" }]);
        const statement = lastStatement(probe);
        expect(statement.sql).toContain("ORDER BY id DESC");
        expect(statement.params).toEqual([]);
      });
    });

    describe("deprecated string form", () => {
      test("still runs, and announces itself once per method", async () => {
        const { client, probe } = await setup();
        const placeholder =
          client.$driver.dialect === "postgresql" ? "$1" : "?";

        const first = await client.$queryRaw<{ id: string }>(
          `SELECT id FROM raw_sql_items WHERE label = ${placeholder}`,
          ["Beta"]
        );
        expect(first).toEqual([{ id: "i2" }]);

        const second = await client.$queryRaw<{ id: string }>(
          `SELECT id FROM raw_sql_items WHERE label = ${placeholder}`,
          ["Gamma"]
        );
        expect(second).toEqual([{ id: "i3" }]);

        const queryWarnings = warnings(probe);
        expect(queryWarnings).toHaveLength(1);
        expect(queryWarnings[0]).toMatchObject({
          level: "warning",
          model: "$raw",
          operation: "$queryRaw",
        });
        expect(
          String(
            (queryWarnings[0]?.meta as { deprecation?: string })?.deprecation
          )
        ).toContain("$queryRawUnsafe");

        // A different method gets its own single notice.
        await client.$executeRaw("UPDATE raw_sql_items SET qty = qty + 1");
        expect(warnings(probe)).toHaveLength(2);
        expect(warnings(probe)[1]).toMatchObject({ operation: "$executeRaw" });
      });

      test("the notice is silent when the warning channel is off", async () => {
        const client = createClient({ schema, driver: createDriver() });
        disconnect = () => client.$disconnect();
        await syncLiveSchema(client);

        await expect(
          client.$executeRaw("UPDATE raw_sql_items SET qty = 0")
        ).resolves.toBe(0);
      });
    });

    describe("lazy transaction operations", () => {
      test("construction performs no query or legacy warning", async () => {
        const { client, probe } = await setup();

        const tagged = client.$queryRaw`SELECT 1`;
        const legacy = client.$queryRaw("SELECT 1");
        await Promise.resolve();

        expect(probe.events).toEqual([]);

        await tagged;
        await legacy;
        expect(warnings(probe)).toHaveLength(1);
      });

      test("an abandoned legacy operation never warns", async () => {
        const { client, probe } = await setup();

        client.$executeRaw("UPDATE raw_sql_items SET qty = 0");
        await Promise.resolve();

        expect(warnings(probe)).toEqual([]);
      });

      test("keeps the complete Promise surface and one execution", async () => {
        const { client } = await setup();
        const operation = client.$queryRaw<{ id: string }>`
          SELECT id FROM raw_sql_items ORDER BY id
        `;

        const [direct, resolved, all] = await Promise.all([
          operation,
          Promise.resolve(operation),
          Promise.all([operation]),
        ]);

        expect(direct).toEqual(resolved);
        expect(all).toEqual([direct]);
        expect(Object.prototype.toString.call(operation)).toBe(
          "[object Promise]"
        );
      });

      test("refuses transaction execution after direct execution", async () => {
        const { client } = await setup();
        const operation = client.$queryRaw`SELECT 1`;
        await operation;

        await expect(client.$transaction([operation])).rejects.toBeInstanceOf(
          PendingOperationError
        );
      });

      test("refuses a raw operation from another transaction scope", async () => {
        const { client } = await setup();
        let scoped: RawOperation<unknown[]> | undefined;

        await client.$transaction(async (tx) => {
          scoped = tx.$queryRaw`SELECT 1`;
        });
        if (!scoped)
          throw new Error("transaction did not create raw operation");

        await expect(client.$transaction([scoped])).rejects.toBeInstanceOf(
          PendingOperationError
        );
      });

      test("model operations in the array still batch", async () => {
        const { client } = await setup();

        const [first, second] = await client.$transaction([
          client.item.findMany({ where: { qty: { gte: 5 } } }),
          client.item.count(),
        ]);

        expect(first.map((row) => row.id)).toEqual(["i2", "i3"]);
        expect(second).toBe(3);
      });
    });
  });
}

describe("raw SQL in a native array transaction", () => {
  test("mixes raw and model operations in one ordered atomic batch", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    try {
      await syncLiveSchema(client);
      await seed(client);
      const executeBatch = vi.spyOn(driver, "_executeBatch");

      const rename = client.$executeRaw`
        UPDATE raw_sql_items SET label = ${"Renamed"} WHERE id = ${"i1"}
      `;
      const [affected, modelRows, rawRows] = await client.$transaction([
        rename,
        client.item.findMany({ where: { label: "Renamed" } }),
        client.$queryRaw<{ id: string }>`
          SELECT id FROM raw_sql_items WHERE label = ${"Renamed"}
        `,
      ]);

      expect(affected).toBe(1);
      expect(modelRows.map((row) => row.id)).toEqual(["i1"]);
      expect(rawRows).toEqual([{ id: "i1" }]);
      expect(executeBatch).toHaveBeenCalledOnce();
      const submitted = executeBatch.mock.calls[0]?.[0] ?? [];
      expect(submitted).toHaveLength(3);
      expect(submitted[0]?.sql).toContain("UPDATE raw_sql_items");
      expect(submitted[0]?.params).toEqual(["Renamed", "i1"]);
      expect(submitted[1]?.sql).toContain("raw_sql_items");
      expect(submitted[2]?.sql).toContain("SELECT id FROM raw_sql_items");
      expect(submitted[2]?.params).toEqual(["Renamed"]);
    } finally {
      await client.$disconnect();
    }
  });

  test("a native batch consumes both raw and model operations exactly once", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    try {
      await syncLiveSchema(client);
      await seed(client);
      const rawOperation = client.$executeRaw`
        UPDATE raw_sql_items SET qty = ${9} WHERE id = ${"i1"}
      `;
      const modelOperation = client.item.findMany({ where: { id: "i1" } });

      await client.$transaction([rawOperation, modelOperation]);

      await expect((async () => rawOperation)()).rejects.toBeInstanceOf(
        PendingOperationError
      );
      await expect((async () => modelOperation)()).rejects.toBeInstanceOf(
        PendingOperationError
      );
      await expect(client.$transaction([rawOperation])).rejects.toBeInstanceOf(
        PendingOperationError
      );
      await expect(
        client.item.findUnique({ where: { id: "i1" } })
      ).resolves.toMatchObject({ qty: 9 });
    } finally {
      await client.$disconnect();
    }
  });

  test("prepares every raw input before dispatching any effect", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    try {
      await syncLiveSchema(client);
      await seed(client);
      const executeBatch = vi.spyOn(driver, "_executeBatch");

      await expect(
        client.$transaction([
          client.$executeRaw`UPDATE raw_sql_items SET qty = ${77}`,
          client.$queryRaw(sql`SELECT 1`, "stray"),
        ])
      ).rejects.toMatchObject({ code: VibORMErrorCode.INVALID_INPUT });

      expect(executeBatch).not.toHaveBeenCalled();
      await expect(client.item.count({ where: { qty: 77 } })).resolves.toBe(0);
    } finally {
      await client.$disconnect();
    }
  });

  test("a later raw failure rolls back an earlier raw and model write", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    try {
      await syncLiveSchema(client);
      await seed(client);

      await expect(
        client.$transaction([
          client.item.update({
            where: { id: "i1" },
            data: { qty: 88 },
          }),
          client.$executeRaw`UPDATE raw_sql_items SET qty = ${99} WHERE id = ${"i2"}`,
          client.$queryRawUnsafe("SELECT * FROM table_that_does_not_exist"),
        ])
      ).rejects.toThrow();

      await expect(
        client.item.findMany({
          where: { qty: { in: [88, 99] } },
        })
      ).resolves.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  test("rejects a foreign-client raw operation before dispatch", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const foreignDriver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    const foreign = createClient({ schema, driver: foreignDriver });
    try {
      await syncLiveSchema(client);
      const executeBatch = vi.spyOn(driver, "_executeBatch");
      const foreignOperation = foreign.$queryRaw`SELECT 1`;

      await expect(
        client.$transaction([foreignOperation])
      ).rejects.toBeInstanceOf(PendingOperationError);
      expect(executeBatch).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.$disconnect(), foreign.$disconnect()]);
    }
  });
});

describe("raw SQL types", () => {
  test("$queryRaw answers rows, $executeRaw answers a count", () => {
    const client = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });

    expectTypeOf(client.$queryRaw<{ id: string }>`SELECT 1`).toEqualTypeOf<
      RawOperation<{ id: string }[]>
    >();
    expectTypeOf(
      client.$queryRawUnsafe<{ id: string }>("SELECT 1")
    ).toEqualTypeOf<RawOperation<{ id: string }[]>>();
    expectTypeOf(client.$executeRaw`SELECT 1`).toEqualTypeOf<
      RawOperation<number>
    >();
    expectTypeOf(client.$executeRawUnsafe("SELECT 1")).toEqualTypeOf<
      RawOperation<number>
    >();

    const queryPromise: Promise<{ id: string }[]> = client.$queryRaw<{
      id: string;
    }>`SELECT 1`;
    expectTypeOf(queryPromise).toEqualTypeOf<Promise<{ id: string }[]>>();

    const query = client.$queryRaw<{ id: string }>`SELECT 1`;
    expectTypeOf(
      client.$transaction([client.$executeRaw`SELECT 1`, query])
    ).toEqualTypeOf<Promise<[number, { id: string }[]]>>();
  });

  test("the transaction client carries the same raw surface", () => {
    const client = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });

    expectTypeOf(client.$transaction).toBeCallableWith(async (tx) => {
      expectTypeOf(tx.$queryRaw<{ id: string }>`SELECT 1`).toEqualTypeOf<
        RawOperation<{ id: string }[]>
      >();
      expectTypeOf(tx.$executeRaw`SELECT 1`).toEqualTypeOf<
        RawOperation<number>
      >();
      return 1;
    });
  });
});
