/**
 * `methods((scope) => ({ $name: fn, model: { name: fn } }))`: functions added
 * to the client (a `$` name) and to the models (a model's name). One factory,
 * run once per view it serves, the first time one of its methods is read; a
 * model method is called with `this` equal to the delegate it is read from.
 * The methods host (`methods.ts`) runs and checks it.
 */
import type {
  AnyTarget,
  ConsumesResults,
  EmptyFacts,
  MethodsCheck,
  MethodsFacts,
  MethodsScope,
  ModelName,
  Part,
} from "./contract";
import { builtPart } from "./extension";
import { methodsPart } from "./methods";

/** Functions added to the client and to the models of the extension's chain. */
export function methods<
  T extends AnyTarget,
  F extends (scope: MethodsScope<T>) => MethodsCheck<ReturnType<F>, T> = (
    scope: MethodsScope<T>
  ) => object,
>(
  factory: F
): Part<T, MethodsFacts<ReturnType<F>, ConsumesResults<F>, ModelName<T>>>;
export function methods(factory: (scope: never) => unknown): unknown {
  return buildMethods(factory);
}

/**
 * `methods` untyped: what an official extension builds its methods with,
 * typed by its own entry point rather than by an inferred target.
 */
export function buildMethods(
  factory: (scope: never) => unknown
): Part<AnyTarget, EmptyFacts>;
export function buildMethods(factory: (scope: never) => unknown): unknown {
  return builtPart([methodsPart], (draft) => {
    draft.methods = factory;
  });
}
