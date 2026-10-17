/**
 * A fragment its statement settles once whole (`SqlSlot`, E5.2) and the
 * uncached reading of a fragment holding one (`Sql.peek`): the engine keys
 * a statement's relation bodies by their provisional text and settles each
 * place before the statement renders. The behaviour is
 * tests/contracts/public-client/extension-shared-bodies.core.test.ts.
 */

import { Sql, sql } from "@sql";
import { SqlSlot } from "@src/sql/slot";
import { describe, expect, test } from "vitest";

describe("SqlSlot and Sql.peek", () => {
  test("a slot reads its provisional text until it is settled, and its settled text after", () => {
    const slot = new SqlSlot(sql`a = ${1}`);
    const statement = sql`SELECT 1 WHERE ${slot}`;
    expect(Sql.peek(statement)).toEqual({
      strings: ["SELECT 1 WHERE a = ", ""],
      values: [1],
    });
    slot.settle(sql`b = ${2}`);
    expect(statement.toStatement()).toBe("SELECT 1 WHERE b = ?");
    expect(statement.values).toEqual([2]);
  });

  test("peek keeps nothing, and reads a rendered fragment's own projection", () => {
    const slot = new SqlSlot(sql`a`);
    const statement = sql`x ${slot}`;
    Sql.peek(statement);
    slot.settle(sql`b`);
    expect(statement.toStatement()).toBe("x b");
    expect(Sql.peek(statement)).toBe(Sql.peek(statement));
  });
});
