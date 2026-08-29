import type { FieldRef } from "@schema/field-ref";
import type { ScalarState } from "@schema/scalars/common";
import { isSql } from "@sql";
import { lazyScalarSchemas } from "../lazy";
import type { DecimalDescriptor } from "../primitives/decimal-codec";
import {
  createSchema,
  fail,
  ok,
  standardSchemaFailure,
  validateSchema,
} from "../primitives/helpers";
import type { ObjectEntries, ObjectSchema } from "../primitives/object";
import v, { type V } from "../primitives/v";
import type {
  InferInput,
  InferOutput,
  ValidationResult,
  VibSchema,
} from "../types";
import { isRecord } from "../value-guards";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// PER-FIELD OPERAND SCHEMAS
// =============================================================================
//
// Every decimal schema on this page is built from the FIELD's declared domain.
// There are no module-level shared bases: an operand that does not know the
// precision and scale it is being compared or added to cannot refuse a value
// outside them, and a filter that silently accepts `1.005` against a scale-2
// column is a query whose answer no provider agrees on.

/** The domain, in the shape `v.decimal` reads it. */
type DomainOptions = { decimal: DecimalDescriptor | undefined };

const domainOf = (state: ScalarState<"decimal">): DomainOptions => ({
  decimal: state.decimal,
});

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * A decimal comparison operand: a literal, a field reference to another decimal
 * column, or a callback returning one — but NEVER a generic typed `Sql`
 * fragment.
 *
 * A fragment carries no trusted precision or scale, so on SQLite, where the
 * column holds an unscaled integer coefficient, `gt: sql\`100\`` would compare a
 * coefficient against a logical number and quietly answer a different question
 * per provider. Raw SQL remains the escape; every other scalar keeps fragments.
 */
interface DecimalComparisonOperandSchema<
  TSchema extends V.Schema,
  C extends V.Operand<any> = V.Operand<any>,
> extends VibSchema<
    | InferInput<TSchema>
    | FieldRef<string, "decimal">
    | ((ctx: C) => FieldRef<string, "decimal">),
    InferOutput<TSchema> | FieldRef<string, "decimal">
  > {
  readonly type: "comparison_operand";
  readonly fieldType: "decimal";
  readonly wrapped: TSchema;
  readonly acceptsUndefined: boolean;
}

type DecimalFilterBase<
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
  C extends V.Operand<any>,
> = {
  equals: DecimalComparisonOperandSchema<S, C>;
  in: L;
  notIn: L;
  lt: DecimalComparisonOperandSchema<O, C>;
  lte: DecimalComparisonOperandSchema<O, C>;
  gt: DecimalComparisonOperandSchema<O, C>;
  gte: DecimalComparisonOperandSchema<O, C>;
};

type DecimalFilterSchema<
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<
  DecimalComparisonOperandSchema<S, C>,
  DecimalFilterBase<S, O, L, C>
>;

type DecimalListFilterBase<
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
> = {
  equals: S;
  has: O;
  hasEvery: L;
  hasSome: L;
  isEmpty: V.Boolean;
  in: DecimalListRefusalSchema;
  notIn: DecimalListRefusalSchema;
  lt: DecimalListRefusalSchema;
  lte: DecimalListRefusalSchema;
  gt: DecimalListRefusalSchema;
  gte: DecimalListRefusalSchema;
};

type DecimalListRefusalSchema = VibSchema<never, never>;

type DecimalListFilterSchema<
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
> = NegatableFilterSchema<S, DecimalListFilterBase<S, O, L>>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

/**
 * EXACTLY one operation.
 *
 * `?: never` on the keys an arm does not carry is what makes a second DECLARED
 * key unrepresentable even when the payload is held in a variable —
 * excess-property checking only fires on a fresh object literal — and building
 * the union out of the arms rather than a partial bag is what makes `{}`
 * unrepresentable at all. The query engine therefore has no precedence to
 * arbitrate for decimals; the ladder in `set-builder.ts` still serves int,
 * number and bigint, whose bags this rule deliberately does not touch.
 */
