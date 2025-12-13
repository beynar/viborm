// String Field Schemas
// Explicit Zod schemas for all string field variants

import { object, json, prefault, ZodJSONSchema, output } from "zod/v4";
import {
  lazy,
  array,
  boolean,
  literal,
  nullable,
  optional,
  partial,
  string,
  transform,
  union,
  pipe,
  type infer,
  number,
  ZodMiniType,
  input as Input,
  ZodMiniNullable,
  email,
} from "zod/v4-mini";

// =============================================================================
// BASE TYPES
// =============================================================================

export const stringBase = string();
export const stringNullable = nullable(stringBase);
export const stringArray = array(stringBase);
export const stringNullableArray = nullable(stringArray);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const stringNullableFilterBase = partial(
  object({
    equals: stringNullable,
    in: array(stringBase),
    notIn: array(stringBase),
    // String-specific filters
    contains: stringBase,
    startsWith: stringBase,
    endsWith: stringBase,
    mode: union([literal("default"), literal("insensitive")]),
    // Comparable filters
    lt: stringNullable,
    lte: stringNullable,
    gt: stringNullable,
    gte: stringNullable,
  })
);

/**
 * Nullable string filter with shorthand support
 * `not` accepts both direct value AND nested filter object
 * Shorthand is normalized to { equals: value } via transform
 */
export const stringNullableFilter = union([
  partial(
    object({
      equals: stringNullable,
      in: array(stringBase),
      notIn: array(stringBase),
      contains: stringBase,
      startsWith: stringBase,
      endsWith: stringBase,
      mode: union([literal("default"), literal("insensitive")]),
      lt: stringNullable,
      lte: stringNullable,
      gt: stringNullable,
      gte: stringNullable,
      not: optional(union([stringNullableFilterBase, stringNullable])),
    })
  ),
  pipe(
    stringNullable,
    transform((v) => ({ equals: v }))
  ),
]);

const out = stringNullableFilter.parse("stringNullableFilter");

console.log({ out });

const test = object({
  name: string(),
  age: number(),
  email: optional(
    lazy(() => {
      console.log("lazy");
      return string();
    })
  ),
});

const out2 = test.parse({
  name: "John",
  age: 30,
});

const jsonBase = json();
const jsonWithSchema = <B extends ZodMiniType>(base: B) => {
  return jsonBase.transform((v) => base.safeParse(v)) as unknown as B;
};

const test2 = jsonWithSchema(test)._zod["input"];

class Test {
  constructor(public name: string, public age: number) {}

  get ["test"](): { name: string } {
    const prop = Object.getOwnPropertyDescriptors(this);
    console.log("~", Object.keys(prop));
    const value = {
      name: this.name,
    };
    if (prop) {
      //
    }
    return value;
  }
}

const testClass = new Test("John", 30);

console.log(testClass["test"]);
console.log(testClass["test"]);

const jsonOptionalNullableCreate = <
  const B extends ZodMiniNullable<ZodJSONSchema>
>(
  base: B
) => {
  return prefault(optional(base), null as Input<B>);
};

const x = nullable(json());

const test3 = prefault(optional(nullable(json())), null);
type InputTest3 = Input<typeof test3>;

export const shorthandUpdate = <Z extends ZodMiniType>(
  schema: Z
): ZodMiniType<{ set: output<Z> }, Z["_zod"]["input"]> =>
  pipe(
    schema,
    transform((v) => ({ set: v }))
  );

// =============================================================================
// TESTING FACTORY PATTERN WITH CUSTOM SCHEMA
// =============================================================================

const stringUpdateFactory = <Z extends ZodMiniType>(base: Z) => {
  return union([partial(object({ set: base })), shorthandUpdate(base)]);
};

// Without custom validator
const stringUpdate = stringUpdateFactory(stringBase);
const result1 = stringUpdate.parse("test");
console.log(result1);

// With custom validator (email)
const customValidator = email();
const validatedBase = pipe(stringBase, customValidator);
const updateWithCustomValidator = stringUpdateFactory(validatedBase);

// This should work - valid email
const result2 = updateWithCustomValidator.parse("test@test.com");
console.log(result2);

// This should fail - invalid email
try {
  updateWithCustomValidator.parse("not-an-email");
} catch (e) {
  console.log("Validation failed as expected:", (e as Error).message);
}
