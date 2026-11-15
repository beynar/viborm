/** What a `unit` part is handed: a unit's kind, model and operation, and how it ended; nothing of the application. */

import { PGliteDriver } from "@drivers/pglite";
import { createClient, extension, s, type UnitKind, unit } from "@src/index";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
});

const client = createClient({
  schema: { record },
  driver: new PGliteDriver(),
}).$extends(
  extension(
    "observer-surface",
    unit((u, next) => {
      // An open string: the core's kinds, and any an extension emits (`work`).
      const kind: UnitKind = u.kind;
      const _emitted: UnitKind = "cache";
      const model: string | undefined = u.model;
      const operation: string | undefined = u.operation;
      next().then((summary) => {
        const status: "success" | "failure" = summary.status;
        const duration: number = summary.duration;
        const certainty: "committed" | "may-have-committed" | undefined =
          summary.certainty;
        // @ts-expect-error - the immutable completion cannot be rewritten
        summary.status = "success";
        // @ts-expect-error - application results never cross the unit boundary
        summary.result;
        // @ts-expect-error - a failure is read through failure(u), never on the completion
        summary.cause;
        return { certainty, duration, status };
      });
      // @ts-expect-error - a unit carries no SQL: text(u) reads it on demand
      u.sql;
      // @ts-expect-error - nor parameters: parameters(u) reads them on demand
      u.params;
      // @ts-expect-error - cache keys never cross the unit boundary
      u.key;
      // @ts-expect-error - cache values never cross the unit boundary
      u.value;
      // @ts-expect-error - cache provider state never crosses the unit boundary
      u.cacheDriver;
      // @ts-expect-error - raw failures are read through failure(u)
      u.error;
      // @ts-expect-error - the driver is read through driver(u)
      u.driver;
      // @ts-expect-error - units receive no array coordination token
      u.token;
      // @ts-expect-error - next takes a statement (Sql) to run instead, never a value
      next("fabricated");
      return { kind, model, operation };
    })
  )
);

const operation = client.record.findMany();
// @ts-expect-error - no observation lifecycle is published on a model operation
operation.observeArrayLifecycle;
// @ts-expect-error - no driver or coordinator token is published
operation.observationToken;

const _connectResult: Promise<void> = client.$connect();
const _disconnectResult: Promise<void> = client.$disconnect();
const _callbackResult: Promise<{ readonly status: "ok" }> = client.$transaction(
  async (tx) => {
    // @ts-expect-error - transaction lifecycle internals are not client surface
    tx.transactionObservation;
    // @ts-expect-error - savepoint lifecycle internals are not client surface
    tx.savepointObservation;
    const status: { readonly status: "ok" } = { status: "ok" };
    return status;
  }
);

// @ts-expect-error - connection observation is extension-only, not client API
client.connectionObservation;
// @ts-expect-error - transaction phase provenance is private to execution
client.transactionPhases;
