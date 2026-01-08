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
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
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
