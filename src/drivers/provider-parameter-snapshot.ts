import { QueryError, VibORMErrorCode } from "@errors";
import { isDate } from "@validation/value-guards";
import type { QueryExecutionContext } from "./types";

type InvalidRawDateError = (parameterIndex: number) => Error;
type UnsupportedRawArrayError = (parameterIndex: number) => Error;

interface RawParameterErrors {
  readonly invalidDate: InvalidRawDateError;
  readonly unsupportedArray: UnsupportedRawArrayError;
}

interface RawParameterEdge {
  readonly descriptor: PropertyDescriptor;
  readonly key: PropertyKey;
  readonly value: unknown;
}

interface RawParameterNode {
  readonly edges: readonly RawParameterEdge[];
  readonly isArray: boolean;
  readonly properties: readonly RawParameterProperty[];
  readonly prototype: object | null;
  readonly source: object;
}

interface RawParameterProperty {
  readonly descriptor: PropertyDescriptor;
  readonly key: PropertyKey;
}

interface RawParameterGraph {
  readonly dateTimes: WeakMap<object, number>;
  readonly nodes: readonly RawParameterNode[];
  readonly roots: readonly unknown[];
}

type RawParameterNodeAnalysis =
  | { readonly kind: "node"; readonly shape: Omit<RawParameterNode, "source"> }
  | { readonly kind: "opaque" }
  | { readonly kind: "unsupported-array" };

const arrayIndex = /^(?:0|[1-9]\d*)$/;
const maximumArrayIndex = 4_294_967_294;

interface BuiltinPrototypeProperty {
  readonly descriptor: PropertyDescriptor;
  readonly key: PropertyKey;
}

function captureBuiltinPrototype(
  prototype: object
): readonly BuiltinPrototypeProperty[] {
  const properties: BuiltinPrototypeProperty[] = [];
  for (const key of Reflect.ownKeys(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) properties.push({ descriptor, key });
  }
  return Object.freeze(properties);
}

const objectPrototypeShape = captureBuiltinPrototype(Object.prototype);
const arrayPrototypeShape = captureBuiltinPrototype(Array.prototype);

function isArrayIndex(key: PropertyKey): boolean {
  if (typeof key !== "string" || !arrayIndex.test(key)) return false;
  const index = Number(key);
  return index <= maximumArrayIndex && String(index) === key;
}

function functionSource(value: unknown): string | undefined {
  if (typeof value !== "function") return;
  try {
    return Function.prototype.toString.call(value);
  } catch {
    return;
  }
}

