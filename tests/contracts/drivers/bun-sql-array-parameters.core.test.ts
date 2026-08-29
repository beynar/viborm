import { BunSQLDriver } from "@drivers/bun-sql";
import { sql } from "@sql";
import { expect, test, vi } from "vitest";

function bunResult() {
  return Object.assign([], { count: 0 });
}

test("Bun SQL delegates ORM list encoding without changing raw parameters", async () => {
  const array = vi.fn(() => ({ serializedValues: '{"a,b","NULL"}' }));
  const unsafe = vi.fn(async () => bunResult());
  const driver = new BunSQLDriver({
    client: {
      array,
      unsafe,
    } as never,
  });
  const members = ["a,b", "NULL"];

  await driver._execute(sql`SELECT ${members}`);

  expect(array).toHaveBeenCalledTimes(1);
  expect(array).toHaveBeenCalledWith(members, "TEXT");
  expect(unsafe).toHaveBeenNthCalledWith(1, "SELECT $1", ['{"a,b","NULL"}']);

  await driver._executeRaw("SELECT $1", [members]);

  expect(array).toHaveBeenCalledTimes(1);
  expect(unsafe).toHaveBeenNthCalledWith(2, "SELECT $1", [members]);

  await driver._execute(sql`SELECT ${members}`, {
    model: "$raw",
    operation: "$queryRaw",
  });

  expect(array).toHaveBeenCalledTimes(2);
  expect(unsafe).toHaveBeenNthCalledWith(3, "SELECT $1", ['{"a,b","NULL"}']);
});

test("Bun SQL uses the transaction transport's array encoder", async () => {
  const rootArray = vi.fn(() => ({ serializedValues: "root" }));
  const transactionArray = vi.fn(() => ({ serializedValues: "{1,2}" }));
  const transactionUnsafe = vi.fn(async () => bunResult());
  const transaction = {
    array: transactionArray,
    unsafe: transactionUnsafe,
    savepoint: vi.fn(),
  };
  const driver = new BunSQLDriver({
    client: {
      array: rootArray,
      begin: async (run: (tx: typeof transaction) => Promise<unknown>) =>
        run(transaction),
      unsafe: vi.fn(async () => bunResult()),
    } as never,
  });

  await driver.withTransaction(async (tx) => {
    await tx._execute(sql`SELECT ${[1, 2]}`);
  });

  expect(rootArray).not.toHaveBeenCalled();
  expect(transactionArray).toHaveBeenCalledTimes(1);
  expect(transactionArray).toHaveBeenCalledWith([1, 2], "TEXT");
  expect(transactionUnsafe).toHaveBeenCalledWith("SELECT $1", ["{1,2}"]);
});
