<script lang="ts">
import { Button } from "entasis/button";
import { Checkbox } from "entasis/checkbox";
import { Dialog } from "entasis/dialog";
import { Select } from "entasis/select";
import { TextArea } from "entasis/text-area";
import type { Row, StudioModel } from "../../lib/api";
import {
  type DataFormat,
  IMPORT_BYTES,
  importedRows,
} from "../../lib/table-data";

let {
  model,
  stage,
  close,
}: { model: StudioModel; stage: (rows: Row[]) => void; close: () => void } =
  $props();
let open = $state(true);
let source = $state("");
let format = $state<DataFormat>("csv");
let omitGenerated = $state(true);
let failure = $state("");
const preview = $derived.by(() => {
  if (!source.trim()) return { rows: [], error: "" };
  try {
    return {
      rows: importedRows(model, source, format, omitGenerated),
      error: "",
    };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
const columns = $derived([
  ...new Set(preview.rows.flatMap((row) => Object.keys(row))),
]);

async function readFile(event: Event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  if (!file) return;
  failure = "";
  try {
    if (file.size > IMPORT_BYTES)
      throw new Error("Import at most 512 KB at a time");
    format = file.name.toLowerCase().endsWith(".json")
      ? "json"
      : file.name.toLowerCase().endsWith(".tsv")
        ? "tsv"
        : "csv";
    source = await file.text();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
}
function submit() {
  try {
    stage(preview.rows);
    open = false;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
}
</script>

<Dialog bind:open title="Import into {model.name}" onAfterClose={close}>
  <div class="grid min-w-0 gap-4">
    <input type="file" accept=".csv,.tsv,.json,text/csv,application/json" aria-label="Import file" onchange={readFile} class="max-w-full text-sm" />
    <Select label="Format" value={format} items={[{value:'csv',label:'CSV'}, {value:'tsv',label:'TSV'}, {value:'json',label:'JSON'}]} onValueChange={value => { if(value === 'csv' || value === 'tsv' || value === 'json') format = value }} />
    <TextArea label="Data" value={source} onValueChange={value => { source = value ?? ''; failure = '' }} rows={7} placeholder="Paste rows with field names as headers, or a JSON array" />
    <p class="m-0 text-xs text-neutral/60">Up to 500 rows. CSV/TSV: first row = field names; \N = null; empty text stays empty. Omit columns to use defaults.</p>
    <Checkbox label="Use new generated values" value={omitGenerated} onValueChange={value => omitGenerated = value === true} />
    {#if failure || preview.error}<p role="alert" class="m-0 text-sm text-danger">{failure || preview.error}</p>{/if}
    {#if preview.rows.length}
      <p class="m-0 text-sm">{preview.rows.length} {preview.rows.length === 1 ? 'row' : 'rows'} ready · preview of the first {Math.min(5, preview.rows.length)}</p>
      <div class="max-h-56 overflow-auto rounded-lg border border-neutral-muted">
        <table class="w-full text-left text-xs">
          <thead><tr>{#each columns as column}<th class="p-2">{column}</th>{/each}</tr></thead>
          <tbody>{#each preview.rows.slice(0,5) as row}<tr>{#each columns as column}<td class="max-w-52 truncate border-t border-neutral-muted p-2">{JSON.stringify(row[column]) ?? 'default'}</td>{/each}</tr>{/each}</tbody>
        </table>
      </div>
    {/if}
    <p class="m-0 text-xs text-neutral/60">Adds unsaved changes. The client validates and writes them only when you save.</p>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => open = false}>Cancel</Button>
      <Button color="primary" disabled={!preview.rows.length || !!preview.error || !!failure} onclick={submit}>Stage {preview.rows.length || ''} {preview.rows.length === 1 ? 'row' : 'rows'}</Button>
    </div>
  {/snippet}
</Dialog>
