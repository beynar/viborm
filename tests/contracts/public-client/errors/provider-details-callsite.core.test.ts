import { inspect } from "node:util";
import { remapStatementIndex } from "@drivers/driver-error-context";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryError, sanitizeErrorForLogging, ValidationError } from "@errors";
import { createClient, s, sql } from "@src/index";
import { instrumentation, type LogEvent } from "@src/instrumentation/exports";
import { describe, expect, it, vi } from "vitest";

function fakeProviderError() {
  return Object.assign(
    new Error(
      "no such column: missing; postgres://fixture_user:fixture_password@fixture.invalid/db"
    ),
    {
      detail: "binding password=fixture_secret token=fixture_token",
      hint: "use the existing column",
      code: "SQLITE_ERROR",
    }
  );
}

describe("opt-in provider diagnostics and deferred callsites", () => {
  it("preserves bounded descriptor-only details through construction, cloning, logging and JSON", () => {
    const error = new QueryError("Query execution failed", {
      cause: fakeProviderError(),
      diagnostics: { includeProviderDetails: true, includeCallsite: true },
      meta: {
        callsite: "fixture application frame",
        query: "hidden SQL",
        params: ["hidden param"],
      },
    });
    const clone = remapStatementIndex(error, 2);
    const logged = sanitizeErrorForLogging(clone);
    for (const value of [error, clone, logged]) {
      const json = JSON.stringify(value);
      expect(json).toContain("no such column: missing");
      expect(json).toContain("use the existing column");
      expect(json).toContain("fixture application frame");
      expect(json).toContain("QueryError");
      for (const secret of [
        "fixture_user",
        "fixture_password",
        "fixture_secret",
        "fixture_token",
        "hidden SQL",
        "hidden param",
      ])
        expect(json).not.toContain(secret);
      expect(value.message).toBe("Query execution failed");
      expect(inspect(value)).not.toContain("fixture_password");
    }
    const getter = vi.fn(() => "must never be read");
    const hostile = Object.defineProperties(new Error("own safe message"), {
      detail: { get: getter },
      hint: { get: getter },
    });
    const safe = new QueryError("failed", {
      cause: hostile,
      diagnostics: { includeProviderDetails: true },
    });
    expect(JSON.stringify(safe)).toContain("own safe message");
    expect(getter).not.toHaveBeenCalled();
    const huge = new QueryError("failed", {
      cause: new Error("x".repeat(100_000)),
      diagnostics: { includeProviderDetails: true },
    });
    expect(JSON.stringify(huge).length).toBeLessThan(5000);
  });

  it("keeps the default cause redacted even after logging and reattribution", () => {
    const error = new QueryError("Query execution failed", {
      cause: fakeProviderError(),
      meta: { callsite: "hidden frame" },
    });
    const json = JSON.stringify(
      sanitizeErrorForLogging(remapStatementIndex(error, 1))
    );
    expect(json).toContain("Underlying error details redacted");
    expect(json).not.toContain("no such column");
    expect(json).not.toContain("hidden frame");
  });

  it("captures raw and model creation frames before a later await, and serializes them in official logs", async () => {
    const events: LogEvent[] = [];
    const driver = new SQLite3Driver();
    const db = createClient({
      schema: { entry: s.model({ id: s.string().id({ generate: false }) }) },
      driver,
    }).$extends(
      instrumentation({
        diagnostics: { includeProviderDetails: true, includeCallsite: true },
        logging: {
          error: (event) => {
            events.push(event);
          },
        },
      })
    );
    function makeRawRequest() {
      return db.$queryRaw(
        sql`SELECT deliberately_missing FROM deliberately_absent`
      );
    }
    function makeModelRequest() {
      return db.entry.findMany();
    }
    try {
      const raw = makeRawRequest();
      await Promise.resolve();
      const rawError = await raw.catch((error: unknown) => error);
      expect(rawError).toBeInstanceOf(QueryError);
      expect(JSON.stringify(rawError)).toContain("makeRawRequest");
      expect(JSON.stringify(rawError)).toContain("no such table");
      const model = makeModelRequest();
      await Promise.resolve();
      const modelError = await model.catch((error: unknown) => error);
      expect(JSON.stringify(modelError)).toContain("makeModelRequest");
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events[0])).toContain("makeRawRequest");
      expect(JSON.stringify(events[0])).toContain("no such table");
      expect(JSON.stringify(events[1])).toContain("makeModelRequest");
    } finally {
      await db.$disconnect();
    }
  });

  it("retains canonical validation class, source and issue path in serialized logs", () => {
    const error = new ValidationError(
      { kind: "operation", operation: "create", model: "entry" },
      [{ path: "data.id", message: "Expected string" }]
    );
    error.issues[0]!.path = "caller mutated";
    const json = JSON.stringify({ error: sanitizeErrorForLogging(error) });
    expect(json).toContain("ValidationError");
    expect(json).toContain("Validation failed");
    expect(json).toContain("data.id");
    expect(json).not.toContain("caller mutated");
  });
});
