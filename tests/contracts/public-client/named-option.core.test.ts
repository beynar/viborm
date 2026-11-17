/**
 * `named`, the call option of named statements, as core carries it: taken
 * out of the call's arguments before anything reads them, admitted once (a
 * boolean), and handed to every statement of the call through its execution
 * context. It changes neither the SQL nor what an extension sees, and no
 * extension may declare an argument of that name. What a driver does with it
 * is tested on a real server (`tests/providers/docker/*-named-statements`).
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { QueryExecutionContext } from "@drivers/types";
import { ValidationError } from "@errors";
import {
  args,
  around,
  call,
  createClient,
  extension,
  key,
  oneOf,
  reads,
  s,
  target,
  unit,
} from "@src/index";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, test } from "vitest";

const owner = s.model({
  id: s.string().id(),
  name: s.string(),
  pets: s.toMany(() => pet),
});
const pet = s.model({
  id: s.string().id(),
  name: s.string(),
  ownerId: s.string(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
});
const schema = { owner, pet };

const RESERVED = /reserves for named statements/;

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly named: boolean | undefined;
}

/** Answers every statement with one owner row, and records what it was sent. */
class RecordingDriver extends SqlOnlyDriver {
  readonly sent: Sent[] = [];

  constructor() {
    super(new PostgresAdapter(), "postgresql");
  }

  protected override async execute<T>(
    _client?: null,
    sql = "",
    params: unknown[] = [],
    context?: QueryExecutionContext
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.sent.push({ sql, params, named: context?.named });
    const rows = [{ id: "o1", name: "one", ownerId: "o1" }] as T[];
    return { rows, rowCount: rows.length };
  }
}

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

function base(findUniqueBatching?: true) {
  const driver = new RecordingDriver();
  const client = createClient({ schema, driver, findUniqueBatching });
  clients.push(client);
  return { client, driver };
}

