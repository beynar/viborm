import type { Sql } from "@sql";
import type { BatchReferenceSqlAdapter } from "./adapter-core-types";
import type { QueryParts } from "./adapter-query-parts";
import type { DatabaseAdapter } from "./database-adapter";

export type { QueryParts } from "./adapter-query-parts";

const ADAPTER_INTERNALS: unique symbol = Symbol("viborm.adapterInternals");

interface AdapterInternals {
  readonly select: (parts: QueryParts) => Sql;
  readonly batchRefs: BatchReferenceSqlAdapter;
}

interface AdapterWithInternals extends DatabaseAdapter {
  readonly [ADAPTER_INTERNALS]: AdapterInternals;
}

function hasAdapterInternals(
  adapter: DatabaseAdapter
): adapter is AdapterWithInternals {
  return ADAPTER_INTERNALS in adapter;
}

/** Install the one query-engine-only dialect seam on a concrete adapter. */
export function installAdapterInternals(
  adapter: DatabaseAdapter,
  internals: AdapterInternals
): void {
  Object.defineProperty(adapter, ADAPTER_INTERNALS, {
    configurable: false,
    enumerable: false,
    value: Object.freeze(internals),
    writable: false,
  });
}

/** Read the internal seam installed by a stock dialect adapter. */
export function getAdapterInternals(
  adapter: DatabaseAdapter
): AdapterInternals {
  if (!hasAdapterInternals(adapter)) {
    throw new TypeError(
      "The database adapter must extend a VibORM dialect adapter."
    );
  }
  return adapter[ADAPTER_INTERNALS];
}

/** Assemble one query-engine SELECT without exposing its parts publicly. */
export function assembleAdapterSelect(
  adapter: DatabaseAdapter,
  parts: QueryParts
): Sql {
  return getAdapterInternals(adapter).select(parts);
}
