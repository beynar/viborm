// The changes the member makes, stacked rather than written: each cell set, row added or deleted, and relation
// linked or unlinked waits here until it is sent, every one in one transaction of the client (`POST /api/changes`),
// or dropped. The table shows them over the rows the database answered. They are kept for the browser's session,
// per project, so a reload does not lose them.
import { confirmation } from "entasis/confirmation";
import { toast } from "entasis/toast";
import { type Row, StudioError, saveChanges } from "./api";

export interface StagedChange {
  readonly id: string;
  readonly model: string;
  readonly action: "create" | "update" | "delete";
  /** The row an update or a delete addresses. */
  readonly key?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
  /** An update that writes a relation (`connect`, `disconnect`): kept apart, never merged. */
  readonly nested?: boolean;
  /** How the list of changes says it. */
  readonly label: string;
  /** A row linked or unlinked through a relation: what the related rows panel draws until it is saved. */
  readonly link?: StagedLink;
}

export interface StagedLink {
  readonly relation: string;
  readonly variant?: string;
  /** The model of the row linked or unlinked, and its key. */
  readonly target: string;
  readonly key: Record<string, unknown>;
  readonly action: "connect" | "disconnect";
}

const keyId = (key: Record<string, unknown> | undefined) =>
  JSON.stringify(key ?? null);

/** Whether a staged value says what the database holds: a day staged as `YYYY-MM-DD` matches its midnight. */
function same(held: unknown, staged: unknown): boolean {
  if (
    typeof held === "string" &&
    typeof staged === "string" &&
    staged.length === 10 &&
    held.startsWith(`${staged}T00:00:00`)
  ) {
    return true;
  }
  return JSON.stringify(held) === JSON.stringify(staged);
}

/** A change as the list says it. */
export function said(change: StagedChange): string {
  if (change.action === "create") return `Add a ${change.model} row`;
  if (change.action === "delete") return `Delete ${change.label}`;
  if (change.nested) return change.label;
  return `${change.label} · ${Object.keys(change.data ?? {}).join(", ")}`;
}

export class Changes {
  list = $state<StagedChange[]>([]);
  /** The change the last save stopped at, when the client refused it, and the client's words for it. */
  failed = $state<string>();
  refusal = $state<string>();
  /** A save is on its way. */
  busy = $state(false);
  /** Bumped by every save that wrote: the open table reads its rows again. */
  saved = $state(0);
  readonly #key: string;
  #past = $state.raw<StagedChange[][]>([]);
  #future = $state.raw<StagedChange[][]>([]);
  #batching = false;

  get canUndo() {
    return !this.busy && this.#past.length > 0;
  }
  get canRedo() {
    return !this.busy && this.#future.length > 0;
  }

  /** One user action (paste/import/bulk edit) is one undo step, even across rows. */
  batch(action: () => void): void {
    if (this.#batching) {
      action();
      return;
    }
    if (this.busy) throw new Error("Wait for the current save to finish");
    const before = this.list;
    this.#batching = true;
    try {
      action();
      sessionStorage.setItem(this.#key, JSON.stringify(this.list));
    } catch (error) {
      this.#replace(before);
      throw error;
    } finally {
      this.#batching = false;
    }
    if (this.list !== before) this.#remember(before);
  }

  constructor(project: string) {
    this.#key = `viborm-studio:changes:${project}`;
    try {
      const stored = JSON.parse(sessionStorage.getItem(this.#key) ?? "[]");
      this.list = Array.isArray(stored) ? stored : [];
    } catch {
      this.list = [];
    }
  }

  /**
   * Cells of one row set: merged into the row's stacked update. A cell set back
   * to what the database holds (`held`) leaves the update; an emptied update goes.
   */
  update(
    model: string,
    key: Record<string, unknown>,
    data: Record<string, unknown>,
    label: string,
    held?: Row
  ): void {
    const id = keyId(key);
    const pending = this.list.find(
      (change) =>
        change.action === "update" &&
        !change.nested &&
        change.model === model &&
        keyId(change.key) === id
    );
    const merged = Object.fromEntries(
      Object.entries({ ...pending?.data, ...data }).filter(
        ([column, value]) =>
          !(held && column in held && same(held[column], value))
      )
    );
    const rest = this.list.filter((change) => change !== pending);
    if (Object.keys(merged).length === 0) {
      this.#write(rest);
      return;
    }
    const change: StagedChange = pending
      ? { ...pending, data: merged }
      : {
          id: crypto.randomUUID(),
          model,
          action: "update",
          key,
          data: merged,
          label,
        };
    this.#write(
      pending
        ? this.list.map((entry) => (entry === pending ? change : entry))
        : [...rest, change]
    );
  }

  /** A relation of one row written (linked, unlinked): its own change. */
  nested(
    model: string,
    key: Record<string, unknown>,
    data: Record<string, unknown>,
    label: string,
    link?: StagedLink
  ): void {
    this.#write([
      ...this.list,
      {
        id: crypto.randomUUID(),
        model,
        action: "update",
        key,
        data,
        nested: true,
        label,
        ...(link ? { link } : {}),
      },
    ]);
  }

