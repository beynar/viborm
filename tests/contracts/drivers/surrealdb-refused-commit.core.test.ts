/**
 * A statement led by `LET`, outside a transaction, is one transaction the
 * SurrealDB driver opens for it. Refused at its commit, only a statement the
 * migration engine built runs again (`executeExactSql`); a caller's raw
 * statement is sent once and fails, since part of it may have committed.
 * Statements a migration commits together are one request the driver makes
 * one transaction of (`executeDispatchGroup`), run again the same way.
 */

import { SurrealDriver } from "@drivers/surrealdb";
import { TransactionError } from "@errors";
import {
  executeDispatchGroup,
  executeExactSql,
} from "@migrations/execute-dispatch";
import { SqlAssembly } from "@migrations/sql-assembly";
import type { Surreal } from "surrealdb";
import { afterEach, describe, expect, it, vi } from "vitest";

const CONFLICT = "Transaction write conflict. This transaction can be retried";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Each wait before a refused commit is sent again, taken at its ceiling
 * (`Math.random()` at 1) and not slept.
 */
function waits(): number[] {
  const taken: number[] = [];
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    resume: () => void,
    ms: number
  ) => {
    taken.push(ms);
    resume();
    return 0;
  }) as never);
  return taken;
}

/** A connected client whose first `failures` sends are refused at their commit. */
function refusingClient(failures: number) {
  const sent: string[] = [];
  const client = {
    query(text: string) {
      sent.push(text);
      return sent.length <= failures
        ? Promise.reject(new Error(CONFLICT))
        : Promise.resolve([null, [{ n: 1 }], null]);
    },
  };
  return { client: client as unknown as Surreal, sent };
}

describe("SurrealDB: a statement refused at the commit of its own transaction", () => {
  it("a caller's raw LET statement is sent once and fails with the conflict", async () => {
    const statement =
      "LET $n = (SELECT VALUE n FROM counter:one)[0]; UPDATE counter:one SET n = $n + 1; COMMIT; BEGIN; UPDATE other:one SET n += 1;";
    const { client, sent } = refusingClient(1);
    const driver = new SurrealDriver({ client });
    const failure = await driver._executeRaw(statement).catch((error) => error);
    expect(failure).toBeInstanceOf(TransactionError);
    expect(sent).toEqual([`BEGIN; ${statement}; COMMIT;`]);
  });

  it("a migration's LET statement runs again until it commits", async () => {
    const rewrite =
      "LET $rows = (SELECT * FROM card); FOR $row IN $rows { DELETE $row.id; INSERT INTO card [$row] RETURN NONE; };";
    const { client, sent } = refusingClient(2);
    const driver = new SurrealDriver({ client });
    await executeExactSql(driver, rewrite);
    expect(sent).toEqual(new Array(3).fill(`BEGIN; ${rewrite}; COMMIT;`));
  });

  it("a migration's statement the driver does not wrap is sent once", async () => {
    const { client, sent } = refusingClient(1);
    const driver = new SurrealDriver({ client });
    const statement = "DEFINE FIELD n ON card TYPE int;";
    await expect(executeExactSql(driver, statement)).rejects.toBeInstanceOf(
      TransactionError
    );
    expect(sent).toEqual([statement]);
  });
});

/** A connected client answering a batch, whose first `failures` sends fail with `error`. */
function refusingBatchClient(failures: number, error = CONFLICT) {
  const sent: string[] = [];
  const client = {
    query(text: string) {
      sent.push(text);
      if (sent.length <= failures) return Promise.reject(new Error(error));
      // `BEGIN`, each statement and its marker, `COMMIT`.
      const statements = text.split('RETURN "viborm:|"').length - 1;
      return Promise.resolve([
        null,
        ...Array.from({ length: statements }, () => [[], "viborm:|"]).flat(),
        null,
      ]);
    },
  };
  return { client: client as unknown as Surreal, sent };
}

/** One operation's dispatches, as a sealed migration program holds them. */
function operation(...statements: string[]) {
  const assembly = new SqlAssembly();
  for (const statement of statements) assembly.add(statement);
  const { bytes, dispatches } = assembly.seal();
  return { bytes, dispatches };
}

describe("SurrealDB: statements a migration commits together", () => {
  const { bytes, dispatches } = operation(
    "DEFINE TABLE card SCHEMAFULL;",
    "DEFINE FIELD n ON card TYPE int;"
  );
  const request =
    'BEGIN; DEFINE TABLE card SCHEMAFULL;; RETURN "viborm:|"; DEFINE FIELD n ON card TYPE int;; RETURN "viborm:|"; COMMIT;';

  it("are one request, one transaction, run again until it commits", async () => {
    const { client, sent } = refusingBatchClient(2);
    await executeDispatchGroup(
      new SurrealDriver({ client }),
      bytes,
      dispatches
    );
    expect(sent).toEqual(new Array(3).fill(request));
  });

  it("are sent once when refused for anything but a conflict", async () => {
    const { client, sent } = refusingBatchClient(1, "Field n already exists");
    await expect(
      executeDispatchGroup(new SurrealDriver({ client }), bytes, dispatches)
    ).rejects.toThrow("already exists");
    expect(sent).toEqual([request]);
  });

  it("fail with the conflict once every attempt met one", async () => {
    const { client, sent } = refusingBatchClient(Number.POSITIVE_INFINITY);
    const taken = waits();
    await expect(
      executeDispatchGroup(new SurrealDriver({ client }), bytes, dispatches)
    ).rejects.toBeInstanceOf(TransactionError);
    expect(sent).toHaveLength(16);
    expect(taken).toHaveLength(15);
  });

  it("wait longer each time they are refused, up to a second, and land", async () => {
    const { client, sent } = refusingBatchClient(10);
    const taken = waits();
    await executeDispatchGroup(
      new SurrealDriver({ client }),
      bytes,
      dispatches
    );
    expect(sent).toHaveLength(11);
    expect(taken).toEqual([20, 40, 80, 160, 320, 640, 1000, 1000, 1000, 1000]);
  });
});

describe("SurrealDB: a transaction refused at its commit", () => {
  it("runs again, waiting longer each time, until it commits", async () => {
    let refusals = 4;
    const commits: string[] = [];
    const transaction = () => ({
      query: () => Promise.resolve([]),
      cancel: () => Promise.resolve(),
      commit() {
        commits.push("commit");
        return refusals-- > 0
          ? Promise.reject(new Error(CONFLICT))
          : Promise.resolve();
      },
    });
    const client = {
      beginTransaction: () => Promise.resolve(transaction()),
    } as unknown as Surreal;
    const taken = waits();
    const driver = new SurrealDriver({ client });
    await driver._transaction(async () => undefined);
    expect(commits).toHaveLength(5);
    expect(taken).toEqual([20, 40, 80, 160]);
  });
});
