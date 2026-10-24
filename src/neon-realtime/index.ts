// viborm/neon-realtime: live model reads through Neon Realtime (PostgreSQL only).

import type { SealedLiveQuery } from "@neon/realtime/client";
import {
  pgParam,
  type RawSqlParameter,
  type RawSqlQuery,
  rawSql,
} from "@neon/realtime/server";
// One chunk graph with the client this extends: importing only the engine
// pieces used here would split the package's shared chunks into more files.
import "../client/client";
import type { DatabaseAdapter } from "../adapters/database-adapter";
import type { VibORMClient, VibORMConfig } from "../client/client";
import type { ClientSchema } from "../client/schema-links";
import type {
  CacheableOperations,
  ClientRowsContext,
  ContextualOperationResult,
  NoExtraOperationKeys,
  OperationPayload,
  PlacedOperationControls,
  WithControlArgs,
} from "../client/types";
import { TransactionBoundDriver } from "../drivers/driver";
import { UnsupportedOperationError } from "../errors";
import { lookupResolvedExtensionHandlers } from "../extensions/chain";
import type {
  ExtensionModelDelegate,
  ExtensionStateConstraint,
  MergeExtensionState,
} from "../extensions/methods";
import {
  exportPendingRead,
  type PendingOperation,
  type ReadExporter,
} from "../query-engine/pending-operation";
import type { Read } from "../query-engine/raptor3/shared/query";
import type { Leaf } from "../query-engine/result/projection-shape";
// The browser half decodes with this same codec, from its own build.
import {
  type RealtimeQuery,
  type RealtimeRenewal,
  realtimeEnvelope,
  type TransportRow,
} from "./plan";
import { postgresTransport } from "./transport-sql";

export type { RealtimePlan, RealtimeQuery, RealtimeRenewal } from "./plan";

export interface NeonRealtimeOptions {
  /** The application's `createRealtime(...)` server: only its `seal` is used. */
  readonly realtime: {
    seal(input: {
      readonly query: RawSqlQuery<TransportRow>;
    }): Promise<SealedLiveQuery<TransportRow>>;
  };
}

const READS = [
  "findMany",
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "count",
  "exist",
  "aggregate",
  "groupBy",
] as const satisfies readonly CacheableOperations[];

/** `{ initialData: false }` renews a capability without reading the database. */
export interface RealtimeReadOptions<Initial extends boolean> {
  readonly initialData?: Initial;
}

type RealtimeResult<Initial, Data> = Promise<
  Initial extends false ? RealtimeRenewal<Data> : RealtimeQuery<Data>
>;

/** The ordinary operation's own arguments and result, carried live. */
type RealtimeRead<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  Name extends keyof ClientSchema<C>,
  O extends CacheableOperations,
  Payload = OperationPayload<O, ClientSchema<C>[Name]>,
  Controls = PlacedOperationControls<X["controls"], Name, O>,
> = undefined extends Payload
  ? <Args extends Payload, Initial extends boolean = true>(
      args?: WithControlArgs<
        NoExtraOperationKeys<
          O,
          Exclude<Args, undefined>,
          Exclude<Payload, undefined>,
          ClientSchema<C>[Name],
          Controls
        >,
        Controls
      >,
      options?: RealtimeReadOptions<Initial>
    ) => RealtimeResult<
      Initial,
      ContextualOperationResult<
        C,
        Name,
        O,
        Args,
        ClientRowsContext<C, X["rows"]>
      >
    >
  : <Args extends Payload, Initial extends boolean = true>(
      args: WithControlArgs<
        NoExtraOperationKeys<O, Args, Payload, ClientSchema<C>[Name], Controls>,
        Controls
      >,
      options?: RealtimeReadOptions<Initial>
    ) => RealtimeResult<
      Initial,
      ContextualOperationResult<
        C,
        Name,
        O,
        Args,
        ClientRowsContext<C, X["rows"]>
      >
    >;

type RealtimeMethods<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  Name extends keyof ClientSchema<C>,
> = {
  readonly [O in (typeof READS)[number] as `${O}Realtime`]: RealtimeRead<
    C,
    X,
    Name,
    O
  >;
};

/** The client `$extends(neonRealtime(...))` answers, named for compact declarations. */
export type NeonRealtimeClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = VibORMClient<
  C,
  MergeExtensionState<
    X,
    {
      readonly name: "viborm.neonRealtime";
      readonly model: {
        readonly [Name in keyof ClientSchema<C>]: (
          delegate: ExtensionModelDelegate<C, X, Name>
        ) => RealtimeMethods<C, X, Name>;
      };
    }
  >
>;

function refuse(reason: string): never {
  throw new UnsupportedOperationError(
    `Neon Realtime cannot reproduce ${reason}.`,
    { meta: { feature: reason } }
  );
}

