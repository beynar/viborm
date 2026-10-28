<script lang="ts">
import { Alert } from "entasis/alert";
import { Button } from "entasis/button";
import { Checkbox } from "entasis/checkbox";
import { Combobox } from "entasis/combobox";
import { confirmation } from "entasis/confirmation";
import { DateInput } from "entasis/date-input";
import { Dialog } from "entasis/dialog";
import { trashIcon } from "entasis/icons/trash";
import { NumberInput } from "entasis/number-input";
import { Select } from "entasis/select";
import { Switch } from "entasis/switch";
import { TextArea } from "entasis/text-area";
import { TextInput } from "entasis/text-input";
import { TimeInput } from "entasis/time-input";
import { untrack } from "svelte";
import {
  foreignKeyOf,
  type Row,
  rowChoices,
  type StudioField,
  type StudioModel,
} from "../../lib/api";
import { TYPE_ICONS } from "../../lib/icons";
import {
  dateToDay,
  dayToDate,
  draftOf,
  editsAsJson,
  instantOf,
  instantParts,
  parseDraft,
  secondsToTime,
  timeToSeconds,
  typeLabel,
} from "../../lib/values";

// One row in a drawer over the table's right side: every column as an editor of its type, and a null switch where a
// column may be empty. A new row sends what was written and leaves the rest to the schema's defaults and generators;
// an existing one sends only what changed. Both go through the client: what it refuses shows here, in its words.
let {
  model,
  models,
  readonly = false,
  row,
  save,
  remove,
  close,
}: {
  model: StudioModel;
  /** Every model: a foreign key picks a row of the model it points to. */
  models: readonly StudioModel[];
  /** The studio does not write: the drawer shows the row and saves nothing. */
  readonly?: boolean;
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
// The drawer is keyed on its row (`RowsView`): its drafts start from the row it opened with.
let drafts = $state<Record<string, Draft>>(
  untrack(() =>
    Object.fromEntries(
      model.fields.map((field) => [field.name, initial(field)])
    )
  )
);
let failure = $state<string>();
let busy = $state(false);
let open = $state(true);

// The label is read by assistive technology only: its header leaves the layout too, so no empty row spaces the control.
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};
/** A field an existing row keeps: its generated key, or a `.now()` creation timestamp. */
const readOnly = (field: StudioField) =>
  row !== undefined &&
  (!field.updatable || (field.id && field.generated !== undefined));
const hint = (field: StudioField) =>
  field.generated
    ? `generated (${field.generated})`
    : field.optional
      ? "default"
      : "";
const keyText = $derived(
  row && model.key
    ? model.key.fields.map((field) => String(row[field])).join(", ")
    : ""
);

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

async function submit() {
  failure = undefined;
  busy = true;
  try {
    await save(dataOf());
    open = false;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
  }
}

async function destroy() {
  if (!remove) return;
  const { confirmed } = await confirmation({
    title: `Delete this ${model.name}?`,
    description: "The row is deleted through your client. It cannot be undone.",
    confirm: { text: "Delete", color: "danger" },
    cancel: "Cancel",
  });
  if (!confirmed) return;
  failure = undefined;
  busy = true;
  try {
    await remove();
    open = false;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
  }
}
</script>

<Dialog
  bind:open
  type="drawerRight"
  title={row ? `${model.name} ${keyText}` : `New ${model.name}`}
  description={readonly ? 'The studio is read-only.' : row ? 'Changed columns are saved through your client.' : 'Left empty, a column takes its default.'}
  onAfterClose={close}
