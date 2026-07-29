/**
 * Literal `code` discrimination on the concrete error classes (plan T1-U1).
 *
 * `VibORMError.code` is the published discriminant, but until now every subclass inherited it
 * at the WIDE `VibORMErrorCode` type, so the taxonomy existed only at runtime: a `catch` block
 * could compare `e.code` against any code at all and the compiler had nothing to say. Each
 * concrete class now RE-DECLARES `code` at the literal (or the measured family) it actually
 * carries, which turns a union of error classes into a discriminated union.
 *
 * Two things are pinned here:
 *
 * 1. **Type**: narrowing on `code` selects the class, and an exhaustive `switch` over the
 *    codes of a union bottoms out at `never`. Both are enforced by `pnpm test:types`, not by a
 *    runtime assertion — the `never` guard is a compile error the moment a code goes missing.
 * 2. **Runtime**: nothing changed. The re-declarations use `declare`, which emits no field, so
 *    the constructor's assignment still owns the property. The serialized shape and the `code`
 *    property descriptor are pinned byte-for-byte against the values measured before the
 *    change.
 */

import {
  CheckConstraintError,
  ForeignKeyError,
  NestedWriteAssertionError,
  NotNullConstraintError,
  QueryEngineError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  ValueTooLongError,
  VibORMErrorCode,
} from "@errors";

/**
 * The eight classes `normalizeDriverError` constructs, spelled here as a local union so this
 * suite pins the DISCRIMINATION independently of where the shipped union lives (T1-U2 gives
 * that union a name in `src/drivers/error-mapping.ts`).
 */
type MappedFailure =
  | CheckConstraintError
  | ForeignKeyError
  | NestedWriteAssertionError
  | NotNullConstraintError
  | QueryError
  | TransactionError
  | UniqueConstraintError
  | ValueTooLongError;

/**
 * The exhaustive switch. Every code every member can carry has an arm; the `default` binds the
 * scrutinee to `never`, so deleting one arm — or adding a code to any member's family without
 * handling it — is a COMPILE error, not a silent fallthrough. This is the W5-U2 bug class
 * (a lane built blind to a code change) turned into a type error.
 */
function classify(failure: MappedFailure): string {
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

describe("literal code discrimination", () => {
  it("narrows a union member to its class on a code comparison", () => {
    const witness = (failure: MappedFailure): string | undefined => {
      if (failure.code === VibORMErrorCode.UNIQUE_CONSTRAINT) {
        // The whole point: `failure` is a UniqueConstraintError here, not the
        // union — `expectTypeOf` fails to compile if the narrowing does not land.
        expectTypeOf(failure).toEqualTypeOf<UniqueConstraintError>();
        return failure.meta.constraint as string | undefined;
      }
      expectTypeOf(failure).not.toEqualTypeOf<UniqueConstraintError>();
      return undefined;
    };

    expect(
      witness(
        new UniqueConstraintError("Unique constraint violation", {
          meta: { constraint: "user_email_key" },
        })
      )
    ).toBe("user_email_key");
    expect(
      witness(new ForeignKeyError("Foreign key constraint violation"))
    ).toBe(undefined);
  });

  it("narrows to the classes behind the other constraint codes", () => {
    const foreignKey = (failure: MappedFailure) => {
      if (failure.code === VibORMErrorCode.FOREIGN_KEY_CONSTRAINT) {
        expectTypeOf(failure).toEqualTypeOf<ForeignKeyError>();
      }
    };
    const notNull = (failure: MappedFailure) => {
      if (failure.code === VibORMErrorCode.NOT_NULL_CONSTRAINT) {
        expectTypeOf(failure).toEqualTypeOf<NotNullConstraintError>();
      }
    };
    const tooLong = (failure: MappedFailure) => {
      if (failure.code === VibORMErrorCode.VALUE_TOO_LONG) {
        expectTypeOf(failure).toEqualTypeOf<ValueTooLongError>();
      }
    };
    for (const probe of [foreignKey, notNull, tooLong]) {
      probe(new CheckConstraintError("Check constraint violation"));
    }
    expect(true).toBe(true);
  });

  it("routes every constructed member through the exhaustive switch", () => {
    const rows: [MappedFailure, string][] = [
      [new UniqueConstraintError("u"), "unique"],
      [new ForeignKeyError("f"), "foreign-key"],
      [new NotNullConstraintError("n"), "not-null"],
      [new CheckConstraintError("c"), "check"],
      [new ValueTooLongError("v"), "value-too-long"],
      [new NestedWriteAssertionError("a"), "assertion"],
      [new TransactionError("t"), "transaction"],
      [
        new TransactionError("d", { code: VibORMErrorCode.DEADLOCK }),
        "transaction",
      ],
      [new QueryError("q"), "query"],
    ];
    for (const [failure, expected] of rows) {
      expect(classify(failure)).toBe(expected);
    }
  });

  it("keeps the engine's refusal separable from its defect", () => {
    // V8003 is the ONE place a code check alone cannot decide the class:
    // UnsupportedOperationError extends QueryEngineError, so the parent's `code`
    // is the two-member family and the subclass narrows to the refusal. The
    // class — not the code — is the discriminator here, which is exactly why
    // classifyFailure (T1-U3) branches on `instanceof`.
    const refusal = new UnsupportedOperationError("shape not expressed");
    const defect = new QueryEngineError("engine invariant broken");
    expectTypeOf(
      refusal.code
    ).toEqualTypeOf<VibORMErrorCode.UNSUPPORTED_OPERATION>();
    expect(refusal.code).toBe(VibORMErrorCode.UNSUPPORTED_OPERATION);
    expect(defect.code).toBe(VibORMErrorCode.INTERNAL_ERROR);
    expect(refusal).toBeInstanceOf(QueryEngineError);
  });
});

describe("the re-declaration changes nothing at runtime", () => {
  const serialize = (error: { toJSON(): Record<string, unknown> }) =>
    JSON.stringify({ ...error.toJSON(), timestamp: "<t>" });

  it("serializes byte-identically to the pre-change measurement", () => {
    // Both strings were captured by running this exact construction against the
    // parent commit, before any `declare readonly code` existed.
    expect(
      serialize(
        new UniqueConstraintError("Unique constraint violation", {
          meta: {
            table: "user",
            columns: ["email"],
            constraint: "user_email_key",
          },
        })
      )
    ).toBe(
      '{"name":"UniqueConstraintError","message":"Unique constraint violation","code":"V3001","prismaCode":"P2002","meta":{"columns":["email"],"constraint":"user_email_key","table":"user"},"timestamp":"<t>"}'
    );
    expect(
      serialize(
        new TransactionError("Transaction deadlock detected", {
          code: VibORMErrorCode.DEADLOCK,
          meta: { driver: "pg" },
        })
      )
    ).toBe(
      '{"name":"TransactionError","message":"Transaction deadlock detected","code":"V5003","meta":{"driver":"pg"},"timestamp":"<t>"}'
    );
  });

  it("leaves `code` an own data property the constructor assigned", () => {
    // A field declared WITHOUT `declare` would emit a class-field definition and
    // clobber the base constructor's assignment with `undefined` under
    // useDefineForClassFields (target es2022). This descriptor is the proof it
    // did not happen.
    const error = new UniqueConstraintError("Unique constraint violation");
    expect(Object.getOwnPropertyDescriptor(error, "code")).toEqual({
      value: "V3001",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getOwnPropertyNames(error).sort()).toEqual([
      "code",
      "message",
      "meta",
      "name",
      "originalCause",
      "stack",
      "timestamp",
    ]);
  });
});
