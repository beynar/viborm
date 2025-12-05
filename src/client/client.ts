import { ProviderAdapter } from "@adapters";
import { Sql } from "@sql";
import { Client, Operations, Schema } from "./types";

function createRecursiveProxy<S extends Schema>(
  adapter: ProviderAdapter,
  schema: S,
  callback: (opts: {
    modelName: keyof S;
    operation: Operations;
    payload: any;
  }) => Promise<unknown>,
  path: string[]
) {
  const proxy: unknown = new Proxy(() => {}, {
    // @ts-ignore
    get(_obj, key) {
      if (typeof key === "string") {
        return createRecursiveProxy(adapter, schema, callback, [...path, key]);
      }
    },
    apply(_1, _2, [payload]) {
      return callback({
        modelName: path[path.length - 1] as keyof S,
        operation: path[path.length - 2] as Operations,
        payload,
      });
    },
  });

  return proxy;
}

export interface VibORMConfig<S extends Schema> {
  schema: S;
  adapter: ProviderAdapter;
}

export class VibORM<S extends Schema> {
  private adapter: ProviderAdapter;
  private schema: S;
  private client: Client<S>;

  constructor(config: VibORMConfig<S>) {
    this.adapter = config.adapter;
    this.schema = config.schema;
    this.client = this.createClient();
  }

  private createClient(): Client<S> {
    return createRecursiveProxy(
      this.adapter,
      this.schema,
      async ({ modelName, operation, payload }) => {
        // Get the model definition
        const model = this.schema[modelName];
        if (!model) {
          throw new Error(`Model "${String(modelName)}" not found in schema`);
        }

        // Execute the operation through the adapter
        // const sql = generateSQL
        // return await this.adapter.execute(sql);
      },
      []
    ) as Client<S>;
  }

  // More elegant approach - proxy the VibORM itself
  private clientProxy = new Proxy(this, {
    get(target, prop) {
      if (typeof prop === "string" && target.schema[prop]) {
        return (target.client as any)[prop];
      }
      return (target as any)[prop];
    },
  });

  // Return the proxy instead of this
  static create<S extends Schema>(config: VibORMConfig<S>) {
    const orm = new VibORM(config);
    return orm.clientProxy as Client<S> & {
      "~connect": () => Promise<void>;
      "~disconnect": () => Promise<void>;
      "~executeRaw": (query: string, ...values: any[]) => Promise<number>;
    };
  }

  "~connect"(): Promise<void> {
    return this.adapter.connect();
  }

  "~disconnect"(): Promise<void> {
    return this.adapter.disconnect();
  }

  // Raw query methods
  async "~executeRaw"(query: string, ...values: any[]): Promise<number> {
    return await this.adapter.execute(new Sql([query], values));
  }
}

// Convenience function for creating ORM instances
export const createClient = <S extends Schema>(config: VibORMConfig<S>) => {
  return VibORM.create(config);
};
