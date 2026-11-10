import { describe, expect, test } from "vitest";
import { writeDelimited } from "../src/delimited";
import type { StudioField, StudioModel } from "../src/schema";
import {
  cellText,
  dataText,
  duplicateData,
  importedRows,
  pastedRows,
  readDelimited,
  textValue,
} from "../ui/src/lib/table-data";

const field = (
  name: string,
  type: StudioField["type"],
  extra: Partial<StudioField> = {}
): StudioField => ({
  name,
  column: name,
  type,
  nullable: false,
  list: false,
  id: false,
  unique: false,
  searchable: type === "string",
  optional: false,
  updatable: true,
  ...extra,
});
const id = field("id", "int", {
  id: true,
  generated: "increment",
  optional: true,
});
const name = field("name", "string");
const active = field("active", "boolean", { optional: true });
const note = field("note", "string", { nullable: true, optional: true });
const model: StudioModel = {
  name: "item",
  table: "item",
  icon: "table",
  key: { fields: ["id"] },
  fields: [
    id,
    name,
    active,
    note,
    field("email", "string", { unique: true, optional: true }),
    field("createdAt", "datetime", {
      generated: "now",
      optional: true,
      updatable: false,
    }),
  ],
  relations: [],
};

describe("tabular transfer", () => {
  test("keeps exact numeric strings and refuses JSON numbers that lose precision", () => {
    const exact: StudioModel = {
      ...model,
      fields: [
        name,
        field("amount", "decimal", { optional: true }),
        field("big", "bigint", { optional: true }),
      ],
    };
    expect(
      importedRows(
        exact,
        '[{"name":"x","amount":"1.234567890123456789","big":"9007199254740993"}]',
        "json"
      )
    ).toEqual([
      { name: "x", amount: "1.234567890123456789", big: "9007199254740993" },
    ]);
    expect(() =>
      importedRows(exact, '[{"name":"x","big":9007199254740993}]', "json")
    ).toThrow("strings");
    expect(() =>
      importedRows(exact, '[{"name":"x","amount":1e999}]', "json")
    ).toThrow("finite");
    expect(
      importedRows(model, writeDelimited(["name"], [{ name: "" }]), "csv")
    ).toEqual([{ name: "" }]);
  });
  test("parses quoted separators, escaped quotes, multiline cells, BOM and CRLF", () => {
    expect(
      readDelimited('\uFEFFname,note\r\n"A,B","say ""hi""\nagain"\r\n')
    ).toEqual([
      ["name", "note"],
      ["A,B", 'say "hi"\nagain'],
    ]);
    expect(readDelimited("a\tb\r1\t2\n", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(readDelimited('""')).toEqual([[""]]);
    expect(readDelimited("a,")).toEqual([["a", ""]]);
  });
  test("refuses malformed quoting rather than moving values into another column", () => {
    for (const text of ['"unclosed', 'a"b', '"a"x'])
      expect(() => readDelimited(text)).toThrow();
  });
  test("round-trips null, empty text, literal null marker, structures and multiline values", () => {
    const rows = [
      { name: "", note: null },
      { name: "\\N", note: 'line\n"two"' },
      { name: "\\path", note: "a,b" },
    ];
    const csv = writeDelimited(["name", "note"], rows);
    expect(importedRows(model, csv, "csv")).toEqual(rows);
    expect(dataText(["note", "name"], rows, "json")).toBe(
      JSON.stringify(
        rows.map((row) => ({ note: row.note, name: row.name })),
        null,
        2
      )
    );
    expect(cellText(note, null)).toBe("\\N");
    expect(
      textValue(name, readDelimited(cellText(name, "\\N"), "\t")[0]![0]!)
    ).toBe("\\N");
  });
  test("imports create data and omits generated columns by default", () => {
    expect(importedRows(model, "id,name,active\n5,Ada,true", "csv")).toEqual([
      { name: "Ada", active: true },
    ]);
    expect(
      importedRows(model, '[{"id":5,"name":"Ada"}]', "json", false)
    ).toEqual([{ id: 5, name: "Ada" }]);
    expect(importedRows(model, "name\tactive\nAda\tfalse", "tsv")).toEqual([
      { name: "Ada", active: false },
    ]);
  });
  test("refuses missing fields, unknown columns, duplicate headers and ragged input", () => {
    for (const [text, format] of [
      ["name,name\na,b", "csv"],
      ["name,note\na", "csv"],
      ["oops\na", "csv"],
      ["active\ntrue", "csv"],
      ["{}", "json"],
      ["[null]", "json"],
      ["[]", "json"],
      ['[{"name":"a","oops":1}]', "json"],
      ["name\n\\N", "csv"],
    ]) {
      if (format !== "csv" && format !== "json") throw new Error("bad fixture");
      expect(() => importedRows(model, text!, format)).toThrow();
    }
  });
  test("refuses oversized imports and too many rows", () => {
    expect(() =>
      importedRows(
        model,
        JSON.stringify(Array.from({ length: 501 }, () => ({ name: "x" }))),
        "json"
      )
    ).toThrow("1–500");
    expect(() =>
      importedRows(model, "x".repeat(512 * 1024 + 1), "csv")
    ).toThrow("512 KB");
  });
  test("refuses invalid booleans and unsafe integers instead of silently coercing them", () => {
    expect(() => textValue(active, "yes")).toThrow("true or false");
    expect(() => textValue(id, "1.5")).toThrow("safe integer");
    expect(() => textValue(id, "9007199254740993")).toThrow("safe integer");
  });
  test("duplicates scalar data without identity, generated or unique columns", () => {
    expect(
      duplicateData(model, {
        id: 4,
        name: "Ada",
        active: true,
        email: "a@example.com",
        createdAt: "now",
        relation: { id: 1 },
      })
    ).toEqual({ name: "Ada", active: true });
  });
  test("prepares an entire paste rectangle before any write", () => {
    const rows = [
      { id: 1, name: "old" },
      { id: 2, name: "old2" },
    ];
    expect(
      pastedRows(model, rows, ["name", "active"], "new\ttrue\nother\tfalse")
    ).toEqual([
      { row: rows[0], data: { name: "new", active: true } },
      { row: rows[1], data: { name: "other", active: false } },
    ]);
    expect(() =>
      pastedRows(model, rows, ["name", "active"], "new\ttrue\nother\tinvalid")
    ).toThrow();
    expect(rows).toEqual([
      { id: 1, name: "old" },
      { id: 2, name: "old2" },
    ]);
    expect(() => pastedRows(model, rows, ["id"], "4")).toThrow("not editable");
    expect(() => pastedRows(model, rows, ["name"], "a\tb")).toThrow("fit");
    expect(() => pastedRows(model, rows, ["name"], "a\nb\nc")).toThrow("fit");
  });
});
