/**
 * The driver layer's failure vocabulary (plan T1-U2).
 *
 * `normalizeDriverError` builds eight precise error classes and used to erase all of them at
 * the return with `: Error`. `DriverFailure` names that union and `mapProviderError` is
 * annotated with it, so the erasure is gone and a ninth class added to the mapper without
 * being added to the union is a compile error rather than a silently widened return.
 *
 * This suite pins three things:
 *   1. the union's EXACT members (a hand-written copy, compared both directions);
 *   2. that the members are disjoint by `code`, i.e. the union is discriminated — the property
 *      that makes T1-U1's literals worth having here;
 *   3. that the mapper still produces exactly those classes at runtime, dialect by dialect.
 *
 * Arms 1 and 2 are enforced by `pnpm test:types`; arm 3 by the assertions below.
 */

import {
  ASSERTION_MARKER,
  type DriverFailure,
  normalizeDriverConnectionError,
  normalizeDriverError,
} from "@drivers/error-mapping";
import {
  CheckConstraintError,
  ConnectionError,
  ForeignKeyError,
  NestedWriteAssertionError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  ValueTooLongError,
  VibORMErrorCode,
} from "@errors";

/**
 * The union, written out by hand. `toEqualTypeOf` compares both directions, so this fails if
 * the shipped union gains a member, loses one, or swaps one out.
 */
type ExpectedDriverFailure =
  | CheckConstraintError
  | ForeignKeyError
  | NestedWriteAssertionError
  | NotNullConstraintError
  | QueryError
  | TransactionError
  | UniqueConstraintError
  | ValueTooLongError;

/**
 * The discrimination proof: every code every member can carry gets an arm, and the `default`
 * binds the scrutinee to `never`. If two members ever shared a code the narrowing would leave
 * a residue here and the guard would go red.
 */
function familyOf(failure: DriverFailure): string {
  switch (failure.code) {
    case VibORMErrorCode.UNIQUE_CONSTRAINT:
      return "unique";
    case VibORMErrorCode.FOREIGN_KEY_CONSTRAINT:
      return "foreign-key";
    case VibORMErrorCode.NOT_NULL_CONSTRAINT:
      return "not-null";
    case VibORMErrorCode.CHECK_CONSTRAINT:
      return "check";
    case VibORMErrorCode.VALUE_TOO_LONG:
      return "value-too-long";
    case VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED:
      return "assertion";
    case VibORMErrorCode.TRANSACTION_FAILED:
    case VibORMErrorCode.TRANSACTION_TIMEOUT:
    case VibORMErrorCode.DEADLOCK:
    case VibORMErrorCode.SERIALIZATION_FAILURE:
    case VibORMErrorCode.INVALID_TRANSACTION_INPUT:
      return "transaction";
    case VibORMErrorCode.QUERY_FAILED:
    case VibORMErrorCode.QUERY_TIMEOUT:
    case VibORMErrorCode.QUERY_SYNTAX:
    case VibORMErrorCode.INVALID_INPUT:
      return "query";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

const providerError = (shape: Record<string, unknown>, message = "boom") =>
  Object.assign(new Error(message), shape);

/**
 * The union's members as VALUES. Narrowing through this — rather than asserting the type —
 * keeps the suite cast-free and doubles as the runtime half of the claim: whatever the mapper
 * returns really is one of the eight, or the assertion throws with the class that turned up.
 */
const DRIVER_FAILURE_CLASSES = [
  CheckConstraintError,
  ForeignKeyError,
  NestedWriteAssertionError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  ValueTooLongError,
] as const;

function assertDriverFailure(error: unknown): DriverFailure {
  for (const candidate of DRIVER_FAILURE_CLASSES) {
    if (error instanceof candidate) return error;
  }
  throw new Error(`expected a DriverFailure, got ${String(error)}`);
}

describe("DriverFailure", () => {
  it("has exactly the eight members the mapper constructs", () => {
    expectTypeOf<DriverFailure>().toEqualTypeOf<ExpectedDriverFailure>();
    expect(true).toBe(true);
  });

  it("narrows to a single class on a code comparison", () => {
    const constraintOf = (failure: DriverFailure) => {
      if (failure.code === VibORMErrorCode.UNIQUE_CONSTRAINT) {
        expectTypeOf(failure).toEqualTypeOf<UniqueConstraintError>();
        return failure.meta.constraint;
      }
      return undefined;
    };
    const mapped = normalizeDriverError(
      providerError({ code: "23505", constraint: "user_email_key" }),
      { driverName: "pg" }
    );
    expect(mapped).toBeInstanceOf(UniqueConstraintError);
    expect(constraintOf(assertDriverFailure(mapped))).toBe("user_email_key");
  });
});

describe("the mapper still builds exactly those classes", () => {
  const rows: Array<{
    label: string;
    raw: Error;
    context?: { query?: string };
    expected: new (...args: never[]) => Error;
    family: string;
  }> = [
    {
      label: "postgres unique 23505",
      raw: providerError({ code: "23505" }),
      expected: UniqueConstraintError,
      family: "unique",
    },
    {
      label: "postgres foreign key 23503",
      raw: providerError({ code: "23503" }),
      expected: ForeignKeyError,
      family: "foreign-key",
    },
    {
      label: "postgres not-null 23502",
      raw: providerError({ code: "23502" }),
      expected: NotNullConstraintError,
      family: "not-null",
    },
    {
      label: "postgres check 23514",
      raw: providerError({ code: "23514" }),
      expected: CheckConstraintError,
      family: "check",
    },
    {
      label: "postgres value-too-long 22001",
      raw: providerError({ code: "22001" }),
      expected: ValueTooLongError,
      family: "value-too-long",
    },
    {
      label: "postgres serialization 40001",
      raw: providerError({ code: "40001" }),
      expected: TransactionError,
      family: "transaction",
    },
    {
      label: "mysql deadlock 1213",
      raw: providerError({ errno: 1213 }),
      expected: TransactionError,
      family: "transaction",
    },
    {
      label: "sqlite busy",
      raw: providerError({ code: "SQLITE_BUSY" }),
      expected: TransactionError,
      family: "transaction",
    },
    {
      label: "sqlite unique via message",
      raw: providerError({}, "UNIQUE constraint failed: user.email"),
      expected: UniqueConstraintError,
      family: "unique",
    },
    {
      label: "batch assertion",
      raw: providerError({ code: "22012" }, "division by zero"),
      context: { query: `SELECT 1 AS ${ASSERTION_MARKER}` },
      expected: NestedWriteAssertionError,
      family: "assertion",
    },
    {
      label: "unrecognised provider error",
      raw: providerError({ code: "42P01" }),
      expected: QueryError,
      family: "query",
    },
  ];

  for (const row of rows) {
    it(`maps ${row.label}`, () => {
      const mapped = normalizeDriverError(row.raw, {
        driverName: "probe",
        ...row.context,
      });
      expect(mapped).toBeInstanceOf(row.expected);
      expect(familyOf(assertDriverFailure(mapped))).toBe(row.family);
    });
  }

  it("keeps the connection variant on its own class", () => {
    const mapped = normalizeDriverConnectionError(
      providerError({ code: "ECONNREFUSED" }),
      { driverName: "probe" }
    );
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.code).toBe(VibORMErrorCode.CONNECTION_FAILED);
  });
});
