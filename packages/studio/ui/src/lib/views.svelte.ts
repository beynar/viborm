// Saved views: a model's table as the member left it (its filter, search, order, page size and columns), named and
// listed in the sidebar. The studio keeps them per project (`~/.viborm/studio`), whatever port it takes and in
// whichever browser, and tells every open page when they change. Views a browser kept before move there once; a
// studio that keeps nothing leaves them to the browser.
import { toast } from "entasis/toast";
import { keepStored, readStored, type Scope } from "./api";
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
  /** The columns hidden, their order and those pinned; absent in views saved before the studio kept them. */
  readonly columnVisibility?: Readonly<Record<string, boolean>>;
  readonly columnOrder?: readonly string[];
  readonly columnPinning?: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  };
}

export type ViewState = Omit<SavedView, "id" | "name" | "model">;

export class Views {
  list = $state<SavedView[]>([]);
  readonly #key: string;
  /** The studio keeps them; else the browser does. */
  #kept = false;

  constructor(project: string) {
    this.#key = `viborm-studio:views:${project}`;
    this.list = this.#readLocal();
  }

  /** The views the studio keeps, read (again, when another page changed them); the browser's moved there once. */
  async load(): Promise<void> {
    try {
      const kept: SavedView[] = await readStored("views").then((value) =>
        Array.isArray(value) ? value : []
      );
      // Views this browser kept alone join the studio's, never replace them.
      const local = this.#readLocal().filter(
        (view) => !kept.some((other) => other.id === view.id)
      );
      this.list = [...kept, ...local];
      if (local.length) await keepStored("views", this.list);
      this.#kept = true;
      localStorage.removeItem(this.#key);
    } catch {
      this.#kept = false;
    }
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

  #readLocal(): SavedView[] {
    try {
      const stored = JSON.parse(localStorage.getItem(this.#key) ?? "[]");
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  #write(list: SavedView[]): void {
    this.list = list;
    if (!this.#kept) {
      localStorage.setItem(this.#key, JSON.stringify(list));
      return;
    }
    keepStored("views", list).catch((error: unknown) =>
      toast.danger({
        title: "The views could not be kept",
        description: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
