/**
 * The TYPE half of `.updatedAt()` update admission (#54), per field.
 *
 * A non-list `.updatedAt()` field keeps its kind's `base`, `create` and
 * `filter` schemas, and its `update` schema is the kind's own update language
 * plus omission: input `| undefined`, output unchanged. A list keeps the plain
 * record, and `.now()` still has no update schema at all. `UpdateAdmission` in
 * `src/validation/scalars/index.ts` computes this without relating each update
 * schema to `VibSchema`; these probes hold the record it must produce.
 *
 * Runtime twin: `tests/unit/operation-schemas/update/updated-at.core.test.ts`.
 */

import { s } from "@schema";
import type { InferInput, InferOutput } from "@validation";
import type { GetScalarsSchemas } from "@validation/scalars";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const stamped = s.model({
  id: s.string().id(),
  touchedAt: s.dateTime().updatedAt(),
  touchedOn: s.date().nullable().updatedAt(),
  touchedTime: s.time().updatedAt(),
  plainAt: s.dateTime(),
  plainOn: s.date().nullable(),
  plainTime: s.time(),
  history: s.dateTime().array().updatedAt(),
  plainHistory: s.dateTime().array(),
  createdAt: s.dateTime().now(),
});

type Scalars = GetScalarsSchemas<typeof stamped>;

/** One member of a field's schema record. */
type Part<
  Field extends keyof Scalars,
  Member extends "base" | "update" | "filter",
> = Scalars[Field] extends { readonly [Key in Member]: infer Schema }
  ? Schema
  : never;

/** `Stamped` refreshes on update exactly as `Plain` would be written. */
type RefreshesLike<
  Stamped extends keyof Scalars,
  Plain extends keyof Scalars,
> = [
  Equal<Part<Stamped, "base">, Part<Plain, "base">>,
  Equal<
    InferInput<Part<Stamped, "update">>,
    InferInput<Part<Plain, "update">> | undefined
  >,
  Equal<
    InferOutput<Part<Stamped, "update">>,
    InferOutput<Part<Plain, "update">>
  >,
  Equal<Part<Stamped, "filter">, Part<Plain, "filter">>,
] extends [true, true, true, true]
  ? true
  : false;

type _dateTimeRefreshes = Expect<RefreshesLike<"touchedAt", "plainAt">>;
type _nullableDateRefreshes = Expect<RefreshesLike<"touchedOn", "plainOn">>;
type _timeRefreshes = Expect<RefreshesLike<"touchedTime", "plainTime">>;

// The omission arm is really there: a plain update input has no `undefined`.
type _plainUpdateRefusesOmission = Expect<
  Equal<
    undefined extends InferInput<Scalars["plainAt"]["update"]> ? true : false,
    false
  >
>;

// A list `.updatedAt()` field keeps the plain update language.
type _listKeepsPlainUpdate = Expect<
  Equal<
    InferInput<Scalars["history"]["update"]>,
    InferInput<Scalars["plainHistory"]["update"]>
  >
>;

// `.now()` stays insert-only.
type _nowHasNoUpdate = Expect<Equal<Scalars["createdAt"]["update"], undefined>>;
