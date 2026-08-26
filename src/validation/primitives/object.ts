import { createJsonSchemaConverter } from "../json-schema/factory";
import type {
  InferInputShape,
  InferOutputShape,
  ThunkCast,
  ValidationResult,
  VibSchema,
} from "../types";
import { isFunction, isRecord } from "../value-guards";
import { fail, OK_NULL, OK_UNDEFINED, ok, validateArray } from "./helpers";

// =============================================================================
// Object Schema Types
// =============================================================================

/**
 * Object entries - a record of field names to schemas or thunks.
 */
export type ObjectEntries = Record<
  string,
  VibSchema<any, any> | ThunkCast<any, any>
>;

/**
 * Options for object schemas.
 */
export interface ObjectOptions<T = unknown, TKeys extends string = string> {
  /** Make all fields optional (default: true) */
  partial?: boolean;
  /** Reject unknown keys (default: true) */
  strict?: boolean;
  /** Make the object itself optional (undefined allowed) */
  optional?: boolean;
  /** Make the object itself nullable (null allowed) */
  nullable?: boolean;
  /** Validate as array of objects */
  array?: boolean;
  /** Default value when undefined/null */
  default?: T | (() => T);
  /** Transform output */
  transform?: (value: T) => T;
  /** Object name for circular references in json schema*/
  name?: string;
  /** Object description for json schema*/
  description?: string;
  /** Require at least these specific keys (works with partial: true) */
  atLeast?: TKeys[];
  /** Require at least one key from each group to be present */
  requiresOneOf?: readonly (readonly TKeys[])[];
  /** Require one key set from each group; all keys in the chosen set must be present */
  requiresOneOfKeySets?: readonly (readonly (readonly TKeys[])[])[];
  /** Omit these keys entirely from the type and validation */
  omit?: TKeys[];
  /** Require at least one key to be present (object cannot be empty) */
  nonEmpty?: boolean;
}

/**
 * Omit specific keys from a type entirely.
 * Preserves optionality of remaining keys.
 */
type VOmit<T, K extends string> = {
  [P in keyof T as P extends K ? never : P]: T[P];
};

type OmittedKeyUnion<TKeys> = TKeys extends readonly PropertyKey[]
  ? Extract<TKeys[number], string>
  : never;

type KeepRequirementGroup<
  Group,
  OmittedKeys extends string,
> = Group extends readonly string[]
  ? [Extract<Group[number], OmittedKeys>] extends [never]
    ? Group
    : never
  : never;

type KeepRequirementKeySetGroup<
  Group,
  OmittedKeys extends string,
> = Group extends readonly (readonly string[])[]
  ? [Extract<Group[number][number], OmittedKeys>] extends [never]
    ? Group
    : never
  : never;

type ActiveRequirementGroups<
  Groups,
  OmittedKeys extends string,
> = Groups extends readonly [
  infer Group extends readonly string[],
  ...infer Rest extends readonly (readonly string[])[],
]
  ? KeepRequirementGroup<Group, OmittedKeys> extends never
    ? ActiveRequirementGroups<Rest, OmittedKeys>
    : readonly [
        KeepRequirementGroup<Group, OmittedKeys>,
        ...ActiveRequirementGroups<Rest, OmittedKeys>,
      ]
  : Groups extends readonly (infer Group extends readonly string[])[]
    ? readonly Exclude<KeepRequirementGroup<Group, OmittedKeys>, never>[]
    : readonly [];

type ActiveRequirementKeySetGroups<
  Groups,
  OmittedKeys extends string,
> = Groups extends readonly [
  infer Group extends readonly (readonly string[])[],
  ...infer Rest extends readonly (readonly (readonly string[])[])[],
]
  ? KeepRequirementKeySetGroup<Group, OmittedKeys> extends never
    ? ActiveRequirementKeySetGroups<Rest, OmittedKeys>
    : readonly [
        KeepRequirementKeySetGroup<Group, OmittedKeys>,
        ...ActiveRequirementKeySetGroups<Rest, OmittedKeys>,
      ]
  : Groups extends readonly (infer Group extends
        readonly (readonly string[])[])[]
    ? readonly Exclude<KeepRequirementKeySetGroup<Group, OmittedKeys>, never>[]
    : readonly [];

