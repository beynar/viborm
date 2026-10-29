import type { ModelIcon } from "../../../src/icons";
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
  readonly icon?: ModelIcon;
}

export class Queries extends SavedItems<SavedQuery> {
  constructor(project: string) {
    super(project, "queries");
  }

  find(id: string | undefined): SavedQuery | undefined {
    return this.list.find((query) => query.id === id);
  }

  async create(
    name: string,
    state: QueryState,
    icon?: ModelIcon
  ): Promise<SavedQuery> {
    const query = {
      ...state,
      id: crypto.randomUUID(),
      name,
      ...(icon ? { icon } : {}),
    };
    await this.change((list) => [...list, query]);
    return query;
  }

  update(
    id: string,
    name: string,
    state: QueryState,
    icon?: ModelIcon
  ): Promise<void> {
    return this.change((list) =>
      list.map((query) =>
        query.id === id
          ? { ...query, ...state, name, ...(icon ? { icon } : {}) }
          : query
      )
    );
  }

  rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error("Enter a query name."));
    return this.change((list) => {
      if (!list.some((query) => query.id === id))
        throw new Error("This query no longer exists.");
      return list.map((query) =>
        query.id === id ? { ...query, name: trimmed } : query
      );
    });
  }

  setIcon(id: string, icon: ModelIcon): Promise<void> {
    return this.change((list) =>
      list.map((query) => (query.id === id ? { ...query, icon } : query))
    );
  }

  duplicate(id: string): Promise<string> {
    return this.duplicateItem(id, (item) =>
      structuredClone($state.snapshot(item))
    );
  }

  remove(id: string): Promise<void> {
    return this.change((list) => list.filter((query) => query.id !== id));
  }
}
