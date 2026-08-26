/** Public E3b array transaction result and capability boundary. */

import { PGliteDriver } from "@drivers/pglite";
import { createClient, s, sql } from "@src/index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type PrivateArrayOperationKey =
  | "canBatch"
  | "clientId"
  | "context"
  | "execute"
  | "executeArrayCore"
  | "executeCore"
  | "executeWith"
  | "hasObservation"
  | "isArrayWrite"
  | "isBatchOperation"
  | "isWrite"
  | "model"
  | "observationToken"
  | "observe"
  | "observeArrayLifecycle"
  | "observeBatchPhase"
  | "operation"
  | "parseResult"
  | "prepare"
  | "prepareAdmission"
  | "prepareArrayAdmission"
  | "prepareBatch"
  | "requiresInterception"
  | "reserveWith"
  | "scopeId"
  | "stagePackageWriteOutcomes"
  | "startArrayInterception"
  | "startInterception";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
});
const schema = { record };
const driver = new PGliteDriver();

const client = createClient({ schema, driver }).$extends({
  name: "array-types",
  async query(context) {
    // @ts-expect-error - array coordination stays private
    context.coordinator;
    // @ts-expect-error - no admission token crosses the public handler boundary
    context.admission;
    return context.proceed();
  },
});

const tuple = client.$transaction([
  client.record.findMany({ select: { id: true } }),
  client.record.deleteMany(),
  client.$queryRaw<{ value: number }>(sql`SELECT 1 AS value`),
]);

const modelOperation = client.record.findMany();
type _modelHasNoPublicSymbolIndex = Expect<
  Equal<symbol extends keyof typeof modelOperation ? true : false, false>
>;
type _modelHasNoPrivateArrayAuthority = Expect<
  Equal<Extract<keyof typeof modelOperation, PrivateArrayOperationKey>, never>
>;

const rawOperation = client.$queryRaw<{ value: number }>(
  sql`SELECT 1 AS value`
);
type _rawHasNoPublicSymbolIndex = Expect<
  Equal<symbol extends keyof typeof rawOperation ? true : false, false>
>;
type _rawHasNoPrivateArrayAuthority = Expect<
  Equal<Extract<keyof typeof rawOperation, PrivateArrayOperationKey>, never>
>;

type _tupleResultIsExact = Expect<
  Equal<
    Awaited<typeof tuple>,
    [{ id: string }[], { count: number }, { value: number }[]]
  >
>;