type ActiveOmitRequirements<TOpts, OmittedKeys extends string> = Omit<
  TOpts,
  "requiresOneOf" | "requiresOneOfKeySets"
> &
  (TOpts extends {
    requiresOneOf: infer Groups extends readonly (readonly string[])[];
  }
    ? {
        requiresOneOf: ActiveRequirementGroups<Groups, OmittedKeys>;
      }
    : unknown) &
  (TOpts extends {
    requiresOneOfKeySets: infer Groups extends
      readonly (readonly (readonly string[])[])[];
  }
    ? {
        requiresOneOfKeySets: ActiveRequirementKeySetGroups<
          Groups,
          OmittedKeys
        >;
      }
    : unknown);

/**
 * Compute input type based on partial option.
 * Default is partial: true, so only non-partial when explicitly { partial: false }
 * If atLeast is specified, those keys are required even when partial: true
 * If omit is specified, those keys are removed from the type entirely
 */
type ComputeObjectInput<TEntries, TOpts> = TOpts extends {
  omit: infer OmitKeys extends readonly string[];
}
  ? TOpts extends { partial: false }
    ? ApplyRequiresOneOf<
        VOmit<InferInputShape<TEntries>, OmitKeys[number]>,
        ActiveOmitRequirements<TOpts, OmitKeys[number]>
      >
    : TOpts extends { atLeast: infer Keys extends readonly string[] }
      ? ApplyRequiresOneOf<
          VOmit<
            RequireKeys<Partial<InferInputShape<TEntries>>, Keys[number]>,
            OmitKeys[number]
          >,
          ActiveOmitRequirements<TOpts, OmitKeys[number]>
        >
      : ApplyRequiresOneOf<
          VOmit<Partial<InferInputShape<TEntries>>, OmitKeys[number]>,
          ActiveOmitRequirements<TOpts, OmitKeys[number]>
        >
  : TOpts extends { partial: false }
    ? ApplyRequiresOneOf<InferInputShape<TEntries>, TOpts>
    : TOpts extends { atLeast: infer Keys extends readonly string[] }
      ? ApplyRequiresOneOf<
          RequireKeys<Partial<InferInputShape<TEntries>>, Keys[number]>,
          TOpts
        >
      : ApplyRequiresOneOf<Partial<InferInputShape<TEntries>>, TOpts>;

/**
 * Compute output type based on entries.
 * Unlike input, output doesn't use Partial - each field's schema determines
 * whether its output includes undefined (based on whether it has a default).
 */
type ComputeObjectOutput<TEntries, _TOpts> = InferOutputShape<TEntries>;

/**
 * Make specific keys required in an otherwise partial object.
 * Uses a mapped type instead of Omit & Required<Pick> to reduce type depth.
 */
type RequireKeys<T, K extends string> = {
  [P in keyof T as P extends K ? never : P]?: T[P];
} & {
  [P in keyof T as P extends K ? P : never]-?: T[P];
};

type RequireOneKey<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? RequireKeys<T, Extract<K, string>>
    : never
  : never;

type ApplyRequiresOneOf<T, TOpts> = TOpts extends {
  requiresOneOf: infer Groups extends readonly (readonly string[])[];
}
  ? ApplyRequiresOneOfKeySets<ApplyRequiresOneOfGroups<T, Groups>, TOpts>
  : ApplyRequiresOneOfKeySets<T, TOpts>;

