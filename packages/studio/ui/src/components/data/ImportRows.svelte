<script lang="ts">
import { Button } from "entasis/button";
import { Checkbox } from "entasis/checkbox";
import { Dialog } from "entasis/dialog";
import { FileInput } from "entasis/file-input";
import { xIcon } from "entasis/icons/x";
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
let chosenFile = $state<File | null>(null);
let reading = $state(false);
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

async function readFile(next: File | null) {
  chosenFile = next;
  source = "";
  failure = "";
  if (!next) return;
  reading = true;
  try {
    const text = await next.text();
    const name = next.name.toLowerCase();
    format =
      name.endsWith(".json") || next.type === "application/json"
        ? "json"
        : name.endsWith(".tsv") || next.type === "text/tab-separated-values"
          ? "tsv"
          : "csv";
    source = text;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    reading = false;
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

<Dialog bind:open title="Import into {model.name}" onAfterClose={close} theme={{ content: { base: 'overflow-hidden' }, header: { base: 'shrink-0' }, footer: { base: 'mt-4 shrink-0 border-t border-neutral-muted pt-4' } }}>
  <div class="grid min-h-0 min-w-0 gap-4 overflow-y-auto p-1">
    <FileInput label="Import file" size="small" fieldAttrs={{ tabindex: reading ? -1 : 0 }} value={chosenFile} disabled={reading} types={['.csv', '.tsv', '.json', 'text/csv', 'text/tab-separated-values', 'application/json']} maxSize={IMPORT_BYTES} placeholder="Drop a CSV, TSV or JSON file here, or click to choose" onValueChange={readFile} onReject={rejections => { failure = rejections.some(entry => entry.reason === 'size') ? 'Import at most 512 KB at a time' : rejections.some(entry => entry.reason === 'limit') ? 'Choose one file at a time' : 'Choose a CSV, TSV or JSON file' }}>
      {#snippet file()}
        {#if chosenFile}
          <div class="min-w-0 flex-1">
            <div class="truncate" title={chosenFile.name}>{chosenFile.name}</div>
            <div class="text-xs text-neutral/60">{chosenFile.size.toLocaleString()} bytes</div>
          </div>
          <Button size="small" variant="ghost" squared prefix={xIcon} label="Remove file" disabled={reading} onclick={event => { event.currentTarget.closest('fieldset')?.focus(); readFile(null) }} />
        {/if}
      {/snippet}
    </FileInput>
    <Select label="Format" disabled={reading} value={format} items={[{value:'csv',label:'CSV'}, {value:'tsv',label:'TSV'}, {value:'json',label:'JSON'}]} onValueChange={value => { if(value === 'csv' || value === 'tsv' || value === 'json') format = value }} />
    <TextArea label="Data" disabled={reading} value={source} onValueChange={value => { source = value ?? ''; failure = ''; chosenFile = null }} rows={7} placeholder="Paste rows with field names as headers, or a JSON array" />
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
  </div>
  {#snippet footer()}
    <div class="grid gap-3">
      <p class="m-0 text-xs text-neutral/60">Adds unsaved changes. The client validates and writes them only when you save.</p>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={() => open = false}>Cancel</Button>
        <Button color="primary" loading={reading} disabled={reading || !preview.rows.length || !!preview.error || !!failure} onclick={submit}>Stage {preview.rows.length || ''} {preview.rows.length === 1 ? 'row' : 'rows'}</Button>
      </div>
    </div>
  {/snippet}
</Dialog>
