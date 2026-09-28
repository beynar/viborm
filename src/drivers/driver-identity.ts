import type { Dialect } from "./types";

/**
 * The configuration facts that name one driver in presented telemetry. No
 * package entry exports this module.
 *
 * `namespace` is the adapter's one normalized SQL qualifier and is absent when
 * the adapter is unqualified. `adapter.namespace` is installed non-writable,
 * so a snapshot taken once (the cached read's, at `$withCache`) cannot go
 * stale. This is the one reader of that property for presentation.
 */
export interface DriverIdentity {
  readonly dialect: Dialect;
  readonly driverName: string;
  readonly namespace?: string;
}

/** Read one driver's identity from its public readonly configuration. */
export function readDriverIdentity(driver: {
  readonly dialect: Dialect;
  readonly driverName: string;
  readonly adapter: { readonly namespace?: string };
}): DriverIdentity {
  const namespace = driver.adapter.namespace;
  return Object.freeze({
    dialect: driver.dialect,
    driverName: driver.driverName,
    ...(namespace === undefined ? {} : { namespace }),
  });
}
