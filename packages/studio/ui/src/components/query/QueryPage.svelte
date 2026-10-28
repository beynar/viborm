<script lang="ts">
import { Alert } from "entasis/alert";
import { Button } from "entasis/button";
import { Code } from "entasis/code";
import { arrowSquareOutIcon } from "entasis/icons/arrowSquareOut";
import { playIcon } from "entasis/icons/play";
import { type PageShellApi, setPageShell } from "entasis/page-shell";
import { SegmentedControl } from "entasis/segmented-control";
import { Select } from "entasis/select";
import { untrack } from "svelte";
import {
  QUERY_OPERATIONS,
  type QueryOperation,
  runQuery,
  type Scope,
  type StudioDescription,
  type StudioStatement,
} from "../../lib/api";
import { fillPage } from "../../lib/fill";

// One read written by hand, as the application would write it — a delegate's operation and its arguments in JSON —
// run through the project's own client: its answer, how long it took, and the SQL it ran. The arguments written
// for each model and operation are kept for the tab's life, so going back finds them.
let {
  schema,
  navigate,
}: {
  schema: StudioDescription;
  navigate: (model: string, scope?: Scope) => void;
} = $props();

setPageShell({ title: "Query", subtitle });

const DRAFTS_KEY = `viborm-studio:query:${untrack(() => schema.project)}`;
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};

/** What a first query of an operation reads, on a model. */
function starter(model: string, operation: QueryOperation): string {
  const first = schema.models
    .find((candidate) => candidate.name === model)
    ?.fields.find((field) => !field.list);
  const args: Record<string, unknown> = {
    findMany: { where: {}, take: 20 },
    findFirst: { where: {} },
    findUnique: { where: {} },
    count: { where: {} },
    aggregate: { _count: true },
    groupBy: { by: first ? [first.name] : [], _count: true },
  }[operation];
  return JSON.stringify(args, null, 2);
}

function keptDrafts(): {
  model?: string;
  operation?: QueryOperation;
  texts: Record<string, string>;
} {
  try {
    const kept = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "{}");
    return { texts: {}, ...kept };
  } catch {
    return { texts: {} };
  }
}
const kept = keptDrafts();
// The page is keyed on the schema's revision: it opens on the models it was given.
const opening = untrack(() => schema.models);
let model = $state(
  opening.some((candidate) => candidate.name === kept.model)
    ? kept.model!
    : (opening[0]?.name ?? "")
);
let operation = $state<QueryOperation>(kept.operation ?? "findMany");
let texts = $state<Record<string, string>>(kept.texts);
const draftKey = $derived(`${model}.${operation}`);
const text = $derived(texts[draftKey] ?? starter(model, operation));
$effect(() => {
  sessionStorage.setItem(
    DRAFTS_KEY,
    JSON.stringify({ model, operation, texts })
  );
});

let editor = $state<HTMLTextAreaElement>();
let running = $state(false);
let answer = $state.raw<{
  result: unknown;
  duration: number;
  statements: StudioStatement[];
  model: string;
  where?: Record<string, unknown>;
}>();
let failure = $state<string>();
let tab = $state<"result" | "sql">("result");

