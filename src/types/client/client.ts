import {
  Operation,
  PayloadByOperation,
  ResultByOperation,
} from "./operations/defintion";
import type { Schema } from "./schema";

function createRecursiveProxy<S extends Schema>(
  callback: (opts: {
    modelName: keyof S;
    operation: Operation;
    payload: any;
  }) => unknown,
  path: string[]
) {
  const proxy: unknown = new Proxy(() => {}, {
    // @ts-ignore
    get(_obj, key) {
      if (typeof key === "string") {
        return createRecursiveProxy(callback, [...path, key]);
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

export const createClient = <S extends Schema>(schema: S) => {
  return createRecursiveProxy(({ modelName, operation, payload }) => {
    console.log(modelName, operation, payload);
  }, []) as Client<S>;
};

type Client<S extends Schema> = {
  [K in keyof S]: {
    [O in Operation]: <P extends PayloadByOperation<O, S[K]>>(
      args: P
    ) => ResultByOperation<O, S[K], P>;
  };
};
