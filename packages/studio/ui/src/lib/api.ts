// The studio API, as the app calls it. Its types are the server's own.
import type { StudioDescription } from "../../../src/api";
import type { StudioModel } from "../../../src/schema";

export type { StudioDescription } from "../../../src/api";
export type {
  StudioEdge,
  StudioField,
  StudioModel,
  StudioRelation,
  StudioSchema,
} from "../../../src/schema";

export type Row = Record<string, unknown> & {
  _count?: Record<string, number>;
};
export type Where = Record<string, unknown>;
export type OrderBy = Record<string, "asc" | "desc">;
/** The rows a followed relation reached: its filter, and how it is said. */
export type Scope = { where: Where; label: string };

/** A refusal the API answered with: the client's own code and message. */
export class StudioError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`./api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = answer?.error ?? {};
    throw new StudioError(
      error.code ?? String(response.status),
      error.message ?? response.statusText
    );
  }
  return answer as T;
}

export const loadSchema = () => call<StudioDescription>("/schema");

const at = (model: string, action: string) =>
  `/models/${encodeURIComponent(model)}/${action}`;

export const readRows = (
  model: string,
  query: {
    where?: Where;
    search?: string;
    orderBy?: OrderBy[];
    skip: number;
    take: number;
  }
) => call<{ rows: Row[]; total: number }>(at(model, "rows"), query);

export const createRow = (model: string, data: Row) =>
  call<{ row: Row }>(at(model, "create"), { data });

export const updateRow = (model: string, key: Row, data: Row) =>
  call<{ row: Row }>(at(model, "update"), { key, data });

export const deleteRow = (model: string, key: Row) =>
  call<{ row: Row }>(at(model, "delete"), { key });

/** The values of a row's key, which update and delete address it by. */
export const keyOf = (model: StudioModel, row: Row): Row | undefined =>
  model.key
    ? Object.fromEntries(model.key.fields.map((field) => [field, row[field]]))
    : undefined;

/** Download every row a page's filter, search and order reach, as a file. */
export async function exportRows(
  model: string,
  query: { where?: Where; search?: string; orderBy?: OrderBy[] },
  format: "csv" | "json"
): Promise<void> {
  const response = await fetch(`./api${at(model, "export")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...query, format }),
  });
  if (!response.ok) {
    const answer = await response.json().catch(() => ({}));
    throw new StudioError(
      answer?.error?.code ?? String(response.status),
      answer?.error?.message ?? response.statusText
    );
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = `${model}.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** A row as a picker says it: its first text column, else its key. */
export function rowLabel(model: StudioModel, row: Row): string {
  const text = model.fields.find(
    (field) =>
      field.type === "string" &&
      !field.id &&
      !field.list &&
      typeof row[field.name] === "string"
  );
  const key = model.key
    ? model.key.fields.map((field) => String(row[field])).join(", ")
    : "";
  return text ? String(row[text.name]) : key;
}

/**
 * The rows of `target` a picker offers for the words typed: found by its text
 * columns, or by its key when it has none. Each option's value is the row's
 * one key value.
 */
export function rowChoices(target: StudioModel, exclude?: string) {
  const key =
    target.key?.fields.length === 1 ? target.key.fields[0]! : undefined;
  const keyField = target.fields.find((field) => field.name === key);
  const searchable = target.fields.some(
    (field) => field.type === "string" && !field.list
  );
  const numeric = keyField?.type === "int" || keyField?.type === "number";
  return async (words: string | undefined) => {
    if (!key) return [];
    const typed = words?.trim() ?? "";
    if (typed && !searchable && numeric && !Number.isFinite(Number(typed)))
      return [];
    const { rows } = await readRows(target.name, {
      skip: 0,
      take: 20,
      ...(typed && searchable ? { search: typed } : {}),
      ...(typed && !searchable
        ? { where: { [key]: numeric ? Number(typed) : typed } }
        : {}),
    });
    return rows
      .filter((row) => String(row[key]) !== exclude)
      .map((row) => ({
        value: String(row[key]),
        label: rowLabel(target, row),
        description: `${target.name} ${String(row[key])}`,
      }));
  };
}
