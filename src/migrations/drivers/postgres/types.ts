/**
 * PostgreSQL Introspection Types
 *
 * Types representing the structure of PostgreSQL's information_schema
 * and system catalog query results.
 */

export interface PgTable {
  table_name: string;
}

export interface PgColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  /**
   * The schema owning the column's type. Distinguishes a built-in
   * (`pg_catalog`) from a type this estate manages (the selected schema) from
   * an external one, which `udt_name` alone cannot: two schemas may hold two
   * different enums under one name.
   */
  udt_schema: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  /**
   * `pg_catalog.format_type(atttypid, atttypmod)` — the server's own spelling,
   * carrying the modifiers and array structure `udt_name` drops (`vector(3)`,
   * `geometry(Point,4326)`). Read ONLY for a type proven extension-owned AND
   * declared by the adapter's capabilities; every other type keeps the
   * `udt_name` path, whose answers differ (`integer` here, `int4` there) and
   * are what every existing snapshot holds.
   */
  formatted_type: string;
  /**
   * The extension that owns this column's type, proven through `pg_depend`
   * (`deptype = 'e'`) and `pg_extension`, or null when no extension owns it.
   * For an array column this is the ELEMENT type's owner.
   */
  type_extension: string | null;
  /** The schema the owning extension was installed into, or null with it. */
  type_extension_schema: string | null;
}

/**
 * One foreign key with exactly one side inside the selected schema.
 *
 * V1 manages a single schema, so such a constraint is a topology this estate
 * cannot represent — in either direction. Both schemas are carried so the
 * refusal can name them.
 */
export interface PgCrossSchemaForeignKey {
  constraint_name: string;
  owning_schema: string;
  owning_table: string;
  referenced_schema: string;
  referenced_table: string;
}

export interface PgPrimaryKey {
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal_position: number;
}

export interface PgIndex {
  table_name: string;
  index_name: string;
  column_name: string;
  is_unique: boolean;
  index_type: string;
  filter_condition: string | null;
  ordinal_position: number;
}

export interface PgForeignKey {
  table_name: string;
  constraint_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  delete_rule: string;
  update_rule: string;
  ordinal_position: number;
}

export interface PgUniqueConstraint {
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal_position: number;
}

export interface PgEnum {
  enum_name: string;
  enum_value: string;
  sort_order: number;
}