function sameInertRecord(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return Object.is(left, right);
  }
  try {
    if (
      Object.getPrototypeOf(left) !== null ||
      Object.getPrototypeOf(right) !== null
    ) {
      return false;
    }
    const leftKeys = Reflect.ownKeys(left);
    const rightKeys = Reflect.ownKeys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < rightKeys.length; index += 1) {
      const leftKey = leftKeys[index];
      const rightKey = rightKeys[index];
      if (leftKey !== rightKey || rightKey === undefined) return false;
      const leftDescriptor = Object.getOwnPropertyDescriptor(left, rightKey);
      const rightDescriptor = Object.getOwnPropertyDescriptor(right, rightKey);
      if (
        leftDescriptor === undefined ||
        rightDescriptor === undefined ||
        !("value" in leftDescriptor) ||
        !("value" in rightDescriptor) ||
        leftDescriptor.configurable !== rightDescriptor.configurable ||
        leftDescriptor.enumerable !== rightDescriptor.enumerable ||
        leftDescriptor.writable !== rightDescriptor.writable ||
        !Object.is(leftDescriptor.value, rightDescriptor.value)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sameBuiltinDescriptor(
  actual: PropertyDescriptor,
  expected: PropertyDescriptor
): boolean {
  if (
    actual.configurable !== expected.configurable ||
    actual.enumerable !== expected.enumerable ||
    "value" in actual !== "value" in expected
  ) {
    return false;
  }
  if ("value" in actual && "value" in expected) {
    if (actual.writable !== expected.writable) return false;
    const expectedSource = functionSource(expected.value);
    if (expectedSource !== undefined) {
      return functionSource(actual.value) === expectedSource;
    }
    return sameInertRecord(actual.value, expected.value);
  }
  return (
    functionSource(actual.get) === functionSource(expected.get) &&
    functionSource(actual.set) === functionSource(expected.set)
  );
}

function hasBuiltinPrototypeShape(
  prototype: object,
  shape: readonly BuiltinPrototypeProperty[]
): boolean {
  try {
    const keys = Reflect.ownKeys(prototype);
    if (keys.length !== shape.length) return false;
    for (let index = 0; index < shape.length; index += 1) {
      const expected = shape[index];
      if (expected === undefined || keys[index] !== expected.key) return false;
      const actual = Object.getOwnPropertyDescriptor(prototype, expected.key);
      if (
        actual === undefined ||
        !sameBuiltinDescriptor(actual, expected.descriptor)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isObjectPrototype(prototype: object): boolean {
  try {
    return (
      Object.getPrototypeOf(prototype) === null &&
      hasBuiltinPrototypeShape(prototype, objectPrototypeShape)
    );
  } catch {
    return false;
  }
}

function isArrayPrototype(prototype: object): boolean {
  try {
    const parent = Object.getPrototypeOf(prototype);
    return (
      parent !== null &&
      isObjectPrototype(parent) &&
      hasBuiltinPrototypeShape(prototype, arrayPrototypeShape)
    );
  } catch {
    return false;
  }
}

/** Only arrays and records with inert inherited behavior are interpreted. */
function rawParameterNodeShape(value: object): RawParameterNodeAnalysis {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (isArray && prototype !== null && !isArrayPrototype(prototype)) ||
      (!isArray && prototype !== null && !isObjectPrototype(prototype))
    ) {
      return { kind: isArray ? "unsupported-array" : "opaque" };
    }

    const edges: RawParameterEdge[] = [];
    const properties: RawParameterProperty[] = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      properties.push({ descriptor, key });
      const isProviderVisible = isArray
        ? isArrayIndex(key)
        : descriptor.enumerable && typeof key === "string";
      if (!isProviderVisible) continue;
      if (!("value" in descriptor)) {
        return { kind: isArray ? "unsupported-array" : "opaque" };
      }
      edges.push({ descriptor, key, value: descriptor.value });
    }
    const toJSON = properties.find((property) => property.key === "toJSON");
    if (
      toJSON &&
      (!("value" in toJSON.descriptor) ||
        typeof toJSON.descriptor.value === "function")
    ) {
      return { kind: isArray ? "unsupported-array" : "opaque" };
    }
    return {
      kind: "node",
      shape: { edges, isArray, properties, prototype },
    };
  } catch {
    // An exotic record owns its traversal semantics. If reflection refuses an
    // array shape, it cannot safely reach provider array semantics.
    return { kind: isArray ? "unsupported-array" : "opaque" };
  }
}

function rawDateTime(
  value: unknown,
  parameterIndex: number,
  invalidDateError: InvalidRawDateError
): number | undefined {
  if (!isDate(value)) return;
  const time = Date.prototype.getTime.call(value);
  if (Number.isNaN(time)) throw invalidDateError(parameterIndex);
  return time;
}

function analyzeRawParameterGraph(
  params: readonly unknown[],
  errors: RawParameterErrors
): RawParameterGraph {
  const nodesBySource = new WeakMap<object, RawParameterNode>();
  const dateTimes = new WeakMap<object, number>();
  const nodes: RawParameterNode[] = [];
  const roots = new Array<unknown>(params.length);

  const discover = (
    value: unknown,
    parameterIndex: number
  ): RawParameterNode | undefined => {
    const time = rawDateTime(value, parameterIndex, errors.invalidDate);
    if (time !== undefined && typeof value === "object" && value !== null) {
      dateTimes.set(value, time);
      return;
    }
    if (typeof value !== "object" || value === null) return;

    const known = nodesBySource.get(value);
    if (known) return known;
    const analysis = rawParameterNodeShape(value);
    if (analysis.kind === "unsupported-array") {
      throw errors.unsupportedArray(parameterIndex);
    }
    if (analysis.kind === "opaque") return;
    const node: RawParameterNode = {
      ...analysis.shape,
      source: value,
    };
    nodesBySource.set(value, node);
    nodes.push(node);
    return node;
  };

  for (
    let parameterIndex = 0;
    parameterIndex < params.length;
    parameterIndex++
  ) {
    if (!Object.hasOwn(params, parameterIndex)) continue;
    const root = params[parameterIndex];
    roots[parameterIndex] = root;
    const rootTime = rawDateTime(root, parameterIndex, errors.invalidDate);
    if (rootTime !== undefined && typeof root === "object" && root !== null) {
      dateTimes.set(root, rootTime);
      continue;
    }
    const rootNode = discover(root, parameterIndex);
    if (!rootNode) continue;

    const pending = [rootNode];
    let cursor = 0;
    while (cursor < pending.length) {
      const node = pending[cursor];
      cursor += 1;
      if (!node) continue;
      for (const edge of node.edges) {
        const before = nodes.length;
        const child = discover(edge.value, parameterIndex);
        if (child && nodes.length > before) pending.push(child);
      }
    }
  }

  return { dateTimes, nodes, roots };
}

/** Validate every interpreted raw parameter before query interception. */
export function validateRawParameters(
  params: readonly unknown[],
  errors: RawParameterErrors
): void {
  analyzeRawParameterGraph(params, errors);
}

/**
 * Snapshot every admitted data-descriptor JSON container, preserving aliases,
 * cycles, and property descriptors. Foreign built-in containers normalize to
 * local prototypes. Custom record carriers and provider-native objects remain
 * opaque; arrays with custom provider-visible behavior are refused. A Proxy
 * can run reflection traps while presenting an admitted container shape; the
 * captured descriptor view, never the later mutable Proxy, reaches dispatch.
 */
function snapshotRawParameterGraph(
  params: readonly unknown[],
  errors: RawParameterErrors
): unknown[] {
  const graph = analyzeRawParameterGraph(params, errors);
  const copies = new WeakMap<object, object>();
  const copiedDates = new WeakMap<object, Date>();

  for (const node of graph.nodes) {
    const copy: object = node.isArray ? [] : {};
    if (node.prototype === null) Object.setPrototypeOf(copy, null);
    copies.set(node.source, copy);
  }

  const copiedValue = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const time = graph.dateTimes.get(value);
    if (time !== undefined) {
      const known = copiedDates.get(value);
      if (known) return known;
      const copy = new Date(time);
      copiedDates.set(value, copy);
      return copy;
    }
    return copies.get(value) ?? value;
  };

  for (const node of graph.nodes) {
    const copy = copies.get(node.source);
    if (!copy) continue;
    for (const property of node.properties) {
      if (node.isArray && property.key === "length") continue;
      const descriptor = property.descriptor;
      Object.defineProperty(
        copy,
        property.key,
        "value" in descriptor &&
          (node.isArray
            ? isArrayIndex(property.key)
            : descriptor.enumerable && typeof property.key === "string")
          ? { ...descriptor, value: copiedValue(descriptor.value) }
          : descriptor
      );
    }
    if (node.isArray) {
      const length = node.properties.find(
        (property) => property.key === "length"
      );
      if (length) Object.defineProperty(copy, "length", length.descriptor);
    }
  }

  const snapshot = new Array<unknown>(graph.roots.length);
  for (let index = 0; index < graph.roots.length; index++) {
    if (!Object.hasOwn(graph.roots, index)) continue;
    snapshot[index] = copiedValue(graph.roots[index]);
  }
  return snapshot;
}

function invalidProviderDateError(
  context: QueryExecutionContext,
  parameterIndex: number
): QueryError {
  return new QueryError(
    `Operation "${context.operation ?? "statement"}" received an invalid Date as bound parameter ${parameterIndex}. An invalid Date names no instant, so a provider either refuses the statement after dispatch or binds it as null.`,
    {
      code: VibORMErrorCode.INVALID_INPUT,
      meta: {
        parameterIndex,
        model: context.model,
        operation: context.operation,
        correlationId: context.correlationId,
      },
    }
  );
}

function unsupportedProviderArrayError(
  context: QueryExecutionContext,
  parameterIndex: number
): QueryError {
  return new QueryError(
    `Operation "${context.operation ?? "statement"}" received raw array parameter ${parameterIndex} with custom inherited or accessor behavior. VibORM cannot validate that behavior without invoking caller code before dispatch.`,
    {
      code: VibORMErrorCode.INVALID_INPUT,
      meta: {
        parameterIndex,
        model: context.model,
        operation: context.operation,
        correlationId: context.correlationId,
      },
    }
  );
}

/**
 * Preserve the raw Date admission invariant after the last trusted statement
 * transform. Non-raw statements keep the old shallow-copy path: their typed
 * inputs were validated upstream, and statement transforms are trusted. Raw
 * Date leaves are revalidated and every admitted data-descriptor array or
 * ordinary JSON record is detached. Reflection does not invoke accessors,
 * iterators, or `toJSON`; a Proxy may run its reflection traps, so its captured
 * descriptor view is the stable provider value. Arrays with custom inherited
 * or accessor behavior are refused. Custom record and provider-native carriers
 * remain opaque and are not traversed.
 */
export function snapshotProviderParameters(
  params: readonly unknown[],
  context: QueryExecutionContext
): unknown[] {
  if (context.model !== "$raw") return [...params];
  return snapshotRawParameterGraph(params, {
    invalidDate: (parameterIndex) =>
      invalidProviderDateError(context, parameterIndex),
    unsupportedArray: (parameterIndex) =>
      unsupportedProviderArrayError(context, parameterIndex),
  });
}
