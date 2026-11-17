/**
 * `_aggregate` and an order by an aggregate of a to-many relation's rows.
 *
 * An entry takes the target model's own `aggregate` members (`where`,
 * `_count`, `_sum`, `_avg`, `_min`, `_max`) and its result is typed as that
 * model's `aggregate` result for the same selection. A to-one relation and a
 * polymorphic slot name no entry. A to-many order term is `_count` or one
 * aggregate of one field, whose direction also takes `{ sort, nulls }`.
 * Runtime pins: `tests/contracts/drivers/behaviors/relation-read-aggregate-behavior.ts`.
 */

import type { OperationPayload, OperationResult } from "@client/types";
import { s } from "@schema";
import type { Decimal } from "@validation/primitives/decimal-value";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const shop = s.model({
  id: s.string().id(),
  name: s.string(),
  orders: s.toMany(() => order),
});
const order = s.model({
  id: s.string().id(),
  shopId: s.string(),
  shop: s
    .toOne(() => shop)
    .fields("shopId")
    .references("id"),
  quantity: s.int(),
  big: s.bigInt(),
  price: s.decimal({ precision: 10, scale: 2 }),
  placedAt: s.dateTime(),
  status: s.string(),
  tags: s.string().array(),
});

// The result: each entry is the target's own aggregate result.
type _selectedAggregates = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof shop,
      {
        select: {
          id: true;
          _aggregate: {
            orders: {
              where: { status: "paid" };
              _count: true;
              _sum: { quantity: true; big: true; price: true };
              _avg: { quantity: true; price: true };
              _min: { placedAt: true };
              _max: { status: true };
            };
          };
        };
      }
    >[number],
    {
      id: string;
      _aggregate: {
        orders: {
          _count: number;
          _sum: {
            quantity: number | null;
            big: bigint | null;
            price: Decimal | null;
          };
          _avg: { quantity: number | null; price: Decimal | null };
          _min: { placedAt: Date | null };
          _max: { status: string | null };
        };
      };
    }
  >
>;

// Beside an include's rows and `_count`.
type IncludedShop = OperationResult<
  "findMany",
  typeof shop,
  {
    include: {
      _count: { select: { orders: true } };
      _aggregate: { orders: { _count: { _all: true; status: true } } };
    };
  }
>[number];
type _includedAggregates = Expect<
  Equal<
    IncludedShop["_aggregate"],
    { orders: { _count: { _all: number; status: number } } }
  >
>;
type _includedCounts = Expect<
  Equal<IncludedShop["_count"], { orders: number }>
>;

// The input: an ordinary to-many relation's entry only.
({
  select: { _aggregate: { orders: { _sum: { quantity: true } } } },
}) satisfies OperationPayload<"findMany", typeof shop>;
({
  // @ts-expect-error `_sum` admits the summable fields only.
  select: { _aggregate: { orders: { _sum: { status: true } } } },
}) satisfies OperationPayload<"findMany", typeof shop>;
({
  // @ts-expect-error a page is not an aggregate's: no `take` in an entry.
  select: { _aggregate: { orders: { _count: true, take: 2 } } },
}) satisfies OperationPayload<"findMany", typeof shop>;
({
  // @ts-expect-error a to-one relation has no rows to aggregate.
  select: { _aggregate: { shop: { _count: true } } },
}) satisfies OperationPayload<"findMany", typeof order>;

// The order: `_count`, or an aggregate of one field, `{ sort, nulls }` too.
({
  orderBy: { orders: { _count: "desc" } },
}) satisfies OperationPayload<"findMany", typeof shop>;
({
  orderBy: [
    { orders: { _sum: { quantity: "desc" } } },
    { orders: { _max: { placedAt: { sort: "asc", nulls: "last" } } } },
  ],
}) satisfies OperationPayload<"findMany", typeof shop>;
({
  // @ts-expect-error `_avg` admits the summable fields only.
  orderBy: { orders: { _avg: { placedAt: "asc" } } },
}) satisfies OperationPayload<"findMany", typeof shop>;
({
  // @ts-expect-error a list orders by `_count` only.
  orderBy: { orders: { _min: { tags: "asc" } } },
}) satisfies OperationPayload<"findMany", typeof shop>;
