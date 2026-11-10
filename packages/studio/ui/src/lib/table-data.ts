import { writeDelimited } from "../../../src/delimited";
import type { Row, StudioField, StudioModel } from "./api";
import { draftOf, parseDraft, parseJson } from "./values";

export type DataFormat = "csv" | "json" | "tsv";
export const IMPORT_LIMIT = 500;
export const IMPORT_BYTES = 512 * 1024;
const BOM = /^\uFEFF/;

/** Quoted separators, line breaks and escaped quotes are data, not new cells. */
export function readDelimited(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const source = text.replace(BOM, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
      continue;
    }
    if (char === separator || char === "\n" || char === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (char !== separator) {
        rows.push(row);
        row = [];
        if (char === "\r" && source[i + 1] === "\n") i++;
      }
    } else if (char === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || char === '"')
        throw new Error(`Invalid quoted cell on row ${rows.length + 1}`);
      cell += char;
    }
  }
  if (quoted) throw new Error("Unclosed quoted cell");
  if (cell !== "" || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Explicit null avoids confusing an empty string with a missing value. */
export function textValue(field: StudioField, text: string): unknown {
  if (text === "\\N") {
    if (!field.nullable) throw new Error(`${field.name}: cannot be null`);
    return null;
  }
  const value = parseDraft(
    field,
    text.startsWith("\\\\") ? text.slice(1) : text
  );
  if (field.type === "int" && !field.list && !Number.isSafeInteger(value))
    throw new Error(`${field.name}: expected a safe integer`);
  return value;
}

export function projectRows(
  columns: readonly string[],
  rows: readonly Row[]
): Row[] {
  return rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column]]))
  );
}

export function dataText(
  columns: readonly string[],
  rows: readonly Row[],
  format: DataFormat
): string {
  return format === "json"
    ? JSON.stringify(projectRows(columns, rows), null, 2)
    : writeDelimited(columns, rows, format === "tsv" ? "\t" : ",");
}

/** Only scalar create data is admitted. Relations and unknown columns are never silently ignored. */
export function importedRows(
  model: StudioModel,
  text: string,
  format: DataFormat,
  omitGenerated = true
): Row[] {
  if (new TextEncoder().encode(text).length > IMPORT_BYTES)
    throw new Error("Import at most 512 KB at a time");
  let records: unknown;
  if (format === "json") records = parseJson(text);
  else {
    const [headers, ...lines] = readDelimited(
      text,
      format === "tsv" ? "\t" : ","
    );
    if (
      !headers?.length ||
      headers.some((name) => !name) ||
      new Set(headers).size !== headers.length
    )
      throw new Error("Use one unique field name per header");
    records = lines.map((line, index) => {
      if (line.length !== headers.length)
        throw new Error(
          `Row ${index + 2}: expected ${headers.length} cells, got ${line.length}`
        );
      return Object.fromEntries(headers.map((name, i) => [name, line[i]]));
    });
  }
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.length > IMPORT_LIMIT
  )
    throw new Error(`Import an array or table of 1–${IMPORT_LIMIT} rows`);
  const fields = new Map(model.fields.map((field) => [field.name, field]));
  return records.map((record: unknown, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error(`Row ${index + 1}: expected an object`);
    const data: Row = {};
    for (const [name, value] of Object.entries(record)) {
      const field = fields.get(name);
      if (!field) throw new Error(`Row ${index + 1}: unknown scalar ${name}`);
      if (omitGenerated && field.generated) continue;
      try {
        const parsed =
          format === "json" ? value : textValue(field, String(value));
        if (
          format === "json" &&
          (field.type === "bigint" || field.type === "decimal")
        ) {
          const values =
            field.list && Array.isArray(parsed) ? parsed : [parsed];
          if (values.some((value) => typeof value === "number"))
            throw new Error(`${name}: quote exact numeric values as strings`);
        }
        if (
          format === "json" &&
          field.type === "int" &&
          !field.list &&
          parsed !== null &&
          !Number.isSafeInteger(parsed)
        )
          throw new Error(`${name}: expected a safe integer`);
        if (parsed === null && !field.nullable)
          throw new Error(`${name}: cannot be null`);
        Object.defineProperty(data, name, {
          value: parsed,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } catch (error) {
        throw new Error(
          `Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const missing = model.fields.filter(
      (field) => !(field.optional || Object.hasOwn(data, field.name))
    );
    if (missing.length)
      throw new Error(
        `Row ${index + 1}: missing ${missing.map((field) => field.name).join(", ")}`
      );
    return data;
  });
}

/** A duplicate gets new identity/defaults and asks the user for unique values before staging. */
export function duplicateData(model: StudioModel, row: Row): Row {
  return Object.fromEntries(
    model.fields
      .filter(
        (field) =>
          !(field.generated || field.id || field.unique) && field.name in row
      )
      .map((field) => [field.name, row[field.name]])
  );
}

export function editableFields(model: StudioModel): readonly StudioField[] {
  return model.fields.filter(
    (field) => field.updatable && !(field.id && field.generated)
  );
}

/** Parse the complete rectangle before staging any cell, so one invalid cell changes nothing. */
export function pastedRows(
  model: StudioModel,
  rows: readonly Row[],
  columns: readonly string[],
  text: string
): { row: Row; data: Row }[] {
  if (new TextEncoder().encode(text).length > IMPORT_BYTES)
    throw new Error("Paste at most 512 KB at a time");
  const matrix = readDelimited(text, "\t");
  if (!matrix.length) return [];
  if (
    matrix.length > rows.length ||
    matrix.some(
      (line) =>
        line.length !== matrix[0]!.length || line.length > columns.length
    )
  )
    throw new Error(
      "The pasted cells must fit the loaded rows and visible columns"
    );
  const writable = new Map(
    editableFields(model).map((field) => [field.name, field])
  );
  return matrix.map((line, index) => ({
    row: rows[index]!,
    data: Object.fromEntries(
      line.map((text, offset) => {
        const field = writable.get(columns[offset]!);
        if (!field) throw new Error(`${columns[offset]}: not editable`);
        return [field.name, textValue(field, text)];
      })
    ),
  }));
}

export function cellText(field: StudioField, value: unknown): string {
  return writeDelimited(
    [field.name],
    [{ [field.name]: value === null ? null : draftOf(field, value) }],
    "\t",
    false
  );
}
