/**
 * The driver failure normalizer is total: whatever a provider throws — a
 * string, a Proxy whose traps throw, an `Error` whose `message` is a getter
 * that explodes — comes back as one typed VibORM failure with the execution
 * context attached. That totality is a real requirement, because this function
 * runs on the failure path, and a normalizer that throws replaces the error the
 * caller needed to see with one about the normalizer.
 *
 * This file covers the shapes the fixture suite does not: the MySQL and SQLite
 * families that are only recognisable from a message, the hostile provider
 * values, and the ValidationError clone whose `source` kinds must survive the
 * round trip through `attachExecutionContext`.
 *
 * `error-mapping.core.test.ts` owns the provider fixture table; this file owns
 * the boundary.
 */

import {
  attachExecutionContext,
  buildMeta,
} from "@drivers/driver-error-context";
import {
  normalizeDriverConnectionError,
  normalizeDriverError,
} from "@drivers/error-mapping";
import {
  attachRecordSeriesProgress,
  CheckConstraintError,
  ConnectionError,
  ForeignKeyError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { describe, expect, test } from "vitest";

const context = { driverName: "boundary", dialect: "sqlite" as const };

describe("provider code families recognised by code or errno", () => {
  test.each([
    {
      expected: TransactionError,
      code: VibORMErrorCode.DEADLOCK,
      label: "PostgreSQL deadlock_detected",
      raw: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    },
    {
      expected: NotNullConstraintError,
      code: VibORMErrorCode.NOT_NULL_CONSTRAINT,
      label: "MySQL ER_BAD_NULL_ERROR by errno",
      raw: Object.assign(new Error("Column 'name' cannot be null"), {
        errno: 1048,
      }),
    },
    {
      expected: NotNullConstraintError,
      code: VibORMErrorCode.NOT_NULL_CONSTRAINT,
      label: "MySQL ER_BAD_NULL_ERROR by symbol",
      raw: Object.assign(new Error("Column 'name' cannot be null"), {
        code: "ER_BAD_NULL_ERROR",
      }),
    },
    {
      expected: CheckConstraintError,
      code: VibORMErrorCode.CHECK_CONSTRAINT,
      label: "MySQL ER_CHECK_CONSTRAINT_VIOLATED by errno",
      raw: Object.assign(new Error("Check constraint 'ck_age' is violated"), {
        errno: 3819,
      }),
    },
    {
      expected: CheckConstraintError,
      code: VibORMErrorCode.CHECK_CONSTRAINT,
      label: "MySQL ER_CHECK_CONSTRAINT_VIOLATED by symbol",
      raw: Object.assign(new Error("Check constraint 'ck_age' is violated"), {
        code: "ER_CHECK_CONSTRAINT_VIOLATED",
      }),
    },
  ])("maps $label", ({ raw, expected, code }) => {
    const failure = normalizeDriverError(raw, { driverName: "provider" });

    expect(failure).toBeInstanceOf(expected);
    expect(failure).toMatchObject({ code });
  });
});

describe("SQLite constraint families recognised from the message", () => {
  test.each([
    {
      expected: ForeignKeyError,
      label: "foreign key",
      columns: undefined,
      message: "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed",
    },
    {
      expected: NotNullConstraintError,
      label: "not null",
      columns: ["entry.title"],
      message: "SQLITE_CONSTRAINT: NOT NULL constraint failed: entry.title",
    },
    {
      expected: CheckConstraintError,
      label: "check",
      columns: undefined,
      message: "SQLITE_CONSTRAINT: CHECK constraint failed: positive_amount",
    },
    {
      expected: UniqueConstraintError,
      label: "unique with two columns",
      columns: ["entry.a", "entry.b"],
      message: "UNIQUE constraint failed: entry.a, entry.b",
    },
  ])("maps a $label failure", ({ message, expected, columns }) => {
    const failure = normalizeDriverError(new Error(message), context);

    expect(failure).toBeInstanceOf(expected);
    expect(failure.meta.columns).toEqual(columns);
  });

  test("leaves an unrecognised SQLITE_CONSTRAINT family as a plain query failure", () => {
    const failure = normalizeDriverError(
      new Error("SQLITE_CONSTRAINT_TRIGGER: abort at 3 in [RAISE]"),
      context
    );

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toBe("Query execution failed");
  });

  test("reports no columns when the message names none", () => {
    const failure = normalizeDriverError(
      new Error("UNIQUE constraint failed"),
      context
    );

    expect(failure).toBeInstanceOf(UniqueConstraintError);
    expect(failure.meta.columns).toBeUndefined();
  });
});

describe("hostile provider values", () => {
  test("normalizes a thrown string with no provider shape to read", () => {
    const failure = normalizeDriverError("connection reset by peer", {
      driverName: "provider",
    });

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.meta).toMatchObject({ driver: "provider" });
    expect(failure.meta.providerCode).toBeUndefined();
  });

  test("survives an error whose identity and message traps throw", () => {
    const hostile = new Proxy(new Error("unreadable"), {
      get(target, key, receiver) {
        if (key === "message") throw new Error("message trap");
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    });

    const failure = normalizeDriverError(hostile, { driverName: "provider" });

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toBe("Query execution failed");
  });

  test("survives an opaque carrier whose every property read throws", () => {
    const opaque = new Proxy(
      {},
      {
        get() {
          throw new Error("provider state is not readable");
        },
      }
    );

    const failure = normalizeDriverError(opaque, { driverName: "provider" });

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.meta).toMatchObject({ driver: "provider" });
  });

  test("survives an error whose own message is not a string", () => {
    const raw = new Error("placeholder");
    Object.defineProperty(raw, "message", { value: 42 });

    const failure = normalizeDriverError(raw, { driverName: "provider" });

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.meta).toMatchObject({ driver: "provider" });
  });

  test("survives an error whose message getter throws", () => {
    const raw = new Error("placeholder");
    Object.defineProperty(raw, "message", {
      get() {
        throw new Error("message accessor");
      },
    });

    const failure = normalizeDriverError(raw, { driverName: "provider" });

    expect(failure).toBeInstanceOf(QueryError);
  });
});

