/**
 * JSON-defined schemas — `viborm/schema/json`.
 *
 * A document is read through the SAME public builders a human calls, so what
 * comes back is a real schema: `createClient`, `push` and the query engine
 * consume it unchanged and emit their existing diagnostics. There is no second
 * schema representation and nothing to keep in sync.
 *
 * ```ts
 * import { parseSchema, serializeSchema } from "viborm/schema/json";
 *
 * const schema = parseSchema(document);        // JSON text OR a plain object
 * const db = createClient({ schema, driver }); // an UntypedClient
 * const back = serializeSchema(schema);        // the reverse direction
 * ```
 *
 * The canonical form of a document IS `serializeSchema(parseSchema(doc))`:
 * running the pair once normalizes every builder coupling, so two documents can
 * be compared by comparing their canonical forms.
 *
 * Distinct from `viborm/validation`'s `json-schema`, which converts VALIDATION
 * schemas to Draft-07 / OpenAPI documents.
 */

import type { VibORMClient, VibORMConfig } from "@client/client";
import type { Schema } from "@schema/hydration";
import type { FieldSchemaMap } from "./interpret";
import { interpret } from "./interpret";
import { readDocument } from "./read";
import { serializeSchema } from "./serialize";
import type { ExactSchemaJsonOptions, SchemaJsonOptions } from "./validate";
import { readValidateOption, validateGraph } from "./validate";

/** The schema container every client takes: model key → model. */
export type { Schema } from "@schema/hydration";
export type {
  CompoundKeyDocument,
  EnumDocument,
  FieldDocument,
  GenerateDocument,
  IndexDocument,
  JunctionDocument,
  ModelDocument,
  RelationFieldDocument,
  ScalarFieldDocument,
  SchemaDocument,
  VariantJunctionDocument,
} from "./document";
export { SCHEMA_DOCUMENT_VERSION } from "./document";
export type { FieldSchemaMap } from "./interpret";
export type { DocumentIssueCode } from "./issues";
export { serializeSchema } from "./serialize";
export type { ExactSchemaJsonOptions, SchemaJsonOptions } from "./validate";

/**
 * Read a schema from a document, given as JSON text or a plain object.
 *
 * Every shape issue in the artifact is collected and thrown as ONE
 * `ValidationError` (V4002) whose issues carry JSON pointers into the document
 * and a `J0xx` code. Semantic refusals stay with the builders and arrive with
 * the pointer of the node that caused them.
 *
 * Each call produces a FRESH object graph. Models, scalars and relation
 * terminals are never reused across calls: write-once model naming and the
 * per-terminal target once-cell both punish a shared declaration.
 *
 * `{ validate: true }` additionally runs the schema validator — the same full
 * rule list `push` and the CLI run — over the schema that was built, AFTER
 * interpretation, so a document whose SHAPE is fine but whose GRAPH is not fails
 * here instead of at `createClient`. It reports in the validator's own
 * vocabulary: a `SchemaValidationError` carrying `M0xx`/`R0xx`/`P0xx` issues,
 * never a `J0xx` code, which describes the artifact and not the graph.
 *
 * Validating hydrates: the models are name-bound write-once under the keys the
 * DOCUMENT gave them, and relation targets settle. Both are idempotent for the
 * `createClient` that follows with this same schema record — it binds the same
 * keys to the same objects — so the only call this forecloses is one that would
 * have re-keyed a parsed schema before constructing a client.
 */
export function parseSchema<
  Options extends SchemaJsonOptions = SchemaJsonOptions,
>(input: string | object, options?: ExactSchemaJsonOptions<Options>): Schema {
  const validate = readValidateOption(options);
  const schema = interpret(readDocument(input));
  if (validate) validateGraph(schema);
  return schema;
}

/**
 * Re-read a schema with Standard Schema validators attached per field, keyed
 * `"<model>.<field>"`.
 *
 * `.schema()` takes arbitrary code, so it has no document spelling. This is the
 * hybrid escape hatch: the schema is stated as a document and read again with
 * the validators applied by the one owner that can apply them LAST — after
 * `.nullable()` and `.array()` have finished rebuilding each base. The result
 * is a new graph, and anything the document cannot carry is refused by name
 * rather than dropped.
 */
export function attachFieldSchemas(
  schema: Schema,
  fieldSchemas: FieldSchemaMap
): Schema {
  return interpret(readDocument(serializeSchema(schema)), fieldSchemas);
}

/**
 * The client a schema with non-literal model keys produces.
 *
 * It is honest, not accidental. Model access is stringly — any name
 * type-checks, and an unknown one is refused at runtime — while the operation
 * set stays exact. Arguments and results degrade to `any` rather than `never`,
 * so nothing type-level crashes and nothing static refuses a bad payload; the
 * runtime validators built from the real schema state do all the refusing.
 */
export type UntypedClient = VibORMClient<VibORMConfig>;
