/**
 * `disclosed`, used as a third-party logging extension would use it: a
 * `unit` part that logs each statement's text, parameters and failure, made
 * of public words only. What it logs never carries more than the
 * application's `disclosure` and its own `allow` let through, and no value
 * the application hands the library can break it or make it read that value
 * twice.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { QueryResult } from "@drivers";
import { Driver } from "@drivers";
import {
  createClient,
  type DisclosurePolicy,
  disclosed,
  disclosure,
  extension,
  failure,
  parameters,
  s,
  sql,
  text,
  unit,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { captureLogs } from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id(), name: s.string() });
const schema = { record };

const SQL_CANARY = "sql_canary";
const PARAMETER_CANARY = "parameter-canary";
const PROVIDER_CANARY = "provider-canary";
const CREDENTIAL = "hunter2";

/** A provider that answers, or fails with what `failWith` holds. */
class ProviderDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  failWith: unknown;

  constructor() {
    super("sqlite", "disclosed-test");
    this.client = {};
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return callback(client);
  }
}

interface Logged {
  readonly text?: string | undefined;
  readonly parameters?: readonly unknown[] | undefined;
  readonly failure?: Error | undefined;
}

/**
 * The third-party extension: it shows statement text and parameters as its
 * own `allow` says, and every failure through `disclosed`.
 */