describe("named", () => {
  test("reaches every statement of the call, and only of that call", async () => {
    const { client, driver } = base();
    await client.owner.findMany({ named: true, where: { name: "one" } });
    await client.owner.findMany({ named: false });
    await client.owner.findMany();
    expect(driver.sent.map((sent) => sent.named)).toEqual([
      true,
      false,
      undefined,
    ]);
  });

  test("reaches every statement of a nested write", async () => {
    const { client, driver } = base();
    await client.owner.create({
      data: {
        id: "o1",
        name: "one",
        pets: {
          create: [
            { id: "p1", name: "a" },
            { id: "p2", name: "b" },
          ],
        },
      },
      named: true,
    });
    expect(driver.sent.length).toBeGreaterThan(1);
    expect(driver.sent.every((sent) => sent.named === true)).toBe(true);
  });

  test("each operation of an array transaction carries its own", async () => {
    const { client, driver } = base();
    await client.$transaction([
      client.owner.findMany({ where: { name: "a" }, named: true }),
      client.pet.findMany({ where: { name: "b" }, named: false }),
      client.owner.findMany({ where: { name: "c" } }),
    ]);
    const statements = driver.sent.filter((sent) => sent.params.length > 0);
    expect(statements.map((sent) => sent.named)).toEqual([
      true,
      false,
      undefined,
    ]);
  });

  test("each call of an interactive transaction carries its own", async () => {
    const { client, driver } = base();
    await client.$transaction(async (tx) => {
      await tx.owner.findMany({ named: true });
      await tx.owner.findMany();
      await tx.pet.findMany({ named: false });
    });
    const reads = driver.sent.filter((sent) => sent.sql.startsWith("SELECT"));
    expect(reads.map((sent) => sent.named)).toEqual([true, undefined, false]);
  });

  test("a transaction of a chain that observes statements carries it too", async () => {
    const { client, driver } = base();
    // An observed transaction hands its statements a context of its own.
    const db = client.$extends(
      extension(
        "observer",
        unit((_u, next) => next())
      )
    );
    await db.$transaction(async (tx) => {
      await tx.owner.findMany({ where: { name: "a" }, named: true });
      await tx.owner.findMany({ where: { name: "b" }, named: false });
    });
    await db.$transaction([
      db.owner.findMany({ where: { name: "c" }, named: true }),
      db.owner.findMany({ where: { name: "d" } }),
    ]);
    const reads = driver.sent.filter((sent) => sent.sql.startsWith("SELECT"));
    expect(reads.map((sent) => sent.named)).toEqual([
      true,
      false,
      true,
      undefined,
    ]);
  });

  test("changes neither the SQL nor its values", async () => {
    const { client, driver } = base();
    const call = { where: { name: "one" }, take: 2 } as const;
    await client.owner.findMany(call);
    await client.owner.findMany({ ...call, named: true });
    await client.owner.findMany({ ...call, named: false });
    const [plain, ...others] = driver.sent;
    for (const other of others) {
      expect(other.sql).toBe(plain?.sql);
      expect(other.params).toEqual(plain?.params);
    }
  });

  test("findUnique calls share a batch only with the same `named`, which the batch carries", async () => {
    const { client, driver } = base(true);
    await Promise.all([
      client.owner.findUnique({ where: { id: "o1" }, named: true }),
      client.owner.findUnique({ where: { id: "o2" }, named: true }),
      client.owner.findUnique({ where: { id: "o3" } }),
      client.owner.findUnique({ where: { id: "o4" } }),
    ]);
    // A statement reads the keys of one `named` alone, and carries that `named`.
    const reads = driver.sent.map((sent) => {
      const keys = JSON.stringify(sent.params);
      const flagged = keys.includes("o1") || keys.includes("o2");
      const plain = keys.includes("o3") || keys.includes("o4");
      return { flagged, plain, named: sent.named };
    });
    expect(reads.some((read) => read.flagged && read.plain)).toBe(false);
    expect(
      reads.every((read) => read.named === (read.flagged || undefined))
    ).toBe(true);
    // Two keys in one statement: each pair did share a batch.
    expect(
      driver.sent.filter((sent) => JSON.stringify(sent.params).includes(","))
    ).toHaveLength(2);
  });

  test("is no argument any extension sees, nor part of a read's key", async () => {
    const seen: unknown[] = [];
    const keys: (string | undefined)[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "observer",
        call((c) => {
          seen.push(c.args);
        }),
        around(
          () => (run) => {
            keys.push(key(run));
            return run();
          },
          target(reads)
        )
      )
    );
    await db.owner.findMany({ where: { name: "one" } });
    await db.owner.findMany({ where: { name: "one" }, named: true });
    await db.owner.findMany({ where: { name: "one" }, named: false });
    expect(seen).toEqual([
      { where: { name: "one" } },
      { where: { name: "one" } },
      { where: { name: "one" } },
    ]);
    expect(keys[0]).toBeTypeOf("string");
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);
  });

  test("sits beside an extension's own arguments", async () => {
    const values: unknown[] = [];
    const { client, driver } = base();
    const db = client.$extends(
      extension(
        "region",
        args({ region: oneOf("eu", "us").on(reads) }),
        call((c) => {
          values.push(c.values);
        })
      )
    );
    await db.owner.findMany({ region: "eu", named: true });
    expect(values).toEqual([{ region: "eu" }]);
    expect(driver.sent[0]?.named).toBe(true);
  });

  test("an extension may not declare an argument named `named`", () => {
    const { client } = base();
    expect(() =>
      client.$extends(
        extension("takes-named", args({ named: oneOf("yes", "no") }))
      )
    ).toThrow(RESERVED);
  });

  test("a value that is not a boolean is refused, and nothing is sent", () => {
    const { client, driver } = base();
    const refused = (() => {
      try {
        // @ts-expect-error - named is a boolean
        client.owner.findMany({ named: "yes" });
      } catch (error) {
        return error;
      }
    })();
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).issues).toEqual([
      { path: "named", message: "named must be a boolean." },
    ]);
    expect(driver.sent).toEqual([]);
  });

  test("`named: undefined` is the same as leaving it out", async () => {
    const { client, driver } = base();
    await client.owner.findMany({ named: undefined });
    expect(driver.sent[0]?.named).toBeUndefined();
  });
});
