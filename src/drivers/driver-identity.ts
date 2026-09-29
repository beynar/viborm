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

/** The public readonly driver fields an identity is read from. */
export interface DriverIdentitySource {
  readonly dialect: Dialect;
  readonly driverName: string;
  readonly adapter: { readonly namespace?: string };
}

/**
 * Read one driver's identity from its public readonly configuration, or
 * `undefined` when that read throws (a custom adapter's `namespace` getter):
 * every presenter then omits the driver attributes and presents the rest.
 */
export function readDriverIdentity(
  driver: DriverIdentitySource
): DriverIdentity | undefined {
  try {
    const namespace = driver.adapter.namespace;
    return Object.freeze({
      dialect: driver.dialect,
      driverName: driver.driverName,
      ...(namespace === undefined ? {} : { namespace }),
    });
  } catch {
    // The operation's facts, its spans and a cached read's revalidation
    // identity survive a driver that cannot name itself.
    return undefined;
  }
}
