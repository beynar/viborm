// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
/**
 * A refused creation-timestamp assignment never reaches the engine (#47).
 *
 * The admission rule lives in the operation schemas
 * (`tests/unit/operation-schemas/update/insert-only-timestamps.core.test.ts`).
 * This file pins what that rule buys a caller of the public client: a root
 * update, updateMany or upsert that names a `.now()` field is refused BEFORE
 * any statement is dispatched, and the refused assignment runs neither the
 * field's own `.schema()` validator nor its default closure (an upsert's
 * create arm is an insert and runs them for its own row, measured by its
 * accepted twin; that pins today's create-before-update admission order).
 * The nested cells record where a
 * nested refusal lands — the same pre-dispatch admission, since the whole
 * payload is parsed before execution — so an acknowledged segment cannot
 * precede it.
 *
 * The driver plans SQL and counts every dispatch; it has no database, so an
 * ACCEPTED write is observed as its first dispatch failing, which the client
 * reports as a (redacted) query failure. Live providers:
 * `tests/providers/local/{sqlite3,pglite}-insert-only-timestamps.test.ts`.
 */

import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { ValidationError } from "@errors";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { beforeEach, describe, expect, test } from "vitest";

const LATER = new Date("2026-02-01T00:00:00.000Z");
/** `entry.createdAt`'s `.schema()` takes the ISO string, so a probe of it must
 *  spell one: a `Date` would be a type error for an unrelated reason. */
const LATER_ISO = LATER.toISOString();

class CountingDriver extends PlanningDriver {
  readonly statements: string[] = [];

  protected override execute<T>(
    client: null,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    return super.execute(client, sql, params, context);
  }
}

const counters = { validated: 0, defaulted: 0 };

/** A `.schema()` validator that counts its invocations and admits any string. */
const countingTimestamp: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "insert-only-timestamps",
    validate: (value) => {
      counters.validated += 1;
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "expected an ISO string" }] };
    },
  },
};

const entry = s.model({
  id: s.string().id(),
  title: s.string(),
  // Insert-only through `.now()`; its own validator counts.
  createdAt: s.dateTime().now().schema(countingTimestamp),
  // Insert-only through `.now()`; `.default(fn)` keeps the generator.
  stampedAt: s
    .dateTime()
    .now()
    .default(() => {
      counters.defaulted += 1;
      return LATER;
    }),
  remarks: s.toMany(() => remark),
});

const remark = s.model({
  id: s.string().id(),
  body: s.string(),
  createdAt: s.dateTime().now(),
  entryId: s.string(),
  entry: s
    .toOne(() => entry)
    .fields("entryId")
    .references("id"),
});

const setup = () => {
  const driver = new CountingDriver("sqlite");
  const client = createClient({ schema: { entry, remark }, driver });
  return { driver, client };
};

/** Run a write through `run` and report how it ended and what it dispatched. */
const observe = async (
  run: (client: ReturnType<typeof setup>["client"]) => PromiseLike<unknown>
) => {
  const { driver, client } = setup();
  let outcome: unknown;
  try {
    await run(client);
    outcome = "resolved";
  } catch (error) {
    outcome = error;
  }
  await client.$disconnect();
  return { outcome, statements: driver.statements, ...counters };
};

type Observed = Awaited<ReturnType<typeof observe>>;

/**
 * Refused with the admission sentence, nothing dispatched, and the field's own
 * validator and default invoked no more than `baseline` — which is zero except
 * where an insert arm of the same call runs them for its own row.
 */
const refusedBeforeDispatch = (
  observed: Observed,
  key: string,
  baseline: Pick<Observed, "validated" | "defaulted"> = {
    validated: 0,
    defaulted: 0,
  }
) => {
  expect(observed.outcome).toBeInstanceOf(ValidationError);
  expect(observed.outcome).toMatchObject({
    message: expect.stringContaining(`Unknown key: ${key}`),
  });
  expect(observed.statements).toEqual([]);
  expect(observed.validated).toBe(baseline.validated);
  expect(observed.defaulted).toBe(baseline.defaulted);
};

