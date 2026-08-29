/**
 * What a JSON-defined schema costs at the type level, MEASURED.
 *
 * `parseSchema` returns `Record<string, Model<any>>`, so a client built from it
 * cannot know model names, argument shapes or result shapes. This file is the
 * honest statement of what is actually left — which is NOT simply "everything
 * becomes `any`". Four facts were measured here, and each is pinned so it
 * cannot silently become something else:
 *
 *  1. model access is stringly AND possibly-undefined (`noUncheckedIndexedAccess`
 *     applies to the index signature a loose schema produces), so a caller
 *     writes `client.user?.findMany(...)`;
 *  2. the operation set stays EXACT;
 *  3. clause keys are NOT permissive. A `Model<any>` resolves its where/select
 *     shapes against a model with no known fields, so an unknown clause key is
 *     REFUSED rather than waved through, and `NoExtraOperationKeys` still bites;
 *  4. results collapse to an empty row rather than to `any`, and a field read
 *     off one is refused.
 *
 * Facts 1, 3 and 4 correct the plan's §5 prediction of `any` arguments and
 * results. Nothing here answers `never` and nothing crashes the compiler, which
 * was the load-bearing half of that claim.
 *
 * Every probe enters through the public API, spelled exactly as a caller spells
 * it. Where a typo is probed it sits BESIDE A REAL KEY — a typo alone is
 * refused by weak-type detection and would prove nothing.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import {
  attachFieldSchemas,
  parseSchema,
  type Schema,
  type SchemaDocument,
  serializeSchema,
  type UntypedClient,
} from "@schema/json";

declare const driver: AnyDriver;

const document = {
  version: 1,
  models: {
    user: {
      fields: {
        id: { type: "string", id: true },
        email: { type: "string", unique: true },
      },
    },
  },
};

// The parser's return type IS the loose schema container the client takes.
const parsed = parseSchema(document);
const _isSchema: Schema = parsed;

// A document object literal is assignable to the published format type, so an
// agent can generate against it, and `serializeSchema` answers the same type.
const _typedDocument: SchemaDocument = {
  version: 1,
  models: { user: { fields: { id: { type: "string", id: true } } } },
};
const _roundTripped: SchemaDocument = serializeSchema(parsed);

// The approximate-number scalar has ONE spelling in the format, and the
// published type is where a generator meets it first — before the reader ever
// runs. `"number"` is a scalar type; the retired `"float"` token is not.
const _numberFieldIsADocument: SchemaDocument = {
  version: 1,
  models: {
    reading: {
      fields: {
        id: { type: "string", id: true },
        value: { type: "number", default: 1.5 },
      },
    },
  },
};
const _floatFieldIsNotADocument = (): SchemaDocument => ({
  version: 1,
  models: {
    reading: {
      fields: {
        id: { type: "string", id: true },
        // @ts-expect-error - the retired `float` token is not a scalar type
        value: { type: "float", default: 1.5 },
      },
    },
  },
});

const _decimalNeedsItsDomain = (): SchemaDocument => ({
  version: 1,
  models: {
    reading: {
      fields: {
        // @ts-expect-error - a decimal document declares both domain bounds
        value: { type: "decimal" },
      },
    },
  },
});

const _decimalHasNoNativeOverride = (): SchemaDocument => ({
  version: 1,
  models: {
    reading: {
      fields: {
        value: {
          type: "decimal",
          precision: 10,
          scale: 2,
          // @ts-expect-error - fixed-decimal storage is derived from its domain
          native: { db: "pg", type: "text" },
        },
      },
    },
  },
});

const _nonDecimalHasNoDecimalDomain = (): SchemaDocument => ({
  version: 1,
  models: {
    reading: {
      fields: {
        value: {
          type: "string",
          // @ts-expect-error - precision belongs only to decimal
          precision: 10,
          // @ts-expect-error - scale belongs only to decimal
          scale: 2,
        },
      },
    },
  },
});
const _attached: Schema = attachFieldSchemas(parsed, {});

// Both entry points take the same options bag, and both answer the same type
// with it as without it — `validate` changes WHEN a schema is refused, never
// what a successful call returns.
const _validatedSchema: Schema = parseSchema(document, { validate: true });
const _validatedDocument: SchemaDocument = serializeSchema(parsed, {
  validate: false,
});
const _optionTypoBesideReal = () =>
  // @ts-expect-error - `validat` is not an option, beside the real one
  parseSchema(document, { validate: true, validat: true });
const _optionIsBoolean = () =>
  // @ts-expect-error - `validate` is a boolean, not a truthy string
  serializeSchema(parsed, { validate: "true" });

const client = createClient({ schema: parsed, driver });

// `UntypedClient` is the NAMED surface for exactly this client.
const _named: UntypedClient = client;

// (1) Model access is stringly — any name type-checks — and each entry is
// possibly-undefined, because the loose schema is an index signature.
const _anyModelName = client.thisModelDoesNotExist?.findMany;
const _presenceIsNotAssumed = () => {
  // @ts-expect-error - an index-signature model entry is possibly undefined
  return client.user.findMany;
};

// (2) The operation set stays EXACT: the last piece of real typing left.
const _realOperation = client.user?.findMany;
const _typoBesideReal = {
  findMany: client.user?.findMany,
  // @ts-expect-error - `findMani` is not an operation, beside a real one
  findMani: client.user?.findMani,
};

// (3) Clause keys are still refused. A model with no known fields publishes no
// field clauses, so an unknown one is a type error beside the real `AND`.
const _clauseKeyBesideReal = () =>
  client.user?.findMany({
    // @ts-expect-error - a loose model publishes no `where` field keys
    where: { AND: [], anything: "at all" },
  });
const _operationKeyBesideReal = () =>
  client.user?.findMany({
    where: {},
    // @ts-expect-error - `NoExtraOperationKeys` still bites on a loose schema
    notAnOperationKey: true,
  });

// (4) Results collapse to an empty row: `null` is assignable, `{}` is
// assignable, and reading a field off one is refused.
type LooseRow = Awaited<
  ReturnType<NonNullable<typeof client.user>["findFirst"]>
>;
const _rowMayBeNull: LooseRow = null;
const _rowIsNotNever: LooseRow = {};
declare const row: NonNullable<LooseRow>;
const _fieldRead = () => {
  // @ts-expect-error - a loose row publishes no fields to read
  return row.email;
};

export type {
  _anyModelName,
  _attached,
  _clauseKeyBesideReal,
  _fieldRead,
  _isSchema,
  _named,
  _operationKeyBesideReal,
  _optionIsBoolean,
  _optionTypoBesideReal,
  _presenceIsNotAssumed,
  _realOperation,
  _roundTripped,
  _rowIsNotNever,
  _rowMayBeNull,
  _typedDocument,
  _typoBesideReal,
  _validatedDocument,
  _validatedSchema,
};
