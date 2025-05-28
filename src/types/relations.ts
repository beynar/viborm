// Relation Type Definitions
// Based on specification: readme/1.4_relation_class.md

// Relation types - following standard relational database patterns
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";

// Cascade options for relations
export type CascadeOptions = "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
