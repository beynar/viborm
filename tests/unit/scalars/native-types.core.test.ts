import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { describe, expect, it } from "vitest";

const NATIVE_TYPE_FACTORIES = [
  ["pg varchar", () => PG.STRING.VARCHAR(42), "pg", "varchar(42)"],
  ["pg char", () => PG.STRING.CHAR(8), "pg", "char(8)"],
  ["pg bit", () => PG.STRING.BIT(4), "pg", "bit(4)"],
  ["pg varbit", () => PG.STRING.VARBIT(), "pg", "varbit"],
  ["pg sized varbit", () => PG.STRING.VARBIT(9), "pg", "varbit(9)"],
  ["pg decimal", () => PG.DECIMAL.DECIMAL(), "pg", "decimal"],
  ["pg decimal precision", () => PG.DECIMAL.DECIMAL(12), "pg", "decimal(12)"],
  ["pg decimal scale", () => PG.DECIMAL.DECIMAL(12, 4), "pg", "decimal(12,4)"],
  ["pg numeric", () => PG.DECIMAL.NUMERIC(), "pg", "numeric"],
  ["pg numeric precision", () => PG.DECIMAL.NUMERIC(12), "pg", "numeric(12)"],
  ["pg numeric scale", () => PG.DECIMAL.NUMERIC(12, 4), "pg", "numeric(12,4)"],
  ["pg timestamp", () => PG.DATETIME.TIMESTAMP(), "pg", "timestamp"],
  [
    "pg timestamp precision",
    () => PG.DATETIME.TIMESTAMP(3),
    "pg",
    "timestamp(3)",
  ],
  ["pg timestamptz", () => PG.DATETIME.TIMESTAMPTZ(), "pg", "timestamptz"],
  [
    "pg timestamptz precision",
    () => PG.DATETIME.TIMESTAMPTZ(3),
    "pg",
    "timestamptz(3)",
  ],
  ["pg time", () => PG.DATETIME.TIME(), "pg", "time"],
  ["pg time precision", () => PG.DATETIME.TIME(3), "pg", "time(3)"],
  ["pg timetz", () => PG.DATETIME.TIMETZ(), "pg", "timetz"],
  ["pg timetz precision", () => PG.DATETIME.TIMETZ(3), "pg", "timetz(3)"],
  ["mysql varchar", () => MYSQL.STRING.VARCHAR(42), "mysql", "VARCHAR(42)"],
  ["mysql char", () => MYSQL.STRING.CHAR(8), "mysql", "CHAR(8)"],
  ["mysql bit", () => MYSQL.STRING.BIT(4), "mysql", "BIT(4)"],
  ["mysql decimal", () => MYSQL.DECIMAL.DECIMAL(), "mysql", "DECIMAL"],
  [
    "mysql decimal precision",
    () => MYSQL.DECIMAL.DECIMAL(12),
    "mysql",
    "DECIMAL(12)",
  ],
  [
    "mysql decimal scale",
    () => MYSQL.DECIMAL.DECIMAL(12, 4),
    "mysql",
    "DECIMAL(12,4)",
  ],
  ["mysql numeric", () => MYSQL.DECIMAL.NUMERIC(), "mysql", "NUMERIC"],
  [
    "mysql numeric precision",
    () => MYSQL.DECIMAL.NUMERIC(12),
    "mysql",
    "NUMERIC(12)",
  ],
  [
    "mysql numeric scale",
    () => MYSQL.DECIMAL.NUMERIC(12, 4),
    "mysql",
    "NUMERIC(12,4)",
  ],
  ["mysql datetime", () => MYSQL.DATETIME.DATETIME(), "mysql", "DATETIME"],
  [
    "mysql datetime precision",
    () => MYSQL.DATETIME.DATETIME(3),
    "mysql",
    "DATETIME(3)",
  ],
  ["mysql timestamp", () => MYSQL.DATETIME.TIMESTAMP(), "mysql", "TIMESTAMP"],
  [
    "mysql timestamp precision",
    () => MYSQL.DATETIME.TIMESTAMP(3),
    "mysql",
    "TIMESTAMP(3)",
  ],
  ["mysql time", () => MYSQL.DATETIME.TIME(), "mysql", "TIME"],
  ["mysql time precision", () => MYSQL.DATETIME.TIME(3), "mysql", "TIME(3)"],
  ["mysql binary", () => MYSQL.BLOB.BINARY(16), "mysql", "BINARY(16)"],
  [
    "mysql varbinary",
    () => MYSQL.BLOB.VARBINARY(255),
    "mysql",
    "VARBINARY(255)",
  ],
] as const;

describe("native scalar types", () => {
  it.each(
    NATIVE_TYPE_FACTORIES
  )("formats %s", (_name, createType, db, type) => {
    expect(createType()).toEqual({ db, type });
  });

  it("publishes representative fixed types for each dialect", () => {
    expect(PG.STRING.UUID).toEqual({ db: "pg", type: "uuid" });
    expect(PG.POINT.GEOGRAPHY_POINT).toEqual({
      db: "pg",
      type: "geography(Point)",
    });
    expect(MYSQL.INT.INT_UNSIGNED).toEqual({
      db: "mysql",
      type: "INT UNSIGNED",
    });
    expect(MYSQL.BLOB.LONGBLOB).toEqual({ db: "mysql", type: "LONGBLOB" });
    expect(SQLITE.DECIMAL.TEXT).toEqual({ db: "sqlite", type: "TEXT" });
    expect(SQLITE.BLOB.BLOB).toEqual({ db: "sqlite", type: "BLOB" });
  });
});
