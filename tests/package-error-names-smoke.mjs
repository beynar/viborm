import {
  QueryError,
  ValidationError,
  VibORMError,
  VibORMErrorCode,
} from "../dist/index.mjs";

if (VibORMErrorCode.OPERATION_CLIENT_MISMATCH !== "V12003") {
  throw new Error("OPERATION_CLIENT_MISMATCH code changed");
}
if (VibORMErrorCode.OPERATION_SCOPE_MISMATCH !== "V12004") {
  throw new Error("OPERATION_SCOPE_MISMATCH code missing");
}

const cases = [
  [
    "VibORMError",
    new VibORMError("base failure", VibORMErrorCode.INTERNAL_ERROR),
  ],
  ["QueryError", new QueryError("query failure")],
  [
    "ValidationError",
    new ValidationError("create", [
      { message: "id is required", path: "data.id" },
    ]),
  ],
];

for (const [expectedName, error] of cases) {
  if (error.name !== expectedName) {
    throw new Error(`Expected runtime name ${expectedName}, got ${error.name}`);
  }
  const serializedName = error.toJSON().name;
  if (serializedName !== expectedName) {
    throw new Error(
      `Expected serialized name ${expectedName}, got ${String(serializedName)}`
    );
  }
}

console.log("packed error diagnostic names: pass");