type ApplyRequiresOneOfGroups<T, Groups> = Groups extends readonly [
  infer Group extends readonly string[],
  ...infer Rest extends readonly (readonly string[])[],
]
  ? ApplyRequiresOneOfGroups<RequireOneKey<T, Group[number]>, Rest>
  : Groups extends readonly (infer Group extends readonly string[])[]
    ? [Group[number]] extends [never]
      ? T
      : RequireOneKey<T, Group[number]>
    : T;

type ApplyRequiresOneOfKeySets<TCurrent, TOpts> = TOpts extends {
  requiresOneOfKeySets: infer Groups extends
    readonly (readonly (readonly string[])[])[];
}
  ? ApplyRequiresOneOfKeySetGroups<TCurrent, Groups>
  : TCurrent;

type RequireKeySet<T, K extends PropertyKey> = T extends unknown
  ? RequireKeys<T, Extract<K, string>>
  : never;

type RequireOneKeySet<T, Alternatives> = [Alternatives] extends [never]
  ? T
  : Alternatives extends readonly []
    ? never
    : Alternatives extends readonly [
          infer KeySet extends readonly string[],
          ...infer Rest extends readonly (readonly string[])[],
        ]
      ? RequireKeySet<T, KeySet[number]> | RequireOneKeySet<T, Rest>
      : Alternatives extends readonly (infer KeySet extends readonly string[])[]
        ? [KeySet[number]] extends [never]
          ? T
          : RequireKeySet<T, KeySet[number]>
        : T;

type UnionToIntersection<T> = (
  T extends unknown
    ? (value: T) => void
    : never
) extends (value: infer I) => void
  ? I
  : never;

type RequireEveryKeySetGroup<T, Group> =
  UnionToIntersection<
    Group extends unknown ? { value: RequireOneKeySet<T, Group> } : never
  > extends { value: infer I }
    ? I & T
    : T;

type ApplyRequiresOneOfKeySetGroups<T, Groups> = Groups extends readonly [
  infer Group extends readonly (readonly string[])[],
  ...infer Rest extends readonly (readonly (readonly string[])[])[],
]
  ? ApplyRequiresOneOfKeySetGroups<RequireOneKeySet<T, Group>, Rest>
  : Groups extends readonly (infer Group extends
        readonly (readonly string[])[])[]
    ? [Group] extends [never]
      ? T
      : RequireEveryKeySetGroup<T, Group>
    : T;

/**
 * Apply wrapper options (optional, nullable, array) to input type.
 * Input accepts undefined when optional (even with default).
 */
type ApplyObjectOptionsInput<TBase, TOpts> = TOpts extends { array: true }
  ? TOpts extends { optional: true }
    ? TOpts extends { nullable: true }
      ? TBase[] | undefined | null
      : TBase[] | undefined
    : TOpts extends { nullable: true }
      ? TBase[] | null
      : TBase[]
  : TOpts extends { optional: true }
    ? TOpts extends { nullable: true }
      ? TBase | undefined | null
      : TBase | undefined
    : TOpts extends { nullable: true }
      ? TBase | null
      : TBase;

/**
 * Apply wrapper options (optional, nullable, array) to output type.
 * When a default is provided, undefined is not included in output
 * (the default will always be applied).
 */
type ApplyObjectOptionsOutput<TBase, TOpts> = TOpts extends { array: true }
  ? TOpts extends { optional: true }
    ? TOpts extends { default: any }
      ? TOpts extends { nullable: true }
        ? TBase[] | null
        : TBase[]
      : TOpts extends { nullable: true }
        ? TBase[] | undefined | null
        : TBase[] | undefined
    : TOpts extends { nullable: true }
      ? TBase[] | null
      : TBase[]
  : TOpts extends { optional: true }
    ? TOpts extends { default: any }
      ? TOpts extends { nullable: true }
        ? TBase | null
        : TBase
      : TOpts extends { nullable: true }
        ? TBase | undefined | null
        : TBase | undefined
    : TOpts extends { nullable: true }
      ? TBase | null
      : TBase;

/**
 * Object schema interface.
 */
