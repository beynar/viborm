/**
 * MySQL Introspection Types
 *
 * Types representing the structure of MySQL's information_schema query results.
 */

export interface MySQLTable {
  TABLE_NAME: string;
}

export interface MySQLColumn {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string; // Full type including ENUM values, e.g., "enum('active','inactive')"
  IS_NULLABLE: string; // "YES" or "NO"
  COLUMN_DEFAULT: string | null;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  /** SRID restriction for a spatial column; null for unrestricted/non-spatial. */
  SRS_ID?: number | string | bigint | null;
  EXTRA: string; // Contains "auto_increment" if applicable
  /**
   * The column's comment, read for the deterministic decimal-list marker.
   *
   * `JSON` is the only shape a MySQL decimal list has and it carries no
   * modifiers, so the marker is where a list's declared precision and scale
   * live. MySQL reports an empty string, never NULL, for a column with no
   * comment.
   */
  COLUMN_COMMENT: string;
}

export interface MySQLPrimaryKey {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number;
}

export interface MySQLIndex {
  TABLE_NAME: string;
  INDEX_NAME: string;
  COLUMN_NAME: string;
  NON_UNIQUE: number; // 0 = unique, 1 = non-unique
  INDEX_TYPE: string; // BTREE, HASH, FULLTEXT, SPATIAL
  SEQ_IN_INDEX: number;
}

export interface MySQLForeignKey {
  /** Both endpoints are read so cross-database topology can be refused (§5.2). */
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  DELETE_RULE: string;
  UPDATE_RULE: string;
  ORDINAL_POSITION: number;
}

export interface MySQLUniqueConstraint {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number;
}