/** An accepted write: the planning driver's dispatch failure, as a query error. */
const dispatched = (observed: Observed) => {
  expect(observed.outcome).toMatchObject({ name: "QueryError" });
  expect(observed.statements.length).toBeGreaterThan(0);
};

beforeEach(() => {
  counters.validated = 0;
  counters.defaulted = 0;
});

describe("insert-only timestamps at the public client", () => {
  test("control: a create runs the field's validator and default, then dispatches", async () => {
    const observed = await observe((client) =>
      client.entry.create({
        data: { id: "e1", title: "t", createdAt: new Date().toISOString() },
      })
    );
    dispatched(observed);
    expect(observed.validated).toBeGreaterThan(0);
    expect(observed.defaulted).toBe(1);
  });

  test("control: an ordinary update dispatches without touching either field", async () => {
    const observed = await observe((client) =>
      client.entry.update({ where: { id: "e1" }, data: { title: "u" } })
    );
    dispatched(observed);
    expect(observed.validated).toBe(0);
    expect(observed.defaulted).toBe(0);
  });

  test("root update refuses either creation timestamp before dispatch", async () => {
    refusedBeforeDispatch(
      await observe((client) =>
        client.entry.update({
          where: { id: "e1" },
          // @ts-expect-error `createdAt` is insert-only; the runtime refusal is the pin here.
          data: { title: "u", createdAt: LATER_ISO },
        })
      ),
      "createdAt"
    );
    refusedBeforeDispatch(
      await observe((client) =>
        client.entry.update({
          where: { id: "e1" },
          // @ts-expect-error `stampedAt` is insert-only; the runtime refusal is the pin here.
          data: { title: "u", stampedAt: { set: LATER } },
        })
      ),
      "stampedAt"
    );
  });

  test("a caller that bypasses TypeScript is refused the same way, `undefined` included", async () => {
    const payload: Record<string, unknown> = {
      title: "u",
      createdAt: undefined,
    };
    refusedBeforeDispatch(
      await observe((client) =>
        Reflect.apply(client.entry.update, client.entry, [
          { where: { id: "e1" }, data: payload },
        ])
      ),
      "createdAt"
    );
  });

  test("updateMany and upsert.update refuse before dispatch", async () => {
    refusedBeforeDispatch(
      await observe((client) =>
        client.entry.updateMany({
          where: {},
          // @ts-expect-error `createdAt` is insert-only; the runtime refusal is the pin here.
          data: { createdAt: LATER_ISO },
        })
      ),
      "createdAt"
    );
    // The create arm is an insert context: admitting it runs `createdAt`'s
    // validator on its generated value. The accepted twin measures that cost,
    // and the refused call may spend exactly it and nothing for the update arm.
    const upsert =
      (update: Record<string, unknown>) =>
      (client: ReturnType<typeof setup>["client"]) =>
        Reflect.apply(client.entry.upsert, client.entry, [
          { where: { id: "e1" }, create: { id: "e1", title: "t" }, update },
        ]);
    const accepted = await observe(upsert({ title: "u" }));
    dispatched(accepted);
    counters.validated = 0;
    counters.defaulted = 0;
    refusedBeforeDispatch(
      await observe(upsert({ title: "u", createdAt: LATER_ISO })),
      "createdAt",
      accepted
    );
  });

  test("a nested update refuses at the same pre-dispatch admission", async () => {
    refusedBeforeDispatch(
      await observe((client) =>
        client.entry.update({
          where: { id: "e1" },
          data: {
            title: "u",
            remarks: {
              // @ts-expect-error `createdAt` is insert-only; the runtime refusal is the pin here.
              updateMany: {
                where: {},
                data: { body: "b", createdAt: LATER },
              },
            },
          },
        })
      ),
      "createdAt"
    );
    refusedBeforeDispatch(
      await observe((client) =>
        client.remark.update({
          where: { id: "r1" },
          data: {
            // @ts-expect-error `createdAt` is insert-only; the runtime refusal is the pin here.
            entry: { update: { title: "u", createdAt: LATER_ISO } },
          },
        })
      ),
      "createdAt"
    );
  });
});