function acmeLog(
  logged: Logged[],
  allow: Pick<DisclosurePolicy, "sql" | "parameters"> = {},
  name = "acme.log"
) {
  return extension(
    name,
    unit(async (u, next) => {
      if (u.kind !== "statement") return next();
      // Read before `next()`: the provider may change what it was handed.
      const shown = allow.parameters === true ? parameters(u) : undefined;
      const end = await next();
      logged.push({
        text: allow.sql === true ? text(u) : undefined,
        parameters: shown,
        failure:
          end.status === "failure" ? disclosed(failure(u), allow) : undefined,
      });
    })
  );
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

function client(driver: ProviderDriver) {
  const made = createClient({ schema, driver });
  clients.push(made);
  return made;
}

/** A provider failure with its own words, a credential and a detail. */
function providerFailure(): Error {
  return Object.assign(
    new Error(`${PROVIDER_CANARY} at postgres://app:${CREDENTIAL}@db/main`),
    { code: "23505", detail: `${PROVIDER_CANARY} detail` }
  );
}

const FLAGS = [false, true] as const;
const CASES = FLAGS.flatMap((sqlAllowed) =>
  FLAGS.flatMap((parametersAllowed) =>
    FLAGS.flatMap((providerDetails) =>
      FLAGS.map((allowed) => ({
        application: {
          sql: sqlAllowed,
          parameters: parametersAllowed,
          providerDetails,
        },
        allowed,
      }))
    )
  )
);

describe("disclosed: what a third-party log shows of a failed statement", () => {
  test.each(
    CASES
  )("application $application, extension allows all: $allowed", async ({
    application,
    allowed,
  }) => {
    const driver = new ProviderDriver();
    driver.failWith = providerFailure();
    const logged: Logged[] = [];
    const allow = { sql: allowed, parameters: allowed };
    const failed = await client(driver)
      .$extends(extension("app.disclosure", disclosure(application)))
      .$extends(acmeLog(logged, allow))
      .$queryRaw(sql`SELECT ${PARAMETER_CANARY} AS ${sql.raw(SQL_CANARY)}`)
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(logged).toHaveLength(1);
    const shown = logged[0]?.failure;
    expect(shown).toBeInstanceOf(Error);
    expect(shown?.stack).toBeUndefined();
    const output = JSON.stringify(logged[0]);
    const failureOutput = JSON.stringify(shown);
    // The extension's own choice: the text and parameters it read.
    expect(output.includes(SQL_CANARY)).toBe(allowed);
    expect(output.includes(PARAMETER_CANARY)).toBe(allowed);
    // The failure: the statement only if the application and `allow` both
    // let it through; the provider's words only if the application did.
    expect(failureOutput.includes(SQL_CANARY)).toBe(application.sql && allowed);
    expect(failureOutput.includes(PARAMETER_CANARY)).toBe(
      application.parameters && allowed
    );
    expect(failureOutput.includes(PROVIDER_CANARY)).toBe(
      application.providerDetails
    );
    // A credential never.
    expect(output).not.toContain(CREDENTIAL);
    expect(JSON.stringify(failed)).not.toContain(CREDENTIAL);
  });

  test("the failure itself is the library's, untouched: the copy is apart", async () => {
    const driver = new ProviderDriver();
    driver.failWith = providerFailure();
    let seen: unknown;
    let shown: Error | undefined;
    const failed = await client(driver)
      .$extends(
        extension(
          "acme.keep",
          unit(async (u, next) => {
            const end = await next();
            if (u.kind === "statement" && end.status === "failure") {
              seen = failure(u);
              shown = disclosed(seen);
            }
          })
        )
      )
      .$queryRaw(sql`SELECT 1`)
      .catch((error: unknown) => error);

    expect(seen).toBe(failed);
    expect(shown).not.toBe(seen);
    // Its class and code, as the library made them.
    const made = failed instanceof Error ? failed : new Error("none");
    expect(made.name).toBe("UniqueConstraintError");
    expect(shown?.name).toBe(made.name);
    expect(Reflect.get(shown ?? {}, "code")).toBe(Reflect.get(made, "code"));
  });
});

describe("parameters(u): one bounded snapshot, read once", () => {
  test("a hostile parameter is read once, however many read the snapshot", async () => {
    let reads = 0;
    // An instance the library hands the provider as it is, without walking it.
    class Opaque {
      readonly secret = PARAMETER_CANARY;
    }
    const hostile = new Proxy(new Opaque(), {
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    });
    const logged: Logged[] = [];
    const logs = captureLogs();
    await client(new ProviderDriver())
      .$extends(
        instrumentation({
          logging: { includeParams: true, query: logs.callback },
        })
      )
      .$extends(acmeLog(logged, { parameters: true }))
      .$extends(acmeLog(logged, { parameters: true }, "acme.log.again"))
      .$queryRaw(sql`SELECT ${hostile}`);

    expect(reads).toBe(1);
    expect(logged).toHaveLength(2);
    expect(logged[0]?.parameters).toBe(logged[1]?.parameters);
    expect(logged[0]?.parameters).toEqual([{ secret: PARAMETER_CANARY }]);
    expect(logs.events[0]?.params).toEqual([{ secret: PARAMETER_CANARY }]);
  });

  test("a throwing getter, a BigInt, a cycle and 1 MB of bytes: bounded, never thrown", async () => {
    const getter = {
      get secret(): string {
        throw new Error("a getter must not run");
      },
    };
    const cyclic: Record<string, unknown> = { name: "cyclic" };
    cyclic.self = cyclic;
    const megabyte = new Uint8Array(1024 * 1024).fill(7);
    const logged: Logged[] = [];
    await client(new ProviderDriver())
      .$extends(acmeLog(logged, { parameters: true }))
      .$queryRaw(sql`SELECT ${getter}, ${2n ** 70n}, ${cyclic}, ${megabyte}`);

    const [shownGetter, shownBigInt, shownCycle, shownBytes] =
      logged[0]?.parameters ?? [];
    expect(shownGetter).toEqual({ secret: "[Unreadable]" });
    expect(shownBigInt).toBe((2n ** 70n).toString());
    expect(shownCycle).toEqual({ name: "cyclic", self: "[Circular]" });
    expect(shownBytes).toMatchObject({
      type: "binary",
      byteLength: 1024 * 1024,
      truncated: true,
    });
    expect(JSON.stringify(logged[0]).length).toBeLessThan(4096);
  });
});

describe("disclosed: any value, never thrown", () => {
  test("a value that is not an Error is shown as nothing of it", () => {
    for (const thrown of [
      `${PROVIDER_CANARY}`,
      { message: PROVIDER_CANARY },
      12n,
      undefined,
      null,
    ]) {
      const shown = disclosed(thrown);
      expect(shown).toBeInstanceOf(Error);
      expect(shown.message).toBe("Error details redacted");
      expect(
        JSON.stringify({ ...shown, message: shown.message })
      ).not.toContain(PROVIDER_CANARY);
    }
  });

  test("an error of the application: its name, message and other words removed", () => {
    const own = Object.assign(new TypeError(PROVIDER_CANARY), {
      code: "ECONNRESET",
      secret: PROVIDER_CANARY,
    });
    const shown = disclosed(own);
    expect(shown).toMatchObject({
      name: "Error",
      message: "Error details redacted",
      code: "ECONNRESET",
    });
    expect(shown).not.toHaveProperty("secret");
    expect(shown.stack).toBeUndefined();
  });

  test("a cyclic cause ends as [Circular]; a deep one is cut", () => {
    const first = new Error(PROVIDER_CANARY);
    const second = new Error(PROVIDER_CANARY, { cause: first });
    Object.assign(first, { cause: second });
    const shown = disclosed(first);
    const cause = shown.cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause instanceof Error && cause.cause).toMatchObject({
      message: "[Circular]",
    });

    let deep = new Error("bottom");
    for (let depth = 0; depth < 20; depth += 1)
      deep = new Error(`level ${depth}`, { cause: deep });
    let link: unknown = disclosed(deep);
    let links = 0;
    while (link instanceof Error && link.cause !== undefined) {
      link = link.cause;
      links += 1;
    }
    expect(links).toBeLessThanOrEqual(9);
  });

  test("hostile errors: a throwing cause getter, a Proxy, a revoked Proxy", () => {
    let causeReads = 0;
    const getterCause = new Error(PROVIDER_CANARY);
    Object.defineProperty(getterCause, "cause", {
      get() {
        causeReads += 1;
        throw new Error("a cause getter that throws");
      },
    });
    const trapped = new Proxy(new Error(PROVIDER_CANARY), {
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
      ownKeys() {
        throw new Error("trap");
      },
    });
    const prototypeTrap = new Proxy(new Error(PROVIDER_CANARY), {
      getPrototypeOf() {
        throw new Error("trap");
      },
    });
    const revocable = Proxy.revocable(new Error(PROVIDER_CANARY), {});
    revocable.revoke();

    for (const hostile of [
      getterCause,
      trapped,
      prototypeTrap,
      revocable.proxy,
    ]) {
      const shown = disclosed(hostile);
      expect(shown.message).toBe("Error details redacted");
      expect(shown.cause).toBeUndefined();
    }
    expect(causeReads).toBe(1);
  });
});
