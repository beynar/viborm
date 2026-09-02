import { createClient } from "@client/client";
import { TransactionError } from "@errors";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { describe, expect, test } from "vitest";

type AtomicOperation = "create" | "update" | "upsert";

const ATOMIC_OPERATIONS: readonly AtomicOperation[] = [
  "create",
  "update",
  "upsert",
];

function unsupportedOperation(
  driver: PlanningDriver,
  operation: AtomicOperation
): PromiseLike<unknown> {
  const client = createClient({ schema: nestedWriteBehaviorSchema, driver });
  // biome-ignore lint/style/useDefaultSwitchClause: every arm returns and there is no trailing return — the switch's exhaustiveness over AtomicOperation is what makes this compile, so a default clause would turn a missing arm from a type error into a silent undefined.
  switch (operation) {
    case "create":
      return client.user.create({
        data: {
          id: "u-create",
          name: "Owner",
          posts: { create: { id: "p-create", title: "Nested" } },
        },
        include: { posts: true },
      });
    case "update":
      return client.user.update({
        where: { id: "u-update" },
        data: {
          posts: { create: { id: "p-update", title: "Nested" } },
        },
      });
    case "upsert":
      return client.user.upsert({
        where: { id: "u-upsert" },
        create: {
          id: "u-upsert",
          name: "Owner",
          posts: { create: { id: "p-upsert", title: "Nested" } },
        },
        update: { name: "Updated" },
      });
  }
}

describe("operation executor atomic-capability refusal", () => {
  for (const operationName of ATOMIC_OPERATIONS) {
    test(`operation '${operationName}' fails before dispatch`, async () => {
      const driver = new PlanningDriver("postgresql", {
        driverName: "no-atomic-planning",
        supportsTransactions: false,
        supportsBatch: false,
      });

      let thrown: unknown;
      try {
        await unsupportedOperation(driver, operationName);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TransactionError);
      if (!(thrown instanceof TransactionError)) {
        throw new Error("Expected a TransactionError.");
      }
      expect(thrown.message).toBe(
        `Driver '${driver.driverName}' supports neither transactions nor atomic batch execution.`
      );
      expect(thrown.meta.driver).toBe(driver.driverName);
      expect(thrown.meta.operation).toBe(operationName);
    });
  }
});
