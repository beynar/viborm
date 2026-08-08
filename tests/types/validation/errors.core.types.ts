import { ValidationError, type ValidationErrorSource } from "@src/index";

const operationError = new ValidationError("findMany", []);
const operation: string | undefined = operationError.operation;
const source: ValidationErrorSource = operationError.source;

if (source.kind === "operation") {
  const operationName: string = source.operation;
  void operationName;
}

const registryError = new ValidationError(
  { kind: "registry", property: "missing" },
  [{ path: "missing", message: "missing does not exist" }]
);

const absentOperation: string | undefined = registryError.operation;

// @ts-expect-error - operation is optional for non-operation validation sources
const requiredOperation: string = registryError.operation;

void operation;
void absentOperation;
void requiredOperation;
