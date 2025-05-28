// Field filter types for different data types
export type FieldFilter<T> =
  | T
  | ({
      equals?: T;
      not?: T;
      in?: T[];
      notIn?: T[];
      // String filters
      contains?: T extends string ? string : never;
      startsWith?: T extends string ? string : never;
      endsWith?: T extends string ? string : never;
      // Numeric filters
      lt?: T extends number | bigint | Date ? T : never;
      lte?: T extends number | bigint | Date ? T : never;
      gt?: T extends number | bigint | Date ? T : never;
      gte?: T extends number | bigint | Date ? T : never;
      // Null handling for nullable fields
    } & (T extends null ? { not?: null } : {}));
