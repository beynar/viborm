// The studio API, as the app calls it. Its types are the server's own.
import type { StudioModel, StudioSchema } from "../../../src/schema";

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

export const loadSchema = () => call<StudioSchema>("/schema");

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
