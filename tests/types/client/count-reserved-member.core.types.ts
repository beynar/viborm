/**
 * `_count` in a selection is the relation-count projection only, and
 * `_distance` is the selected distance only.
 *
 * Schema validation refuses a member named `_count` or `_distance` (F010), so
 * the select input's `_count` is the count shorthand or the count object and
 * never a scalar boolean, and the result's `_count` is the counts object,
 * never intersected with a scalar; the result's `_distance` is the distance
 * number. A scalar mapped to either COLUMN keeps its own member name on both
 * sides. Runtime and refusal pins:
 * `tests/contracts/public-client/count-reserved-member.core.test.ts`.
 *
 * `s.model` and `.extends` refuse both member names at compile time as well:
 * their shape parameter forbids the keys `_count` and `_distance`
 * (`DeclaredModelShape`), for a scalar, a relation and a variant slot alike.
 * The constraint names keys and never a member's type, so the mutually
 * recursive `ledger`/`entry` pair below still infers concrete members.
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

// The declaration: `_count` is refused as a member key, whatever the member.
const countTarget = s.model({ id: s.string().id() });
const countClip = s.model({ id: s.string().id(), seconds: s.int() });
s.model({
  id: s.string().id(),
  // @ts-expect-error `_count` is a reserved member name; a scalar may not take it.
  _count: s.int(),
});
s.model({
  id: s.string().id(),
  // @ts-expect-error `_count` is a reserved member name; a relation may not take it.
  _count: s.toMany(() => countTarget),
});
s.model({
  id: s.string().id(),
  // @ts-expect-error `_count` is a reserved member name; a variant slot may not take it.
  _count: s.toOne({ target: () => countTarget, clip: () => countClip }),
});
// @ts-expect-error `_count` is a reserved member name; `.extends` may not add it.
countTarget.extends({ _count: s.int() });
// The column name stays available under another member name.
s.model({ id: s.string().id(), tally: s.int().map("_count") });

// `_distance` is refused the same way, whatever the member.
s.model({
  id: s.string().id(),
  // @ts-expect-error `_distance` is a reserved member name; a scalar may not take it.
  _distance: s.number(),
});
s.model({
  id: s.string().id(),
  // @ts-expect-error `_distance` is a reserved member name; a relation may not take it.
  _distance: s.toMany(() => countTarget),
});
s.model({
  id: s.string().id(),
  // @ts-expect-error `_distance` is a reserved member name; a variant slot may not take it.
  _distance: s.toOne({ target: () => countTarget, clip: () => countClip }),
});
// @ts-expect-error `_distance` is a reserved member name; `.extends` may not add it.
countTarget.extends({ _distance: s.number() });

// A member in the `_distance` column beside a selected distance: both keys,
// each with its own meaning.
const landmark = s.model({
  id: s.string().id(),
  at: s.point(),
  score: s.number().map("_distance"),
});
type _mappedMemberBesideTheDistance = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof landmark,
      {
        select: {
          score: true;
          at: { _distance: { to: { longitude: 0; latitude: 0 } } };
        };
      }
    >[number],
    { score: number; _distance: number }
  >
>;

// The recursive pair still infers concrete members through the constraint.
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type _ledgerIsNotAny = Expect<Equal<IsAny<typeof ledger>, false>>;
type _entryIsNotAny = Expect<Equal<IsAny<typeof entry>, false>>;
type _ledgerReadsThroughEntry = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof ledger,
      {
        select: {
          entries: { select: { ledger: { select: { tally: true } } } };
        };
      }
    >[number],
    { entries: { ledger: { tally: number } }[] }
  >
>;
