// Saved views: a model's table as the member left it (its filter, search, order, page size and columns), named and
// listed in the sidebar. The studio keeps them per project (`~/.viborm/studio`), whatever port it takes and in
// whichever browser, and tells every open page when they change. Views a browser kept before move there once; a
// studio that keeps nothing leaves them to the browser.
import type { ModelIcon } from "../../../src/icons";
import type { Scope } from "./api";
import { SavedItems } from "./saved-items.svelte";
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

export class Views extends SavedItems<SavedView> {
  constructor(project: string) {
    super(project, "views");
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
    await this.change((list) => [...list, view]);
    return view;
  }

  /** The view, renamed, holding the table as it is now, under the icon chosen (else the one it had). */
  update(
    id: string,
    name: string,
    state: ViewState,
    icon?: ModelIcon
  ): Promise<void> {
    return this.change((list) =>
      list.map((view) =>
        view.id === id
          ? { ...view, ...state, name, ...(icon ? { icon } : {}) }
          : view
      )
    );
  }

  /** The view's icon in the sidebar. */
  setIcon(id: string, icon: ModelIcon): Promise<void> {
    return this.change((list) =>
      list.map((view) => (view.id === id ? { ...view, icon } : view))
    );
  }

  duplicate(id: string): Promise<string> {
    return this.duplicateItem(id, (item) =>
      structuredClone($state.snapshot(item))
    );
  }

  remove(id: string): Promise<void> {
    return this.change((list) => list.filter((view) => view.id !== id));
  }
}
