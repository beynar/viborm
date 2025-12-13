import { scope, type } from "arktype";

const ensureObjectOrder = (t) => {
  if (typeof t === "object" && t !== null) {
    return t;
  }
  return {
    sort: t,
    nulls: "last" as const,
  };
};

export const genericsScope = scope({
  //  ========================
  // UTILITY TYPES
  // ========================
  "KEYS<M extends object>": "keyof M",

  //  ========================
  // NESTED FILTERS
  // ========================
  "TO_ONE_FILTER_BASE<M>": {
    "is?": "M",
    "isNot?": "M",
  },
  "TO_ONE_FILTER<M>": "TO_ONE_FILTER_BASE<M> | M",
  "TO_MANY_FILTER<M>": {
    "some?": "M",
    "every?": "M",
    "none?": "M",
  },
  //  ========================
  // AGGREGATE FILTERS
  // ========================
  AGGREGATE_FILTER: {
    "equals?": "number",
    "not?": "number | AGGREGATE_FILTER",
    "gt?": "number",
    "gte?": "number",
    "lt?": "number",
    "lte?": "number",
    "in?": "number[]",
    "notIn?": "number[]",
  },
  "HAVING_AGGREGATE_INPUT<NumericFields extends string, ScalarFields extends string>":
    {
      "_count?": "Record<ScalarFields| '_all', AGGREGATE_FILTER>",
      "_avg?": "Record<NumericFields| '_all', AGGREGATE_FILTER>",
      "_sum?": "Record<NumericFields| '_all', AGGREGATE_FILTER>",
      "_min?": "Record<NumericFields| '_all', AGGREGATE_FILTER>",
      "_max?": "Record<NumericFields| '_all', AGGREGATE_FILTER>",
    },
  //  ========================
  // ORDER BY
  // ========================
  ORDER_BY: type
    .enumerated("asc", "desc")
    .or(
      type({
        sort: type.enumerated("asc", "desc"),
        nulls: type.enumerated("first", "last").default("last"),
      })
    )
    .pipe(ensureObjectOrder),
  "ORDER_BY_INPUT<M extends string>": "Partial<Record<M, ORDER_BY>>",
  USER: {
    name: "string",
    email: "string",
    createdAt: "Date",
  },
  TEST_2: "HAVING_AGGREGATE_INPUT<KEYS<USER>,KEYS<USER>>",
});

const t2 = genericsScope.export("TEST_2").TEST_2.inferIn;
