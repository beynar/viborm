/**
 * Static contract of the runner of `around`'s second moments: each one is
 * handed the prepared call and `run`, which takes no arguments, and the
 * runner's result is its child's. What an application writes is typed by
 * `around` itself (`extensions.core.types.ts`).
 */

import type { ResolvedOperationHandler } from "@extensions/chain";
import {
  type AroundRunner,
  type PreparedModelQueryContext,
  type PreparedRawQueryContext,
  runArounds,
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
type _executionModeIsTruthful = Expect<
  Equal<(typeof context)["mode"], "direct" | "transaction" | "array">
>;

const exact: ResolvedOperationHandler<AroundRunner> = {
  extension: "exact-result",
  handler(prepared, run) {
    if (prepared.kind === "model") {
      const _model: string = prepared.model;
    } else {
      const _model: undefined = prepared.model;
      const _operation:
        | "$queryRaw"
        | "$executeRaw"
        | "$queryRawUnsafe"
        | "$executeRawUnsafe" = prepared.operation;
    }
    // @ts-expect-error - the prepared input is shallow readonly
    prepared.input = {};
    // @ts-expect-error - run never accepts replacement arguments
    run({ where: { id: "other" } });
    return run();
  },
};

const child = async (): Promise<Rows> => [{ id: "post-1" }];
const intercepted = runArounds(context, [exact], child);
type _resultIsTheChilds = Expect<Equal<typeof intercepted, Promise<Rows>>>;

const rawContext: PreparedRawQueryContext<Record<string, never>> =
  Object.freeze({
    mode: "direct",
    kind: "queryRaw",
    model: undefined,
    operation: "$queryRaw",
    input: Object.freeze({}),
  });
const rawResult = runArounds(rawContext, [exact], child);
type _rawResultIsTheChilds = Expect<Equal<typeof rawResult, Promise<Rows>>>;
