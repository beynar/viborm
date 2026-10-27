<script lang="ts">
import { untrack } from "svelte";
import type { Row, StudioField, StudioModel } from "../../lib/api";
import { draftOf, editsAsJson, parseDraft, typeLabel } from "../../lib/values";
import Icon from "../Icon.svelte";

// One row in a side panel: every column as an editor of its type. A new row sends what was written and leaves the
// rest to the schema's defaults; an existing one sends only what changed. Both go through the client, which refuses
// what it does not admit, and its message is shown here.
const {
  model,
  row,
  save,
  remove,
  close,
}: {
  model: StudioModel;
  /** The row edited; absent for a new one. */
  row?: Row;
  save: (data: Row) => Promise<void>;
  remove?: () => Promise<void>;
  close: () => void;
} = $props();

type Draft = { text: string; isNull: boolean };
const initial = (field: StudioField): Draft =>
  row
    ? {
        text: draftOf(field, row[field.name]),
        isNull: row[field.name] === null,
      }
    : { text: "", isNull: false };
// The panel is keyed on its row (`RowsView`): its drafts start from the row it opened with.
const drafts = $state<Record<string, Draft>>(
  untrack(() =>
    Object.fromEntries(
      model.fields.map((field) => [field.name, initial(field)])
    )
  )
);
let failure = $state<string>();
let busy = $state(false);

const readOnly = (field: StudioField) =>
  row !== undefined && field.id && field.generated !== undefined;

/** What the client is sent: the changed columns of a row, or the written ones of a new row. */
function dataOf(): Row {
  const data: Row = {};
  for (const field of model.fields) {
    const draft = drafts[field.name]!;
    if (readOnly(field)) continue;
    if (row) {
      const before = initial(field);
      if (draft.isNull === before.isNull && draft.text === before.text)
        continue;
    } else if (
      !draft.isNull &&
      draft.text === "" &&
      (field.optional || field.type !== "string")
    ) {
      continue;
    }
    data[field.name] = draft.isNull ? null : parseDraft(field, draft.text);
  }
  return data;
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  failure = undefined;
  busy = true;
  try {
    await save(dataOf());
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
  }
}

/** A delete asks once more, in the panel, before it reaches the client. */
let confirming = $state(false);

async function destroy() {
  if (!remove) return;
  confirming = false;
  failure = undefined;
  busy = true;
  try {
    await remove();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
  }
}

const hint = (field: StudioField) =>
  field.generated
    ? `generated (${field.generated})`
    : field.optional
      ? field.nullable
        ? "null or default"
        : "default"
      : "required";
</script>

<aside class="panel" aria-label={row ? `Edit ${model.name}` : `New ${model.name}`}>
  <header>
    <h2>{row ? `Edit ${model.name}` : `New ${model.name}`}</h2>
    <button class="icon ghost" aria-label="Close" onclick={close}><Icon name="x" /></button>
  </header>
  <form onsubmit={submit}>
    <div class="fields">
      {#each model.fields as field (field.name)}
        {@const draft = drafts[field.name]!}
        {@const id = `field-${field.name}`}
        <div class="field">
          <label for={id}>
            <span class="name">{field.name}</span>
            <span class="type">{typeLabel(field)}</span>
            {#if field.nullable}
              <span class="null"><input type="checkbox" bind:checked={draft.isNull} disabled={readOnly(field)} aria-label="{field.name} is null" />null</span>
            {/if}
          </label>
          {#if field.type === 'boolean' && !field.list}
            <select {id} bind:value={draft.text} disabled={draft.isNull || readOnly(field)}>
              {#if !row}<option value="">{hint(field)}</option>{/if}
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          {:else if field.type === 'enum' && !field.list}
            <select {id} bind:value={draft.text} disabled={draft.isNull || readOnly(field)}>
              {#if !row}<option value="">{hint(field)}</option>{/if}
              {#each field.enumValues ?? [] as value (value)}<option {value}>{value}</option>{/each}
            </select>
          {:else if editsAsJson(field) || field.type === 'blob'}
            <textarea {id} rows="4" bind:value={draft.text} disabled={draft.isNull || readOnly(field)} placeholder={field.type === 'blob' ? 'base64' : 'JSON'}></textarea>
          {:else}
            <input
              {id}
              bind:value={draft.text}
              disabled={draft.isNull || readOnly(field)}
              inputmode={field.type === 'int' || field.type === 'number' || field.type === 'bigint' || field.type === 'decimal' ? 'decimal' : undefined}
              placeholder={row ? '' : hint(field)}
            />
          {/if}
        </div>
      {/each}
    </div>
    {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
    <footer>
      {#if remove && confirming}
        <span class="confirm">Delete this {model.name}? This cannot be undone.</span>
        <button type="button" class="danger" onclick={destroy} disabled={busy}><Icon name="trash" />Delete</button>
        <button type="button" onclick={() => (confirming = false)}>Keep</button>
      {:else if remove}
        <button type="button" class="danger" onclick={() => (confirming = true)} disabled={busy}><Icon name="trash" />Delete</button>
      {/if}
      {#if !confirming}
        <span class="spacer"></span>
        <button type="button" onclick={close}>Cancel</button>
        <button type="submit" class="primary" disabled={busy}>{row ? 'Save' : 'Create'}</button>
      {/if}
    </footer>
  </form>
</aside>

<style>
  .panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--color-surface);
    box-shadow: -8px 0 24px color-mix(in oklab, var(--color-neutral) 10%, transparent);
    z-index: 5;
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 15px; }
  form { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .fields { flex: 1; overflow: auto; padding: 12px 16px; display: grid; gap: 12px; align-content: start; }
  .field { display: grid; gap: 4px; }
  label { display: flex; align-items: baseline; gap: 8px; }
  .name { font-weight: 600; }
  .type { font: 11px var(--mono); color: var(--muted); }
  .null { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
  .null input { height: auto; }
  .failure { margin: 0 16px; padding: 8px 10px; border-radius: 8px; background: color-mix(in oklab, var(--color-danger) 12%, transparent); color: var(--color-danger); white-space: pre-wrap; }
  footer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  .spacer { flex: 1; }
  .confirm { flex: 1; align-self: center; color: var(--color-danger); }
</style>
