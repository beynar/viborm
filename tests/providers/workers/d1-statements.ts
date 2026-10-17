/**
 * A D1 binding seen from outside the driver: every statement the driver
 * prepares is recorded with the values it binds, and a test may land a write
 * of its own right before the `skip`-th later statement matching `match` runs,
 * alone or in a batch (a concurrent writer between two statements of one
 * operation, the interleaving `InterleavingSQLite3Driver` produces on
 * SQLite3 in tests/raptor3/post-prep/row-scopes.test.ts). Nothing in the
 * driver is patched: the binding it is given is.
 */

import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";

export interface D1Statement {
  readonly sql: string;
  readonly values: readonly unknown[];
  /** The ordinal of the `batch` call that ran it; absent when it ran alone. */
  readonly batch?: number;
}

interface Pending {
  readonly match: RegExp;
  skip: number;
  readonly sql: string;
  readonly values: readonly unknown[];
}

const EXECUTE = new Set(["run", "all", "raw", "first"]);

export class RecordingD1 {
  readonly statements: D1Statement[] = [];
  readonly database: D1Database;
  readonly #target: D1Database;
  #batches = 0;
  #pending: Pending | undefined;
  /** The real statement behind each one the driver holds, and its record. */
  readonly #bound = new WeakMap<
    object,
    { real: D1PreparedStatement; record: D1Statement }
  >();

  constructor(target: D1Database) {
    this.#target = target;
    const prepare = (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, {
        get: (prepared, property) => {
          if (property !== "bind") {
            const value = Reflect.get(prepared, property, prepared);
            return typeof value === "function" ? value.bind(prepared) : value;
          }
          return (...values: unknown[]) =>
            this.#wrap(prepared.bind(...values), { sql, values });
        },
      });
    };
    const batch = async (statements: readonly object[]) => {
      const ordinal = ++this.#batches;
      const reals = statements.map((statement) => {
        const known = this.#bound.get(statement);
        if (known === undefined) return statement as D1PreparedStatement;
        this.statements.push({ ...known.record, batch: ordinal });
        return known.real;
      });
      for (const statement of statements) {
        const known = this.#bound.get(statement);
        if (known !== undefined && (await this.#interleave(known.record)))
          break;
      }
      return await target.batch(reals);
    };
    this.database = new Proxy(target, {
      get: (database, property) => {
        if (property === "prepare") return prepare;
        if (property === "batch") return batch;
        const value = Reflect.get(database, property, database);
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
  }

  /** Runs `sql` right before the `skip`-th later statement matching `match`. */
  before(
    match: RegExp,
    sql: string,
    values: readonly unknown[],
    skip = 0
  ): void {
    this.#pending = { match, skip, sql, values };
  }

  /** Whether a write `before` set up is still waiting for its statement. */
  get armed(): boolean {
    return this.#pending !== undefined;
  }

  #wrap(real: D1PreparedStatement, record: D1Statement): D1PreparedStatement {
    const target = this;
    const wrapped = new Proxy(real, {
      get(statement, property) {
        const value = Reflect.get(statement, property, statement);
        if (typeof property !== "string" || !EXECUTE.has(property))
          return typeof value === "function" ? value.bind(statement) : value;
        return async (...args: unknown[]) => {
          target.statements.push(record);
          await target.#interleave(record);
          return await (value as (...a: unknown[]) => unknown).apply(
            statement,
            args
          );
        };
      },
    });
    this.#bound.set(wrapped, { real, record });
    return wrapped;
  }

  async #interleave(record: D1Statement) {
    const pending = this.#pending;
    if (pending === undefined || !pending.match.test(record.sql)) return false;
    if (pending.skip-- !== 0) return false;
    this.#pending = undefined;
    const statement = this.#target.prepare(pending.sql);
    await (pending.values.length > 0
      ? statement.bind(...pending.values)
      : statement
    ).run();
    return true;
  }
}
