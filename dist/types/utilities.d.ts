export type AtLeast<T, K extends keyof T> = Partial<T> & Pick<T, K>;
export type Exact<T, W> = T extends W ? (W extends T ? T : never) : never;
export type SelectSubset<T, U> = T extends U ? T : never;
export type GetScalarType<T, O> = T extends keyof O ? O[T] : never;
export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
export type DeepRequired<T> = {
    [P in keyof T]-?: T[P] extends object ? DeepRequired<T[P]> : T[P];
};
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type Required<T, K extends keyof T> = T & {
    [P in K]-?: T[P];
};
export type NonNullable<T> = T extends null | undefined ? never : T;
export type NonFunctionPropertyNames<T> = {
    [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];
export type NonFunctionProperties<T> = Pick<T, NonFunctionPropertyNames<T>>;
export type FunctionPropertyNames<T> = {
    [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];
export type FunctionProperties<T> = Pick<T, FunctionPropertyNames<T>>;
export type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
export type Extends<T, U> = T extends U ? true : false;
export type Equals<T, U> = T extends U ? (U extends T ? true : false) : false;
export type KeysOfType<T, U> = {
    [K in keyof T]: T[K] extends U ? K : never;
}[keyof T];
export type OmitByValue<T, ValueType> = Pick<T, {
    [Key in keyof T]: T[Key] extends ValueType ? never : Key;
}[keyof T]>;
export type PickByValue<T, ValueType> = Pick<T, {
    [Key in keyof T]: T[Key] extends ValueType ? Key : never;
}[keyof T]>;
export type Flatten<T> = T extends Array<infer U> ? Flatten<U> : T;
export type ArrayElement<ArrayType extends readonly unknown[]> = ArrayType extends readonly (infer ElementType)[] ? ElementType : never;
export type Merge<A, B> = {
    [K in keyof A | keyof B]: K extends keyof B ? B[K] : K extends keyof A ? A[K] : never;
};
export type Override<T, U> = Omit<T, keyof U> & U;
export type Mutable<T> = {
    -readonly [P in keyof T]: T[P];
};
export type Immutable<T> = {
    readonly [P in keyof T]: T[P];
};
export type Stringify<T> = {
    [K in keyof T]: string;
};
export type Nullable<T> = T | null;
export type Undefinable<T> = T | undefined;
export type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type IsPrimitive<T> = T extends Primitive ? true : false;
export type Length<T extends readonly any[]> = T["length"];
export type Head<T extends readonly any[]> = T extends readonly [any, ...any[]] ? T[0] : never;
export type Tail<T extends readonly any[]> = T extends readonly [
    any,
    ...infer U
] ? U : never;
export type IsNever<T> = [T] extends [never] ? true : false;
export type IsAny<T> = 0 extends 1 & T ? true : false;
export type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false;
export type If<C extends boolean, T, F> = C extends true ? T : F;
export type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;
export type PromiseType<T extends Promise<any>> = T extends Promise<infer U> ? U : never;
export type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
export type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
export type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (...args: infer P) => any ? P : never;
export type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : any;
export type Brand<T, B> = T & {
    __brand: B;
};
export type Opaque<T, K> = T & {
    readonly __opaque__: K;
};
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject {
    [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {
}
export type IsSerializable<T> = T extends JsonValue ? true : false;
//# sourceMappingURL=utilities.d.ts.map