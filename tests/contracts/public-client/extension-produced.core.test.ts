/**
 * K4, the produced row (permissions plan §4.4, R4, OD-13), on in-memory SQLite: the
 * interactive route, the batch-only substrate (every statement of a write in
 * one batch, a database-generated key carried to the rows after it by the
 * batch scratch) and a driver without RETURNING (MySQL's shape: the key read
 * back as the insert id). The behaviour is
 * tests/contracts/engine/query/produced-row-behavior.ts; PGlite, PostgreSQL,
 * MySQL and D1 run it in their provider projects.
 */

import { ClientInitializationError } from "@errors";
import { check, extension, rule } from "@src/index";
import {
  createProducedRowClient,
  policyArgs,
  policyRules,
  runProducedRowBehavior,
} from "@tests/contracts/engine/query/produced-row-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  createBatchOnlySQLite3Driver,
  createNonReturningSQLite3Driver,
} from "@tests/providers/local/sqlite3-fixtures";
import { afterEach, describe, expect, test } from "vitest";

runProducedRowBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});
runProducedRowBehavior({
  name: "SQLite3, rules declared lazily",
  createDriver: createInMemorySQLite3Driver,
  lazy: true,
});
runProducedRowBehavior({
  name: "SQLite3 batch-only",
  createDriver: createBatchOnlySQLite3Driver,
});
runProducedRowBehavior({
  name: "SQLite3 without RETURNING",
  createDriver: createNonReturningSQLite3Driver,
  generatedKeys: false,
});

describe("rule moves and acyclic relations: admitted when the extension is applied", () => {
  const client = () =>
    createProducedRowClient(createInMemorySQLite3Driver()) as unknown as {
      $extends(definition: object): unknown;
      $disconnect(): Promise<void>;
    };
  const opened: { $disconnect(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const base of opened.splice(0)) await base.$disconnect();
  });
  /** The policy with `item`'s entry changed by `change`, applied: its refusal. */
  const refusal = (change: (entry: typeof policyRules.item) => object) => {
    const base = client();
    // Each changed entry is one the types refuse: the refusal tested is the runtime's.
    const rules = { ...policyRules, item: change(policyRules.item) } as never;
    try {
      base.$extends(extension("policy", policyArgs, rule(rules)));
    } catch (error) {
      return error as ClientInitializationError;
    } finally {
      opened.push(base);
    }
    throw new Error("expected the definition to be refused");
  };

  test("a move names one of the model's fields", () => {
    const moved = refusal((item) => ({
      ...item,
      update: { ...item.update, fields: { shelf: { check: check({}) } } },
    }));
    expect(moved).toBeInstanceOf(ClientInitializationError);
    expect(moved.message).toBe(
      'Extension "policy" rule.item: update.fields names unknown field "shelf".'
    );
  });

  test("an acyclic relation is a to-one relation of the model to itself that holds its key", () => {
    for (const relation of ["folder", "missing"])
      expect(
        refusal((item) => ({ ...item, acyclic: [relation] })).message
      ).toBe(
        `Extension "policy" rule.item.acyclic.${relation}: names no to-one relation of the model to itself holding its key.`
      );
  });
});
