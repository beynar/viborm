// The changes the member makes, stacked rather than written: each cell set, row added or deleted, and relation
// linked or unlinked waits here until it is sent, every one in one transaction of the client (`POST /api/changes`),
// or dropped. The table shows them over the rows the database answered. They are kept for the browser's session,
// per project, so a reload does not lose them.
import type { Row } from "./api";

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

export class Changes {
  list = $state<StagedChange[]>([]);
  /** The change the last save stopped at, when the client refused it. */
  failed = $state<string>();
  /** Bumped by every save that wrote: the open table reads its rows again. */
  saved = $state(0);
  readonly #key: string;

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
    if (Object.keys(merged).length === 0) return this.#write(rest);
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
    label: string
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
    this.list = list;
    this.failed = undefined;
    sessionStorage.setItem(this.#key, JSON.stringify(list));
  }
}
