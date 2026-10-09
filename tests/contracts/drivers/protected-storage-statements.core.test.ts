import {
  createExecutionContext,
  deriveStatementExecutionContext,
  getExecutionExtensionChain,
} from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/types";
import { appendResolvedExtension } from "@extensions/chain";
import { type Sql, sql } from "@sql";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { expect, test, vi } from "vitest";

class StorageStatementDriver extends PlanningDriver {
  override readonly maxBindParametersPerStatement = 1;
  finalize(statement: Sql, context: QueryExecutionContext): Sql {
    return this.applyTrustedStatementTransforms(statement, context, "findMany");
  }
}

test("protected storage checks bypass user transforms but retain bind limits", () => {
  const changed = sql`SELECT ${2}`;
  const transform = vi.fn(() => changed);
  const chain = appendResolvedExtension(
    undefined,
    { name: "replace", statement: transform },
    {}
  );
  const driver = new StorageStatementDriver("postgresql");
  const original = sql`SELECT ${1}`;
  for (const operation of ["verifyStorage", "assertStorage"]) {
    const context = deriveStatementExecutionContext(
      createExecutionContext(
        { model: "user", operation: "findMany", correlationId: "request" },
        undefined,
        chain
      ),
      "$schema",
      operation
    );
    expect(getExecutionExtensionChain(context)).toBe(chain);
    expect(context.correlationId).toBe("request");
    expect(driver.finalize(original, context)).toBe(original);
    expect(() => driver.finalize(sql`SELECT ${1}, ${2}`, context)).toThrow();
  }
  expect(transform).not.toHaveBeenCalled();
  expect(
    driver.finalize(
      original,
      createExecutionContext(
        { model: "user", operation: "findMany" },
        undefined,
        chain
      )
    )
  ).toBe(changed);
  expect(transform).toHaveBeenCalledOnce();
});
