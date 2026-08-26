/** Static contract for the neutral E4 statement-transform runner. */

import type { QueryExecutionContext } from "@drivers";
import type { ResolvedExtensionHandler } from "@extensions/chain";
import {
  applyStatementTransforms,
  type StatementContext,
  type StatementHandler,
} from "@extensions/statement";
import { type Sql, sql } from "@sql";

type StatementHandlerEntry = ResolvedExtensionHandler<StatementHandler>;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _contextSurfaceIsExact = Expect<
  Equal<keyof StatementContext, "statement" | "model" | "operation">
>;
type _modelIdentityIsOptional = Expect<
  Equal<StatementContext["model"], string | undefined>
>;
type _operationIdentityIsRequired = Expect<
  Equal<
    StatementContext["operation"],
    import("@client/types").Operations | keyof import("@client/raw").RawSurface
  >
>;
type _executionContextHasNoPublicChain = Expect<
  Equal<keyof QueryExecutionContext, "model" | "operation" | "correlationId">
>;

const transform: ResolvedExtensionHandler<StatementHandler> = {
  extension: "readonly-context",
  handler(context) {
    const statement: Sql = context.statement;
    // @ts-expect-error - the borrowed statement identity is readonly
    context.statement = sql`SELECT 2`;
    // @ts-expect-error - model identity is readonly
    context.model = "other";
    // @ts-expect-error - operation identity is readonly
    context.operation = "other";
    // @ts-expect-error - no driver surface crosses this boundary
    context.driver;
    // @ts-expect-error - no operation program crosses this boundary
    context.program;
    return statement;
  },
};

const _asyncTransform: StatementHandlerEntry = {
  extension: "async-refused",
  // @ts-expect-error - statement transforms must return synchronously
  async handler(context) {
    return context.statement;
  },
};

const _nonSqlTransform: StatementHandlerEntry = {
  extension: "non-sql-refused",
  // @ts-expect-error - statement transforms return exactly Sql
  handler() {
    return "SELECT 1";
  },
};

const original = sql`SELECT ${1}`;
const transformed = applyStatementTransforms(original, "post", "findMany", [
  transform,
]);
type _resultStaysSql = Expect<Equal<typeof transformed, Sql>>;
