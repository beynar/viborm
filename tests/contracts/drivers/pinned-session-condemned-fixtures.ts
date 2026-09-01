import type { PGlite } from "@electric-sql/pglite";

export const RESET = "pg_advisory_unlock_all";

export function failResetOn(
  client: PGlite,
  rejectWith: unknown = new Error("the session is gone")
): void {
  const answer: unknown = Reflect.get(client, "query");
  Object.defineProperty(client, "query", {
    configurable: true,
    value: (sql: string, params?: unknown[]) =>
      sql.includes(RESET)
        ? Promise.reject(rejectWith)
        : Reflect.apply(
            typeof answer === "function" ? answer : () => undefined,
            client,
            [sql, params]
          ),
  });
}

export function discardingBody(): (
  pinned: unknown,
  control: { discard(): void }
) => Promise<string> {
  return (_pinned, control) => {
    control.discard();
    return Promise.resolve("done");
  };
}

export function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => new Error("the pinned session was expected to fail"),
    (error: unknown) => error
  );
}

export function prototypeTrapProxy(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    }
  );
}
