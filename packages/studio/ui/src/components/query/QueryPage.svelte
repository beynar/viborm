<script lang="ts">
import { Alert } from "entasis/alert";
import { Button } from "entasis/button";
import { Code } from "entasis/code";
import { arrowSquareOutIcon } from "entasis/icons/arrowSquareOut";
import { arrowsClockwiseIcon } from "entasis/icons/arrowsClockwise";
import { bookmarkSimpleIcon } from "entasis/icons/bookmarkSimple";
import { plusIcon } from "entasis/icons/plus";
import { sidebarSimpleIcon } from "entasis/icons/sidebarSimple";
import { xIcon } from "entasis/icons/x";
import { NumberInput } from "entasis/number-input";
import { type PageShellApi, setPageShell } from "entasis/page-shell";
import { Popover } from "entasis/popover";
import { SegmentedControl } from "entasis/segmented-control";
import { Select } from "entasis/select";
import { Sidebar, type SidebarApi } from "entasis/sidebar";
import { Tabbar } from "entasis/tabbar";
import { TextInput } from "entasis/text-input";
import { toast } from "entasis/toast";
import { untrack } from "svelte";
import {
  explainQuery,
  type QueryOperation,
  runQuery,
  type Scope,
  type StudioDescription,
  type StudioExplained,
  type StudioSpan,
  type StudioStatement,
} from "../../lib/api";
import { fillPage } from "../../lib/fill";
import { MODEL_ICON } from "../../lib/model-icons";
import {
  type Queries,
  type QueryState,
  queryHref,
  type SavedQuery,
} from "../../lib/queries.svelte";
import {
  AGGREGATES,
  aggregatable,
  aggregateOf,
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
import { prettySql } from "../../lib/sql";
import { cellText, display, grouped } from "../../lib/values";
import FilterGroup from "../data/FilterGroup.svelte";
import PlanView from "./PlanView.svelte";
import ResultTable from "./ResultTable.svelte";
import TraceView from "./TraceView.svelte";

// A read built with pickers, as the application would write it: what to read (the rows' own filter, an order, a
// page, columns and relations) or what to compute (counts, sums, averages, extremes, per group). It runs through
// the project's client as it changes; the page shows the rows, the JSON, the SQL the client ran and the call to
// write in the application. What was built for each model is kept for the tab's life.
let {
  schema,
  navigate,
  queries,
  saved,
}: {
  schema: StudioDescription;
  navigate: (model: string, scope?: Scope) => void;
  queries: Queries;
  saved?: SavedQuery;
} = $props();

setPageShell({ title: queryTitle, subtitle });

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

// The page is keyed on the schema's revision: it opens on the models it was given.
const models = untrack(() => schema.models);
function keptState(): {
  model?: string;
  operation?: QueryOperation;
  drafts?: Record<string, QueryDraft>;
} {
  if (saved)
    return {
      model: saved.model,
      operation: saved.operation,
      drafts: { [saved.model]: structuredClone($state.snapshot(saved.draft)) },
    };
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
  if (saved) return;
  sessionStorage.setItem(
    KEPT,
    JSON.stringify({ model: modelName, operation, drafts })
  );
});

