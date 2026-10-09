import { createClient } from "@client/client";
import {
  FeatureNotSupportedError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import { s } from "@schema";
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

      // The refusal reaches the caller INSTEAD of any provider work: this
      // fixture's `execute` throws "A planning-only contract dispatched
      // provider work." and its `_executeBatch` a different sentence, so a
      // dispatched decision read could not produce this error at all.
      expect(thrown).toBeInstanceOf(TransactionError);
      if (!(thrown instanceof TransactionError)) {
        throw new Error("Expected a TransactionError.");
      }
      // The surviving driver seam's own sentence, unchanged since before the
      // cutover (`drivers/driver-transaction-base.ts:790`, `:979`, and
      // `client/array-transaction-native-batch.ts:51-61`). The deleted engine
      // spelled the same capability with `'` quotes; the wording that survives
      // is the one the estate still raises everywhere else.
      expect(thrown.message).toBe(
        `Driver "${driver.driverName}" supports neither transactions nor atomic batch execution.`
      );
      expect(thrown.meta.driver).toBe(driver.driverName);
      expect(thrown.meta.operation).toBe(operationName);
    });
  }
});

class VectorDistanceProbeDriver extends PlanningDriver {
  requests = 0;
  protected override async execute<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.requests++;
    return { rows: [], rowCount: 0 };
  }
}

test("public vector distance admission distinguishes unsupported tiers and invalid dimensions", async () => {
  const embedding = s.model({
    id: s.int().id(),
    value: s.vector().dimension(3).nullable(),
  });
  const supported = new VectorDistanceProbeDriver("postgresql");
  supported.adapter.capabilities.supportsVector = true;
  const db = createClient({ schema: { embedding }, driver: supported });
  const refused = await db.embedding
    .findMany({
      select: { value: { _distance: { to: [1, 2], metric: "l2" } } },
    })
    .catch((failure: unknown) => failure);
  expect(refused).toBeInstanceOf(UnsupportedOperationError);
  expect(refused).toMatchObject({ code: "V8003" });
  expect(supported.requests).toBe(0);
  expect(
    await db.embedding.findMany({
      select: { value: { _distance: { to: [1, 2, 3], metric: "l2" } } },
    })
  ).toEqual([]);
  expect(supported.requests).toBe(1);
  const unsupported = new VectorDistanceProbeDriver("sqlite");
  const unavailable = createClient({
    schema: { embedding },
    driver: unsupported,
  });
  await expect(
    unavailable.embedding.findMany({
      select: { value: { _distance: { to: [1, 2, 3], metric: "l2" } } },
    })
  ).rejects.toBeInstanceOf(FeatureNotSupportedError);
  expect(unsupported.requests).toBe(0);
});
