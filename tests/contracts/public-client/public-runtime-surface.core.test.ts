import { describe, expect, it } from "vitest";
import * as viborm from "@src/index";

const documentedRuntimeExports = [
  "AnyNull",
  "CheckConstraintError",
  "ClientInitializationError",
  "ConnectionError",
  "DbNull",
  "Decimal",
  "FeatureNotSupportedError",
  "ForeignKeyError",
  "JsonNull",
  "JsonNullSentinel",
  "NestedWriteError",
  "NotFoundError",
  "NotNullConstraintError",
  "PendingOperation",
  "QueryError",
  "SchemaValidationError",
  "Sql",
  "TransactionError",
  "UniqueConstraintError",
  "UnsupportedOperationError",
  "ValidationError",
  "ValueTooLongError",
  "VibORMError",
  "VibORMErrorCode",
  "createClient",
  "createModelFieldRefs",
  "defineExtension",
  "empty",
  "getOperationPayloadSchema",
  "getSchemas",
  "isFieldRef",
  "isJsonNullSentinel",
  "isPendingOperation",
  "isRetryableError",
  "isSchemaValidationError",
  "isSql",
  "isVibORMError",
  "join",
  "raw",
  "renderOperationResultType",
  "renderSchemaType",
  "s",
  "sql",
  "toPrismaErrorCode",
  "validateOperationPayload",
  "validateSchema",
  "validateSchemaOrThrow",
  "wrapError",
];

describe("public runtime surface", () => {
  it("exports the intentional root entry-point vocabulary", () => {
    expect(Object.keys(viborm).sort()).toEqual([...documentedRuntimeExports].sort());
  });
});
