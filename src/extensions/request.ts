import type { OperationPayload, Operations, Schema } from "@client/types";
import { QueryError } from "@errors";
import { isFunction, isRecord } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ResolvedOperationHandler } from "./chain";
import { type AdmittedControls, controlsOwnedBy } from "./controls";

/** Frozen runtime contribution after hostile definition normalization. */
type RuntimeRequestFunction = (...args: never[]) => unknown;
export type RuntimeRequestContribution =
  | RuntimeRequestFunction
  | Readonly<Record<string, Readonly<Record<string, RuntimeRequestFunction>>>>;

type ResultShapeKey =
  | "select"
  | "include"
  | "omit"
  | "_count"
  | "_avg"
  | "_sum"
  | "_min"
  | "_max"
  | "by";

const resultShapeKeys = <const Keys extends readonly ResultShapeKey[]>(
  ...keys: Keys
): Readonly<Keys> => Object.freeze(keys);

/**
 * The single operation-specific owner of request properties that determine the
 * public result type. A future projection spelling extends this table; runtime
 * detachment and the handler input/patch types then change together.
 */
const RESULT_SHAPE_KEYS_BY_OPERATION = Object.freeze({
  findFirst: resultShapeKeys("select", "include", "omit"),
  findMany: resultShapeKeys("select", "include", "omit"),
  findUnique: resultShapeKeys("select", "include", "omit"),
  findUniqueOrThrow: resultShapeKeys("select", "include", "omit"),
  findFirstOrThrow: resultShapeKeys("select", "include", "omit"),
  create: resultShapeKeys("select", "include", "omit"),
  update: resultShapeKeys("select", "include", "omit"),
  delete: resultShapeKeys("select", "include", "omit"),
  upsert: resultShapeKeys("select", "include", "omit"),
  createMany: resultShapeKeys("select", "omit"),
  updateMany: resultShapeKeys("select", "omit"),
  deleteMany: resultShapeKeys("select", "omit"),
  count: resultShapeKeys("select"),
  aggregate: resultShapeKeys("_count", "_avg", "_sum", "_min", "_max"),
  groupBy: resultShapeKeys("by", "_count", "_avg", "_sum", "_min", "_max"),
  exist: resultShapeKeys(),
} satisfies Readonly<Record<Operations, readonly ResultShapeKey[]>>);

type ResultShapeKeyFor<Operation extends Operations> =
  (typeof RESULT_SHAPE_KEYS_BY_OPERATION)[Operation][number];

/** The operation input visible to an ordinary request transform. */
export type RequestTransformInput<
  Operation extends Operations,
  Input extends object,
> = Omit<Input, ResultShapeKeyFor<Operation>>;

/**
 * A shallow patch over the non-projection input. The optional `never`
 * properties make protected keys fail structurally, including held values.
 */
export type RequestTransformPatch<
  Operation extends Operations,
  Input extends object,
> = Partial<RequestTransformInput<Operation, Input>> & {
  readonly [Key in ResultShapeKeyFor<Operation>]?: never;
};

export interface RequestTransformContext<
  Operation extends Operations,
  Input extends object,
> {
  readonly model: string;
  readonly operation: Operation;
  readonly input: Readonly<RequestTransformInput<Operation, Input>>;
  /** The call's controls this handler's extension declares, and only those. */
  readonly controls?: AdmittedControls;
}

export interface GenericRequestContext {
  readonly model: string;
  readonly operation: Operations;
  readonly input: Readonly<
    RequestTransformPatch<Operations, Record<string, unknown>>
  >;
  /** The call's controls this handler's extension declares, and only those. */
  readonly controls?: AdmittedControls;
}

type GenericRequestHandlerCall = (
  context: GenericRequestContext
) => Readonly<RequestTransformPatch<Operations, Record<string, unknown>>>;

declare const officialRequestHandlerIdentity: unique symbol;

/** Public ordinary request handler; official identities cannot be erased into it. */
export type GenericRequestHandler = GenericRequestHandlerCall & {
  readonly [officialRequestHandlerIdentity]?: never;
};

/** Internal nominal call shape used by official request-based capabilities. */
export type OfficialGenericRequestHandler = GenericRequestHandlerCall & {
  readonly [officialRequestHandlerIdentity]: true;
};

type RequestOperationInput<
  S extends Schema,
  ModelName extends keyof S,
  OperationName extends Operations,
> = Extract<
  Exclude<OperationPayload<OperationName, S[ModelName]>, undefined>,
  object
