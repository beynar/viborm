<script lang="ts">
import { Alert } from "entasis/alert";
import { Button } from "entasis/button";
import { Code } from "entasis/code";
import { arrowSquareOutIcon } from "entasis/icons/arrowSquareOut";
import { arrowsClockwiseIcon } from "entasis/icons/arrowsClockwise";
import { plusIcon } from "entasis/icons/plus";
import { sidebarSimpleIcon } from "entasis/icons/sidebarSimple";
import { xIcon } from "entasis/icons/x";
import { NumberInput } from "entasis/number-input";
import { type PageShellApi, setPageShell } from "entasis/page-shell";
import { SegmentedControl } from "entasis/segmented-control";
import { Select } from "entasis/select";
import { TextInput } from "entasis/text-input";
import { untrack } from "svelte";
import {
  type QueryOperation,
  runQuery,
  type Scope,
  type StudioDescription,
  type StudioStatement,
} from "../../lib/api";
import { fillPage } from "../../lib/fill";
import { MODEL_ICON } from "../../lib/model-icons";
import {
  AGGREGATE_LABELS,
  type Aggregate,
  aggregatable,
  argsOf,
  codeOf,
  computedColumn,
  emptyDraft,
  type QueryDraft,
  scalarFields,
  tableOf,
  uniqueFields,
  whereOf,
} from "../../lib/query-builder";
import { cellText, display, grouped } from "../../lib/values";
import FilterGroup from "../data/FilterGroup.svelte";
import ResultTable from "./ResultTable.svelte";

// A read built with pickers, as the application would write it: what to read (the rows' own filter, an order, a
// page, columns and relations) or what to compute (counts, sums, averages, extremes, per group). It runs through
// the project's client as it changes; the page shows the rows, the JSON, the SQL the client ran and the call to
// write in the application. What was built for each model is kept for the tab's life.
let {
  schema,
  navigate,
}: {
  schema: StudioDescription;
  navigate: (model: string, scope?: Scope) => void;
} = $props();

setPageShell({ title: "Query", subtitle });

const KEPT = `viborm-studio:query-builder:${untrack(() => schema.project)}`;
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};
const OPERATIONS: {
  value: QueryOperation;
  label: string;
  description: string;
}[] = [
  { value: "findMany", label: "Find rows", description: "findMany" },
  { value: "findFirst", label: "Find the first row", description: "findFirst" },
  {
    value: "findUnique",
    label: "Find one row by a unique column",
    description: "findUnique",
  },
  { value: "count", label: "Count rows", description: "count" },
  {
    value: "aggregate",
    label: "Compute over the rows",
    description: "aggregate",
  },
  { value: "groupBy", label: "Compute per group", description: "groupBy" },
];
const AGGREGATES = (Object.keys(AGGREGATE_LABELS) as Aggregate[]).map(
  (value) => ({ value, label: AGGREGATE_LABELS[value] })
);

// The page is keyed on the schema's revision: it opens on the models it was given.
const models = untrack(() => schema.models);
function keptState(): {
  model?: string;
  operation?: QueryOperation;
  drafts?: Record<string, QueryDraft>;
} {
  try {
    return JSON.parse(sessionStorage.getItem(KEPT) ?? "{}");
  } catch {
    return {};
  }
}
const kept = keptState();
let modelName = $state(
  models.some((candidate) => candidate.name === kept.model)
    ? kept.model!
    : (models[0]?.name ?? "")
);
let operation = $state<QueryOperation>(kept.operation ?? "findMany");
const drafts = $state<Record<string, QueryDraft>>(
  Object.fromEntries(
    models.map((entry) => [
      entry.name,
      kept.drafts?.[entry.name] ?? emptyDraft(entry),
    ])
  )
);
$effect(() => {
  sessionStorage.setItem(
    KEPT,
    JSON.stringify({ model: modelName, operation, drafts })
  );
});

const model = $derived(models.find((entry) => entry.name === modelName)!);
const draft = $derived(drafts[modelName]!);
const reads = $derived(
  operation === "findMany" ||
    operation === "findFirst" ||
    operation === "findUnique"
);
const computes = $derived(operation === "aggregate" || operation === "groupBy");
const pages = $derived(
  operation === "findMany" ||
    operation === "findFirst" ||
    operation === "groupBy"
);