// The transport names recursive rows by ordinal (`postgresTransport`).
const ORDINAL: readonly Leaf[] = [
  { kind: "scalar", type: "int", nullable: false },
];

/** The shape the browser decodes, as plain JSON, refused where the sealed SQL cannot carry it. */
function describe(
  shape: Read["query"]["shape"]
): Parameters<typeof realtimeEnvelope>[1]["shape"] {
  return JSON.parse(
    JSON.stringify(shape, (key, value) => {
      if (key === "scalar") return;
      // Its row carries the withheld value: only the decoder leaves it out.
      if (key === "gated") refuse("a read-gated field's projection");
      if (key === "_distance") refuse("a `_distance` projection");
      if (value?.type === "point" || value?.type === "vector")
        refuse(`a ${value.type} projection (PostGIS/pgvector functions)`);
      return value?.kind === "recursive"
        ? { ...value, identity: ORDINAL }
        : value;
    })
  );
}

function parameter(value: unknown): RawSqlParameter {
  if (value instanceof Uint8Array) return pgParam.bytea(value);
  if (Array.isArray(value)) return pgParam.array("unknown", value);
  // A JSON document parameter answers its canonical text (`JsonParameter`).
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value as RawSqlParameter;
}

/** One admitted read's sealed SQL and plan, refused where its answer depends on this process. */
function exportRead(
  model: string,
  operation: CacheableOperations,
  adapter: DatabaseAdapter,
  ...[engine, options, routed]: Parameters<ReadExporter>
) {
  const chain = engine.extensionChain;
  if (engine.driver instanceof TransactionBoundDriver)
    refuse("a read inside a transaction");
  if (chain?.statement.length) refuse("a read through statement transforms");
  if (options.finishResult) refuse("computed result fields");
  const read = routed.exportRead(adapter);
  const { sql } = read.query;
  return {
    plan: {
      shape: describe(read.query.shape),
      rule: read.rule,
      ...(operation.endsWith("OrThrow")
        ? { missing: { model, operation } }
        : {}),
    },
    query: rawSql<TransportRow>(
      sql.toStatement("$n"),
      sql.values.map(parameter)
    ),
  };
}

function methods(
  delegate: Readonly<Record<string, (args: unknown) => unknown>>,
  model: string,
  realtime: NeonRealtimeOptions["realtime"],
  adapter: DatabaseAdapter
) {
  return Object.fromEntries(
    READS.map((operation) => [
      `${operation}Realtime`,
      async (args: unknown, options?: RealtimeReadOptions<boolean>) => {
        const initial = options?.initialData !== false;
        let exported: ReturnType<typeof exportRead> | undefined;
        let answer: unknown;
        // The ordinary read's own lifecycle (admission, query handlers,
        // observers), with the export in place of its execution, and its
        // result where asked for. Query handlers (`permissions()`) only ever
        // see that result, so a renewal through them reads it too.
        const data = await exportPendingRead(
          delegate[operation]!(args) as PendingOperation<unknown>,
          async (...context) => {
            exported = exportRead(model, operation, adapter, ...context);
            const [engine, , , execute] = context;
            if (
              initial ||
              lookupResolvedExtensionHandlers(
                engine.extensionChain,
                "query",
                model,
                operation
              )?.length
            )
              answer = await execute();
            return answer;
          }
        );
        // Every query handler ran the export and passed its answer through.
        if (exported === undefined || data !== answer)
          refuse("a read whose query handlers replace its answer");
        const { plan, query } = exported;
        const sealed = await realtime.seal({ query });
        return initial
          ? realtimeEnvelope(sealed, plan, data)
          : realtimeEnvelope(sealed, plan);
      },
    ])
  );
}

/**
 * Live variants of the nine model reads. A read whose answer the sealed SQL
 * cannot reproduce on its own is refused: see the Neon Realtime guide.
 */
export function neonRealtime({ realtime }: NeonRealtimeOptions) {
  return <C extends VibORMConfig, X extends ExtensionStateConstraint>(
    client: VibORMClient<C, X>
  ): NeonRealtimeClient<C, X> => {
    const driver = client.$driver;
    if (driver.dialect !== "postgresql")
      refuse(`a ${driver.dialect} read: it is PostgreSQL only`);
    // Realtime runs the sealed SQL as one role, without the user's token.
    if ("userAuthorized" in driver && driver.userAuthorized)
      refuse("reads authorized by an `authToken` (row-level security)");
    const adapter = postgresTransport(driver.adapter);
    const model = Object.fromEntries(
      Object.keys(client.$schema).map((name) => [
        name,
        // Each schema model's delegate answers the nine reads by name.
        (delegate: object) =>
          methods(
            delegate as Parameters<typeof methods>[0],
            name,
            realtime,
            adapter
          ),
      ])
    );
    return client.$extends({
      name: "viborm.neonRealtime",
      model,
    }) as unknown as NeonRealtimeClient<C, X>;
  };
}
