/**
 * The options bag's exactness, at the type level.
 *
 * A misspelled option is the failure the runtime reader exists for, and the
 * compiler should catch it first. `options?: SchemaJsonOptions` does not: a bag
 * with a stray key is still assignable, leaving only excess-property checking,
 * and EPC needs a FRESH object literal. A bag held in a variable —
 * `const opts = { validate: ci }` reused across two calls — sails through,
 * which is exactly how a program that builds its options from data writes them.
 *
 * So both probes are here: a fresh literal, which EPC alone would catch, and a
 * NON-FRESH one, which only the structural instrument catches. Each typo sits
 * beside a real key, because a typo alone is refused by weak-type detection and
 * would prove nothing. The sibling file pins the fresh `parseSchema` case; this
 * one pins the non-fresh cases and both directions.
 */

import type { Schema, SchemaJsonOptions } from "@schema/json";
import { parseSchema, serializeSchema } from "@schema/json";

declare const document: object;
declare const schema: Schema;
declare const ci: boolean;

/** The bag as a TYPE still admits its one key and only its one key. */
const _bagIsExact: SchemaJsonOptions = { validate: true };
const _bagMayBeEmpty: SchemaJsonOptions = {};

/** A fresh literal at the call site, in the direction the sibling does not pin. */
const _freshTypoOnSerialize = () =>
  // @ts-expect-error - the typo is refused beside the real option
  serializeSchema(schema, { validate: true, validat: true });

/**
 * A bag a program built and held: NOT fresh, so nothing but the structural
 * instrument is watching.
 */
const held = { validate: ci, validat: ci };
const _heldTypoOnParse = () =>
  // @ts-expect-error - the typo is refused however the bag was built
  parseSchema(document, held);
const _heldTypoOnSerialize = () =>
  // @ts-expect-error - the typo is refused however the bag was built
  serializeSchema(schema, held);

/** The same bag with only real keys stays accepted, non-fresh and all. */
const legitimate = { validate: ci };
const _heldRealOption: Schema = parseSchema(document, legitimate);
const _heldRealOptionOnSerialize = serializeSchema(schema, legitimate);
const _noBagAtAll: Schema = parseSchema(document);
const _noBagOnSerialize = serializeSchema(schema);

export type {
  _bagIsExact,
  _bagMayBeEmpty,
  _freshTypoOnSerialize,
  _heldRealOption,
  _heldRealOptionOnSerialize,
  _heldTypoOnParse,
  _heldTypoOnSerialize,
  _noBagAtAll,
  _noBagOnSerialize,
};
