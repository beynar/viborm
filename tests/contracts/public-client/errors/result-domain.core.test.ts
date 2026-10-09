import { attachCommitCertainty } from "@drivers/driver-error-context";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  createClient,
  QueryEngineError,
  QueryError,
  s,
  sql,
  VibORMErrorCode,
} from "@src/index";
import { describe, expect, it } from "vitest";

describe("expected result domain failures", () => {
  it("refuses a database-legal poisoned INTEGER without blaming the engine or losing valid rows", async () => {
    const db = createClient({
      schema: {
        entry: s.model({
          id: s.string().id({ generate: false }),
          rank: s.int(),
        }),
      },
      driver: new SQLite3Driver(),
    });
    try {
      await db.$executeRaw(
        sql`CREATE TABLE entry (id TEXT PRIMARY KEY, rank INTEGER NOT NULL)`
      );
      await db.$executeRaw(
        sql`INSERT INTO entry (id, rank) VALUES ('safe', 1), ('z-poison', 9007199254740993)`
      );
      await expect(
        db.entry.findUnique({ where: { id: "safe" } })
      ).resolves.toEqual({ id: "safe", rank: 1 });
      await expect(
        db.entry.findMany({
          where: {
            rank: { in: Array.from({ length: 1000 }, (_, index) => index) },
          },
          orderBy: { id: "asc" },
        })
      ).resolves.toEqual([{ id: "safe", rank: 1 }]);
      const failure = await db.entry.findMany({ orderBy: { id: "asc" } }).then(
        () => {
          throw new Error("Poisoned result unexpectedly succeeded");
        },
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(QueryError);
      expect(failure).not.toBeInstanceOf(QueryEngineError);
      expect(failure).toMatchObject({
        code: VibORMErrorCode.QUERY_RESULT_INVALID,
        meta: {
          model: "entry",
          operation: "findMany",
          scalarType: "int",
          reason: "the integer is outside the safe range",
        },
      });
      if (!(failure instanceof QueryError)) throw failure;
      expect(failure.isRetryable()).toBe(false);
      expect(failure.message).not.toContain("Driver");
      expect(failure.message).not.toContain("9007199254740993");
      const clone = attachCommitCertainty(failure, "may-have-committed");
      expect(clone).toBeInstanceOf(QueryError);
      expect(clone.meta).toMatchObject({
        model: "entry",
        scalarType: "int",
        reason: "the integer is outside the safe range",
        commitCertainty: "may-have-committed",
      });
      await expect(
        db.entry.findUnique({ where: { id: "safe" } })
      ).resolves.toEqual({ id: "safe", rank: 1 });
    } finally {
      await db.$disconnect();
    }
  });
});
