import { s, TYPES } from "@schema";
import { validateSchema } from "@schema/validation";
import { describe, expect, it } from "vitest";

const SAME_SQLITE_DATETIME_FORM = /same SQLite DateTime physical form/i;
const SAME_SCALAR_LIST_SHAPE = /same scalar\/list shape/i;

function datetimeReference(
  local: Parameters<typeof s.dateTime>[0],
  remote: Parameters<typeof s.dateTime>[0]
) {
  const parent = s.model({
    at: s.dateTime(remote).id(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentAt: s.dateTime(local),
    parent: s
      .toOne(() => parent)
      .fields("parentAt")
      .references("at"),
  });
  return validateSchema({ parent, child });
}

function datetimeArrayReference(
  local: Parameters<typeof s.dateTime>[0],
  remote: Parameters<typeof s.dateTime>[0]
) {
  const parent = s.model({
    id: s.string().id(),
    instants: s.dateTime(remote).array().unique(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentInstants: s.dateTime(local).array(),
    parent: s
      .toOne(() => parent)
      .fields("parentInstants")
      .references("instants"),
  });
  return validateSchema({ parent, child });
}

function datetimeListToScalarReference(
  local: Parameters<typeof s.dateTime>[0],
  remote: Parameters<typeof s.dateTime>[0]
) {
  const parent = s.model({
    at: s.dateTime(remote).unique(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentAt: s.dateTime(local).array(),
    parent: s
      .toOne(() => parent)
      .fields("parentAt")
      .references("at"),
  });
  return validateSchema({ parent, child });
}

describe("SQLite DateTime foreign-key domains", () => {
  it.each([
    [TYPES.SQLITE.DATETIME.INTEGER, TYPES.SQLITE.DATETIME.REAL],
    [TYPES.SQLITE.DATETIME.REAL, TYPES.SQLITE.DATETIME.TEXT],
    [TYPES.SQLITE.DATETIME.INTEGER, undefined],
  ])("refuses physically different local %o and remote %o forms", (local, remote) => {
    const issue = datetimeReference(local, remote).errors.find(
      (candidate) => candidate.code === "FK003"
    );

    expect(issue?.message).toContain("datetime(");
    expect(issue?.repair).toMatch(SAME_SQLITE_DATETIME_FORM);
  });

  it.each([
    TYPES.SQLITE.DATETIME.TEXT,
    TYPES.SQLITE.DATETIME.INTEGER,
    TYPES.SQLITE.DATETIME.REAL,
    undefined,
  ])("accepts equal %o forms", (form) => {
    expect(
      datetimeReference(form, form).errors.map((issue) => issue.code)
    ).not.toContain("FK003");
  });

  it("accepts lists with different native member declarations", () => {
    expect(
      datetimeArrayReference(
        TYPES.SQLITE.DATETIME.INTEGER,
        TYPES.SQLITE.DATETIME.REAL
      ).errors.map((issue) => issue.code)
    ).not.toContain("FK003");
  });

  it("refuses a list that references a scalar DateTime", () => {
    const issue = datetimeListToScalarReference(
      TYPES.SQLITE.DATETIME.INTEGER,
      TYPES.SQLITE.DATETIME.INTEGER
    ).errors.find((candidate) => candidate.code === "FK003");

    expect(issue?.message).toContain("datetime[]");
    expect(issue?.message).toContain("datetime(epochMillis)");
    expect(issue?.repair).toMatch(SAME_SCALAR_LIST_SHAPE);
  });
});
