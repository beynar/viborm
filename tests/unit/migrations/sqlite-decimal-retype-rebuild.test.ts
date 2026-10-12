/**
 * A SQLite rebuild that moves a column into or out of a fixed-decimal domain.
 *
 * SQLite stores `decimal(p,s)` as the scaled INTEGER coefficient: 1.23 at
 * scale 2 is the integer 123. A rebuild that drops the domain must descale it,
 * or 1.23 silently reads back as 123; a value the target cannot hold exactly
 * aborts the rebuild with the table untouched. 10,000 ledger rows each.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { isMigrationError, VibORMErrorCode } from "@errors";
import { applyV1 as apply } from "@migrations/apply-v1";
import { generateV1 as generate } from "@migrations/generate-v1";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";
import { MemoryStorage } from "./_estate";

const ROWS = 10_000;

type Amount =
  | "int"
  | "string"
  | "number"
  | { precision: number; scale: number };

function schema(amount: Amount) {
  const column =
    amount === "int"
      ? s.int()
      : amount === "string"
        ? s.string()
        : amount === "number"
          ? s.number()
          : s.decimal(amount);
  return {
    ledger: s.model({
      id: s.string().id(),
      account: s.string(),
      amount: column.nullable(),
      currency: s.enum(["EUR", "USD"]),
      memo: s.string().nullable(),
      posted: s.boolean().default(false),
      sequence: s.int(),
      tags: s.json().nullable(),
      rate: s.number().nullable(),
      batch: s.string().nullable(),
      reference: s.string().nullable(),
      createdAt: s.dateTime().now(),
    }),
  };
}

const resolve: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : undefined;

/**
 * A database at `from` holding ROWS ledger rows whose amount is `value(i)`,
 * created by migrations or, with `pushed`, by push.
 */
async function prepare(
  from: Amount,
  value: (i: number) => string | number,
  pushed = false
) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const driver = new SQLite3Driver({ client: db });
  const storage = new MemoryStorage();
  const v1 = createClient({ schema: schema(from), driver });
  if (pushed) {
    await syncLiveSchema(v1 as never);
  } else {
    await generate(v1 as never, storage, { name: "v1" });
    await apply(v1 as never, storage);
  }
  for (let start = 0; start < ROWS; start += 1000) {
    await v1.ledger.createMany({
      data: Array.from({ length: 1000 }, (_, k) => ({
        id: `row-${start + k}`,
        account: `acct-${(start + k) % 97}`,
        amount: value(start + k) as never,
        currency: "EUR" as const,
        sequence: start + k,
      })),
    });
  }
  return { db, driver, storage };
}

async function migrate(
  setup: Awaited<ReturnType<typeof prepare>>,
  to: Amount
): Promise<void> {
  const v2 = createClient({ schema: schema(to), driver: setup.driver });
  await generate(v2 as never, setup.storage, { name: "v2", resolve });
  await apply(v2 as never, setup.storage);
}

const caught = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error
  );

/**
 * A rebuild the copy aborted: the descaling copy's `SQLITE_ABORT` raises an
 * integer overflow, the decimal copy's sentinel fails the reserved CHECK; the
 * migration wraps either, keeping its code on the redacted cause.
 */
const aborted = (
  error: unknown,
  code:
    | VibORMErrorCode.QUERY_OUT_OF_RANGE
    | VibORMErrorCode.CHECK_CONSTRAINT = VibORMErrorCode.QUERY_OUT_OF_RANGE
): boolean =>
  [error, error instanceof Error ? error.cause : undefined].some(
    (raised) => raised instanceof Error && Reflect.get(raised, "code") === code
  );

const stored = (db: InstanceType<typeof Database>, id: string) =>
  db.prepare(`SELECT "amount" FROM "ledger" WHERE "id" = ?`).get(id) as {
    amount: unknown;
  };

const DECIMAL_2 = { precision: 10, scale: 2 };
const DECIMAL_4 = { precision: 10, scale: 4 };