type ExactlyOne<Allowed> = {
  [K in keyof Allowed]: { [P in K]-?: Allowed[P] } & {
    [P in Exclude<keyof Allowed, K>]?: never;
  };
}[keyof Allowed];

/** An object schema that admits exactly one of its entries. */
export interface ExactlyOneSchema<TEntries extends ObjectEntries>
  extends VibSchema<
    ExactlyOne<InferInput<ObjectSchema<TEntries>>>,
    ExactlyOne<InferOutput<ObjectSchema<TEntries>>>
  > {
  readonly type: "exact_one";
  readonly entries: TEntries;
}

/** The operations a decimal SCALAR update declares, named once. */
type DecimalOperations<S extends V.Schema, O extends V.Schema> = {
  set: S;
  increment: O;
  decrement: O;
  multiply: O;
  divide: O;
};

type DecimalUpdateSchema<S extends V.Schema, O extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, ExactlyOneSchema<DecimalOperations<S, O>>]
> extends infer Schema extends VibSchema
  ? VibSchema<
      InferInput<Schema>,
      ExactlyOne<{
        set: InferOutput<S>;
        increment: InferOutput<O>;
        decrement: InferOutput<O>;
        multiply: InferOutput<O>;
        divide: InferOutput<O>;
      }>
    > & {
      readonly type: "union";
      readonly options: readonly [
        V.ShorthandUpdate<S>,
        ExactlyOneSchema<DecimalOperations<S, O>>,
      ];
    }
  : never;

type DecimalPushSchema<O extends V.Schema, L extends V.Schema> = V.Union<
  readonly [V.ShorthandArray<O>, L]
>;

type DecimalListUpdateSchema<
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    ExactlyOneSchema<DecimalListOperations<S, O, L>>,
  ]
> extends infer Schema extends VibSchema
  ? VibSchema<
      InferInput<Schema>,
      ExactlyOne<{
        set: InferOutput<S>;
        push: InferOutput<DecimalPushSchema<O, L>>;
        unshift: InferOutput<DecimalPushSchema<O, L>>;
        increment: never;
        decrement: never;
        multiply: never;
        divide: never;
      }>
    > & {
      readonly type: "union";
      readonly options: readonly [
        V.ShorthandUpdate<S>,
        ExactlyOneSchema<DecimalListOperations<S, O, L>>,
      ];
    }
  : never;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

/**
 * `comparisonOperand`, closed to fragments.
 *
 * Wrapping is what keeps the accepted spellings — a value, a reference, a
 * callback returning one — and their exact messages, while refusing the one
 * kind the descriptor cannot vouch for. The validator is built inside this
 * factory, before the schema object exists, because every filter that holds it
 * is a union and a union captures each member's validate at construction.
 */
const decimalComparisonOperand = <
  TSchema extends V.Schema,
  C extends V.Operand<any> = V.Operand<any>,
>(
  wrapped: TSchema
): DecimalComparisonOperandSchema<TSchema, C> => {
  const operand = v.comparisonOperand("decimal", wrapped);
  const validateOperand = operand["~standard"].validate;
  const schema = createSchema<
    InferInput<DecimalComparisonOperandSchema<TSchema, C>>,
    InferOutput<DecimalComparisonOperandSchema<TSchema, C>>
  >("comparison_operand", (value) => {
    const result = validateOperand(value);
    if (result.issues) return standardSchemaFailure(result.issues);
    return isSql(result.value)
      ? fail(
          "An SQL fragment is not a decimal operand: it carries no precision or scale, so the comparison would mean something different on each provider. Use a field reference or raw SQL."
        )
      : ok(result.value);
  });
  const metadata: Pick<
    DecimalComparisonOperandSchema<TSchema, C>,
    "type" | "fieldType" | "wrapped" | "acceptsUndefined"
  > = {
    type: "comparison_operand",
    fieldType: "decimal",
    wrapped,
    acceptsUndefined: operand.acceptsUndefined,
  };

  // `createSchema` owns the Standard Schema carrier. The metadata is the
  // comparison-operand surface its JSON converter reads lazily.
  return Object.assign(schema, metadata);
};

