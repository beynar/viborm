// Named project items share persistence, browser migration and write ordering.
import { keepStored, readStored } from "./api";

export class SavedItems<Item extends { readonly id: string }> {
  list = $state<Item[]>([]);
  /** The items the studio keeps were read (or it keeps none): an address naming one can find it. */
  loaded = $state(false);
  readonly #key: string;
  readonly #name: "views" | "queries";
  /** The studio keeps them; else the browser does. */
  #kept = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(project: string, name: "views" | "queries") {
    this.#name = name;
    this.#key = `viborm-studio:${name}:${project}`;
    this.list = this.#readLocal();
  }

  /** The items the studio keeps, read (again, when another page changed them); the browser's moved there once. */
  async load(): Promise<void> {
    try {
      const kept: Item[] = await readStored(this.#name).then((value) =>
        Array.isArray(value) ? value : []
      );
      // Items this browser kept alone join the studio's, never replace them.
      const local = this.#readLocal().filter(
        (item) => !kept.some((other) => other.id === item.id)
      );
      this.list = [...kept, ...local];
      if (local.length) await keepStored(this.#name, this.list);
      this.#kept = true;
      localStorage.removeItem(this.#key);
    } catch {
      this.#kept = false;
    } finally {
      this.loaded = true;
    }
  }

  #readLocal(): Item[] {
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
  protected change(change: (list: Item[]) => Item[]): Promise<void> {
    const next = this.#writing.then(async () => {
      const list = change(this.list);
      if (this.#kept) await keepStored(this.#name, list);
      else localStorage.setItem(this.#key, JSON.stringify(list));
      this.list = list;
    });
    // A refused change fails its own caller only: the next one still runs.
    this.#writing = next.catch(() => undefined);
    return next;
  }
}
