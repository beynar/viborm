// Scalar Type Definitions
// Based on specification: readme/1.3_field_scalar_types.md
export const ScalarTypeMappings = {
    string: {
        postgresql: "TEXT",
        mysql: "VARCHAR(191)",
    },
    boolean: {
        postgresql: "BOOLEAN",
        mysql: "TINYINT(1)",
    },
    int: {
        postgresql: "INTEGER",
        mysql: "INT",
    },
    bigInt: {
        postgresql: "BIGINT",
        mysql: "BIGINT",
    },
    float: {
        postgresql: "DOUBLE PRECISION",
        mysql: "DOUBLE",
    },
    decimal: {
        postgresql: "DECIMAL",
        mysql: "DECIMAL",
    },
    dateTime: {
        postgresql: "TIMESTAMP",
        mysql: "DATETIME",
    },
    json: {
        postgresql: "JSONB",
        mysql: "JSON",
    },
    blob: {
        postgresql: "BYTEA",
        mysql: "BLOB",
    },
    enum: {
        postgresql: "ENUM",
        mysql: "ENUM",
    },
};
