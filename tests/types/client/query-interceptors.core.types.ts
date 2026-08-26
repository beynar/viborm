/** Static contract for the standalone E3 query-interceptor boundary. */

import {
  type PreparedModelQueryContext,
  type PreparedRawQueryContext,
  type QueryInterceptor,
  type QueryInterceptorContext,
  runQueryInterceptors,
  type WriteOutcomeRegistration,
} from "@extensions/query";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type Input = {
  where?: { id?: string };
  select?: { id?: boolean };
};
type Rows = { id: string }[];

const input: Readonly<Input> = Object.freeze({
  where: Object.freeze({ id: "post-1" }),
  select: Object.freeze({ id: true }),
});
const context: PreparedModelQueryContext<Input> = Object.freeze({
  mode: "direct",
  kind: "model",
  model: "post",
  operation: "findMany",
  input,
});

type HandlerContext = QueryInterceptorContext<Rows, Input>;
type _handlerSurfaceIsExact = Expect<
  Equal<
    keyof HandlerContext,
    | "mode"
    | "kind"
    | "model"
    | "operation"
    | "input"
    | "proceed"
    | "onWriteOutcome"
  >
>;
type _executionModeIsTruthful = Expect<
  Equal<HandlerContext["mode"], "direct" | "transaction" | "array">
>;

const exactInterceptor: QueryInterceptor<Rows, Input> = {
  extension: "exact-result",
  async handler(handlerContext) {
    handlerContext.input.where;
    handlerContext.input.select;
    // @ts-expect-error - the inspection input is shallow readonly
    handlerContext.input.where = { id: "other" };
    // @ts-expect-error - proceed never accepts replacement arguments
    handlerContext.proceed({ where: { id: "other" } });
    // @ts-expect-error - no operation program crosses the boundary
    handlerContext.program;
    // @ts-expect-error - no driver crosses the boundary
    handlerContext.driver;
    // @ts-expect-error - no result mutation surface crosses the boundary
    handlerContext.result;
    handlerContext.onWriteOutcome((outcome) => {
      const certainty: "committed" | "may-have-committed" = outcome.certainty;
      // @ts-expect-error - outcome facts are immutable
      outcome.certainty = "committed";
      return certainty;
    });
    handlerContext.onWriteOutcome(async () => undefined);
    return handlerContext.proceed();
  },
};

const _wrongResultInterceptor: QueryInterceptor<Rows, Input> = {
  extension: "wrong-result",
  // @ts-expect-error - an interceptor cannot invent another public result type
  async handler() {
    return [{ title: "wrong" }];
  },
};

const capture = (_registration: WriteOutcomeRegistration): void => undefined;
const child = async (): Promise<Rows> => [{ id: "post-1" }];
const intercepted = runQueryInterceptors(
  context,
  [exactInterceptor],
  child,
  capture
);
type _publicResultRemainsExact = Expect<
  Equal<typeof intercepted, Promise<Rows>>
>;

const rawContext: PreparedRawQueryContext<Record<string, never>> =
  Object.freeze({
    mode: "direct",
    kind: "queryRaw",
    model: undefined,
    operation: "$queryRaw",
    input: Object.freeze({}),
  });
const rawInterceptor: QueryInterceptor<Rows, Record<string, never>> = {
  extension: "raw-identity",
  async handler(handlerContext) {
    if (handlerContext.kind === "model") {
      const _model: string = handlerContext.model;
      return handlerContext.proceed();
    }
    const _model: undefined = handlerContext.model;
    const _operation:
      | "$queryRaw"
      | "$executeRaw"
      | "$queryRawUnsafe"
      | "$executeRawUnsafe" = handlerContext.operation;
    return handlerContext.proceed();
  },
};
const rawResult = runQueryInterceptors(
  rawContext,
  [rawInterceptor],
  child,
  capture
);
type _rawResultRemainsExact = Expect<Equal<typeof rawResult, Promise<Rows>>>;