export interface ObjectSchema<
  TEntries,
  TOpts extends ObjectOptions | undefined = undefined,
  TInput = ApplyObjectOptionsInput<ComputeObjectInput<TEntries, TOpts>, TOpts>,
  TOutput = ApplyObjectOptionsOutput<
    ComputeObjectOutput<TEntries, TOpts>,
    TOpts
  >,
> extends VibSchema<TInput, TOutput> {
  readonly type: "object";
  readonly entries: TEntries;
  readonly options: TOpts;
  readonly parse: VibSchema<TInput, TOutput>["~standard"]["validate"];
  /** Extend this schema with additional entries */
  extend<
    TNewEntries extends ObjectEntries,
    TNewTOpts extends ObjectOptions | undefined = undefined,
  >(
    newEntries: TNewEntries,
    options?: TNewTOpts
  ): ObjectSchema<TEntries & TNewEntries, TOpts & TNewTOpts>;
}

/** An object schema whose parser omits keys from both its input and output. */
export type OmittedObjectSchema<
  TEntries,
  TOpts extends ObjectOptions | undefined,
  TKeys extends readonly PropertyKey[] | undefined,
> = ObjectSchema<
  TEntries,
  TOpts,
  ApplyObjectOptionsInput<ComputeObjectInput<TEntries, TOpts>, TOpts>,
  ApplyObjectOptionsOutput<
    VOmit<InferOutputShape<TEntries>, OmittedKeyUnion<TKeys>>,
    TOpts
  >
>;

// =============================================================================
// Object Schema Implementation
// =============================================================================

// Pre-computed error for fast path (frozen — shared across all callers)
const OBJECT_TYPE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected object" })]),
});

const EMPTY_METADATA_ARRAY: readonly never[] = Object.freeze([]);
const EMPTY_KEY_INDEX: ReadonlyMap<string, number> = Object.freeze(new Map());
const INPUT_VALUE_UNREAD = Symbol("inputValueUnread");

function readObjectInputValue(
  input: Record<string, unknown>,
  key: string,
  inputValueScratch: unknown[] | undefined,
  inputValueScratchIndexByName: ReadonlyMap<string, number> | undefined
): unknown {
  if (
    inputValueScratch === undefined ||
    inputValueScratchIndexByName === undefined
  ) {
    return input[key];
  }
  const scratchIndex = inputValueScratchIndexByName.get(key);
  if (scratchIndex === undefined) return input[key];
  const settledInputValue = inputValueScratch[scratchIndex];
  if (settledInputValue !== INPUT_VALUE_UNREAD) return settledInputValue;
  const inputValue = input[key];
  inputValueScratch[scratchIndex] = inputValue;
  return inputValue;
}

/**
 * Create an optimized validator for an object schema.
 * Minimal overhead, Valibot-style simplicity.
 */