describe("SQLite rebuilds descale or refuse a fixed-decimal column", () => {
  it("decimal(10,2) -> int stores the value, not the coefficient", async () => {
    const setup = await prepare(DECIMAL_2, (i) => `${i - 5000}.00`);

    await migrate(setup, "int");

    expect(stored(setup.db, "row-5123")).toEqual({ amount: 123 });
    expect(stored(setup.db, "row-0")).toEqual({ amount: -5000 });
    const total = setup.db
      .prepare(`SELECT sum("amount") AS "sum" FROM "ledger"`)
      .get() as { sum: number };
    expect(total.sum).toBe(-5000);
  }, 60_000);

  it("decimal(10,2) -> int aborts on a fraction and changes nothing", async () => {
    const setup = await prepare(DECIMAL_2, (i) =>
      i === ROWS - 1 ? "1.23" : `${i}.00`
    );

    expect(aborted(await caught(migrate(setup, "int")))).toBe(true);

    expect(stored(setup.db, `row-${ROWS - 1}`)).toEqual({ amount: 123 });
    expect(stored(setup.db, "row-7")).toEqual({ amount: 700 });
  }, 60_000);

  it("decimal(10,2) -> int aborts on a stored value that is no coefficient", async () => {
    const setup = await prepare(DECIMAL_2, (i) => `${i}.00`);
    // An estate written past the reserved CHECK (one SQLite never enforced).
    setup.db.pragma("ignore_check_constraints = ON");
    setup.db
      .prepare(`UPDATE "ledger" SET "amount" = 'abc' WHERE "id" = ?`)
      .run(`row-${ROWS - 1}`);
    setup.db.pragma("ignore_check_constraints = OFF");

    expect(aborted(await caught(migrate(setup, "int")))).toBe(true);

    expect(stored(setup.db, `row-${ROWS - 1}`)).toEqual({ amount: "abc" });
    expect(stored(setup.db, "row-7")).toEqual({ amount: 700 });
  }, 60_000);

  it.each([
    "string",
    "number",
  ] as const)("decimal(10,2) -> %s is refused before any statement runs", async (to) => {
    const setup = await prepare(DECIMAL_2, () => "1.23");

    const error = await caught(migrate(setup, to));

    expect(isMigrationError(error)).toBe(true);
    expect(error).toHaveProperty("code", VibORMErrorCode.FEATURE_NOT_SUPPORTED);
    expect(stored(setup.db, "row-0")).toEqual({ amount: 123 });
  }, 60_000);

  it("push refuses decimal(10,2) -> string before any statement runs", async () => {
    const setup = await prepare(DECIMAL_2, () => "1.23", true);

    const error = await caught(
      syncLiveSchema(
        createClient({
          schema: schema("string"),
          driver: setup.driver,
        }) as never,
        { resolve }
      )
    );

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining("descaled exactly"),
    });
    expect(stored(setup.db, "row-0")).toEqual({ amount: 123 });
  }, 60_000);

  it("int -> decimal(10,2) scales the value into a coefficient", async () => {
    const setup = await prepare("int", (i) => i - 5000);

    await migrate(setup, DECIMAL_2);

    expect(stored(setup.db, "row-5123")).toEqual({ amount: 12_300 });
    expect(stored(setup.db, "row-0")).toEqual({ amount: -500_000 });
  }, 60_000);

  it("int -> decimal(10,2) aborts on a value past the precision", async () => {
    const setup = await prepare("int", (i) =>
      i === ROWS - 1 ? 100_000_000 : i
    );

    expect(
      aborted(
        await caught(migrate(setup, DECIMAL_2)),
        VibORMErrorCode.CHECK_CONSTRAINT
      )
    ).toBe(true);

    expect(stored(setup.db, `row-${ROWS - 1}`)).toEqual({
      amount: 100_000_000,
    });
  }, 60_000);

  it("decimal(10,2) -> decimal(10,4) rescales every coefficient", async () => {
    const setup = await prepare(DECIMAL_2, (i) => `${i}.23`);

    await migrate(setup, DECIMAL_4);

    expect(stored(setup.db, "row-42")).toEqual({ amount: 422_300 });
  }, 60_000);

  it("decimal(10,4) -> decimal(10,2) aborts on a digit the target drops", async () => {
    const setup = await prepare(DECIMAL_4, (i) =>
      i === ROWS - 1 ? "1.2345" : `${i}.2300`
    );

    expect(
      aborted(
        await caught(migrate(setup, DECIMAL_2)),
        VibORMErrorCode.CHECK_CONSTRAINT
      )
    ).toBe(true);

    expect(stored(setup.db, `row-${ROWS - 1}`)).toEqual({ amount: 12_345 });
    expect(stored(setup.db, "row-42")).toEqual({ amount: 422_300 });
  }, 60_000);
});