>;

export type RequestHandlerMap<S extends Schema> = {
  readonly [ModelName in keyof S]?: {
    readonly [OperationName in Operations]?: (context: {
      readonly model: ModelName;
      readonly operation: OperationName;
      readonly input: Readonly<
        RequestTransformInput<
          OperationName,
          RequestOperationInput<S, ModelName, OperationName>
        >
      >;
      /** The call's controls this handler's extension declares, and only those. */
      readonly controls?: AdmittedControls;
    }) => RequestTransformPatch<
      OperationName,
      RequestOperationInput<S, ModelName, OperationName>
    >;
  };
};

/** One already-selected request transform in extension application order. */
export type RequestTransform<
  Operation extends Operations,
  Input extends object,
> = ResolvedOperationHandler<
  (
    context: RequestTransformContext<Operation, Input>
  ) => RequestTransformPatch<Operation, Input>
>;

interface DescriptorEntry {
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor;
}

type DescriptorState = DescriptorEntry[];

const EMPTY_REQUEST_INPUT: Readonly<Record<string, never>> = Object.freeze({});

/** What request transforms are told about the chain's controls. */
export interface RequestControls {
  /** Every control name on the chain: no patch may name one. */
  readonly names: ReadonlySet<string>;
  /** This call's admitted controls; each owner sees its own. */
  readonly admitted: AdmittedControls | undefined;
}

function hasRequestTransforms(
  transforms: readonly ResolvedOperationHandler[] | undefined
): transforms is readonly [
  ResolvedOperationHandler,
  ...ResolvedOperationHandler[],
] {
  return transforms !== undefined && transforms.length > 0;
}

/**
 * Apply an operation's synchronous request transforms without validating the
 * resulting operation input. Validation remains the next boundary's owner.
 *
 * The undefined/empty-handler branch is deliberately first and returns the
 * original value by identity: an unextended operation allocates and inspects
 * nothing here. A handled operation always materializes the descriptors that
 * were captured before the first handler ran, so a handler cannot mutate its
 * closed-over caller input and make that mutation authoritative.
 */
export function applyRequestTransforms<
  Operation extends Operations,
  Input extends object,
>(
  model: string,
  operation: Operation,
  input: Input | undefined,
  transforms: readonly RequestTransform<Operation, Input>[] | undefined,
  controls?: RequestControls
): Input | Record<string, unknown> | undefined;
export function applyRequestTransforms(
  model: string,
  operation: Operations,
  input: object | undefined,
  transforms: readonly ResolvedOperationHandler[] | undefined,
  controls?: RequestControls
): Record<string, unknown> | undefined;
export function applyRequestTransforms<
  Operation extends Operations,
  Input extends object,
>(
  model: string,
  operation: Operation,
  input: Input | undefined,
  transforms:
    | readonly RequestTransform<Operation, Input>[]
    | readonly ResolvedOperationHandler[]
    | undefined,
  controls?: RequestControls
): Input | Record<string, unknown> | undefined {
  if (!hasRequestTransforms(transforms)) return input;
  const firstTransform = transforms[0];

  const descriptors = readOwnDescriptors(
    input ?? EMPTY_REQUEST_INPUT,
    firstTransform,
    model,
    operation
  );
  let handlerInput = materializeHandlerInput<Operation, Input>(
    descriptors,
    operation
  );
  for (const [index, transform] of transforms.entries()) {
    const context: RequestTransformContext<Operation, Input> = Object.freeze(
      transform.controls === undefined
        ? { model, operation, input: handlerInput }
        : {
            model,
            operation,
            input: handlerInput,
            controls: controlsOwnedBy(controls?.admitted, transform.controls),
          }
    );
    const patch = invokeTransform(transform, context, model, operation);
    if (
      mergePatch(
        descriptors,
        patch,
        transform.extension,
        model,
        operation,
        controls?.names
      ) &&
      index + 1 < transforms.length
    ) {
      handlerInput = materializeHandlerInput<Operation, Input>(
        descriptors,
        operation
      );
    }
  }

  return materializeResult(descriptors);
}

function invokeTransform<Operation extends Operations, Input extends object>(
  transform: ResolvedOperationHandler,
  context: RequestTransformContext<Operation, Input>,
  model: string,
  operation: Operation
): unknown {
  try {
    return Reflect.apply(transform.handler, undefined, [context]);
  } catch (cause) {
    throw transformFailure(
      transform.extension,
      model,
      operation,
      "threw",
      normalizeThrown(cause)
    );
  }
}