function createObjectValidator(
  entries: ObjectEntries,
  options: ObjectOptions = {}
): (value: unknown) => ValidationResult<Record<string, unknown>> {
  const {
    partial = true,
    strict = true,
    atLeast,
    requiresOneOf,
    requiresOneOfKeySets,
    omit,
    nonEmpty,
  } = options;
  let keys: readonly string[] = EMPTY_METADATA_ARRAY;
  let keyIndex = EMPTY_KEY_INDEX;
  let validates: readonly ((value: unknown) => any)[] = EMPTY_METADATA_ARRAY;
  let activeRequiresOneOf: ObjectOptions["requiresOneOf"];
  let activeRequiresOneOfKeySets: ObjectOptions["requiresOneOfKeySets"];
  let isFullyPartial = true;
  let runOnMissingIdx: readonly number[] = EMPTY_METADATA_ARRAY;
  let acceptsUndefined: readonly boolean[] = EMPTY_METADATA_ARRAY;
  let requiredByAtLeast: readonly boolean[] | null = null;
  let inputValueScratchTemplate: readonly unknown[] | undefined;
  let inputValueScratchIndexByName: ReadonlyMap<string, number> | undefined;

  // Compile only when a record first reaches this validator. Registry schemas
  // that are never used retain their public entries, but no lookup structures.
  let resolve: (() => void) | undefined;
  resolve = () => {
    // Release this resolver before resolving thunks. The state arrays are
    // published below, so a circular thunk observes initialized storage.
    resolve = undefined;

    const omitSet = omit ? new Set(omit) : null;
    const resolvedKeys = Object.keys(entries).filter(
      (key) => !omitSet?.has(key)
    );
    const atLeastSet = atLeast ? new Set(atLeast) : null;
    const resolvedKeyIndex = new Map<string, number>();
    const resolvedValidates: ((value: unknown) => any)[] = new Array(
      resolvedKeys.length
    );
    const resolvedIsFullyPartial = partial && !atLeastSet;
    const resolvedActiveRequiresOneOf = requiresOneOf?.filter(
      (group) => !group.some((key) => omitSet?.has(key))
    );
    const resolvedActiveRequiresOneOfKeySets = requiresOneOfKeySets?.filter(
      (group) =>
        !group.some((keySet) => keySet.some((key) => omitSet?.has(key)))
    );
    let mutableRunOnMissingIdx: number[] | undefined;
    let mutableAcceptsUndefined: boolean[] | undefined;

    keys = resolvedKeys;
    keyIndex = resolvedKeyIndex;
    validates = resolvedValidates;
    activeRequiresOneOf = resolvedActiveRequiresOneOf;
    activeRequiresOneOfKeySets = resolvedActiveRequiresOneOfKeySets;
    isFullyPartial = resolvedIsFullyPartial;

    if (resolvedIsFullyPartial) {
      mutableRunOnMissingIdx = [];
      runOnMissingIdx = mutableRunOnMissingIdx;
      acceptsUndefined = EMPTY_METADATA_ARRAY;
      requiredByAtLeast = null;
    } else {
      mutableAcceptsUndefined = new Array(resolvedKeys.length);
      runOnMissingIdx = EMPTY_METADATA_ARRAY;
      acceptsUndefined = mutableAcceptsUndefined;
      // Sparse atLeast schemas cache required flags. Fully-required schemas
      // derive the answer from partial=false without retaining another array.
      requiredByAtLeast =
        partial && atLeastSet
          ? resolvedKeys.map((key) => atLeastSet.has(key))
          : null;
    }

    // Publish the arrays before resolving thunks to preserve circular references.
    for (let i = 0; i < resolvedKeys.length; i++) {
      const key = resolvedKeys[i]!;
      resolvedKeyIndex.set(key, i);
      const entry = entries[key]!;
      const schema = isFunction(entry)
        ? (entry as () => VibSchema<any, any>)()
        : entry;

      resolvedValidates[i] = schema["~standard"].validate;
      const doesAcceptUndefined =
        (schema as { acceptsUndefined?: boolean }).acceptsUndefined === true;

      if (mutableRunOnMissingIdx) {
        if (doesAcceptUndefined) mutableRunOnMissingIdx.push(i);
      } else if (mutableAcceptsUndefined) {
        mutableAcceptsUndefined[i] = doesAcceptUndefined;
      }
    }

    const resolvedInputValueScratchIndexByName = new Map<string, number>();
    const registerInputValueScratchIndex = (key: string): void => {
      if (resolvedInputValueScratchIndexByName.has(key)) return;
      resolvedInputValueScratchIndexByName.set(
        key,
        resolvedInputValueScratchIndexByName.size
      );
    };
    for (const group of resolvedActiveRequiresOneOf ?? EMPTY_METADATA_ARRAY) {
      for (const key of group) registerInputValueScratchIndex(key);
    }
    for (const group of resolvedActiveRequiresOneOfKeySets ??
      EMPTY_METADATA_ARRAY) {
      for (const keySet of group) {
        for (const key of keySet) registerInputValueScratchIndex(key);
      }
    }
    for (const i of runOnMissingIdx) {
      registerInputValueScratchIndex(resolvedKeys[i]!);
    }
    if (resolvedInputValueScratchIndexByName.size > 0) {
      inputValueScratchTemplate = Array.from(
        { length: resolvedInputValueScratchIndexByName.size },
        () => INPUT_VALUE_UNREAD
      );
      inputValueScratchIndexByName = resolvedInputValueScratchIndexByName;
    }
  };

  return (value: unknown): ValidationResult<Record<string, unknown>> => {
    // Type check
    if (!isRecord(value)) {
      return OBJECT_TYPE_ERROR as ValidationResult<Record<string, unknown>>;
    }

    const input = value as Record<string, unknown>;
    if (resolve) resolve();
    const output: Record<string, unknown> = {};
    const inputValueScratch = inputValueScratchTemplate?.slice();

    // Strict mode: check for extra keys first (fail-fast)
    if (strict) {
      for (const key in input) {
        if (!keyIndex.has(key)) {
          return { issues: [{ message: `Unknown key: ${key}`, path: [key] }] };
        }
      }
    }

    // Check for nonEmpty constraint
    if (nonEmpty === true) {
      // Check if object has any keys at all (including unknown keys when strict: false)
      let hasAnyKey = false;
      for (const _key in input) {
        hasAnyKey = true;
        break;
      }
      if (!hasAnyKey) {
        return {
          issues: [{ message: "Object cannot be empty" }],
        };
      }
    }

    if (activeRequiresOneOf) {
      for (const group of activeRequiresOneOf) {
        const hasOne = group.some(
          (key) =>
            readObjectInputValue(
              input,
              key,
              inputValueScratch,
              inputValueScratchIndexByName
            ) !== undefined
        );
        if (!hasOne) {
          return {
            issues: [
              {
                message: `Missing required field: one of ${group.join(", ")}`,
              },
            ],
          };
        }
      }
    }

    if (activeRequiresOneOfKeySets) {
      for (const group of activeRequiresOneOfKeySets) {
        const hasAlternative = group.some((keySet) =>
          keySet.every(
            (key) =>
              readObjectInputValue(
                input,
                key,
                inputValueScratch,
                inputValueScratchIndexByName
              ) !== undefined
          )
        );
        if (!hasAlternative) {
          const alternatives = group
            .map((keySet) => keySet.join(", "))
            .join(" or ");
          return {
            issues: [
              {
                message: `Missing required fields: one of ${alternatives}`,
              },
            ],
          };
        }
      }
    }

    // Fast path for fully-partial objects (where/select/orderBy args):
    // iterate input keys instead of all schema keys, and don't materialize
    // undefined entries for absent keys — output stays input-sized.
    if (isFullyPartial) {
      for (const key in input) {
        const i = keyIndex.get(key);
        if (i === undefined) {
          // unknown key with strict: false — dropped, as before
          continue;
        }

        // Explicit undefined is treated as absent (Prisma parity): it is
        // neither validated nor materialized. Downstream consumers use key
        // presence ("where" in config, hasRecordKeys) as meaningful, so
        // { f: undefined } must behave exactly like {}. Defaults for such
        // keys still fire via the absent-keys loop below.
        const inputValue = readObjectInputValue(
          input,
          key,
          inputValueScratch,
          inputValueScratchIndexByName
        );
        if (inputValue === undefined) {
          continue;
        }

        const result = validates[i]!(inputValue);
        if (result.issues) {
          const issue = result.issues[0]!;
          return {
            issues: [
              {
                message: issue.message,
                path: issue.path ? [key].concat(issue.path) : [key],
              },
            ],
          };
        }
        if (result.value !== undefined) {
          output[key] = result.value;
        }
      }

      // Keys that are absent (or explicitly undefined) only matter when their
      // schema can apply a default
      for (const i of runOnMissingIdx) {
        const key = keys[i]!;
        if (
          readObjectInputValue(
            input,
            key,
            inputValueScratch,
            inputValueScratchIndexByName
          ) !== undefined
        ) {
          continue;
        }
        const result = validates[i]!(undefined);
        if (result.value !== undefined) {
          output[key] = result.value;
        }
      }

      return { value: output };
    }

    // Slow path (partial: false or atLeast): output is intentionally DENSE —
    // every schema key is materialized, including undefined. Create/update
    // data schemas rely on this to surface defaults; required keys are always
    // present in valid input anyway, so sparse vs dense doesn't diverge there.
    // Validate each field - direct array access, no object property lookup
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;

      // Handle an ABSENT key — which, per Prisma parity, includes a key that is
      // present with an explicit `undefined`. This is the same rule the
      // fully-partial fast path above applies, the same rule `requiresOneOf`
      // already applies here (`input[key] !== undefined`), and the same rule the
      // whole client surface is documented to follow: `{ f: undefined }` must
      // behave exactly like `{}`, so the spread-an-optional idiom
      // (`{ ...(sel && { select: sel }) }` collapsed to `{ select: sel }`) works.
      // Testing `key in input` instead made an optional key spelled `undefined`
      // validate `undefined` against a schema that does not accept it —
      // `createMany({ data, select: undefined })` failed with "Expected object"
      // while the identical `deleteMany` call (fully partial, fast path)
      // returned `{ count }`.
      const inputValue = readObjectInputValue(
        input,
        key,
        inputValueScratch,
        inputValueScratchIndexByName
      );
      if (inputValue === undefined) {
        // Key is required (partial: false OR in atLeast) and schema doesn't accept undefined
        if (
          (!partial || requiredByAtLeast?.[i] === true) &&
          !acceptsUndefined[i]
        ) {
          return {
            issues: [
              { message: `Missing required field: ${key}`, path: [key] },
            ],
          };
        }

        // If schema accepts undefined, run validator to apply defaults
        if (acceptsUndefined[i]) {
          const result = validates[i]!(undefined);
          output[key] = result.value;
        } else {
          // Scalar is optional (partial: true, not in atLeast) but schema doesn't have defaults
          // Just set to undefined without running validator
          output[key] = undefined;
        }
        continue;
      }

      // Validate field - direct function call
      const result = validates[i]!(inputValue);

      // Handle validation error (most common unhappy path)
      if (result.issues) {
        const issue = result.issues[0]!;
        return {
          issues: [
            {
              message: issue.message,
              path: issue.path ? [key].concat(issue.path) : [key],
            },
          ],
        };
      }

      output[key] = result.value;
    }

    return { value: output };
  };
}

