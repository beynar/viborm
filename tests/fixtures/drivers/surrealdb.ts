/**
 * The SurrealDB test estate: a driver opens its own database, on first use or
 * when a test's schema is about to be pushed to it.
 */

import { SurrealDriver } from "@drivers/surrealdb";
import { RecordId, Surreal } from "surrealdb";

export const surrealUrl = process.env.SURREAL_TEST_URL;

let databases = 0;
let latest: string | undefined;
const nextDatabase = () => `t${process.pid}_${Date.now()}_${++databases}`;

class SurrealTestDriver extends SurrealDriver {
  #connected: Promise<Surreal> | undefined;
  #database: string | undefined;
  #defined = false;

  readonly #surreal = new Surreal();

  constructor() {
    super(new Surreal());
    // Connected on first use, as a URL-configured driver would be.
    this.client = null;
  }

  // The shared contracts spell a few raw statements in SQL's words.
  protected override execute<T>(
    client: never,
    statement: string,
    params: unknown[]
  ) {
    return super.execute<T>(
      client,
      statement
        .replace(DROP_TABLE, "REMOVE TABLE IF EXISTS")
        .replace(CREATE_EXTENSION, "RETURN 1")
        .replace(RAW_NAME, "DELETE FROM $1")
        .replace(RAW_KEY, (found, position) =>
          params[Number(position) - 1] instanceof RecordId
            ? found
            : `WHERE record::id(id) = $p${position}`
        ),
      params
    );
  }

  async #connect(): Promise<Surreal> {
    const surreal = this.#surreal;
    // A driver opened after a schema reads that schema's database, as a second
    // connection to one server does.
    this.#database ??= latest ?? nextDatabase();
    const database = this.#database;
    await surreal.connect(surrealUrl!, {
      authentication: { username: "root", password: "root" },
    });
    await surreal.query(
      `DEFINE NAMESPACE IF NOT EXISTS viborm; USE NS viborm; DEFINE DATABASE IF NOT EXISTS ${database};`
    );
    await surreal.use({ namespace: "viborm", database });
    return surreal;
  }

  protected override initClient(): Promise<Surreal> {
    this.#connected ??= this.#connect();
    return this.#connected;
  }

  protected override async closeClient(): Promise<void> {
    await this.#surreal.close();
    this.#connected = undefined;
  }

  /**
   * A driver's first schema is a fresh database, as an in-memory one is, even when
   * a raw statement already opened the one it had.
   */
  async fresh(): Promise<void> {
    if (this.#defined) return;
    this.#defined = true;
    this.#database = nextDatabase();
    latest = this.#database;
    if (!this.#connected) return;
    const surreal = await this.#connected;
    await surreal.query(
      `DEFINE NAMESPACE IF NOT EXISTS viborm; USE NS viborm; DEFINE DATABASE IF NOT EXISTS ${this.#database};`
    );
    await surreal.use({ namespace: "viborm", database: this.#database });
  }
}

export function createSurrealTestDriver(): SurrealDriver {
  return new SurrealTestDriver();
}

const DROP_TABLE = /^DROP TABLE IF EXISTS/;
const CREATE_EXTENSION = /^CREATE EXTENSION .*/;
const RAW_NAME = /^DELETE FROM "([a-z_]+)"/;
const RAW_KEY = /WHERE id = \$p(\d+)/;
