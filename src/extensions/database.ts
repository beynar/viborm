/**
 * `database(x)`: the database a call, a run or a method's scope works
 * against, as an extension that keeps data beside it partitions on: the
 * driver's dialect and its SQL namespace (a PostgreSQL schema, a MySQL
 * database; `undefined` where the dialect qualifies nothing), and the
 * driver's name, as telemetry names it. Never a connection string, a host or
 * a credential.
 */
import { engineOf } from "./origin";

export interface Database {
  readonly dialect: string;
  readonly namespace: string | undefined;
  /** The driver's name (`pg`, `postgres`, `mysql2`, …). */
  readonly driverName: string;
}

/** The database of a first moment's context, a `run`, or a method's scope. */
export function database(x: object): Database {
  const driver = engineOf(x)?.driver;
  if (driver === undefined)
    throw new TypeError(
      "database(x) takes the context of a model call, its run, or a method's scope"
    );
  return Object.freeze({
    dialect: driver.dialect,
    namespace: driver.adapter.namespace,
    driverName: driver.driverName,
  });
}
