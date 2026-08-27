// The `validate` option: how a call states it, and who it hands the schema to.
//
// The option is NOT part of the document — nothing about it describes a schema —
// so it is read at the CALL boundary rather than by the document reader, and its
// pointers name the options argument (`/options/...`) rather than a location in
// the author's artifact. It gets the same discipline the document gets, down to
// the guarded accessor: a program that builds its options from data can build
// them from a getter, and a bag is no more the caller's own literal than a
// document handed in as an object is.
//
// What `validate: true` RUNS is deliberately not written here.
// `validateSchemaOrThrow` is the schema validator every effect-capable boundary
// already runs — `push`, the CLI — and this option is a second CALLER of it,
// never a second copy: the whole rule list, its `M0xx`/`R0xx`/`P0xx` codes and
// its `SchemaValidationError` all arrive unfiltered and untranslated. The `J0xx`
// family stays what it has always been, a vocabulary for the shape of the
// ARTIFACT; a graph is refused in the graph's own words.

import { hydrateSchemaNames, type Schema } from "@schema/hydration";
import { validateSchemaOrThrow } from "@schema/validation/validator";
import {
  addIssue,
  type DocumentIssues,
  documentRoot,
  inspectKeys,
  inspectPlainRecord,
  member,
  pointer,
  refuseDocument,
  throwIfRefused,
} from "./issues";

/**
 * What a call may ask for beyond the conversion itself.
 *
 * `validate` runs the schema validator over the schema — the same full rule list
 * `push` and the CLI run, reporting in its own vocabulary. It defaults to
 * `false`: a document is legitimately read for inspection, canonicalization or
 * diffing without ever becoming a client, and a schema is legitimately dumped
 * for diagnosis while it is still broken.
 */
export type SchemaJsonOptions = {
  validate?: boolean;
};

/**
 * An options bag that carries this call's own keys and NOTHING else.
 *
 * `options?: SchemaJsonOptions` is no guard on its own: a bag with a stray key
 * is still assignable, and only excess-property checking stands between the
 * caller and a silent no-op — which needs a FRESH object literal. A bag built
 * from data and held in a variable, which is how a program actually writes one,
 * sails through. Demanding `never` for the unknown keys refuses structurally,
 * whatever the argument's freshness. Same instrument as the model builder's
 * `ExactOptions` and `push`'s `ExactPushOptions`.
 *
 * The runtime reader below stays: a caller in JavaScript, or one who built the
 * bag through `JSON.parse`, never met the compiler at all.
 */
export type ExactSchemaJsonOptions<Given> = Given &
  Record<Exclude<keyof Given, keyof SchemaJsonOptions>, never>;

const OPTION_KEYS = ["validate"];
const DECLARED_OPTIONS = OPTION_KEYS.map((key) => `'${key}'`).join(", ");

/** The options argument's own pointer root; no document node is spelled `options`. */
const OPTIONS_ROOT = pointer(documentRoot, "options");

/**
 * Read the options argument, refusing anything this call does not declare.
 *
 * A misspelled option is the failure this owner exists for: `{ validat: true }`
 * would otherwise be a silent no-op, and a call that asked for validation and
 * did not get it is the one outcome worse than not asking. A non-boolean
 * `validate` is the same failure spelled by a program that built its options
 * from data — `"true"` is not `true`.
 */
export function readValidateOption(
  options: SchemaJsonOptions | undefined
): boolean {
  if (options === undefined) return false;
  const issues: DocumentIssues = [];
  if (!inspectPlainRecord(options, OPTIONS_ROOT, issues, "J004")) {
    addIssue(issues, OPTIONS_ROOT, "J004", "`options` must be a plain object");
    throw refuseDocument(issues);
  }
  // The options bag TOLERATES own-`undefined` (the document does not): the loop
  // below reads `validate` and treats `undefined` as absent, because
  // `validate?: boolean` admits it by the TS optional-property idiom.
  for (const key of inspectKeys(options, OPTIONS_ROOT, issues, "J004")) {
    if (OPTION_KEYS.includes(key)) continue;
    addIssue(
      issues,
      pointer(OPTIONS_ROOT, key),
      "J003",
      `Unknown option '${key}'; this call declares ${DECLARED_OPTIONS}`
    );
  }
  const validate = member(options, "validate", OPTIONS_ROOT, issues);
  if (validate !== undefined && typeof validate !== "boolean") {
    addIssue(
      issues,
      pointer(OPTIONS_ROOT, "validate"),
      "J004",
      "`validate` must be a boolean"
    );
  }
  throwIfRefused(issues);
  return validate === true;
}

/**
 * The two ordered phases of the definition pipeline, at this boundary as at
 * every other: hydration binds names and proves model identity, then the
 * validator resolves the relation graph and runs the rule list over it.
 *
 * Both phases WRITE to the schema — write-once name binding, and the per-terminal
 * target once-cell — which is why the option that reaches them is off by
 * default.
 */
export function validateGraph(schema: Schema): void {
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
}
