import { env, runInDurableObject } from "cloudflare:test";
import type {
  DurableObjectNamespace,
  DurableObjectState,
} from "@cloudflare/workers-types";

declare global {
  namespace Cloudflare {
    interface Env {
      SQL_OBJECT: DurableObjectNamespace;
    }
  }
}

/** Runs `fn` as one request inside a fresh SQLite Durable Object. */
export function inObject<T>(
  fn: (state: DurableObjectState) => Promise<T>
): Promise<T> {
  const stub = env.SQL_OBJECT.get(env.SQL_OBJECT.newUniqueId());
  return runInDurableObject(stub, (_instance, state) => fn(state));
}
