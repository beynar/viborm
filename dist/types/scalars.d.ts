export type ScalarFieldType = "string" | "boolean" | "int" | "bigInt" | "float" | "decimal" | "dateTime" | "json" | "blob" | "enum";
export interface DatabaseMapping {
    postgresql: string;
    mysql: string;
}
export declare const ScalarTypeMappings: Record<ScalarFieldType, DatabaseMapping>;
export type AutoGenerateType = "uuid" | "ulid" | "nanoid" | "cuid" | "increment" | "now" | "updatedAt";
export type ScalarToTypeScript<T extends ScalarFieldType> = T extends "string" ? string : T extends "boolean" ? boolean : T extends "int" | "float" | "decimal" ? number : T extends "bigInt" ? bigint : T extends "dateTime" ? Date : T extends "json" ? any : T extends "blob" ? Uint8Array : T extends "enum" ? string | number : never;
export interface FieldOptions {
    nullable?: boolean;
    unique?: boolean;
    id?: boolean;
    auto?: AutoGenerateType;
    default?: any;
    list?: boolean;
}
export interface StringFieldOptions extends FieldOptions {
    minLength?: number;
    maxLength?: number;
    regex?: RegExp;
}
export interface NumberFieldOptions extends FieldOptions {
    min?: number;
    max?: number;
}
export interface DecimalFieldOptions extends NumberFieldOptions {
    precision?: number;
    scale?: number;
}
export interface EnumFieldOptions<T extends readonly (string | number)[]> extends FieldOptions {
    values: T;
}
//# sourceMappingURL=scalars.d.ts.map