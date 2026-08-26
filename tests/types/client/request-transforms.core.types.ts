/** Type contract for the standalone E2 request-transform boundary. */

import type {
  RequestTransform,
  RequestTransformInput,
  RequestTransformPatch,
} from "@extensions/request";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type RowInput = {
  where?: { published?: boolean };
  take?: number;
  select?: { id?: boolean };
  include?: { author?: boolean };
  omit?: { secret?: boolean };
};

type _rowInputHidesEveryProjection = Expect<
  Equal<keyof RequestTransformInput<"findMany", RowInput>, "where" | "take">
>;

const _rowHandler: RequestTransform<"findMany", RowInput> = {
  extension: "row",
  handler({ model, operation, input }) {
    const _concreteModel: string = model;
    const _concreteOperation: "findMany" = operation;
    input.where;
    input.take;
    // @ts-expect-error - select determines the call-site result
    input.select;
    // @ts-expect-error - include determines the call-site result
    input.include;
    // @ts-expect-error - omit determines the call-site result
    input.omit;
    return { take: 2 };
  },
};

const heldProjectionPatch = { take: 1, select: { id: true } };
// @ts-expect-error - protected keys are refused structurally beside a real patch key
const _heldProjectionPatch: RequestTransformPatch<"findMany", RowInput> =
  heldProjectionPatch;

const _inlineProjectionPatch: RequestTransform<"findMany", RowInput> = {
  extension: "inline-projection",
  // @ts-expect-error - a request patch cannot replace caller select
  handler() {
    return {
      take: 1,
      select: { id: true },
    };
  },
};

type CountInput = {
  where?: { published?: boolean };
  take?: number;
  select?: { _all?: boolean; id?: boolean };
};
type _countHidesSelect = Expect<
  Equal<keyof RequestTransformInput<"count", CountInput>, "where" | "take">
>;

type AggregateInput = {
  where?: { published?: boolean };
  take?: number;
  _count?: true;
  _avg?: { views?: boolean };
  _sum?: { views?: boolean };
  _min?: { views?: boolean };
  _max?: { views?: boolean };
};
type _aggregateHidesEverySelector = Expect<
  Equal<
    keyof RequestTransformInput<"aggregate", AggregateInput>,
    "where" | "take"
  >
>;

type GroupByInput = AggregateInput & {
  by: readonly ["published"];
  having?: { views?: { _sum?: { gt?: number } } };
};
type _groupByHidesGroupingAndSelectors = Expect<
  Equal<
    keyof RequestTransformInput<"groupBy", GroupByInput>,
    "where" | "take" | "having"
  >
>;

type BulkInput = {
  data: readonly [{ id: string }];
  skipDuplicates?: boolean;
  select?: { id?: boolean };
  omit?: { id?: boolean };
};
type _createManyHidesReturningProjection = Expect<
  Equal<
    keyof RequestTransformInput<"createMany", BulkInput>,
    "data" | "skipDuplicates"
  >
>;
type _updateManyHidesReturningProjection = Expect<
  Equal<
    keyof RequestTransformInput<"updateMany", BulkInput>,
    "data" | "skipDuplicates"
  >
>;
type _deleteManyHidesReturningProjection = Expect<
  Equal<
    keyof RequestTransformInput<"deleteMany", BulkInput>,
    "data" | "skipDuplicates"
  >
>;

type ExistInput = {
  where?: { id?: string };
  unknownOrdinaryKey?: boolean;
  select?: { id?: boolean };
};
type _anUnownedKeyStaysForCoreValidation = Expect<
  Equal<
    keyof RequestTransformInput<"exist", ExistInput>,
    "where" | "unknownOrdinaryKey" | "select"
  >
>;
