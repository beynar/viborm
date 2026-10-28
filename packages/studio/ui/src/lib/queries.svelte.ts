import type { QueryOperation } from "./api";
import type { QueryDraft } from "./query-builder";
import { SavedItems } from "./saved-items.svelte";

export interface QueryState {
  readonly model: string;
  readonly operation: QueryOperation;
  readonly draft: QueryDraft;
  /** Present when the query opens in the code editor. Older saved queries use the builder. */
  readonly code?: string;
}

export interface SavedQuery extends QueryState {
  readonly id: string;
  readonly name: string;
}

export const queryHref = (query: SavedQuery) =>
  `#/query?query=${encodeURIComponent(query.id)}`;

export class Queries extends SavedItems<SavedQuery> {
  constructor(project: string) {
    super(project, "queries");
  }

  find(id: string | undefined): SavedQuery | undefined {
    return this.list.find((query) => query.id === id);
  }

  async create(name: string, state: QueryState): Promise<SavedQuery> {
    const query = { ...state, id: crypto.randomUUID(), name };
    await this.change((list) => [...list, query]);
    return query;
  }

  update(id: string, name: string, state: QueryState): Promise<void> {
    return this.change((list) =>
      list.map((query) =>
        query.id === id ? { ...query, ...state, name } : query
      )
    );
  }

  remove(id: string): Promise<void> {
    return this.change((list) => list.filter((query) => query.id !== id));
  }
}
