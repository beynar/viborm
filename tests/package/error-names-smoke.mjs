import {
  ClientInitializationError,
  QueryError,
  ValidationError,
  ValueTooLongError,
  VibORMError,
  VibORMErrorCode,
} from "../../dist/index.mjs";

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
  ["ValueTooLongError", new ValueTooLongError("value too long")],
  [
    "ClientInitializationError",
    new ClientInitializationError("driver is required"),
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

// Prisma-code compatibility has to survive bundling too: a `catch` written for Prisma reads
// error.prismaCode off the packed build, and the serialized form carries it alongside `code`.
const prismaCases = [
  ["ValueTooLongError", new ValueTooLongError("value too long"), "P2000"],
  [
    "ClientInitializationError",
    new ClientInitializationError("driver is required"),
    "P1012",
  ],
  ["QueryError", new QueryError("query failure"), undefined],
];

for (const [label, error, expected] of prismaCases) {
  if (error.prismaCode !== expected) {
    throw new Error(
      `Expected ${label}.prismaCode ${String(expected)}, got ${String(error.prismaCode)}`
    );
  }
  const serialized = error.toJSON().prismaCode;
  if (serialized !== expected) {
    throw new Error(
      `Expected serialized ${label}.prismaCode ${String(expected)}, got ${String(serialized)}`
    );
  }
}

console.log("packed error diagnostic names: pass");