/** The arguments as JSON, or what is wrong with them. */
const parsed = $derived.by<{ args?: unknown; error?: string }>(() => {
  try {
    return { args: JSON.parse(text.trim() || "{}") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

async function run() {
  if (parsed.error !== undefined || running) return;
  running = true;
  failure = undefined;
  try {
    const { args } = parsed;
    const where =
      typeof args === "object" && args !== null && "where" in args
        ? (args.where as Record<string, unknown>)
        : undefined;
    answer = {
      ...(await runQuery(model, operation, args)),
      model,
      ...(where && Object.keys(where).length ? { where } : {}),
    };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    running = false;
  }
}

/** A field's name written where the caret is, quoted as a key. */
function insert(name: string) {
  if (!editor) return;
  const { selectionStart, selectionEnd, value } = editor;
  const written = `"${name}": `;
  texts[draftKey] =
    value.slice(0, selectionStart) + written + value.slice(selectionEnd);
  const caret = selectionStart + written.length;
  requestAnimationFrame(() => {
    editor?.focus();
    editor?.setSelectionRange(caret, caret);
  });
}

function keys(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    run();
  }
}

const current = $derived(
  schema.models.find((candidate) => candidate.name === model)
);
const names = $derived([
  ...(current?.fields.map((field) => field.name) ?? []),
  ...(current?.relations.map((relation) => relation.name) ?? []),
]);
const counted = $derived(
  Array.isArray(answer?.result)
    ? `${answer.result.length} ${answer.result.length === 1 ? "row" : "rows"}`
    : undefined
);
const sql = $derived(
  (answer?.statements ?? [])
    .map(
      (statement) =>
        `-- ${statement.duration ?? "?"} ms${statement.params?.length ? ` · ${JSON.stringify(statement.params)}` : ""}\n${statement.sql ?? "(not reported)"};`
    )
    .join("\n\n")
);
</script>

{#snippet subtitle(_page: PageShellApi)}
  A read through your client, with the SQL it ran
{/snippet}

<section class="grid grid-rows-[auto_minmax(0,1fr)] gap-3 p-4" aria-label="Query" {@attach fillPage}>
  <div class="grid gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <div class="w-48"><Select size="small" label="Model" theme={HIDDEN_LABEL} items={schema.models.map(entry => ({ value: entry.name, label: entry.name }))} value={model} onValueChange={value => value && (model = value)} /></div>
      <div class="w-36"><Select size="small" label="Operation" theme={HIDDEN_LABEL} items={QUERY_OPERATIONS.map(value => ({ value, label: value }))} value={operation} onValueChange={value => value && (operation = value as QueryOperation)} /></div>
      <Button size="small" color="primary" prefix={playIcon} loading={running} disabled={parsed.error !== undefined} onclick={run}>Run <span class="text-[11px] opacity-70">⌘↵</span></Button>
      {#if texts[draftKey] !== undefined}
        <Button size="small" variant="ghost" onclick={() => delete texts[draftKey]}>Reset</Button>
      {/if}
    </div>
    <label class="sr-only" for="query-args">The arguments of {model}.{operation}, in JSON</label>
    <textarea id="query-args" bind:this={editor} class="min-h-36 w-full resize-y rounded-md border border-neutral-muted bg-surface p-3 font-mono text-[13px] leading-5 outline-none focus:border-primary" spellcheck="false" value={text} oninput={event => (texts[draftKey] = event.currentTarget.value)} onkeydown={keys}></textarea>
    <div class="flex flex-wrap items-center gap-1 text-[12px] text-neutral/60">
      {#if parsed.error !== undefined}
        <span class="text-danger">Not JSON: {parsed.error}</span>
      {:else}
        <span class="mr-1">Insert</span>
        {#each names as name (name)}
          <button type="button" class="rounded border border-neutral-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-neutral-muted" onclick={() => insert(name)}>{name}</button>
        {/each}
      {/if}
    </div>
  </div>
  <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
    {#if failure}
      <div class="row-span-2"><Alert color="danger" variant="soft">{#snippet title()}The client refused the query{/snippet}{#snippet description()}<span class="whitespace-pre-wrap">{failure}</span>{/snippet}</Alert></div>
    {:else if answer}
      <div class="flex flex-wrap items-center gap-3">
        <SegmentedControl size="small" label="What to show" items={[{ value: 'result', label: 'Result' }, { value: 'sql', label: `SQL · ${answer.statements.length}` }]} bind:value={tab} />
        <span class="text-[12px] text-neutral/60">{counted ? `${counted} · ` : ''}{answer.duration} ms · {answer.statements.length === 1 ? 'one statement' : `${answer.statements.length} statements`}</span>
        {#if answer.where}
          {@const { model: read, where } = answer}
          <Button class="ml-auto" size="small" variant="outline" prefix={arrowSquareOutIcon} onclick={() => navigate(read, { where, label: 'Query' })}>Open these rows</Button>
        {/if}
      </div>
      <div class="min-h-0 overflow-auto rounded-lg">
        {#if tab === 'result'}
          <Code language="json" code={JSON.stringify(answer.result, null, 2)} />
        {:else}
          <Code language="sql" code={sql || '-- No statement ran.'} wrap />
        {/if}
      </div>
    {:else}
      <p class="row-span-2 m-0 text-[13px] text-neutral/60">Write the arguments as you would pass them to <code class="font-mono">client.{model}.{operation}()</code>, then run. Only reads run here.</p>
    {/if}
  </div>
</section>