/**
 * Create an object schema.
 *
 * IMPORTANT: No constraint on TEntries to allow circular reference resolution.
 * The identity conditional (R extends infer _ ? _ : never) defers type evaluation.
 *
 * @param entries - Object schema entries
 * @param options - Schema options
 *   - `strict` (default: true) - Reject unknown keys
 *   - `partial` (default: true) - Make all fields optional
 *   - `optional` - Allow undefined
 *   - `nullable` - Allow null
 *   - `array` - Validate as array of objects
 *   - `default` - Default value
 *   - `transform` - Transform output
 *
 * @example
 * // Basic object (strict by default)
 * const user = v.object({
 *   name: v.string(),
 *   age: v.number(),
 * });
 *
 * // Circular references
 * const node = v.object({
 *   value: v.string(),
 *   child: () => node,  // Thunk
 * });
 */
export function object<TEntries>(
  entries: TEntries
): ObjectSchema<TEntries, undefined>;
export function object<TEntries, const TOpts extends ObjectOptions | undefined>(
  entries: TEntries,
  options?: TOpts
): ObjectSchema<TEntries, TOpts>;
export function object<
  TEntries, // NO constraint - critical for circular references
  const TOpts extends ObjectOptions | undefined,
  R = ObjectSchema<TEntries, TOpts>,