describe("connection failures", () => {
  test("keeps the MySQL errno a connection error only carries in its message", () => {
    const failure = normalizeDriverConnectionError(
      new Error("Too many connections (errno 1040)"),
      { driverName: "mysql2" }
    );

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.meta).toMatchObject({
      driver: "mysql2",
      providerErrno: 1040,
    });
  });

  test("passes an already-typed failure through with execution context", () => {
    const original = new ConnectionError("pool exhausted");

    const failure = normalizeDriverConnectionError(original, {
      driverName: "mysql2",
      model: "entry",
      operation: "findMany",
    });

    expect(failure.meta).toMatchObject({
      driver: "mysql2",
      model: "entry",
      operation: "findMany",
    });
  });
});

describe("record-series progress survives normalization", () => {
  test("re-attaches a committed prefix to the re-contextualized clone", () => {
    const original = new QueryError("segment failed");
    attachRecordSeriesProgress(original, {
      atomicity: "segment",
      phase: "member",
      committedSegments: 2,
      completedMembers: 3,
      committedWriteMembers: 2,
    });

    const failure = normalizeDriverError(original, {
      driverName: "provider",
      model: "entry",
      operation: "createMany",
    });

    expect(failure).not.toBe(original);
    expect(failure.meta).toMatchObject({
      driver: "provider",
      model: "entry",
      recordSeriesProgress: expect.objectContaining({
        committedSegments: 2,
        completedMembers: 3,
      }),
    });
  });
});

