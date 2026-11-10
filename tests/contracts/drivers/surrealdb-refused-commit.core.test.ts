/**
 * A statement led by `LET`, outside a transaction, is one transaction the
 * SurrealDB driver opens for it. Refused at its commit, only a statement the
 * migration engine built runs again (`executeExactSql`); a caller's raw
 * statement is sent once and fails, since part of it may have committed.
 */

import { SurrealDriver } from "@drivers/surrealdb";
import { TransactionError } from "@errors";
import { executeExactSql } from "@migrations/execute-dispatch";
import type { Surreal } from "surrealdb";
import { describe, expect, it } from "vitest";

const CONFLICT = "Transaction write conflict. This transaction can be retried";

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