const model = $derived(models.find((entry) => entry.name === modelName)!);
const draft = $derived(drafts[modelName]!);
const stateOf = (): QueryState => ({
  model: modelName,
  operation,
  draft: structuredClone($state.snapshot(draft)),
});
const unsaved = $derived(
  saved !== undefined &&
    JSON.stringify(stateOf()) !==
      JSON.stringify({
        model: saved.model,
        operation: saved.operation,
        draft: saved.draft,
      })
);
let queryName = $state(untrack(() => saved?.name ?? ""));
let saving = $state(false);
async function saveQuery(asNew: boolean, close: () => void) {
  const name = queryName.trim();
  if (!name || saving) return;
  saving = true;
  try {
    if (saved && !asNew) await queries.update(saved.id, name, stateOf());
    else location.hash = queryHref(await queries.create(name, stateOf()));
    close();
    toast.success({ title: `The query “${name}” was saved` });
  } catch (error) {
    toast.danger({
      title: "The query could not be saved",
      description: error instanceof Error ? error.message : String(error),
    });
  } finally {
    saving = false;
  }
}
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
  signature: string;
  result: unknown;
  duration: number;
  statements: StudioStatement[];
  spans: StudioSpan[];
  model: string;
  operation: QueryOperation;
}>();
let failure = $state<string>();
let tab = $state<"table" | "json" | "sql" | "trace" | "plan" | "code">("table");
const resultTabsId = $props.id();
const resultTabs = $derived([
  { value: "table", label: "Result" },
  { value: "json", label: "JSON" },
  {
    value: "sql",
    label: `SQL${answer ? ` · ${answer.statements.length}` : ""}`,
  },
  {
    value: "trace",
    label: `Trace${answer ? ` · ${answer.spans.length}` : ""}`,
  },
  { value: "plan", label: "Plan" },
  { value: "code", label: "Code" },
]);
const resultTabIndex = $derived(
  resultTabs.findIndex((item) => item.value === tab)
);

/** The captured read and its plans belong to one request and are replaced together. */
let explained = $state.raw<{
  explained: StudioExplained[];
  at: Date;
}>();
let planMode = $state<"analyze" | "estimate">("analyze");
let explaining = $state(false);
let explainFailure = $state<string>();
/** The query's sidebar open; folded away, the result takes the page. */
let editing = $state(true);

const signature = $derived(
  built.args
    ? `${modelName}.${operation}${JSON.stringify(built.args)}`
    : undefined
);
const wantsPlan = $derived(tab === "plan");
// One request owner for both paths: changing the query invalidates an in-flight answer before the debounce.
let request = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
async function run(
  asked: string,
  mode: "analyze" | "estimate" | undefined,
  ask: number
) {
  const { args } = built;
  if (!args) return;
  const read = modelName;
  const operationRead = operation;
  running = true;
  explaining = mode !== undefined;
  failure = undefined;
  explainFailure = undefined;
  try {
    const answered =
      mode === undefined
        ? {
            ...(await runQuery(read, operationRead, args)),
            explained: undefined,
          }
        : await explainQuery(read, operationRead, args, mode === "analyze");
    if (ask !== request || signature !== asked) return;
    answer = {
      ...answered,
      signature: asked,
      model: read,
      operation: operationRead,
    };
    // /explain returns the same read used to capture the statements: Result, SQL and Trace stay together.
    explained = answered.explained
      ? { explained: answered.explained, at: new Date() }
      : undefined;
  } catch (error) {
    if (ask !== request || signature !== asked) return;
    const message = error instanceof Error ? error.message : String(error);
    if (mode === undefined) failure = message;
    else explainFailure = message;
  } finally {
    if (ask === request) {
      running = false;
      explaining = false;
    }
  }
}

$effect(() => {
  const asked = signature;
  const mode = wantsPlan ? planMode : undefined;
  const ask = ++request;
  running = false;
  explaining = false;
  // Leaving Plan already has the captured read; changing between Result, SQL and Trace never reruns it.
  if (
    asked !== undefined &&
    (mode !== undefined || untrack(() => answer?.signature) !== asked)
  )
    timer = setTimeout(() => untrack(() => run(asked, mode, ask)), 350);
  return () => {
    clearTimeout(timer);
    ++request;
  };
});

/** One path per click: explaining already runs and captures the read. */
function runAgain() {
  clearTimeout(timer);
  if (signature !== undefined)
    run(signature, wantsPlan ? planMode : undefined, ++request);
}

