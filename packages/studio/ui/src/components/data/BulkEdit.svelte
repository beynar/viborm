<script lang="ts">
import { Button } from "entasis/button";
import { Checkbox } from "entasis/checkbox";
import { Dialog } from "entasis/dialog";
import { Select } from "entasis/select";
import { TextArea } from "entasis/text-area";
import { TextInput } from "entasis/text-input";
import type { StudioModel } from "../../lib/api";
import { editableFields, textValue } from "../../lib/table-data";
import { editsAsJson, typeLabel } from "../../lib/values";

let {
  model,
  count,
  apply,
  close,
}: {
  model: StudioModel;
  count: number;
  apply: (field: string, value: unknown) => void;
  close: () => void;
} = $props();
let open = $state(true);
const fields = $derived(
  editableFields(model).filter(
    (field) => count === 1 || !(field.id || field.unique)
  )
);
let selected = $state("");
const field = $derived(fields.find((field) => field.name === selected));
let text = $state("");
let isNull = $state(false);
let failure = $state("");
function submit() {
  if (!field) return;
  try {
    apply(field.name, textValue(field, isNull ? "\\N" : text));
    open = false;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
}
</script>

<Dialog bind:open title="Edit {count} selected {count === 1 ? 'row' : 'rows'}" onAfterClose={close}>
  <div class="grid gap-4">
    <Select label="Field" placeholder="Choose a field" items={fields.map(field => ({value:field.name,label:field.name}))} value={selected} onValueChange={value => { selected = value ?? ''; text = ''; isNull = false; failure = '' }} />
    {#if field}
      {#if field.nullable}<Checkbox label="Set to null" value={isNull} onValueChange={value => isNull = value === true} />{/if}
      {#if field.type === 'boolean' && !field.list}
        <Select label="Value" disabled={isNull} items={[{value:'true',label:'true'},{value:'false',label:'false'}]} value={text} onValueChange={value => text = value ?? ''} />
      {:else if field.type === 'enum' && !field.list}
        <Select label="Value" disabled={isNull} items={(field.enumValues ?? []).map(value=>({value,label:value}))} value={text} onValueChange={value => text = value ?? ''} />
      {:else if editsAsJson(field)}
        <TextArea label="Value (JSON)" disabled={isNull} value={text} onValueChange={value => text = value ?? ''} rows={5} />
      {:else}
        <TextInput label="Value ({typeLabel(field)})" disabled={isNull} value={text} onValueChange={value => text = value ?? ''} />
      {/if}
    {/if}
    {#if failure}<p role="alert" class="m-0 text-sm text-danger">{failure}</p>{/if}
    <p class="m-0 text-sm text-neutral/60">The same value will be staged for these {count} rows. Save changes to write it.</p>
  </div>
  {#snippet footer()}<div class="flex justify-end gap-2"><Button variant="ghost" onclick={() => open = false}>Cancel</Button><Button color="primary" disabled={!field} onclick={submit}>Stage changes</Button></div>{/snippet}
</Dialog>