const OPERATION_REFUSAL = (keys: readonly string[]) =>
  `A decimal update takes exactly one operation: ${keys.join(", ")}`;

const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

type OperationName<TEntries extends ObjectEntries> = Extract<
  keyof TEntries,
  string
>;

type OperationValidator<TEntries extends ObjectEntries> = (
  operation: OperationName<TEntries>,
  operand: unknown
) => ValidationResult<InferOutput<ExactlyOneSchema<TEntries>>>;

const validateRefusal = (
  schema: DecimalListRefusalSchema,
  operand: unknown
): ValidationResult<never> => validateSchema(schema, operand);

/** Give a naturally typed one-key result the pollution-safe output prototype. */
const operationOutput = <T extends object>(output: T): T => {
  Object.setPrototypeOf(output, null);
  return output;
};

/**
 * Exactly one operation, owned by one hostile-object preflight.
 *
 * `Reflect.ownKeys` sees symbols and non-enumerable declarations that an object
 * schema's string enumeration cannot. The prototype walk rejects every key on
 * a caller-supplied prototype. `Object.prototype` itself is the language
 * intrinsic, so only its fixed built-in surface is ignored. Only then is the
 * selected operand read once. The
 * operation-specific validator emits a typed literal rather than asking
 * TypeScript to trust a dynamic-key assertion. Its null prototype prevents
 * prototype pollution from adding an operation downstream.
 */
const exactlyOneOperation = <TEntries extends ObjectEntries>(
  entries: TEntries,
  validateOperation: OperationValidator<TEntries>
): ExactlyOneSchema<TEntries> => {
  const keys = Object.keys(entries);
  const keySet = new Set(keys);
  const isOperation = (
    operation: string
  ): operation is OperationName<TEntries> => keySet.has(operation);
  const schema = createSchema<
    InferInput<ExactlyOneSchema<TEntries>>,
    InferOutput<ExactlyOneSchema<TEntries>>
  >("exact_one", (value) => {
    let selected: {
      operation: OperationName<TEntries>;
      operand: unknown;
    };
    try {
      if (!isRecord(value)) return fail("Expected object");

      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== 1) return fail(OPERATION_REFUSAL(keys));
      const [operation] = ownKeys;
      if (typeof operation !== "string" || !isOperation(operation)) {
        return fail(OPERATION_REFUSAL(keys));
      }

      // Any key on a caller-supplied prototype is a second declaration.
      // Object.prototype's built-ins are language machinery, but any added
      // string or symbol key still is not.
      const visited = new Set<object>();
      let prototype = Reflect.getPrototypeOf(value);
      while (prototype !== null) {
        if (visited.has(prototype)) return fail(OPERATION_REFUSAL(keys));
        visited.add(prototype);
        const isLanguageIntrinsic = prototype === Object.prototype;
        for (const inherited of Reflect.ownKeys(prototype)) {
          if (
            !isLanguageIntrinsic ||
            typeof inherited !== "string" ||
            !OBJECT_PROTOTYPE_KEYS.has(inherited)
          ) {
            return fail(OPERATION_REFUSAL(keys));
          }
        }
        prototype = Reflect.getPrototypeOf(prototype);
      }

      // Read a caller accessor once. The selected validator never re-enters
      // the hostile object.
      const operand = Reflect.get(value, operation);
      if (operand === undefined) return fail(OPERATION_REFUSAL(keys));
      selected = { operation, operand };
    } catch {
      return fail(OPERATION_REFUSAL(keys));
    }
    // Carrier reflection is hostile input and is contained above. The selected
    // validator is a different trust boundary: an external `.schema()` failure
    // must reach SchemaRegistry so it can retain the sanitized cause instead of
    // being mislabeled as an exact-one carrier refusal.
    return validateOperation(selected.operation, selected.operand);
  });
  const metadata: Pick<ExactlyOneSchema<TEntries>, "type" | "entries"> = {
    type: "exact_one",
    entries,
  };

  return Object.assign(schema, metadata);
};

