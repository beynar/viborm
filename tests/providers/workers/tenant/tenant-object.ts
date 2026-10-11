import { Socket } from "node:net";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { createClient } from "@src/drivers/pg";
import { createDurableObjectStorageWriter } from "@src/migrations/storage/durable-object";
import {
  createTenantMigrator,
  type TenantMigrator,
  type TenantMigratorOptions,
} from "@src/migrations/tenant";
import pg from "pg";

export interface TenantEnv {
  /** PostgreSQL the tenant's tables live in; empty skips the suite. */
  readonly TENANT_PG_URL: string;
}

/**
 * One tenant, as the docs wire it: its migration history in this object's
 * own storage, its tables in one PostgreSQL schema, and one migrator that
 * every request and alarm of the object shares.
 */
export class TenantObject {
  readonly ctx: DurableObjectState;
  readonly namespace: string;
  readonly pool: pg.Pool;
  readonly client: TenantMigratorOptions["client"];
  readonly migrator: TenantMigrator;

  constructor(ctx: DurableObjectState, env: TenantEnv) {
    this.ctx = ctx;
    this.namespace = `tenant_${ctx.id.toString().slice(0, 16)}`;
    this.pool = new pg.Pool({
      connectionString: env.TENANT_PG_URL,
      max: 2,
      // workerd's own `node:net`. Under the vitest workspace, the pool
      // resolves `pg`'s require of `pg-cloudflare` without the `workerd`
      // condition and gets its empty stub; a wrangler bundle needs no stream.
      stream: () => new Socket(),
    });
    this.client = createClient({
      pool: this.pool,
      schema: {},
      namespace: this.namespace,
    });
    this.migrator = createTenantMigrator({
      client: this.client,
      history: createDurableObjectStorageWriter(ctx.storage),
      // A short lock wait, so the retry of a held lock is quick to see.
      limits: { statementTimeout: 20_000, lockWait: 500 },
    });
  }

  /** Any request resets the object, as an eviction or a crash would. */
  fetch(): Response {
    this.ctx.abort("reset");
    return new Response(null);
  }
}
