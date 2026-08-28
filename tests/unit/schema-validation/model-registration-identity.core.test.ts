import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { generate, MemoryEstateStorage } from "@migrations";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { serializeModels } from "@src/migrations/serializer";
import { type AnyModel, s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { getSchemas } from "@src/schema/schemas";
import {
  resolveSchemaOrThrow,
  SchemaValidator,
  validateSchema,
} from "@src/schema/validation";
import { createSchemaRegistry } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

/**
 * ONE MODEL OBJECT BINDS ONE SCHEMA KEY (plan §6.1, §9.4; falsifier §11.2.22).
 *
 * Every derived name in the estate — table, junction table, index, constraint —
 * is generated from the SCHEMA KEY (ruling D24). HEAD let a second schema rebind
 * a model object freely, which meant a client built over the first schema
 * silently started emitting SQL for the second one's table. The binding is
 * write-once now, proved in a PREFLIGHT phase before any registry write, so a
 * refused schema never leaves models 0..N-1 bound while model N is rejected.
 *
 * Re-registering the SAME key stays idempotent: one schema composed twice, or a
 * second client over the same models, is a normal thing to do.
 */

class DefinitionDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();

  constructor() {
    super("postgresql", "registration-identity");
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The definition driver owns no provider resource.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

class EffectTrackingStorage extends MemoryEstateStorage {
  readonly accesses: string[] = [];

  override async readEstate() {
    this.accesses.push("readEstate");
    return super.readEstate();
  }

  override async publishEstate(bytes: Uint8Array) {
    this.accesses.push("publishEstate");
    return super.publishEstate(bytes);
  }
}

const REFUSAL = /one model object binds one schema key/;

describe("the write-once schema key", () => {
  it("binds, then accepts the same key again", () => {
    const shared = s.model({ id: s.string().id(), name: s.string() });

    hydrateSchemaNames({ alpha: shared });
    hydrateSchemaNames({ alpha: shared });

    expect(shared["~"].names.ts).toBe("alpha");
    expect(shared["~"].names.sql).toBe("alpha");
  });

  it("refuses a different key and leaves the first binding intact", () => {
    const shared = s.model({ id: s.string().id(), name: s.string() });
    hydrateSchemaNames({ alpha: shared });

    expect(() => hydrateSchemaNames({ beta: shared })).toThrow(REFUSAL);
    expect(shared["~"].names.ts).toBe("alpha");
    expect(shared["~"].names.sql).toBe("alpha");
  });

  it("refuses BEFORE writing any of the pass's other models", () => {
    const shared = s.model({ id: s.string().id() });
    hydrateSchemaNames({ alpha: shared });
    const fresh = s.model({ id: s.string().id() });

    expect(() => hydrateSchemaNames({ fresh, beta: shared })).toThrow(REFUSAL);
    // The preflight ran over every model first, so `fresh` was never bound.
    expect(fresh["~"].names.ts).toBeUndefined();
  });

  it("refuses two keys over one object inside ONE schema", () => {
    const shared = s.model({ id: s.string().id() });

    expect(() => hydrateSchemaNames({ alpha: shared, beta: shared })).toThrow(
      REFUSAL
    );
    expect(shared["~"].names.ts).toBeUndefined();
  });

  it("reports the same M003 through direct validation and resolution", () => {
    const shared = s.model({ id: s.string().id() });
    const models = { alpha: shared, beta: shared };

    const validation = validateSchema(models);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual([
      expect.objectContaining({ code: "M003", model: "beta" }),
    ]);
    expect(shared["~"].names.ts).toBeUndefined();

    const resolution = new SchemaValidator().registerAll(models).resolve();
    expect(resolution.ok).toBe(false);
    expect(resolution.issues).toEqual([
      expect.objectContaining({ code: "M003", model: "beta" }),
    ]);
    expect(() => resolveSchemaOrThrow(models)).toThrow("[M003]");
    expect(shared["~"].names.ts).toBeUndefined();
  });

  it("refuses direct registry and serializer construction before any binding", () => {
    for (const construct of [
      (models: Record<string, AnyModel>) => createSchemaRegistry(models),
      (models: Record<string, AnyModel>) =>
        serializeModels(models, { migrationDriver: postgresMigrationDriver }),
    ]) {
      const shared = s.model({ id: s.string().id() });
      const fresh = s.model({ id: s.string().id() });

      expect(() => construct({ fresh, alpha: shared, beta: shared })).toThrow(
        "[M003]"
      );
      expect(fresh["~"].names.ts).toBeUndefined();
      expect(shared["~"].names.ts).toBeUndefined();
    }
  });
});

describe("every effect-capable boundary refuses the rebind", () => {
  it("client construction", () => {
    const shared = s.model({ id: s.string().id() });
    createClient({ schema: { alpha: shared }, driver: new DefinitionDriver() });

    expect(() =>
      createClient({ schema: { beta: shared }, driver: new DefinitionDriver() })
    ).toThrow(REFUSAL);
    expect(shared["~"].names.sql).toBe("alpha");
  });

  it("registry-only construction", () => {
    const shared = s.model({ id: s.string().id() });
    getSchemas({ alpha: shared });

    expect(() => getSchemas({ beta: shared })).toThrow(REFUSAL);
    expect(shared["~"].names.sql).toBe("alpha");
  });

  it("migration generation refuses before storage access or file creation", async () => {
    const shared = s.model({ id: s.string().id() });
    hydrateSchemaNames({ alpha: shared });
    const storage = new EffectTrackingStorage();
    const client = {
      $driver: new DefinitionDriver(),
      $schema: { beta: shared },
    };

    await expect(
      generate(client, storage, { name: "rebind" })
    ).rejects.toThrow(REFUSAL);
    expect(storage.accesses).toEqual([]);
    expect(await storage.listStates()).toEqual([]);
    expect(shared["~"].names.ts).toBe("alpha");
    expect(shared["~"].names.sql).toBe("alpha");
  });

  it("push, including push({ skipValidation: true })", async () => {
    const shared = s.model({ id: s.string().id() });
    hydrateSchemaNames({ alpha: shared });
    const client = {
      $driver: new DefinitionDriver(),
      $schema: { beta: shared },
    };

    await expect(syncLiveSchema(client)).rejects.toThrow(REFUSAL);
    await expect(syncLiveSchema(client, { skipValidation: true })).rejects.toThrow(
      REFUSAL
    );
    expect(shared["~"].names.sql).toBe("alpha");
  });
});
