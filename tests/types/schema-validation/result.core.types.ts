import {
  isSchemaValidationError,
  type SchemaValidationError,
  type SchemaValidationIssue,
  type ValidationResult,
  validateSchema,
  validateSchemaOrThrow,
} from "@src/index";
import { s } from "@src/schema";

const schema = { user: s.model({ id: s.string().id() }) };
const validationResult: ValidationResult = validateSchema(schema);
const _throwResult: void = validateSchemaOrThrow(schema);

// @ts-expect-error - public validation does not accept custom rules
validateSchema(schema, []);
// @ts-expect-error - public throwing validation does not accept custom rules
validateSchemaOrThrow(schema, []);

const _errorCount: number = validationResult.errors.length;
const _warningCount: number = validationResult.warnings.length;
const _firstIssue: SchemaValidationIssue | undefined =
  validationResult.errors[0];

declare const caught: unknown;
if (isSchemaValidationError(caught)) {
  const typedError: SchemaValidationError = caught;
  const _code: "V4002" = typedError.code;
  const _issues: readonly SchemaValidationIssue[] = typedError.issues;
}
