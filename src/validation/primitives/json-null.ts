// JSON null sentinel operand schemas
// Admits `DbNull` / `JsonNull` / `AnyNull` into the exact JSON slots that can
// mean something by them, and refuses them everywhere else BY NAME.

import {
  type AnyJsonNullSentinel,
  isJsonNullSentinel,
  type JsonNullKind,
  type JsonNullSentinel,
} from "@schema/json-null";
import type { InferInput, InferOutput, VibSchema } from "../types";
import { createSchema, fail, ok, validateSchema } from "./helpers";

/**
 * Why this is a brand-discriminated wrapper and not `v.union([...])`: a union
 * rewrites every existing operand failure into "Value did not match any union
 * member: …". Here the brand is the discriminator, so a non-sentinel value is
 * handed straight to the wrapped schema and keeps its exact message, and a
 * sentinel gets a sentinel-specific one. Same reasoning as
 * {@link file://./field-ref.ts}.
 */
export interface JsonNullOrSchema<
  TAllowed extends JsonNullKind,
  TSchema extends VibSchema<any, any>,
> extends VibSchema<
    InferInput<TSchema> | JsonNullSentinel<TAllowed>,
    InferOutput<TSchema> | JsonNullSentinel<TAllowed>
  > {
  readonly type: "json_null_or";
  /** The sentinel kinds this slot accepts. */
  readonly allowed: readonly JsonNullKind[];
  /** The operand schema this wraps. */
  readonly wrapped: TSchema;
  /** Mirrors the wrapped schema, for the object validator's absent-key path. */
  readonly acceptsUndefined: boolean;
}

/**
 * A JSON WRITE slot: the sentinels it accepts, the whole JSON document
 * language, and — deliberately — NOT a bare `null`.
 *
 * `null` is excluded from the INPUT type as well as refused at runtime, which
 * is Prisma's rule: its `InputJsonValue` documents that `null` is disallowed at
 * the top level of a JSON write because its meaning would be ambiguous, and
 * directs callers to `Prisma.JsonNull` / `Prisma.DbNull`
 * (`@prisma/client`, `runtime/client.d.ts`, the `InputJsonValue` doc comment;
 * https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-json-fields#using-null-values).
 * `null` is only excluded at the TOP level — `{ a: null }` is an ordinary
 * document and stays legal, exactly as in Prisma.
 */
export interface JsonWriteSchema<
  TAllowed extends JsonNullKind,
  TSchema extends VibSchema<any, any>,
> extends VibSchema<
    Exclude<InferInput<TSchema>, null> | JsonNullSentinel<TAllowed>,
    InferOutput<TSchema> | JsonNullSentinel<TAllowed>
  > {
  readonly type: "json_write";
  readonly allowed: readonly JsonNullKind[];
  readonly wrapped: TSchema;
  readonly acceptsUndefined: boolean;
}

const ALL_KINDS: readonly JsonNullKind[] = ["DbNull", "JsonNull", "AnyNull"];

/** `DbNull, JsonNull or AnyNull` — for the refusal messages. */
function listKinds(kinds: readonly JsonNullKind[]): string {
  if (kinds.length === 1) return kinds[0] as string;
  return `${kinds.slice(0, -1).join(", ")} or ${kinds.at(-1)}`;
}

/**
 * The refusal a disallowed sentinel gets. It names the token the caller used
 * and the ones this slot would have accepted, because the whole point of the
 * sentinels is that "null" alone never says enough.
 */
function refuseSentinel(
  sentinel: AnyJsonNullSentinel,
  allowed: readonly JsonNullKind[],
  where: string
) {
  const rejected = ALL_KINDS.filter((kind) => !allowed.includes(kind));
  const reason =
    rejected.length === ALL_KINDS.length
      ? `JSON null sentinels are not supported in ${where}`
      : `${sentinel.kind} is not supported in ${where}; that slot accepts ${listKinds(allowed)}`;
  return fail(`${reason}.`);
}

function checkSentinel(
  value: AnyJsonNullSentinel,
  allowed: readonly JsonNullKind[],
  where: string
) {
  return allowed.includes(value.kind)
    ? ok(value)
    : refuseSentinel(value, allowed, where);
}

function copyOptionality(
  schema: object,
  wrapped: VibSchema<any, any>,
  allowed: readonly JsonNullKind[]
): void {
  (schema as { allowed: readonly JsonNullKind[] }).allowed = allowed;
  (schema as { wrapped: VibSchema<any, any> }).wrapped = wrapped;
  (schema as { acceptsUndefined: boolean }).acceptsUndefined =
    (wrapped as { acceptsUndefined?: boolean }).acceptsUndefined === true;
}

/**
 * A JSON FILTER operand that also accepts the sentinels in `allowed`.
 *
 * A bare `null` is NOT intercepted here: it keeps whatever the wrapped operand
 * already meant (at the document root, "the column IS NULL"; under a `path`,
 * "the value at that path is the JSON null"). That behavior predates the
 * sentinels and stays pinned — see the regression witnesses in
 * `tests/drivers/json-null-sentinel-behavior.ts`.
 */
export function jsonNullOr<
  TAllowed extends JsonNullKind,
  TSchema extends VibSchema<any, any>,
>(
  allowed: readonly TAllowed[],
  wrapped: TSchema,
  where: string
): JsonNullOrSchema<TAllowed, TSchema> {
  const schema = createSchema<
    InferInput<TSchema> | JsonNullSentinel<TAllowed>,
    InferOutput<TSchema> | JsonNullSentinel<TAllowed>
  >("json_null_or", (value) => {
    if (isJsonNullSentinel(value)) {
      return checkSentinel(value, allowed, where) as never;
    }
    return validateSchema(wrapped, value) as never;
  }) as JsonNullOrSchema<TAllowed, TSchema>;

  copyOptionality(schema, wrapped, allowed);
  return schema;
}

/**
 * A JSON WRITE slot: sentinels in `allowed`, any JSON document, no bare `null`.
 *
 * The bare-`null` refusal is the reason this is not just `jsonNullOr`. See
 * {@link JsonWriteSchema} for the rule and its citation.
 *
 * An OMITTED key is untouched: `undefined` falls through to the wrapped schema,
 * which applies the field's own default — for a nullable JSON field that
 * default is the database NULL, which is exactly what `DbNull` names. Only a
 * `null` the CALLER spelled is ambiguous, and only that one is refused.
 */
export function jsonWrite<
  TAllowed extends JsonNullKind,
  TSchema extends VibSchema<any, any>,
>(
  allowed: readonly TAllowed[],
  wrapped: TSchema,
  where: string,
  nullRefusal: string
): JsonWriteSchema<TAllowed, TSchema> {
  const schema = createSchema<
    Exclude<InferInput<TSchema>, null> | JsonNullSentinel<TAllowed>,
    InferOutput<TSchema> | JsonNullSentinel<TAllowed>
  >("json_write", (value) => {
    if (isJsonNullSentinel(value)) {
      return checkSentinel(value, allowed, where) as never;
    }
    if (value === null) return fail(nullRefusal) as never;
    return validateSchema(wrapped, value) as never;
  }) as JsonWriteSchema<TAllowed, TSchema>;

  copyOptionality(schema, wrapped, allowed);
  return schema;
}
