import type { AnyDriver } from "@src/drivers/driver";
import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import { runProgram } from "@src/migrations/pinned-session";
import { describe, expect, test } from "vitest";
import { mysqlEstateDriver, sqliteEstateDriver } from "./_estate";

const BEGIN = "<begin>";

async function run(
  driver: ReturnType<typeof sqliteEstateDriver>,
  program: Parameters<typeof runProgram>[2],
  fail = false
) {
  const seen: { producer: AnyDriver; atomic: boolean }[] = [];
  await runProgram(
    driver,
    getMigrationDriver(driver),
    program,
    async (producer, atomic) => {
      seen.push({ producer, atomic });
      await producer._executeRaw("SELECT 1", []);
      if (fail) throw new Error("body failed");
    }
  ).catch((error: unknown) => {
    if (!fail) throw error;
  });
  return seen;
}

describe("runProgram", () => {
  test("runs transactional work in one transaction and records its commit", async () => {
    const driver = sqliteEstateDriver();
    const phase = { committing: false, committed: false };
    const seen = await run(driver, {
      transactional: true,
      statements: ["CREATE TABLE t (id INTEGER)"],
      phase,
    });
    expect(seen.map((item) => item.atomic)).toEqual([true]);
    expect(seen[0]?.producer).not.toBe(driver);
    expect(driver.statements).toEqual(["<connect>", BEGIN, "SELECT 1"]);
    expect(phase).toEqual({ committing: true, committed: true });
  });

  test("a body failure leaves the phase before the commit", async () => {
    const phase = { committing: false, committed: false };
    await run(
      sqliteEstateDriver(),
      { transactional: true, statements: [], phase },
      true
    );
    expect(phase).toEqual({ committing: false, committed: false });
  });

  test("stepwise work and a program-less body run directly on the session", async () => {
    for (const program of [
      { transactional: false, statements: [] },
      undefined,
    ]) {
      const driver = sqliteEstateDriver();
      const seen = await run(driver, program);
      expect(seen).toEqual([{ producer: driver, atomic: false }]);
      expect(driver.statements).toEqual(["<connect>", "SELECT 1"]);
    }
  });

  test("MySQL runs as a sequential program, whatever the boundary", async () => {
    for (const program of [
      { transactional: true, statements: [] },
      undefined,
    ]) {
      const driver = mysqlEstateDriver({ namespace: "app" });
      // An unbound command reaches the sequential program's own refusal
      // before the body runs: no transaction is ever opened.
      await expect(
        runProgram(driver, getMigrationDriver(driver), program, () =>
          Promise.resolve()
        )
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        meta: { type: "unbound-migration-command" },
      });
      expect(driver.statements).toEqual([]);
    }
  });
});