  /** A row to add; a row already stacked to be added has its data replaced. */
  create(
    model: string,
    data: Record<string, unknown>,
    label: string,
    id?: string
  ): void {
    const existing = id && this.list.find((change) => change.id === id);
    this.#write(
      existing
        ? this.list.map((change) =>
            change === existing ? { ...change, data } : change
          )
        : [
            ...this.list,
            { id: crypto.randomUUID(), model, action: "create", data, label },
          ]
    );
  }

  /** A row to delete: what was stacked for it goes, as the row will. */
  delete(model: string, key: Record<string, unknown>, label: string): void {
    const id = keyId(key);
    this.#write([
      ...this.list.filter(
        (change) => !(change.model === model && keyId(change.key) === id)
      ),
      { id: crypto.randomUUID(), model, action: "delete", key, label },
    ]);
  }

  remove(id: string): void {
    this.#write(this.list.filter((change) => change.id !== id));
  }

  clear(): void {
    this.#write([]);
  }

  /** Every change sent in one transaction: all written, or none, the refused one named. */
  async save(): Promise<void> {
    if (this.busy || this.list.length === 0) return;
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    this.busy = true;
    try {
      const { saved } = await saveChanges(this.toSend());
      this.#replace([]);
      this.#past = [];
      this.#future = [];
      this.refusal = undefined;
      this.saved += 1;
      toast.success({
        title: saved === 1 ? "One change saved" : `${saved} changes saved`,
      });
    } catch (error) {
      const at = error instanceof StudioError ? error.at : undefined;
      const stopped = at === undefined ? undefined : this.list[at];
      this.failed = stopped?.id;
      this.refusal = error instanceof Error ? error.message : String(error);
      toast.danger({
        title: stopped
          ? `Nothing was saved: “${said(stopped)}” was refused`
          : "Nothing was saved",
        description: this.refusal,
      });
    } finally {
      this.busy = false;
    }
  }

  /** Every change dropped, once the member says so. */
  async discard(): Promise<void> {
    const count = this.list.length;
    if (count === 0) return;
    const { confirmed } = await confirmation({
      title: count === 1 ? "Drop this change?" : `Drop these ${count} changes?`,
      description:
        "Nothing was written: the rows stay as the database holds them.",
      confirm: { text: "Drop", color: "danger" },
      cancel: "Keep them",
    });
    if (confirmed) this.clear();
  }

  /** Undo the last editing action, preserving earlier edits to the same row. */
  undo(): void {
    if (!this.canUndo) return;
    const previous = this.#past.at(-1)!;
    this.#past = this.#past.slice(0, -1);
    this.#future = [...this.#future, this.list];
    this.#replace(previous);
  }

  redo(): void {
    if (!this.canRedo) return;
    const next = this.#future.at(-1)!;
    this.#future = this.#future.slice(0, -1);
    this.#past = [...this.#past, this.list];
    this.#replace(next);
  }

  /** The cells stacked for one row, merged. */
  pendingOf(model: string, key: Record<string, unknown> | undefined) {
    const id = keyId(key);
    return this.list.find(
      (change) =>
        change.action === "update" &&
        !change.nested &&
        change.model === model &&
        keyId(change.key) === id
    )?.data;
  }

  isDeleted(model: string, key: Record<string, unknown> | undefined): boolean {
    const id = keyId(key);
    return this.list.some(
      (change) =>
        change.action === "delete" &&
        change.model === model &&
        keyId(change.key) === id
    );
  }

  createdOf(model: string): StagedChange[] {
    return this.list.filter(
      (change) => change.action === "create" && change.model === model
    );
  }

  /** What `POST /api/changes` sends: each change as the API takes it. */
  toSend() {
    return this.list.map(({ model, action, key, data }) => ({
      model,
      action,
      ...(key ? { key } : {}),
      ...(data ? { data } : {}),
    }));
  }

  #write(list: StagedChange[]): void {
    if (this.busy) throw new Error("Wait for the current save to finish");
    if (JSON.stringify(list) === JSON.stringify(this.list)) return;
    const before = this.list;
    this.#replace(list);
    if (!this.#batching) this.#remember(before);
  }

  #remember(list: StagedChange[]): void {
    this.#past = [...this.#past.slice(-99), list];
    this.#future = [];
  }

  #replace(list: StagedChange[]): void {
    if (!this.#batching)
      sessionStorage.setItem(this.#key, JSON.stringify(list));
    this.list = list;
    this.failed = undefined;
  }
}
