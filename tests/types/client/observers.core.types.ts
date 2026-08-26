/** Public E5 protected-observer authority and privacy boundary. */

import { PGliteDriver } from "@drivers/pglite";
import { createClient, s } from "@src/index";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
});

const client = createClient({
  schema: { record },
  driver: new PGliteDriver(),
}).$extends({
  name: "observer-surface",
  observe(unit, proceed) {
    const proveDiscriminant = () => {
      switch (unit.kind) {
        case "operation": {
          const operation: string = unit.operation;
          const model: string | undefined = unit.model;
          return { model, operation };
        }
        case "statement": {
          const operation: string | undefined = unit.operation;
          const model: string | undefined = unit.model;
          return { model, operation };
        }
        case "batch": {
          const operation: string = unit.operation;
          // @ts-expect-error - batch units disclose no model
          unit.model;
          return operation;
        }
        case "transaction":
        case "savepoint":
        case "connection": {
          const operation: string | undefined = unit.operation;
          // @ts-expect-error - these units disclose no model
          unit.model;
          return operation;
        }
        case "segment": {
          const operation: string | undefined = unit.operation;
          const model: string | undefined = unit.model;
          return { model, operation };
        }
        case "cache": {
          const operation: "get" | "set" | "revalidate" | "invalidate" =
            unit.operation;
          // @ts-expect-error - cache units disclose no model
          unit.model;
          return operation;
        }
        default: {
          const exhaustive: never = unit;
          return exhaustive;
        }
      }
    };
    proveDiscriminant();
    const kind:
      | "operation"
      | "statement"
      | "batch"
      | "transaction"
      | "savepoint"
      | "segment"
      | "connection"
      | "cache" = unit.kind;
    const model: string | undefined = "model" in unit ? unit.model : undefined;
    const operation: string | undefined = unit.operation;
    proceed().then((summary) => {
      const status: "success" | "failure" = summary.status;
      const certainty: "committed" | "may-have-committed" | undefined =
        summary.commitCertainty;
      // @ts-expect-error - the immutable completion cannot be rewritten
      summary.status = "success";
      // @ts-expect-error - application results never cross the observer boundary
      summary.result;
      // @ts-expect-error - raw application errors never cross the boundary
      summary.cause;
      return { certainty, status };
    });
    // @ts-expect-error - observers receive no SQL disclosure
    unit.sql;
    // @ts-expect-error - observers receive no parameter disclosure
    unit.params;
    // @ts-expect-error - cache keys never cross the observer boundary
    unit.key;
    // @ts-expect-error - cache values never cross the observer boundary
    unit.value;
    // @ts-expect-error - cache provider state never crosses the observer boundary
    unit.cacheDriver;
    // @ts-expect-error - raw failures never cross the observer boundary
    unit.error;
    // @ts-expect-error - observers receive no driver authority
    unit.driver;
    // @ts-expect-error - observers receive no array coordination token
    unit.token;
    // @ts-expect-error - proceed is completion-only and accepts no value
    proceed("fabricated");
    return { fabricated: { kind, model, operation } };
  },
});

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
