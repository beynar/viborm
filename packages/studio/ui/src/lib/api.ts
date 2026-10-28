// The studio API, as the app calls it. Its types are the server's own.
import type { StudioDescription } from "../../../src/api";
import type { StudioField, StudioModel } from "../../../src/schema";
import { parseDraft } from "./values";

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
  /** The change a save stopped at, by its place in the list. */
  readonly at?: number;
  constructor(code: string, message: string, at?: number) {
    super(message);
    this.code = code;
    if (at !== undefined) this.at = at;
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
      error.message ?? response.statusText,
      typeof error.at === "number" ? error.at : undefined
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

/** What the studio keeps for the page, per project: its views and the diagram's layout. */
export const readStored = async (name: "views" | "layout") =>
  (await call<{ value: unknown }>(`/store/${name}`)).value;
export const keepStored = (name: "views" | "layout", value: unknown) =>
  call<{ kept: string }>(`/store/${name}`, { value });

/** The stacked changes, written in one transaction: all of them, or none. */
export const saveChanges = (changes: readonly unknown[]) =>
  call<{ saved: number }>("/changes", { changes });

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

/** A row as a picker says it: its first text column (other than `shown`, which the option says already), else its key. */
export function rowLabel(model: StudioModel, row: Row, shown?: string): string {
  const text = model.fields.find(
    (field) =>
      field.searchable &&
      !field.id &&
      field.name !== shown &&
      typeof row[field.name] === "string"
  );
  const key = model.key
    ? model.key.fields.map((field) => String(row[field])).join(", ")
    : "";
  return text ? String(row[text.name]) : key;
}

/** A column that is a relation's single foreign key: the model it points to, and the column there it holds. */
export interface ForeignKey {
  readonly target: StudioModel;
  readonly reference: string;
}

export function foreignKeyOf(
  model: StudioModel,
  models: readonly StudioModel[],
  field: StudioField
): ForeignKey | undefined {
  const relation = model.relations.find(
    (candidate) =>
      candidate.owner &&
      candidate.fields.length === 1 &&
      candidate.fields[0] === field.name
  );
  const target = models.find(
    (candidate) => candidate.name === relation?.targets[0]
  );
  return relation && target
    ? { target, reference: relation.references[0]! }
    : undefined;
}

const PICKED = 20;

/**
 * The rows of `target` a picker offers for the words typed, each option's
 * value the row's `valueField` (its one key column unless named): the row whose
 * value is the words, then the rows whose text holds them. The exact lookup is
 * the client's to admit: words that are no such value find nothing there.
 */
export function rowChoices(
  target: StudioModel,
  valueField = target.key?.fields.length === 1
    ? target.key.fields[0]
    : undefined
) {
  const field = target.fields.find(
    (candidate) => candidate.name === valueField
  );
  const searchable = target.fields.some((candidate) => candidate.searchable);
  return async (words: string | undefined) => {
    if (!(valueField && field)) return [];
    const typed = words?.trim() ?? "";
    const exact = async (): Promise<Row[]> => {
      if (!typed) return [];
      try {
        const where = { [valueField]: parseDraft(field, typed) };
        return (await readRows(target.name, { skip: 0, take: 1, where })).rows;
      } catch {
        return [];
      }
    };
    const found = async (): Promise<Row[]> => {
      if (typed && !searchable) return [];
      const search = typed ? { search: typed } : {};
      return (await readRows(target.name, { skip: 0, take: PICKED, ...search }))
        .rows;
    };
    const [first, rest] = await Promise.all([exact(), found()]);
    const seen = new Set<string>();
    const choices: { value: string; label: string; description: string }[] = [];
    for (const row of [...first, ...rest]) {
      const value = String(row[valueField]);
      if (seen.has(value) || seen.size === PICKED) continue;
      seen.add(value);
      choices.push({
        value,
        label: rowLabel(target, row, valueField),
        description: `${target.name} ${value}`,
      });
    }
    return choices;
  };
}
