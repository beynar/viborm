import { s } from "@src/schema";
import {
  isSchemaValidationError,
  SchemaValidationError,
  type SchemaValidationIssue,
  type ValidationResult,
  validateSchema,
} from "@src/index";

const schema = { user: s.model({ id: s.string().id() }) };
const validationResult: ValidationResult = validateSchema(schema);

const errorCount: number = validationResult.errors.length;
const warningCount: number = validationResult.warnings.length;
const firstIssue: SchemaValidationIssue | undefined =
  validationResult.errors[0];

declare const caught: unknown;
if (isSchemaValidationError(caught)) {
  const typedError: SchemaValidationError = caught;
  const code: "V4002" = typedError.code;
  const issues: readonly SchemaValidationIssue[] = typedError.issues;
  void code;
  void issues;
}

void errorCount;
void warningCount;
void firstIssue;
