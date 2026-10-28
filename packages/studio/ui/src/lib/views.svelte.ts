// Saved views: a model's table as the member left it (its filter, search, order, page size and column widths),
// named and listed in the sidebar. They are kept in the browser per project (the config's path makes the key, as for
// the diagram's layout), and every tab of the studio sees a change made in another.
import type { Scope } from "./api";
import type { Condition } from "./values";

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  /** The relation followed into the model, when the view was saved from one. */
  readonly scope?: Scope;
  readonly conditions: readonly Condition[];
  readonly combinator: "AND" | "OR";
  readonly search: string;
  /** The search folds case; absent in views saved before it could. */
  readonly ignoreCase?: boolean;
  readonly sorting: readonly { readonly id: string; readonly desc: boolean }[];
  readonly pageSize: number;
  readonly columnSizing: Readonly<Record<string, number>>;
}

export type ViewState = Omit<SavedView, "id" | "name" | "model">;

export class Views {
  list = $state<SavedView[]>([]);
  readonly #key: string;

  constructor(project: string) {
    this.#key = `viborm-studio:views:${project}`;
    this.list = this.#read();
  }

  /** Follows the views another tab saved; returns what stops following them. */
  follow(): () => void {
    const changed = (event: StorageEvent) => {
      if (event.key === this.#key) this.list = this.#read();
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }

  find(id: string | undefined): SavedView | undefined {
    return this.list.find((view) => view.id === id);
  }

  /** A new view, named, of a model's table as it is now. */
  create(name: string, model: string, state: ViewState): SavedView {
    const view = { ...state, id: crypto.randomUUID(), name, model };
    this.#write([...this.list, view]);
    return view;
  }

  /** The view, renamed, holding the table as it is now. */
  update(id: string, name: string, state: ViewState): void {
    this.#write(
      this.list.map((view) =>
        view.id === id ? { ...view, ...state, name } : view
      )
    );
  }

  remove(id: string): void {
    this.#write(this.list.filter((view) => view.id !== id));
  }

  #read(): SavedView[] {
    try {
      const stored = JSON.parse(localStorage.getItem(this.#key) ?? "[]");
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  #write(list: SavedView[]): void {
    this.list = list;
    localStorage.setItem(this.#key, JSON.stringify(list));
  }
}