const decimalScalarOperation = <S extends V.Schema, O extends V.Schema>(
  entries: DecimalOperations<S, O>
): ExactlyOneSchema<DecimalOperations<S, O>> => {
  const set = v.object({ set: entries.set }, { partial: false, strict: false });
  const increment = v.object(
    { increment: entries.increment },
    { partial: false, strict: false }
  );
  const decrement = v.object(
    { decrement: entries.decrement },
    { partial: false, strict: false }
  );
  const multiply = v.object(
    { multiply: entries.multiply },
    { partial: false, strict: false }
  );
  const divide = v.object(
    { divide: entries.divide },
    { partial: false, strict: false }
  );

  return exactlyOneOperation(entries, (operation, operand) => {
    switch (operation) {
      case "set": {
        const result = set["~standard"].validate({ set: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "increment": {
        const result = increment["~standard"].validate({ increment: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "decrement": {
        const result = decrement["~standard"].validate({ decrement: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "multiply": {
        const result = multiply["~standard"].validate({ multiply: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "divide": {
        const result = divide["~standard"].validate({ divide: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      default: {
        const exhaustiveOperation: never = operation;
        return exhaustiveOperation;
      }
    }
  });
};

type DecimalListOperations<
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
> = {
  set: S;
  push: DecimalPushSchema<O, L>;
  unshift: DecimalPushSchema<O, L>;
  increment: DecimalListRefusalSchema;
  decrement: DecimalListRefusalSchema;
  multiply: DecimalListRefusalSchema;
  divide: DecimalListRefusalSchema;
};

/**
 * The operation names declared by the one exact-one decimal update owner.
 *
 * The public client uses this projection to seal only a direct decimal update
 * leaf after it has inferred the caller's concrete object keys. Keeping the
 * names derived from these maps prevents the type boundary from restating a
 * second decimal operation language.
 */
export type DecimalUpdateOperationKeys<State extends ScalarState<"decimal">> =
  State["array"] extends true
    ? keyof DecimalListOperations<V.Schema, V.Schema, V.Schema>
    : true extends State["array"]
      ?
          | keyof DecimalOperations<V.Schema, V.Schema>
          | keyof DecimalListOperations<V.Schema, V.Schema, V.Schema>
      : keyof DecimalOperations<V.Schema, V.Schema>;

const decimalListOperation = <
  S extends V.Schema,
  O extends V.Schema,
  L extends V.Schema,
>(
  entries: DecimalListOperations<S, O, L>
): ExactlyOneSchema<DecimalListOperations<S, O, L>> => {
  const set = v.object({ set: entries.set }, { partial: false, strict: false });
  const push = v.object(
    { push: entries.push },
    { partial: false, strict: false }
  );
  const unshift = v.object(
    { unshift: entries.unshift },
    { partial: false, strict: false }
  );

  return exactlyOneOperation(entries, (operation, operand) => {
    switch (operation) {
      case "set": {
        const result = set["~standard"].validate({ set: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "push": {
        const result = push["~standard"].validate({ push: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "unshift": {
        const result = unshift["~standard"].validate({ unshift: operand });
        return result.issues
          ? standardSchemaFailure(result.issues)
          : ok(operationOutput(result.value));
      }
      case "increment":
        return validateRefusal(entries.increment, operand);
      case "decrement":
        return validateRefusal(entries.decrement, operand);
      case "multiply":
        return validateRefusal(entries.multiply, operand);
      case "divide":
        return validateRefusal(entries.divide, operand);
      default: {
        const exhaustiveOperation: never = operation;
        return exhaustiveOperation;
      }
    }
  });
};

// =============================================================================
// DECIMAL SCHEMA BUILDER
// =============================================================================

export interface DecimalSchemas<
  F extends ScalarState<"decimal">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: DecimalCreateSchema<F>;
  update: F["array"] extends true
    ? DecimalListUpdateSchema<F["base"], V.Decimal, V.Decimal<{ array: true }>>
    : DecimalUpdateSchema<F["base"], V.Decimal>;
  filter: F["array"] extends true
    ? DecimalListFilterSchema<F["base"], V.Decimal, V.Decimal<{ array: true }>>
    : DecimalFilterSchema<F["base"], V.Decimal, V.Decimal<{ array: true }>, C>;
}

type DecimalCreateSchema<F extends ScalarState<"decimal">> =
  F["hasDefault"] extends true
    ? F["default"] extends (...args: never[]) => unknown
      ? V.Decimal<F>
      : F["array"] extends true
        ? V.Optional<F["base"], () => InferOutput<F["base"]>>
        : V.Optional<F["base"], F["default"]>
    : V.Decimal<F>;

const buildDecimalCreateSchema = (state: ScalarState<"decimal">) => {
  if (!state.hasDefault || typeof state.default === "function") {
    return v.decimal(state);
  }
  if (state.array && Array.isArray(state.default)) {
    const retained = state.default;
    return v.optional(state.base, () => retained.slice());
  }
  return v.optional(state.base, state.default);
};

export function buildDecimalSchema<
  F extends ScalarState<"decimal">,
  C extends V.Operand<any> = V.Operand<any>,
>(state: F): DecimalSchemas<F, C>;
export function buildDecimalSchema(state: ScalarState<"decimal">) {
  const domain = domainOf(state);
  // One MEMBER schema and one LIST schema per field, both holding the declared
  // domain. `state.base` carries the field's own nullability and arity, which
  // an operand must not inherit: only the whole-value arms take `null`.
  const member = () => v.decimal(domain);
  const list = () => v.decimal({ ...domain, array: true });

  return lazyScalarSchemas({
    base: state.base,
    // Literal decimal defaults already crossed the complete field codec at
    // declaration. Apply that trusted canonical output directly; explicit
    // input still delegates to `state.base`. The list path returns a fresh
    // container so operation output cannot mutate retained schema metadata. A
    // factory remains untrusted until each invocation and keeps the full codec.
    create: () => buildDecimalCreateSchema(state),
    update: () =>
      state.array
        ? v.union([
            v.shorthandUpdate(state.base),
            decimalListOperation({
              set: state.base,
              push: v.union([v.shorthandArray(member()), list()]),
              unshift: v.union([v.shorthandArray(member()), list()]),
              increment: v.refused(
                "A decimal list update does not support 'increment'."
              ),
              decrement: v.refused(
                "A decimal list update does not support 'decrement'."
              ),
              multiply: v.refused(
                "A decimal list update does not support 'multiply'."
              ),
              divide: v.refused(
                "A decimal list update does not support 'divide'."
              ),
            }),
          ])
        : v.union([
            v.shorthandUpdate(state.base),
            // All five operands are held to the field's own domain: the SQL
            // rounding rule works in coefficient space at the field scale, so
            // a finer `multiply` operand has no representation to be exact in.
            // Only derived RESULTS round; no input ever does.
            decimalScalarOperation({
              set: state.base,
              increment: member(),
              decrement: member(),
              multiply: member(),
              divide: member(),
            }),
          ]),
    filter: () =>
      state.array
        ? buildNegatableFilterSchema(
            v.object({
              equals: state.base,
              has: member(),
              hasEvery: list(),
              hasSome: list(),
              isEmpty: v.boolean(),
              in: v.refused("A decimal list filter does not support 'in'."),
              notIn: v.refused(
                "A decimal list filter does not support 'notIn'."
              ),
              lt: v.refused("A decimal list filter does not support 'lt'."),
              lte: v.refused("A decimal list filter does not support 'lte'."),
              gt: v.refused("A decimal list filter does not support 'gt'."),
              gte: v.refused("A decimal list filter does not support 'gte'."),
            }),
            state.base
          )
        : buildDecimalFilterSchema(state.base, member, list),
  });
}

const buildDecimalFilterSchema = <S extends V.Schema>(
  base: S,
  member: () => V.Decimal,
  list: () => V.Decimal<{ array: true }>
) => {
  const operand = decimalComparisonOperand(base);
  return buildNegatableFilterSchema(
    v.object({
      equals: operand,
      in: list(),
      notIn: list(),
      lt: decimalComparisonOperand(member()),
      lte: decimalComparisonOperand(member()),
      gt: decimalComparisonOperand(member()),
      gte: decimalComparisonOperand(member()),
    }),
    operand
  );
};
