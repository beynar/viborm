import { Operation } from "./types/client/operations/defintion";
import { Schema } from "./types/client/schema";
import { Client } from "./types/client/client";

// Define the adapter interface
export interface AdapterInterface {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Core operations - these receive processed query objects
  execute(operation: {
    type: Operation;
    model: string;
    payload: any;
  }): Promise<any>;
}

function createRecursiveProxy<S extends Schema>(
  adapter: AdapterInterface,
  schema: S,
  callback: (opts: {
    modelName: keyof S;
    operation: Operation;
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
        operation: path[path.length - 2] as Operation,
        payload,
      });
    },
  });

  return proxy;
}

export interface VibeORMConfig<S extends Schema> {
  schema: S;
  adapter: AdapterInterface;
}

export class VibeORM<S extends Schema> {
  private adapter: AdapterInterface;
  private schema: S;
  private client: Client<S>;

  constructor(config: VibeORMConfig<S>) {
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
        return await this.adapter.execute({
          type: operation,
          model: String(modelName),
          payload: payload || {},
        });
      },
      []
    ) as Client<S>;
  }

  // More elegant approach - proxy the VibeORM itself
  private clientProxy = new Proxy(this, {
    get(target, prop) {
      if (typeof prop === "string" && target.schema[prop]) {
        return (target.client as any)[prop];
      }
      return (target as any)[prop];
    },
  });

  // Return the proxy instead of this
  static create<S extends Schema>(
    config: VibeORMConfig<S>
  ): Omit<VibeORM<S>, keyof S> & Client<S> {
    const orm = new VibeORM(config);
    return orm.clientProxy as Omit<VibeORM<S>, keyof S> & Client<S>;
  }

  async $connect(): Promise<void> {
    await this.adapter.connect();
  }

  async $disconnect(): Promise<void> {
    await this.adapter.disconnect();
  }

  // Raw query methods
  async $executeRaw(query: string, ...values: any[]): Promise<number> {
    return await this.adapter.execute({
      type: "executeRaw" as any,
      model: "",
      payload: { query, values },
    });
  }

  async $queryRaw<T = unknown>(query: string, ...values: any[]): Promise<T> {
    return await this.adapter.execute({
      type: "queryRaw" as any,
      model: "",
      payload: { query, values },
    });
  }
}

// Convenience function for creating ORM instances
export const createClient = <S extends Schema>(config: VibeORMConfig<S>) => {
  return VibeORM.create(config);
};