function keys(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    runAgain();
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
/** Each statement the read ran, laid out to be read, with its time and the values it bound. */
const statements = $derived(
  (answer?.statements ?? []).map((statement) => ({
    sql: statement.sql ? prettySql(statement.sql, schema.dialect) : "",
    duration: statement.duration,
    params: statement.params ?? [],
  }))
);
const code = $derived(
  built.args ? codeOf(modelName, operation, built.args) : ""
);

function chooseOperation(value: string | null) {
  const chosen = OPERATIONS.find((entry) => entry.value === value);
  if (chosen) operation = chosen.value;
}

function chooseFunction(
  computed: QueryDraft["computed"][number],
  value: string | null
) {
  const fn = aggregateOf(value)?.value;
  if (!fn) return;
  computed.fn = fn;
  // A sum, an average or an extreme reads a column the function takes.
  if (!aggregatable(model, fn).some((field) => field.name === computed.field))
    computed.field =
      fn === "_count" ? "" : (aggregatable(model, fn)[0]?.name ?? "");
}
</script>

<svelte:window onkeydown={keys} />

{#snippet queryTitle(_page: PageShellApi)}{saved?.name ?? 'Query'}{/snippet}

{#snippet subtitle(_page: PageShellApi)}
  Build a read with pickers: it runs through your client as you go
{/snippet}

{#snippet heading(text: string)}
  <h3 class="m-0 text-[11px] font-semibold tracking-wide text-neutral/55 uppercase">{text}</h3>
{/snippet}

<!-- The query in a sidebar of the page's own: resized from its edge, folded away (the button above the result,
     or dragging the edge past its narrowest), the result filling the rest. ⌘B stays the studio's sidebar's. -->
<section class="relative min-h-0" aria-label="Query" {@attach fillPage}>
  <Sidebar
    mode="layout"
    frame="contained"
    variant="admin"
    collapsible="offcanvas"
    keyboardShortcut={false}
    edgeReveal={false}
    width="26rem"
    resizable={{ minWidth: '20rem', maxWidth: '44rem', storageKey: 'viborm-studio:query-sidebar' }}
    bind:open={editing}
    content={queryPane}
    theme={{ panel: { base: 'bg-surface' } }}
  >
    {#snippet children()}{@render resultPane()}{/snippet}
  </Sidebar>
</section>

{#snippet queryPane(_sidebar: SidebarApi)}
  <!-- What to read: the model, the operation, then what that operation takes. -->
  <div class="grid content-start gap-5 p-4">
    <div class="grid gap-2">
      {@render heading('Read')}
      <Select size="small" label="Model" theme={HIDDEN_LABEL} items={models.map(entry => ({ value: entry.name, label: entry.name, icon: MODEL_ICON[entry.icon] }))} value={modelName} onValueChange={value => value && (modelName = value)} />
      <Select size="small" label="Operation" theme={HIDDEN_LABEL} items={OPERATIONS} value={operation} onValueChange={chooseOperation} />
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
  </div>
{/snippet}

{#snippet resultPane()}

  <!-- What it read. -->
  <div class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-4">
    <div class="flex flex-wrap items-center gap-3">
      <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label={editing ? 'Hide the query: the result takes the page' : 'Show the query'} onclick={() => (editing = !editing)} />
      <Tabbar id={resultTabsId} controlsPanels size="small" label="What to show" items={resultTabs} bind:value={tab} />
      {#if answer}
        <span class="text-[12px] text-neutral/60">{counted ? `${counted} · ` : ''}{answer.duration} ms</span>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        <Popover position="bottom-end" focusOnOpen="first" theme={{ popover: { base: 'w-72 p-3' } }}>
          {#snippet trigger(popover)}
            <Button size="small" variant={saved ? 'soft' : 'ghost'} squared={!unsaved} prefix={bookmarkSimpleIcon} label={saved ? `Save the query ${saved.name}` : 'Save query'} {@attach popover.trigger}>
              {#if unsaved}<span class="text-[12px]">Unsaved</span>{/if}
            </Button>
          {/snippet}
          {#snippet children(popover)}
            <form class="grid gap-3" onsubmit={event => { event.preventDefault(); saveQuery(false, popover.close) }}>
              <TextInput size="small" label="Query name" value={queryName} onValueChange={value => (queryName = value ?? '')} />
              <div class="flex justify-end gap-2">
                {#if saved}<Button type="button" size="small" variant="ghost" disabled={!queryName.trim() || saving} onclick={() => saveQuery(true, popover.close)}>Save as new</Button>{/if}
                <Button size="small" color="primary" type="submit" loading={saving} disabled={!queryName.trim()}>Save</Button>
              </div>
            </form>
          {/snippet}
        </Popover>
        {#if openable}
          {@const where = openable}
          <Button size="small" variant="outline" prefix={arrowSquareOutIcon} onclick={() => navigate(modelName, { where, label: 'Query' })}>Open these rows</Button>
        {/if}
        <Button size="small" variant="ghost" prefix={arrowsClockwiseIcon} loading={running || (tab === 'plan' && explaining)} disabled={!built.args} onclick={runAgain}>{tab === 'plan' ? 'Explain again' : 'Run again'}</Button>
      </div>
    </div>
    <div role="tabpanel" id="{resultTabsId}-panel-{resultTabIndex}" aria-labelledby="{resultTabsId}-tab-{resultTabIndex}" tabindex="0" class={['min-h-0 gap-3 overflow-auto', tab === 'plan' ? 'flex flex-col' : 'grid content-start']}>
      <!-- A result the latest query did not replace shows faded under its error. -->
      {#if built.error}
        <Alert color="warning" variant="soft">{#snippet title()}Not ready to run{/snippet}{#snippet description()}{built.error}{/snippet}</Alert>
      {/if}
      {#if failure}
        <Alert color="danger" variant="soft">{#snippet title()}The client refused the query{/snippet}{#snippet description()}<span class="whitespace-pre-wrap">{failure}</span>{/snippet}</Alert>
      {/if}
      <div class={['gap-3 transition-opacity', tab === 'plan' ? 'flex min-h-0 flex-1 flex-col' : 'grid content-start', (failure || built.error) && tab !== 'code' && 'opacity-45']}>
      {#if tab === 'plan'}
        {#if explainFailure}
          <Alert color="danger" variant="soft">{#snippet title()}The plan could not be read{/snippet}{#snippet description()}<span class="whitespace-pre-wrap">{explainFailure}</span>{/snippet}</Alert>
        {:else}
          <div class={['min-h-0 flex-1 transition-opacity', explaining && 'opacity-60']}>
            <PlanView
              explained={explained?.explained ?? []}
              loading={explaining}
              at={explained?.at}
              bind:mode={planMode}
            />
          </div>
        {/if}
      {:else if tab === 'code'}
        <Code language="ts" code={code || '// Not ready to run'} />
      {:else if !answer}
        <p class="m-0 text-[13px] text-neutral/60">{running ? 'Reading…' : 'Choose what to read: it runs as you build it.'}</p>
      {:else if tab === 'trace'}
        <TraceView spans={answer.spans} duration={answer.duration} dialect={schema.dialect} />
      {:else if tab === 'sql'}
        {#each statements as statement, index (index)}
          <div class="grid gap-1.5">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-neutral/60">
              <span class="font-medium text-neutral/80">{statements.length > 1 ? `Statement ${index + 1}` : 'Statement'}</span>
              {#if statement.duration !== undefined}<span class="tabular-nums">{statement.duration} ms</span>{/if}
              {#each statement.params as param, at (at)}
                <span class="rounded border border-neutral-muted px-1.5 py-0.5 font-mono text-[11px]"><span class="text-neutral/45">{schema.dialect.includes('postgres') ? `$${at + 1}` : `?${at + 1}`}</span> {typeof param === 'string' ? param : JSON.stringify(param)}</span>
              {/each}
            </div>
            <Code language="sql" code={statement.sql || '-- Not reported'} />
          </div>
        {:else}
          <p class="m-0 text-[13px] text-neutral/60">No statement ran.</p>
        {/each}
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
{/snippet}