>(entries: TEntries, options?: TOpts): R extends infer _ ? _ : never {
  type BaseOutput = ComputeObjectOutput<TEntries, TOpts>;

  // Pre-create the optimized object validator (caches keys and schemas)
  const validateObj = createObjectValidator(entries as ObjectEntries, options);

  // Check if we have wrapper options (optional/nullable/array)
  const hasOptional = options?.optional === true;
  const hasNullable = options?.nullable === true;
  const hasArray = options?.array === true;
  const hasTransform = options?.transform !== undefined;
  const hasDefault = options?.default !== undefined;

  // Fast path: no wrapper options (most common case)
  const needsWrapper =
    hasOptional || hasNullable || hasArray || hasTransform || hasDefault;

  let validate: (value: unknown) => any;

  if (needsWrapper) {
    // Pre-compute default getter once (avoid repeated typeof checks)
    const getDefault = hasDefault
      ? isFunction(options!.default)
        ? (options!.default as () => BaseOutput)
        : () => options!.default as BaseOutput
      : null;

    // Create the base validator (with optional transform)
    const validateItem = hasTransform
      ? (value: unknown): ValidationResult<any> => {
          const result = validateObj(value);
          if (result.issues) return result;
          try {
            return ok(options!.transform!((result as { value: any }).value));
          } catch (error) {
            return fail(
              `Transform failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      : validateObj;

    // Build wrapper based on options
    if (hasArray) {
      // Array mode: use shared validateArray utility
      const arrayValidate = (value: unknown) =>
        validateArray(value, validateItem);

      if (hasOptional && hasNullable) {
        validate = (value: unknown) => {
          if (value === undefined)
            return getDefault ? ok(getDefault()) : OK_UNDEFINED;
          if (value === null) return OK_NULL;
          return arrayValidate(value);
        };
      } else if (hasOptional) {
        validate = (value: unknown) => {
          if (value === undefined)
            return getDefault ? ok(getDefault()) : OK_UNDEFINED;
          return arrayValidate(value);
        };
      } else if (hasNullable) {
        validate = (value: unknown) => {
          if (value === null) return OK_NULL;
          return arrayValidate(value);
        };
      } else {
        validate = arrayValidate;
      }
    } else if (hasOptional && hasNullable) {
      // Single object mode
      validate = (value: unknown) => {
        if (value === undefined)
          return getDefault ? ok(getDefault()) : OK_UNDEFINED;
        if (value === null) return OK_NULL;
        return validateItem(value);
      };
    } else if (hasOptional) {
      validate = (value: unknown) => {
        if (value === undefined)
          return getDefault ? ok(getDefault()) : OK_UNDEFINED;
        return validateItem(value);
      };
    } else if (hasNullable) {
      validate = (value: unknown) => {
        if (value === null) return OK_NULL;
        return validateItem(value);
      };
    } else {
      // Only transform, no optional/nullable
      validate = validateItem;
    }
  } else {
    // Fast path: direct object validation
    validate = validateObj;
  }

  const schema = {
    type: "object" as const,
    entries,
    options,
    acceptsUndefined: hasOptional || hasDefault,
    "~standard": {
      version: 1 as const,
      vendor: "viborm" as const,
      validate,
      // Lazy jsonSchema - converter is created when first accessed
      get jsonSchema() {
        const converter = createJsonSchemaConverter(
          schema as unknown as VibSchema<unknown, unknown>
        );
        // Replace getter with static value for subsequent access
        Object.defineProperty(this, "jsonSchema", {
          value: converter,
          writable: false,
          enumerable: true,
        });
        return converter;
      },
    },
    extend: (newEntries: ObjectEntries) =>
      object({ ...entries, ...newEntries } as any, options),
  };

  return schema as R extends infer _ ? _ : never;
}