/** The arguments built, or why they cannot be yet. */
const built = $derived.by<{ args?: Record<string, unknown>; error?: string }>(
  () => {
    if (!model) return { error: "This schema has no model" };
    try {
      return { args: argsOf(model, models, operation, draft) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
);

let running = $state(false);
let answer = $state.raw<{
  result: unknown;
  duration: number;
  statements: StudioStatement[];
  model: string;
  operation: QueryOperation;
}>();
let failure = $state<string>();
let tab = $state<"table" | "json" | "sql" | "code">("table");
/** The query folded away: the result takes the page. */
let folded = $state(false);
let asked = 0;

async function run() {
  const { args } = built;
  if (!args) return;
  asked += 1;
  const ask = asked;
  const read = modelName;
  const asking = operation;
  running = true;
  try {
    const answered = await runQuery(read, asking, args);
    if (ask !== asked) return;
    answer = { ...answered, model: read, operation: asking };
    failure = undefined;
  } catch (error) {
    if (ask !== asked) return;
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (ask === asked) running = false;
  }
}

// The query runs again a moment after it changes: what is built shows what it reads.
const signature = $derived(
  built.args
    ? `${modelName}.${operation}${JSON.stringify(built.args)}`
    : undefined
);
$effect(() => {
  if (signature === undefined) return;
  const timer = setTimeout(() => untrack(run), 350);
  return () => clearTimeout(timer);
});

function keys(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    run();
  }
}

const nextId = (entries: readonly { id: number }[]) =>
  Math.max(0, ...entries.map((entry) => entry.id)) + 1;

const fieldItems = (fields: readonly { name: string }[]) =>
  fields.map((field) => ({ value: field.name, label: field.name }));
/** What an order may follow: a column; for groups, a column they share. */
const sortItems = $derived(
  fieldItems(
    scalarFields(model).filter(
      (field) => operation !== "groupBy" || draft.by.includes(field.name)
    )
  )
);

/** The filter of the rows read, to open them in their table. */
const openable = $derived.by(() => {
  const listed =
    operation === "findMany" ||
    operation === "findFirst" ||
    operation === "count";
  if (!(answer && listed)) return undefined;
  try {
    return whereOf(model, models, draft);
  } catch {
    return undefined;
  }
});

const table = $derived(tableOf(answer?.result));
const answeredModel = $derived(
  models.find((entry) => entry.name === answer?.model)
);
const counted = $derived(
  typeof answer?.result === "number"
    ? undefined
    : `${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}`
);
const sql = $derived(
  (answer?.statements ?? [])
    .map(
      (statement) =>
        `-- ${statement.duration ?? "?"} ms${statement.params?.length ? ` · ${JSON.stringify(statement.params)}` : ""}\n${statement.sql ?? "(not reported)"};`
    )
    .join("\n\n")
);
const code = $derived(
  built.args ? codeOf(modelName, operation, built.args) : ""
);

function chooseFunction(
  computed: QueryDraft["computed"][number],
  value: string | null
) {
  if (!value) return;
  const fn = value as Aggregate;
  computed.fn = fn;
  // A sum, an average or an extreme reads a column the function takes.
  if (!aggregatable(model, fn).some((field) => field.name === computed.field))
    computed.field =
      fn === "_count" ? "" : (aggregatable(model, fn)[0]?.name ?? "");
}
</script>

<svelte:window onkeydown={keys} />

{#snippet subtitle(_page: PageShellApi)}
  Build a read with pickers: it runs through your client as you go
{/snippet}

{#snippet heading(text: string)}
  <h3 class="m-0 text-[11px] font-semibold tracking-wide text-neutral/55 uppercase">{text}</h3>
{/snippet}

<section class={['grid gap-4 p-4', folded ? 'grid-cols-[minmax(0,1fr)]' : 'grid-cols-[30rem_minmax(0,1fr)]']} aria-label="Query" {@attach fillPage}>
  {#if !folded}
  <!-- What to read: the model, the operation, then what that operation takes. -->
  <aside class="grid min-h-0 content-start gap-5 overflow-auto rounded-lg border border-neutral-muted bg-surface p-4" aria-label="The query">
    <div class="grid gap-2">
      {@render heading('Read')}
      <Select size="small" label="Model" theme={HIDDEN_LABEL} items={models.map(entry => ({ value: entry.name, label: entry.name, icon: MODEL_ICON[entry.icon] }))} value={modelName} onValueChange={value => value && (modelName = value)} />
      <Select size="small" label="Operation" theme={HIDDEN_LABEL} items={OPERATIONS} value={operation} onValueChange={value => value && (operation = value as QueryOperation)} />
    </div>

    {#if operation === 'groupBy'}
      <div class="grid gap-2">
        {@render heading('Group by')}
        <Select size="small" multiple label="Columns the groups share" theme={HIDDEN_LABEL} placeholder="Choose columns" items={fieldItems(scalarFields(model))} value={draft.by} onValueChange={value => (draft.by = value ?? [])} />
      </div>
    {/if}

    {#if operation === 'findUnique'}
      <div class="grid gap-2">
        {@render heading('Find by')}
        {#if uniqueFields(model).length}
          <div class="flex gap-2">
            <div class="w-40 shrink-0"><Select size="small" label="Unique column" theme={HIDDEN_LABEL} items={fieldItems(uniqueFields(model))} value={draft.key.field} onValueChange={value => value && (draft.key.field = value)} /></div>
            <div class="min-w-0 flex-1"><TextInput size="small" label="Value" theme={HIDDEN_LABEL} placeholder="value" value={draft.key.value} onValueChange={value => (draft.key.value = value ?? '')} /></div>
          </div>
        {:else}
          <p class="m-0 text-[13px] text-neutral/60">{model.name} has no single unique column: find its rows with “Find the first row”.</p>
        {/if}
      </div>
    {:else}
      <div class="grid gap-2">
        {@render heading('Where')}
        {#key modelName}
          <FilterGroup {model} {models} bind:conditions={draft.conditions} bind:combinator={draft.combinator} />
        {/key}
      </div>
    {/if}

    {#if computes}
      <div class="grid gap-2">
        {@render heading('Compute')}
        {#each draft.computed as computed (computed.id)}
          <div class="flex items-center gap-2">
            <div class="w-32 shrink-0"><Select size="small" label="Function" theme={HIDDEN_LABEL} items={AGGREGATES} value={computed.fn} onValueChange={value => chooseFunction(computed, value)} /></div>
            <div class="min-w-0 flex-1"><Select size="small" label="Of" theme={HIDDEN_LABEL} items={[...(computed.fn === '_count' ? [{ value: '', label: 'rows' }] : []), ...fieldItems(aggregatable(model, computed.fn))]} value={computed.field} onValueChange={value => (computed.field = value ?? '')} /></div>
            <Button size="small" variant="ghost" squared label="Remove the value" prefix={xIcon} onclick={() => (draft.computed = draft.computed.filter(entry => entry.id !== computed.id))} />
          </div>
        {/each}
        <div><Button size="small" variant="outline" prefix={plusIcon} onclick={() => draft.computed.push({ id: nextId(draft.computed), fn: '_count', field: '' })}>Value</Button></div>
      </div>
    {/if}

    {#if pages}
      <div class="grid gap-2">
        {@render heading('Order by')}
        {#each draft.sort as sort (sort.id)}
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1"><Select size="small" label="Column" theme={HIDDEN_LABEL} placeholder="Column" items={sortItems} value={sort.field} onValueChange={value => (sort.field = value ?? '')} /></div>
            <SegmentedControl size="small" label="Direction" items={[{ value: 'asc', label: '↑ asc' }, { value: 'desc', label: '↓ desc' }]} value={sort.desc ? 'desc' : 'asc'} onValueChange={value => (sort.desc = value === 'desc')} />
            <Button size="small" variant="ghost" squared label="Remove the order" prefix={xIcon} onclick={() => (draft.sort = draft.sort.filter(entry => entry.id !== sort.id))} />
          </div>
        {/each}
        <div><Button size="small" variant="outline" prefix={plusIcon} disabled={sortItems.length === 0} onclick={() => draft.sort.push({ id: nextId(draft.sort), field: sortItems[0]?.value ?? '', desc: false })}>Order</Button></div>
      </div>

      <div class="grid gap-2">
        {@render heading(operation === 'findFirst' ? 'Skip' : 'Page')}
        <div class="flex gap-2">
          {#if operation !== 'findFirst'}
            <div class="min-w-0 flex-1"><NumberInput size="small" label="Take" min={0} placeholder="every row" value={draft.take} onValueChange={value => (draft.take = value ?? null)} /></div>
          {/if}
          <div class="min-w-0 flex-1"><NumberInput size="small" label="Skip" min={0} placeholder="none" value={draft.skip} onValueChange={value => (draft.skip = value ?? null)} /></div>
        </div>
      </div>
    {/if}

    {#if reads}
      <div class="grid gap-2">
        {@render heading('Return')}
        <Select size="small" multiple label="Columns" placeholder="Every column" items={fieldItems(model.fields)} value={draft.columns} onValueChange={value => (draft.columns = value ?? [])} />
        {#if model.relations.length}
          <Select size="small" multiple label="With related rows" placeholder="No relation" items={fieldItems(model.relations)} value={draft.include} onValueChange={value => (draft.include = value ?? [])} />
        {/if}
      </div>
    {/if}

    <div class="flex items-center gap-2 border-t border-neutral-muted pt-3">
      <Button size="small" variant="ghost" onclick={() => (drafts[modelName] = emptyDraft(model))}>Reset</Button>
      <span class="ml-auto text-[12px] text-neutral/50">Runs as you build · ⌘↵ runs again</span>
    </div>
  </aside>
  {/if}

  <!-- What it read. -->
  <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
    <div class="flex flex-wrap items-center gap-3">
      <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label={folded ? 'Show the query' : 'Hide the query: the result takes the page'} onclick={() => (folded = !folded)} />
      <SegmentedControl size="small" label="What to show" items={[{ value: 'table', label: 'Result' }, { value: 'json', label: 'JSON' }, { value: 'sql', label: `SQL${answer ? ` · ${answer.statements.length}` : ''}` }, { value: 'code', label: 'Code' }]} bind:value={tab} />
      {#if answer}
        <span class="text-[12px] text-neutral/60">{counted ? `${counted} · ` : ''}{answer.duration} ms</span>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        {#if openable}
          {@const where = openable}
          <Button size="small" variant="outline" prefix={arrowSquareOutIcon} onclick={() => navigate(modelName, { where, label: 'Query' })}>Open these rows</Button>
        {/if}
        <Button size="small" variant="ghost" prefix={arrowsClockwiseIcon} loading={running} disabled={!built.args} onclick={run}>Run again</Button>
      </div>
    </div>
    <div class="grid min-h-0 content-start gap-3 overflow-auto">
      <!-- A result the latest query did not replace shows faded under its error. -->
      {#if built.error}
        <Alert color="warning" variant="soft">{#snippet title()}Not ready to run{/snippet}{#snippet description()}{built.error}{/snippet}</Alert>
      {/if}
      {#if failure}
        <Alert color="danger" variant="soft">{#snippet title()}The client refused the query{/snippet}{#snippet description()}<span class="whitespace-pre-wrap">{failure}</span>{/snippet}</Alert>
      {/if}
      <div class={['grid content-start gap-3 transition-opacity', (failure || built.error) && tab !== 'code' && 'opacity-45']}>
      {#if tab === 'code'}
        <Code language="ts" code={code || '// Not ready to run'} />
      {:else if !answer}
        <p class="m-0 text-[13px] text-neutral/60">{running ? 'Reading…' : 'Choose what to read: it runs as you build it.'}</p>
      {:else if tab === 'sql'}
        <Code language="sql" code={sql || '-- No statement ran.'} wrap />
      {:else if tab === 'json'}
        <Code language="json" code={JSON.stringify(answer.result, null, 2)} />
      {:else if typeof answer.result === 'number'}
        <div class="grid justify-items-start gap-1 rounded-lg border border-neutral-muted bg-surface p-6">
          <span class="text-4xl font-semibold tabular-nums">{answer.result}</span>
          <span class="text-[13px] text-neutral/60">{answer.result === 1 ? 'row matches' : 'rows match'}</span>
        </div>
      {:else if answer.operation === 'aggregate' && table.rows.length === 1}
        <!-- Values computed over the rows: one card each. -->
        <div class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {#each table.columns as column (column)}
            {@const computed = computedColumn(answeredModel, column)}
            {@const held = table.rows[0]![column]}
            {@const said = held === null || held === undefined ? '—' : computed?.field ? cellText(computed.field, held) : grouped(held)}
            <div class="grid content-start gap-1 rounded-lg border border-neutral-muted bg-surface p-4">
              <span class="text-[12px] text-neutral/60">{computed?.label ?? column}</span>
              <span class="text-lg font-semibold break-words tabular-nums" title={display(held)}>{said}</span>
            </div>
          {/each}
        </div>
      {:else}
        <ResultTable model={answeredModel} {models} result={answer.result} />
      {/if}
      </div>
    </div>
  </div>
</section>