>
  {#if failure}
    <div class="mb-4">
      <Alert color="danger" variant="soft">
        {#snippet title()}The client refused this change{/snippet}
        {#snippet description()}<span class="whitespace-pre-wrap">{failure}</span>{/snippet}
      </Alert>
    </div>
  {/if}
  <form class="grid gap-4" onsubmit={event => { event.preventDefault(); submit() }} id="row-form">
    {#each model.fields as field (field.name)}
      {@const draft = drafts[field.name]!}
      <!-- A read-only studio shows values as text to read, not greyed out; null is said as null. -->
      {@const disabled = !readonly && (draft.isNull || readOnly(field))}
      {@const placeholder = draft.isNull ? 'null' : readonly || readOnly(field) ? '' : hint(field)}
      {@const pointed = foreignKeyOf(model, models, field)}
      <div class="grid gap-1.5">
        <div class="flex items-center gap-2 text-[13px]">
          <span class="inline-flex text-neutral/55">{@render TYPE_ICONS[field.type]({ size: 14 })}</span>
          <span class="font-medium">{field.name}</span>
          <span class="font-mono text-[11px] text-neutral/50">{typeLabel(field)}</span>
          {#if field.nullable && !readonly && !readOnly(field)}
            <span class="ml-auto"><Checkbox size="small" label="null" value={draft.isNull} onValueChange={value => (draft.isNull = value === true)} /></span>
          {/if}
        </div>
        {#if pointed}
          {@const target = pointed.target}
          <!-- A foreign key picks the row it points to, found by its text or the value it holds. -->
          <Combobox
            size="small"
            label={field.name}
            theme={HIDDEN_LABEL}
            {disabled}
            readOnly={readonly}
            items={rowChoices(target, pointed.reference)}
            openOnFocus
            placeholder={placeholder || (readonly ? '' : `A ${target.name} row`)}
            loadingText="Searching…"
            noOptionsText="No {target.name} row matches"
            value={draft.text || null}
            getValueOption={value => ({ value, label: `${target.name} ${value}` })}
            onValueChange={({ value }) => (draft.text = value ?? '')}
          />
        {:else if field.type === 'boolean' && !field.list}
          <Switch label={field.name} theme={HIDDEN_LABEL} disabled={disabled || readonly} value={draft.text === 'true'} onValueChange={value => (draft.text = value ? 'true' : 'false')} />
        {:else if field.type === 'enum' && !field.list}
          <Select
            size="small"
            label={field.name}
            theme={HIDDEN_LABEL}
            {disabled}
            readOnly={readonly}
            placeholder={placeholder || (readonly ? '' : 'Choose')}
            items={(field.enumValues ?? []).map(value => ({ value, label: value }))}
            value={draft.text || null}
            onValueChange={value => (draft.text = value ?? '')}
          />
        {:else if field.type === 'datetime' && !field.list}
          <!-- An instant: its day on a calendar and its time, in the browser's zone; stored as an ISO instant. -->
          {@const parts = instantParts(draft.text)}
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1"><DateInput size="small" label="{field.name}, day" theme={HIDDEN_LABEL} {disabled} readOnly={readonly} format="yyyy/mm/dd" closeOnSelect value={parts?.day ?? null} onValueChange={day => (draft.text = day ? instantOf(day, parts?.seconds ?? 0) : '')} /></div>
            <div class="w-36 shrink-0"><TimeInput size="small" label="{field.name}, time" theme={HIDDEN_LABEL} {disabled} readOnly={readonly} format="HH:MM:SS" as="secondSinceMidnight" value={parts?.seconds ?? null} onValueChange={seconds => (draft.text = instantOf(parts?.day ?? new Date(), seconds ?? 0))} /></div>
            {#if !readonly && !disabled}<Button size="small" variant="ghost" type="button" onclick={() => (draft.text = new Date().toISOString())}>Now</Button>{/if}
          </div>
        {:else if field.type === 'date' && !field.list}
          <DateInput size="small" label={field.name} theme={HIDDEN_LABEL} {disabled} readOnly={readonly} format="yyyy/mm/dd" closeOnSelect value={dayToDate(draft.text)} onValueChange={day => (draft.text = day ? dateToDay(day) : '')} />
        {:else if field.type === 'time' && !field.list}
          <TimeInput size="small" label={field.name} theme={HIDDEN_LABEL} {disabled} readOnly={readonly} format="HH:MM:SS" as="secondSinceMidnight" value={timeToSeconds(draft.text)} onValueChange={seconds => (draft.text = seconds === null ? '' : secondsToTime(seconds))} />
        {:else if (field.type === 'int' || field.type === 'number') && !field.list}
          <NumberInput size="small" label={field.name} theme={HIDDEN_LABEL} {disabled} readOnly={readonly} {placeholder} step={field.type === 'int' ? 1 : 0.1} value={draft.text === '' ? null : Number(draft.text)} onValueChange={value => (draft.text = value === null || value === undefined ? '' : String(value))} />
        {:else if editsAsJson(field) || field.type === 'blob'}
          <TextArea size="small" label={field.name} theme={HIDDEN_LABEL} {disabled} readOnly={readonly} rows={4} placeholder={placeholder || (readonly ? '' : field.type === 'blob' ? 'base64' : 'JSON')} value={draft.text} onValueChange={value => (draft.text = value ?? '')} />
        {:else}
          <TextInput size="small" label={field.name} theme={HIDDEN_LABEL} {disabled} readOnly={readonly} {placeholder} value={draft.text} onValueChange={value => (draft.text = value ?? '')} />
        {/if}
      </div>
    {/each}
  </form>
  {#snippet footer()}
    <div class="flex w-full items-center gap-2 border-t border-neutral-muted pt-4">
      {#if remove && !readonly}<Button variant="soft" color="danger" prefix={trashIcon} disabled={busy} onclick={destroy}>Delete</Button>{/if}
      <span class="flex-1"></span>
      {#if readonly}
        <Button variant="ghost" onclick={() => (open = false)}>Close</Button>
      {:else}
        <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button color="primary" loading={busy} onclick={() => submit()}>{row ? 'Save' : 'Create'}</Button>
      {/if}
    </div>
  {/snippet}
</Dialog>
