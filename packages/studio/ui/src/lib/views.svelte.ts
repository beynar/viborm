// Saved views: a model's table as the member left it (its filter, search, order, page size and columns), named and
// listed in the sidebar. The studio keeps them per project (`~/.viborm/studio`), whatever port it takes and in
// whichever browser, and tells every open page when they change. Views a browser kept before move there once; a
// studio that keeps nothing leaves them to the browser.
import type { ModelIcon } from "../../../src/icons";
import { keepStored, readStored, type Scope } from "./api";
import type { Combinator, FilterEntry } from "./values";

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  /** The icon chosen for it in the sidebar; none, a bookmark. */
  readonly icon?: ModelIcon;
  /** The relation followed into the model, when the view was saved from one. */
  readonly scope?: Scope;
  /** Conditions and groups of them; views saved before groups hold conditions only. */
  readonly conditions: readonly FilterEntry[];
  readonly combinator: Combinator;
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

export type ViewState = Omit<SavedView, "id" | "name" | "model" | "icon">;

export class Views {
  list = $state<SavedView[]>([]);
  /** The views the studio keeps were read (or it keeps none): an address naming one can find it. */
  loaded = $state(false);
  readonly #key: string;
  /** The studio keeps them; else the browser does. */
  #kept = false;
  #writing: Promise<void> = Promise.resolve();

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
    } finally {
      this.loaded = true;
    }
  }

  find(id: string | undefined): SavedView | undefined {
    return this.list.find((view) => view.id === id);
  }

  /** A new view, named, of a model's table as it is now; once it is kept. */
  async create(
    name: string,
    model: string,
    state: ViewState,
    icon?: ModelIcon
  ): Promise<SavedView> {
    const view = {
      ...state,
      id: crypto.randomUUID(),
      name,
      model,
      ...(icon ? { icon } : {}),
    };
    await this.#write((list) => [...list, view]);
    return view;
  }

  /** The view, renamed, holding the table as it is now, under the icon chosen (else the one it had). */
  update(
    id: string,
    name: string,
    state: ViewState,
    icon?: ModelIcon
  ): Promise<void> {
    return this.#write((list) =>
      list.map((view) =>
        view.id === id
          ? { ...view, ...state, name, ...(icon ? { icon } : {}) }
          : view
      )
    );
  }

  /** The view's icon in the sidebar. */
  setIcon(id: string, icon: ModelIcon): Promise<void> {
    return this.#write((list) =>
      list.map((view) => (view.id === id ? { ...view, icon } : view))
    );
  }

  remove(id: string): Promise<void> {
    return this.#write((list) => list.filter((view) => view.id !== id));
  }

  #readLocal(): SavedView[] {
    try {
      const stored = JSON.parse(localStorage.getItem(this.#key) ?? "[]");
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  /**
   * One change at a time, each made to the list the previous one left, and shown once kept: a change the studio
   * refused leaves the list as it was, and is never carried into the next one.
   */
  #write(change: (list: SavedView[]) => SavedView[]): Promise<void> {
    const next = this.#writing.then(async () => {
      const list = change(this.list);
      if (this.#kept) await keepStored("views", list);
      else localStorage.setItem(this.#key, JSON.stringify(list));
      this.list = list;
    });
    // A refused change fails its own caller only: the next one still runs.
    this.#writing = next.catch(() => undefined);
    return next;
  }
}
