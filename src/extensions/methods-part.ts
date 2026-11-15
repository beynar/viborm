/**
 * `methods((scope) => ({ $name: fn }))`: functions added to the client, and
 * `modelMethods((scope) => ({ model: { name: fn } }))`: functions added to
 * the models. Each factory runs once per view it serves, the first time one
 * of its methods is read; a model method is called with `this` equal to the
 * delegate it is read from. Two builders, each bringing its own half of the
 * methods host (`methods.ts`): an extension that adds client methods only
 * carries no model-method code, and the reverse.
 */
import type {
  AnyTarget,
  ConsumesResults,
  MethodsCheck,
  MethodsFacts,
  MethodsScope,
  ModelName,
  Part,
} from "./contract";
import { clientLayer, methodsPart, modelLayer } from "./methods";

/** Functions added to the client of the extension's chain: `$` names. */
export function methods<
  T extends AnyTarget,
  F extends (
    scope: MethodsScope<T>
  ) => MethodsCheck<ReturnType<F>, T, "client"> = (
    scope: MethodsScope<T>
  ) => object,
>(factory: F): Part<T, MethodsFacts<ReturnType<F>, ConsumesResults<F>, never>>;
export function methods(factory: (scope: never) => unknown): unknown {
  return methodsPart(factory, clientLayer, (key) =>
    key.startsWith("$")
      ? undefined
      : "which is not a $ client method (a model's are written with modelMethods)"
  );
}

/** Functions added to the models of the extension's chain, by model. */
export function modelMethods<
  T extends AnyTarget,
  F extends (
    scope: MethodsScope<T>
  ) => MethodsCheck<ReturnType<F>, T, "model"> = (
    scope: MethodsScope<T>
  ) => object,
>(
  factory: F
): Part<T, MethodsFacts<ReturnType<F>, ConsumesResults<F>, ModelName<T>>>;
export function modelMethods(factory: (scope: never) => unknown): unknown {
  return methodsPart(factory, modelLayer, (key, schema) =>
    Object.hasOwn(schema, key) ? undefined : "which is not a model"
  );
}
