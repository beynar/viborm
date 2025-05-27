// Utility Type Definitions
// Advanced TypeScript patterns and helper types

// Require at least one of the specified keys
export type AtLeast<T, K extends keyof T> = Partial<T> & Pick<T, K>;

// Exact type matching
export type Exact<T, W> = T extends W ? (W extends T ? T : never) : never;

// Select subset utility
export type SelectSubset<T, U> = T extends U ? T : never;

// Get scalar type from union
export type GetScalarType<T, O> = T extends keyof O ? O[T] : never;

// Deep partial type
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Deep required type
export type DeepRequired<T> = {
  [P in keyof T]-?: T[P] extends object ? DeepRequired<T[P]> : T[P];
};

// Make specific keys optional
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// Make specific keys required
export type Required<T, K extends keyof T> = T & {
  [P in K]-?: T[P];
};

// Non-nullable type
export type NonNullable<T> = T extends null | undefined ? never : T;

// Extract non-function properties
export type NonFunctionPropertyNames<T> = {
  [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];

export type NonFunctionProperties<T> = Pick<T, NonFunctionPropertyNames<T>>;

// Extract function properties
export type FunctionPropertyNames<T> = {
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];

export type FunctionProperties<T> = Pick<T, FunctionPropertyNames<T>>;

// Union to intersection utility
export type UnionToIntersection<U> = (
  U extends any ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

// Check if type extends another
export type Extends<T, U> = T extends U ? true : false;

// Check if two types are equal
export type Equals<T, U> = T extends U ? (U extends T ? true : false) : false;

// Extract keys of specific type
export type KeysOfType<T, U> = {
  [K in keyof T]: T[K] extends U ? K : never;
}[keyof T];

// Omit by value type
export type OmitByValue<T, ValueType> = Pick<
  T,
  {
    [Key in keyof T]: T[Key] extends ValueType ? never : Key;
  }[keyof T]
>;

// Pick by value type
export type PickByValue<T, ValueType> = Pick<
  T,
  {
    [Key in keyof T]: T[Key] extends ValueType ? Key : never;
  }[keyof T]
>;

// Flatten nested arrays
export type Flatten<T> = T extends Array<infer U> ? Flatten<U> : T;

// Get array element type
export type ArrayElement<ArrayType extends readonly unknown[]> =
  ArrayType extends readonly (infer ElementType)[] ? ElementType : never;

// Merge two types
export type Merge<A, B> = {
  [K in keyof A | keyof B]: K extends keyof B
    ? B[K]
    : K extends keyof A
    ? A[K]
    : never;
};

// Override properties
export type Override<T, U> = Omit<T, keyof U> & U;

// Mutable version of readonly type
export type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};

// Immutable version of mutable type
export type Immutable<T> = {
  readonly [P in keyof T]: T[P];
};

// Convert all properties to strings
export type Stringify<T> = {
  [K in keyof T]: string;
};

// Nullable version of type
export type Nullable<T> = T | null;

// Undefinable version of type
export type Undefinable<T> = T | undefined;

// Primitive types
export type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

// Check if type is primitive
export type IsPrimitive<T> = T extends Primitive ? true : false;

// Length of tuple type
export type Length<T extends readonly any[]> = T["length"];

// Head of tuple type
export type Head<T extends readonly any[]> = T extends readonly [any, ...any[]]
  ? T[0]
  : never;

// Tail of tuple type
export type Tail<T extends readonly any[]> = T extends readonly [
  any,
  ...infer U
]
  ? U
  : never;

// Check if type is never
export type IsNever<T> = [T] extends [never] ? true : false;

// Check if type is any
export type IsAny<T> = 0 extends 1 & T ? true : false;

// Check if type is unknown
export type IsUnknown<T> = IsAny<T> extends true
  ? false
  : unknown extends T
  ? true
  : false;

// Conditional type helper
export type If<C extends boolean, T, F> = C extends true ? T : F;

// Promise utilities
export type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;

export type PromiseType<T extends Promise<any>> = T extends Promise<infer U>
  ? U
  : never;

// Function utilities
export type Parameters<T extends (...args: any) => any> = T extends (
  ...args: infer P
) => any
  ? P
  : never;

export type ReturnType<T extends (...args: any) => any> = T extends (
  ...args: any
) => infer R
  ? R
  : any;

// Constructor utilities
export type ConstructorParameters<
  T extends abstract new (...args: any) => any
> = T extends abstract new (...args: infer P) => any ? P : never;

export type InstanceType<T extends abstract new (...args: any) => any> =
  T extends abstract new (...args: any) => infer R ? R : any;

// Type brand utility for nominal typing
export type Brand<T, B> = T & { __brand: B };

// Opaque type utility
export type Opaque<T, K> = T & { readonly __opaque__: K };

// JSON serializable types
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

// Serializable type checker
export type IsSerializable<T> = T extends JsonValue ? true : false;