describe("validation failures keep their source through re-contextualization", () => {
  test.each([
    {
      label: "a registry source",
      source: { kind: "registry", model: "entry", property: "title" } as const,
      expected: { kind: "registry", model: "entry", property: "title" },
    },
    {
      label: "a schema-builder source",
      source: {
        kind: "schema-builder",
        builder: "s.string()",
        path: "entry.title",
      } as const,
      expected: {
        kind: "schema-builder",
        builder: "s.string()",
        path: "entry.title",
      },
    },
    {
      label: "a JSON-schema source",
      source: {
        kind: "json-schema",
        target: "entry",
        schemaType: "object",
      } as const,
      expected: { kind: "json-schema", target: "entry", schemaType: "object" },
    },
    {
      label: "an operation source",
      source: { kind: "operation", operation: "createMany" } as const,
      expected: { kind: "operation", operation: "createMany" },
    },
  ])("clones $label", ({ source, expected }) => {
    const original = new ValidationError(source, [
      { path: "title", message: "must be a string" },
    ]);

    const failure = attachExecutionContext(original, {
      driverName: "provider",
      model: "entry",
      operation: "createMany",
    });

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).not.toBe(original);
    expect((failure as ValidationError).source).toEqual(expected);
    expect((failure as ValidationError).issues).toEqual([
      { path: "title", message: "must be a string" },
    ]);
    expect(failure.meta).toMatchObject({ driver: "provider", model: "entry" });
  });

  test("falls back to a plain clone when the source names no known kind", () => {
    const original = new ValidationError(
      { kind: "operation", operation: "createMany" },
      [{ path: "title", message: "must be a string" }]
    );
    Object.defineProperty(original, "source", {
      configurable: true,
      value: { kind: "invented-kind" },
    });

    const failure = attachExecutionContext(original, {
      driverName: "provider",
    });

    // An unrecognised source cannot be reconstructed honestly, so the clone
    // degrades to the base failure rather than inventing one.
    expect(failure).toBeInstanceOf(VibORMError);
    expect(failure).not.toBeInstanceOf(ValidationError);
    expect(failure.meta).toMatchObject({ driver: "provider" });
  });

  test("falls back when the declared operation is not a real operation", () => {
    const original = new ValidationError(
      { kind: "operation", operation: "createMany" },
      []
    );
    Object.defineProperty(original, "source", {
      configurable: true,
      value: { kind: "operation", operation: "notAnOperation" },
    });

    const failure = attachExecutionContext(original, {
      driverName: "provider",
    });

    expect(failure).not.toBeInstanceOf(ValidationError);
  });

  test("keeps only the issue entries that carry a readable path and message", () => {
    const original = new ValidationError(
      { kind: "operation", operation: "createMany" },
      [{ path: "title", message: "must be a string" }]
    );
    // A third-party Standard Schema validator owns the issue records, so the
    // clone reads them defensively rather than trusting their shape.
    const hostile = Object.defineProperty({ message: "hostile" }, "path", {
      enumerable: true,
      get() {
        throw new Error("path accessor");
      },
    });
    Object.defineProperty(original, "issues", {
      configurable: true,
      value: [
        { path: "title", message: "must be a string" },
        "not a record",
        { path: 7, message: "wrong path type" },
        { path: "body" },
        hostile,
      ],
    });

    const failure = attachExecutionContext(original, {
      driverName: "provider",
    });

    expect((failure as ValidationError).issues).toEqual([
      { path: "title", message: "must be a string" },
    ]);
  });
});

describe("execution metadata composition", () => {
  test("names the MySQL constraint when its key carries no table qualifier", () => {
    expect(
      buildMeta(
        {},
        { driverName: "mysql2" },
        "Duplicate entry 'x' for key 'unique_email'"
      )
    ).toMatchObject({ constraint: "unique_email" });
    expect(
      buildMeta(
        {},
        { driverName: "mysql2" },
        "Duplicate entry 'x' for key 'users.unique_email'"
      )
    ).toMatchObject({ constraint: "unique_email", table: "users" });
  });
});