function mergePatch(
  state: DescriptorState,
  patch: unknown,
  extension: string,
  model: string,
  operation: Operations,
  controlNames: ReadonlySet<string> | undefined
): boolean {
  let isAsync: boolean;
  try {
    isAsync = isPromiseLike(patch);
  } catch (cause) {
    throw transformFailure(
      extension,
      model,
      operation,
      "returned an unreadable patch",
      normalizeThrown(cause)
    );
  }

  if (isAsync) {
    throw transformFailure(
      extension,
      model,
      operation,
      "returned a promise",
      new TypeError("Request transforms must return synchronously")
    );
  }
  if (!isRecord(patch)) {
    throw transformFailure(
      extension,
      model,
      operation,
      "returned a non-record patch",
      new TypeError("Request transforms must return an object")
    );
  }

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(patch);
  } catch (cause) {
    throw transformFailure(
      extension,
      model,
      operation,
      "returned an unreadable patch",
      normalizeThrown(cause)
    );
  }
  // Decided from the key alone, before any descriptor is read: a control left
  // the arguments before any handler ran, and no patch puts one back.
  for (const key of keys) {
    if (typeof key === "string" && controlNames?.has(key)) {
      throw transformFailure(
        extension,
        model,
        operation,
        `named control "${key}"`,
        new TypeError("Request patches cannot set extension controls")
      );
    }
  }
  try {
    let changed = false;
    for (const key of keys) {
      // Decide from the key alone. A malicious getter behind a protected key is
      // never read or copied into the trusted operation input.
      if (isResultShapeKey(operation, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(patch, key);
      if (!descriptor) continue;
      const existingIndex = state.findIndex((entry) => entry.key === key);
      if (existingIndex === -1) {
        state.push({ key, descriptor });
      } else {
        state[existingIndex] = { key, descriptor };
      }
      changed = true;
    }
    return changed;
  } catch (cause) {
    throw transformFailure(
      extension,
      model,
      operation,
      "returned an unreadable patch",
      normalizeThrown(cause)
    );
  }
}

function readOwnDescriptors<Operation extends Operations>(
  value: object,
  transform: ResolvedOperationHandler,
  model: string,
  operation: Operation
): DescriptorState {
  try {
    const state: DescriptorState = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      state.push({ key, descriptor });
    }
    return state;
  } catch (cause) {
    throw transformFailure(
      transform.extension,
      model,
      operation,
      "could not inspect request input",
      normalizeThrown(cause)
    );
  }
}

function materializeHandlerInput<
  Operation extends Operations,
  Input extends object,
>(
  descriptors: DescriptorState,
  operation: Operation
): Readonly<RequestTransformInput<Operation, Input>>;
function materializeHandlerInput(
  descriptors: DescriptorState,
  operation: Operations
): Readonly<Record<string, unknown>> {
  const input = materializeDescriptors(descriptors, operation);
  return input === undefined ? EMPTY_REQUEST_INPUT : Object.freeze(input);
}

function materializeResult(
  descriptors: DescriptorState
): Record<string, unknown> {
  return materializeDescriptors(descriptors) ?? {};
}

function materializeDescriptors(
  state: DescriptorState,
  operation?: Operations
): Record<string, unknown> | undefined {
  let value: Record<string, unknown> | undefined;
  for (const { key, descriptor } of state) {
    if (operation !== undefined && isResultShapeKey(operation, key)) continue;
    value ??= {};
    Object.defineProperty(value, key, descriptor);
  }
  return value;
}

function isResultShapeKey(operation: Operations, key: PropertyKey): boolean {
  if (typeof key !== "string") return false;
  const protectedKeys: readonly string[] =
    RESULT_SHAPE_KEYS_BY_OPERATION[operation];
  return protectedKeys.includes(key);
}

function isPromiseLike(value: unknown): boolean {
  return isRecord(value) && "then" in value && isFunction(value.then);
}

function normalizeThrown(thrown: unknown): Error {
  return isError(thrown)
    ? thrown
    : new Error("Request transform threw a non-Error value");
}

function transformFailure(
  extension: string,
  model: string,
  operation: Operations,
  failure: string,
  cause: Error
): QueryError {
  return new QueryError(
    `Extension "${extension}" request handler for ${model}.${operation} ${failure}.`,
    {
      cause,
      meta: { model, operation },
    }
  );
}
