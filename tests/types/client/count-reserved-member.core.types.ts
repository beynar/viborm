/**
 * `_count` in a selection is the relation-count projection only.
 *
 * Schema validation refuses a member named `_count` (F010), so the select
 * input's `_count` is the count shorthand or the count object and never a
 * scalar boolean, and the result's `_count` is the counts object, never
 * intersected with a scalar. A scalar mapped to the `_count` COLUMN keeps its
 * own member name on both sides. Runtime and refusal pins:
 * `tests/contracts/public-client/count-reserved-member.core.test.ts`.
 */

import type { OperationPayload, OperationResult } from "@client/types";
import { s } from "@schema";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const ledger = s.model({
  id: s.string().id(),
  tally: s.int().map("_count"),
  entries: s.toMany(() => entry),
});
const entry = s.model({
  id: s.string().id(),
  ledgerId: s.string(),
  ledger: s
    .toOne(() => ledger)
    .fields("ledgerId")
    .references("id"),
});

type SelectOf<Payload> = Payload extends unknown
  ? "select" extends keyof Payload
    ? NonNullable<Payload["select"]>
    : never
  : never;
type LedgerSelect = SelectOf<OperationPayload<"findMany", typeof ledger>>;
type SelectCount = NonNullable<LedgerSelect["_count"]>;

// The input: the shorthand `true`, or an object that names relations.
type _countBooleanIsTheShorthandOnly = Expect<
  Equal<Extract<SelectCount, boolean>, true>
>;
type _countObjectNamesRelations = Expect<
  Equal<keyof NonNullable<Extract<SelectCount, object>["select"]>, "entries">
>;
({
  select: { _count: { select: { entries: true } } },
}) satisfies OperationPayload<"findMany", typeof ledger>;
({
  // @ts-expect-error `false` is a scalar selection, and `_count` is not a scalar.
  select: { _count: false },
}) satisfies OperationPayload<"findMany", typeof ledger>;

// The result: the counts object, beside the mapped member under its own name.
type _selectedCountsAreCountsOnly = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof ledger,
      { select: { tally: true; _count: true } }
    >[number],
    { tally: number; _count: { entries: number } }
  >
>;
type _includedCountsAreCountsOnly = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof ledger,
      { include: { _count: { select: { entries: true } } } }
    >[number],
    { id: string; tally: number; _count: { entries: number } }
  >
>;
