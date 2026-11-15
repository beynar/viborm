/**
 * viborm/instrumentation on SQL Server: every statement the driver sends is
 * logged and traced as it is sent (`@pN` and its parameters), a transaction
 * is one span holding each call's savepoint and statements, and a statement
 * the server refuses is
 * logged and traced as the typed error the call fails with (by its name:
 * what is logged is the error's disclosed copy). Set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { UniqueConstraintError } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import type { LogEvent, SpanTracer, TracingSpan } from "@instrumentation/types";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const READ_BY_EMAIL = /^SELECT .* WHERE .*= @p1/;
const NAMESPACE = "viborm_instrumentation";

const account = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("accounts");

interface Recorded {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly exceptions: Error[];
  ended: boolean;
}

/** A tracer as a runtime hands one: every span it starts, recorded. */
function recordingTracer(): { tracer: SpanTracer; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const tracer: SpanTracer = {
    startActiveSpan<T>(name: string, fn: (span: TracingSpan) => T): T {
      const recorded: Recorded = {
        name,
        attributes: {},
        exceptions: [],
        ended: false,
      };
      spans.push(recorded);
      return fn({
        setAttribute: (key, value) => {
          recorded.attributes[key] = value;
        },
        recordException: (exception) => {
          recorded.exceptions.push(exception);
        },
        end: () => {
          recorded.ended = true;
        },
      });
    },
  };
  return { tracer, spans };
}

describeIf("SQL Server: viborm/instrumentation", () => {
  const base = createClient({
    schema: { account },
    driver: createMssqlDriverIn(NAMESPACE),
  });
  const logged: LogEvent[] = [];
  const failed: LogEvent[] = [];
  const { tracer, spans } = recordingTracer();
  const db = base.$extends(
    instrumentation({
      logging: {
        query: (event) => {
          logged.push(event);
        },
        error: (event) => {
          failed.push(event);
        },
        includeSql: true,
        includeParams: true,
      },
      tracing: { tracer, includeSql: true },
    })
  );

  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await base.$executeRawUnsafe(
      `CREATE TABLE "${NAMESPACE}"."accounts" ("id" NVARCHAR(450) NOT NULL PRIMARY KEY, "email" NVARCHAR(450) NOT NULL UNIQUE, "name" NVARCHAR(MAX) NOT NULL)`
    );
  });
  afterAll(async () => {
    try {
      await dropSchema(NAMESPACE);
    } finally {
      await base.$disconnect();
    }
  });

  test("each statement is logged and traced as SQL Server receives it", async () => {
    logged.length = 0;
    spans.length = 0;
    await db.account.create({
      data: { id: "a", email: "a@x", name: "Ada" },
    });
    expect(await db.account.findUnique({ where: { email: "a@x" } })).toEqual({
      id: "a",
      email: "a@x",
      name: "Ada",
    });
    const insert = logged.find((event) => event.sql?.startsWith("INSERT"));
    expect(insert?.sql).toContain("@p1");
    expect(insert?.params).toEqual(["a", "a@x", "Ada"]);
    expect(insert?.model).toBe("account");
    const read = logged.at(-1)!;
    expect(read.sql).toMatch(READ_BY_EMAIL);
    expect(read.params).toEqual(["a@x"]);
    const executed = spans.filter(
      (span) => span.name === "viborm.execute" && span.ended
    );
    expect(executed.length).toBeGreaterThanOrEqual(2);
    expect(
      executed.some((span) =>
        String(span.attributes["db.query.text"] ?? "").startsWith("INSERT")
      )
    ).toBe(true);
  });

  // A call that sends more than one statement (an INSERT, then the row read
  // back: SQL Server returns none) runs in a savepoint of the transaction,
  // traced as a transaction span of its own operation.
  test("a transaction is one span, committed, around each call's savepoint and statements", async () => {
    spans.length = 0;
    await db.$transaction(async (tx) => {
      await tx.account.create({
        data: { id: "b", email: "b@x", name: "Bob" },
      });
      await tx.account.update({
        where: { id: "b" },
        data: { name: "Bobby" },
      });
    });
    const transaction = spans.filter(
      (span) => span.name === "viborm.transaction"
    );
    expect(
      transaction.map((span) => span.attributes["db.operation.name"])
    ).toEqual(["$transaction(callback)", "create", "update"]);
    expect(spans[0]).toBe(transaction[0]);
    expect(
      spans.every((span) => span.ended && span.exceptions.length === 0)
    ).toBe(true);
    expect(
      spans
        .filter((span) => span.name === "viborm.execute")
        .map((span) => String(span.attributes["db.query.text"]).split(" ")[0])
    ).toEqual(["INSERT", "SELECT", "UPDATE", "SELECT"]);
    expect(await base.account.findUnique({ where: { id: "b" } })).toEqual({
      id: "b",
      email: "b@x",
      name: "Bobby",
    });
  });

  test("a refused statement is logged and traced as the typed error the call fails with", async () => {
    failed.length = 0;
    spans.length = 0;
    const refusal = await db.account
      .create({ data: { id: "c", email: "a@x", name: "Copy" } })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refusal).toBeInstanceOf(UniqueConstraintError);
    expect(failed.map((event) => [event.operation, event.error?.name])).toEqual(
      [["create", "UniqueConstraintError"]]
    );
    const insert = spans.find((span) =>
      String(span.attributes["db.query.text"] ?? "").startsWith("INSERT")
    );
    expect(insert?.exceptions.map((exception) => exception.name)).toEqual([
      "UniqueConstraintError",
    ]);
    expect(await base.account.count()).toBe(2);
  });
});
