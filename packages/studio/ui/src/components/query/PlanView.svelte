<script lang="ts">
import "@xyflow/svelte/dist/base.css";
import { type Edge, type Node, SvelteFlow } from "@xyflow/svelte";
import { Button } from "entasis/button";
import { Code } from "entasis/code";
import { crosshairIcon } from "entasis/icons/crosshair";
import { infoIcon } from "entasis/icons/info";
import { warningIcon } from "entasis/icons/warning";
import { warningOctagonIcon } from "entasis/icons/warningOctagon";
import { SegmentedControl } from "entasis/segmented-control";
import { useTheme } from "entasis/theme";
import type {
  PlanAdvice,
  PlanNode,
  Severity,
  StudioExplained,
} from "../../lib/api";
import {
  compact,
  ms,
  type PlanCardData,
  planGraph,
  rowsOut,
  totalTime,
} from "../../lib/plan-graph";
import PlanCard, { kindLabel } from "./PlanCard.svelte";
import PlanEdge from "./PlanEdge.svelte";
import PlanFocus from "./PlanFocus.svelte";

// A read's plan, as the database ran it (ANALYZE) or would run it (an estimate): what it took (time, rows, pages in
// memory and read), the operations as a graph, a table or the database's own text, and beside them what to do,
// gravest first, each index fix written as the model's `.index([...])`. Choosing a piece of
// advice brings its operations into view; choosing an operation says all the database told of it.
let {
  explained,
  loading,
  at,
  mode = $bindable(),
}: {
  explained: readonly StudioExplained[];
  loading: boolean;
  at: Date | undefined;
  mode: "analyze" | "estimate";
} = $props();

const NODE_TYPES = { plan: PlanCard };
const EDGE_TYPES = { plan: PlanEdge };
const theme = useTheme();

let statementIndex = $state(0);
const current = $derived(
  explained[Math.min(statementIndex, explained.length - 1)]
);
const plan = $derived(current?.plan);
let view = $state<"graph" | "table" | "raw">("graph");

let nodes = $state.raw<Node<PlanCardData>[]>([]);
let edges = $state.raw<Edge[]>([]);
$effect(() => {
  chosen = undefined;
  panel = "advice";
  if (!plan) {
    nodes = [];
    edges = [];
    return;
  }
  const graph = planGraph(plan.root, plan.executionTime, plan.advice);
  nodes = graph.nodes;
  edges = graph.edges;
  focus = { targets: [], version: 0 };
});

let panel = $state<"advice" | "node">("advice");
let chosen = $state<string>();
let focus = $state<{ targets: readonly string[]; version: number }>({
  targets: [],
  version: 0,
});
const flat = $derived.by(() => {
  const out: { node: PlanNode; depth: number }[] = [];
  const visit = (node: PlanNode, depth: number) => {
    out.push({ node, depth });
    for (const child of node.children) visit(child, depth + 1);
  };
  if (plan) visit(plan.root, 0);
  return out;
});
const chosenNode = $derived(
  flat.find((entry) => entry.node.id === chosen)?.node
);
const hasAdvice = $derived((plan?.advice.length ?? 0) > 0);
const showPanel = $derived(hasAdvice || chosenNode !== undefined);
function choose(ids: readonly string[]) {
  const set = new Set(ids);
  nodes = nodes.map((node) => ({ ...node, selected: set.has(node.id) }));
  chosen = ids[0];
}
function chooseNode(id: string) {
  choose([id]);
  panel = "node";
}
/** A piece of advice's operations, chosen and brought into view. */
function show(ids: readonly string[]) {
  choose(ids);
  view = "graph";
  focus = { targets: ids, version: focus.version + 1 };
}

const total = $derived(
  plan ? totalTime(plan.root, plan.executionTime) : undefined
);
/** The rows the statement returned: its top operation's, or under the plan's own top (MySQL, SQLite), its first. */
const returned = $derived(
  plan
    ? (rowsOut(plan.root) ??
        (plan.root.children[0] ? rowsOut(plan.root.children[0]) : undefined))
    : undefined
);
/** The operation that took the most time of its own. */
const slowest = $derived.by(() => {
  let best: PlanNode | undefined;
  for (const { node } of flat) {
    if (node.actual && node.actual.self > (best?.actual?.self ?? -1))
      best = node;
  }
  return best?.actual && best.actual.self > 0 ? best : undefined;
});
const cache = $derived.by(() => {
  const buffers = plan?.root.buffers;
  if (!buffers || buffers.hit + buffers.read === 0) return undefined;
  return { ...buffers, share: buffers.hit / (buffers.hit + buffers.read) };
});
const counts = $derived.by(() => {
  const by: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const entry of plan?.advice ?? []) by[entry.severity] += 1;
  return by;
});

const SEVERITY: Record<
  Severity,
  { icon: typeof infoIcon; tone: string; label: string }
> = {
  critical: {
    icon: warningOctagonIcon,
    tone: "text-danger border-danger/40 bg-danger-muted/40",
    label: "Slow",
  },
  warning: {
    icon: warningIcon,
    tone: "text-warning border-warning/40 bg-warning-muted/40",
    label: "Worth a look",
  },
  info: {
    icon: infoIcon,
    tone: "text-info border-info/30 bg-info-muted/30",
    label: "Good to know",
  },
};
const indexesOf = (node: PlanNode) =>
  node.relation ? (plan?.indexes[node.relation] ?? []) : [];
const time = (date: Date) =>
  date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
</script>

{#snippet adviceCard(entry: PlanAdvice)}
  {@const tone = SEVERITY[entry.severity]}
  <article class={['grid gap-2 rounded-lg border p-3', tone.tone]}>
    <header class="flex items-start gap-2">
      <span class="mt-0.5 inline-flex shrink-0" role="img" aria-label={tone.label} title={tone.label}>{@render tone.icon({ size: 16 })}</span>
      <div class="grid min-w-0 gap-0.5">
        <h4 class="m-0 text-[13px] font-semibold text-neutral" title={entry.title}>{entry.fix?.schema ? 'Add an index' : entry.title}</h4>
      </div>
      <div class="ml-auto shrink-0"><Button size="small" variant="ghost" prefix={crosshairIcon} onclick={() => show(entry.nodes)}>Show</Button></div>
    </header>
    {#if entry.fix?.schema}
      <Code language="ts" title="Schema" code={entry.fix.schema} />
    {:else}
      <p class="m-0 text-[12px] leading-5 text-neutral/80">{entry.fix?.note ?? entry.detail}</p>
    {/if}
  </article>
{/snippet}

{#snippet stat(label: string, value: string, hint?: string)}
  <div class="grid gap-0.5 rounded-md border border-neutral-muted bg-surface px-3 py-2" title={hint}>
    <span class="text-[11px] text-neutral/55">{label}</span>
    <span class="text-[14px] leading-snug font-semibold break-words tabular-nums">{value}</span>
  </div>
{/snippet}

{#snippet measure(label: string, value: string | undefined, tone?: string)}
  {#if value !== undefined}
    <dt class="text-neutral/60">{label}</dt><dd class={['m-0 text-right font-mono tabular-nums', tone]}>{value}</dd>
  {/if}
{/snippet}

<div class="@container grid h-full min-h-[36rem] grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
  <!-- How the plan is asked: run again and measured, or the planner's estimate; when; again. -->
  <div class="flex flex-wrap items-center gap-2">
    <SegmentedControl size="small" label="How to explain" items={[{ value: 'analyze', label: 'Analyze' }, { value: 'estimate', label: 'Estimate' }]} bind:value={mode} />
    <span class="text-[12px] text-neutral/60">
      {#if mode === 'analyze'}Captures the read, then measures each step where the database supports ANALYZE{:else}Captures the read, then asks for the planner’s estimate{/if}
    </span>
    <div class="ml-auto flex items-center gap-2">
      {#if at && !loading}
        <span class="text-[12px] text-neutral/55" title={plan?.analyzed ? 'This request captured the read once, then ran this statement once more under ANALYZE; the second run may find its pages already in memory.' : current?.error ? 'This request captured the read once, but EXPLAIN failed; any additional execution is unknown.' : 'This request captured the read once; this statement’s plan did not execute it again.'}>
          Captured {time(at)} · {current?.error ? 'EXPLAIN failed' : plan?.analyzed ? 'captured + analyzed' : 'captured once'}
        </span>
      {/if}
    </div>
  </div>

  {#if !current}
    <p class="m-0 text-[13px] text-neutral/60">{loading ? 'Explaining…' : 'No statement to explain.'}</p>
  {:else}
    <div class="grid gap-2">
      {#if explained.length > 1}
        <SegmentedControl size="small" label="Statement" items={explained.map((_, index) => ({ value: String(index), label: `Statement ${index + 1}` }))} value={String(statementIndex)} onValueChange={value => (statementIndex = Number(value))} />
      {/if}
      {#if current.error}
        <p class="m-0 rounded-md border border-danger/40 bg-danger-muted/40 p-3 text-[13px] text-danger">The database would not explain this statement: {current.error}</p>
      {:else if plan}
        <div class="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
          {@render stat(plan.analyzed ? 'Execution' : 'Statement', total === undefined ? '—' : ms(total), plan.analyzed ? 'The time the database spent running it under ANALYZE' : plan.dialect === 'sqlite' ? 'The time the client measured: SQLite does not time its plan' : 'Not run: no time measured')}
          {#if plan.planningTime !== undefined}{@render stat('Planning', ms(plan.planningTime), 'The time the database spent choosing the plan')}{/if}
          {@render stat(plan.analyzed ? 'Rows returned' : 'Rows expected', returned === undefined ? '—' : compact(returned))}
          {#if cache}{@render stat('Cache', `${Math.round(cache.share * 100)}% hit`, `${compact(cache.hit)} pages found in shared memory, ${compact(cache.read)} read from disk or the OS cache`)}{/if}
          {#if slowest?.actual}{@render stat('Slowest step', `${ms(slowest.actual.self)} · ${slowest.operation}${slowest.relation ? ` on ${slowest.relation}` : ''}`, 'The operation with the most time of its own')}{/if}
          {#if hasAdvice}{@render stat('Advice', [counts.critical && `${counts.critical} slow`, counts.warning && `${counts.warning} to look at`, counts.info && `${counts.info} to know`].filter(Boolean).join(' · '))}{/if}
        </div>
        {#if !plan.analyzed}
          <p class="m-0 text-[12px] text-neutral/60">{plan.dialect === 'sqlite' ? 'SQLite says the plan it chose, not what each step cost: the time is the whole statement’s.' : 'An estimate: the rows are the planner’s guesses and no step is timed. Analyze to measure them.'}</p>
        {/if}
      {/if}
    </div>

    {#if plan}
      <!-- The plan (graph, table or the database's text), and beside it (below on a narrow page) the advice and the chosen operation. -->
      <div class={['grid min-h-0 gap-3', showPanel ? 'grid-rows-[minmax(26rem,1fr)_auto] @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:grid-rows-1' : 'grid-rows-[minmax(26rem,1fr)]']}>
        <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
          <SegmentedControl size="small" label="How to show the plan" items={[{ value: 'graph', label: 'Graph' }, { value: 'table', label: 'Table' }, { value: 'raw', label: plan.dialect === 'postgresql' ? 'JSON' : 'Text' }]} bind:value={view} />
          {#if view === 'graph'}
            <div class="plan relative min-h-[24rem] overflow-hidden rounded-lg border border-neutral-muted">
              {#key plan}
              <SvelteFlow
                bind:nodes
                {edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                colorMode={theme.resolvedTheme === 'dark' ? 'dark' : 'light'}
                panOnScroll
                zoomOnScroll={false}
                minZoom={0.01}
                maxZoom={1.6}
                nodesConnectable={false}
                nodesDraggable={false}
                proOptions={{ hideAttribution: true }}
                onnodeclick={({ node }) => chooseNode(node.id)}
                onpaneclick={() => choose([])}
              >
                <PlanFocus root={plan.root.id} targets={focus.targets} version={focus.version} />
              </SvelteFlow>
              {/key}
            </div>
          {:else if view === 'table'}
            <div class="min-h-0 overflow-auto rounded-lg border border-neutral-muted bg-surface">
              <table class="w-full border-collapse text-[12px]">
                <thead class="sticky top-0 bg-surface-floating text-left text-neutral/60">
                  <tr>
                    <th class="px-3 py-2 font-medium">Operation</th>
                    <th class="px-3 py-2 text-right font-medium">Own</th>
                    <th class="px-3 py-2 text-right font-medium">Total</th>
                    <th class="px-3 py-2 text-right font-medium">Rows</th>
                    <th class="px-3 py-2 text-right font-medium">Expected</th>
                    <th class="px-3 py-2 text-right font-medium">Loops</th>
                    <th class="px-3 py-2 text-right font-medium">Hit / read</th>
                  </tr>
                </thead>
                <tbody>
                  {#each flat as { node, depth } (node.id)}
                    <tr class={['cursor-pointer border-t border-neutral-muted hover:bg-neutral-muted/40', chosen === node.id && 'bg-primary/10', node.neverExecuted && 'opacity-50']} onclick={() => chooseNode(node.id)}>
                      <td class="px-3 py-1.5" style:padding-left="{12 + depth * 16}px">
                        <span class={['font-medium', node.fullScan && 'text-danger']}>{node.operation}</span>
                        {#if node.relation}<span class="ml-1 font-mono text-neutral/65">{node.relation}</span>{/if}
                        {#if node.index}<span class="ml-1 font-mono text-success">{node.index}</span>{/if}
                      </td>
                      <td class="px-3 py-1.5 text-right font-mono tabular-nums">{node.actual ? ms(node.actual.self) : ''}</td>
                      <td class="px-3 py-1.5 text-right font-mono tabular-nums">{node.actual ? ms(node.actual.time) : ''}</td>
                      <td class="px-3 py-1.5 text-right font-mono tabular-nums">{node.actual ? compact(node.actual.rows) : ''}</td>
                      <td class="px-3 py-1.5 text-right font-mono tabular-nums text-neutral/60">{node.estimate?.rows === undefined ? '' : compact(node.estimate.rows)}</td>
                      <td class="px-3 py-1.5 text-right font-mono tabular-nums">{node.actual && node.actual.loops > 1 ? compact(node.actual.loops) : ''}</td>
                      <td class="px-3 py-1.5 text-right font-mono tabular-nums">{node.buffers ? `${compact(node.buffers.hit)} / ${compact(node.buffers.read)}` : ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="min-h-0 overflow-auto"><Code language={plan.dialect === 'postgresql' ? 'json' : 'text'} title={plan.dialect === 'postgresql' ? 'EXPLAIN (FORMAT JSON)' : plan.dialect === 'mysql' ? 'EXPLAIN' : 'EXPLAIN QUERY PLAN'} code={plan.raw} /></div>
          {/if}
        </div>
        {#if showPanel}
        <aside class="grid min-h-0 content-start gap-2 overflow-auto @3xl:max-h-full" aria-label="Advice and the chosen operation">
          {#if hasAdvice}
          <SegmentedControl size="small" label="What to show" items={[{ value: 'advice', label: `Advice · ${plan.advice.length}` }, { value: 'node', label: chosenNode ? chosenNode.operation : 'Operation' }]} bind:value={panel} />
          {/if}
          {#if hasAdvice && panel === 'advice'}
            {#each plan.advice as entry (entry.id)}{@render adviceCard(entry)}{/each}
          {:else if chosenNode}
            {@const node = chosenNode}
            <div class="grid gap-3 rounded-lg border border-neutral-muted bg-surface p-3 text-[13px]">
              <div class="grid gap-0.5">
                <span class="text-[11px] tracking-wide text-neutral/55 uppercase">{kindLabel(node) || 'Operation'}</span>
                <h4 class="m-0 text-[15px] font-semibold">{node.operation}</h4>
                {#if node.relation || node.alias}<span class="font-mono text-[12px] text-neutral/70">{[node.relation, node.alias].filter(Boolean).join(' as ')}{node.index ? ` · ${node.index}` : ''}</span>{/if}
              </div>
              {#if node.neverExecuted}
                <p class="m-0 text-neutral/65">The query never reached it: the rows above it were already enough, or none came to it.</p>
              {/if}
              {#if node.actual || node.estimate || node.buffers}
                <dl class="m-0 grid grid-cols-2 gap-x-3 gap-y-1">
                  {@render measure('Own time', node.actual ? ms(node.actual.self) : undefined)}
                  {@render measure(node.actual?.parallel ? 'Elapsed, with its inputs' : 'With its inputs', node.actual ? ms(node.actual.time) : undefined)}
                  {@render measure('Workers’ time, added', node.actual?.work === undefined ? undefined : ms(node.actual.work))}
                  {@render measure('First row after', node.actual?.startup === undefined ? undefined : ms(node.actual.startup))}
                  {@render measure('Rows (per loop)', node.actual ? compact(node.actual.rows) : undefined)}
                  {@render measure(node.actual?.parallel ? 'Workers' : 'Loops', node.actual ? compact(node.actual.loops) : undefined)}
                  {@render measure('Rows expected', node.estimate?.rows === undefined ? undefined : compact(node.estimate.rows))}
                  {@render measure('Planner’s cost', node.estimate?.cost === undefined ? undefined : compact(node.estimate.cost))}
                  {@render measure('Pages in memory', node.buffers ? compact(node.buffers.hit) : undefined)}
                  {@render measure('Pages read', node.buffers ? compact(node.buffers.read) : undefined)}
                  {@render measure('Pages dirtied', node.buffers?.dirtied ? compact(node.buffers.dirtied) : undefined)}
                  {@render measure('Pages written', node.buffers?.written ? compact(node.buffers.written) : undefined)}
                  {@render measure('Temp pages read', node.buffers?.tempRead ? compact(node.buffers.tempRead) : undefined, 'text-danger')}
                  {@render measure('Temp pages written', node.buffers?.tempWritten ? compact(node.buffers.tempWritten) : undefined, 'text-danger')}
                </dl>
              {/if}
              {#each node.conditions as condition (condition.label)}
                <div class="grid gap-1">
                  <span class="text-[11px] text-neutral/55">{condition.label}</span>
                  <code class="rounded bg-neutral-muted/50 px-2 py-1 font-mono text-[12px] break-words whitespace-pre-wrap">{condition.text}</code>
                </div>
              {/each}
              {#if node.facts.length}
                <dl class="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                  {#each node.facts as fact (fact.label)}
                    <dt class="text-neutral/60">{fact.label}</dt><dd class="m-0 text-right font-mono">{fact.value}</dd>
                  {/each}
                </dl>
              {/if}
              {#if node.detail && node.detail !== node.operation}
                <code class="rounded bg-neutral-muted/50 px-2 py-1 font-mono text-[12px] break-words whitespace-pre-wrap">{node.detail}</code>
              {/if}
              {#if indexesOf(node).length}
                <div class="grid gap-1">
                  <span class="text-[11px] text-neutral/55">Indexes on {node.relation}</span>
                  {#each indexesOf(node) as index (index.name)}
                    <span class="font-mono text-[12px]" title={index.definition}>{index.name} <span class="text-neutral/55">({index.columns.join(', ')}){index.unique ? ' unique' : ''}{index.partial ? ' partial' : ''}{index.ordered ? '' : ' not a b-tree'}</span></span>
                  {/each}
                </div>
              {/if}
              {#each plan.advice.filter(entry => entry.nodes.includes(node.id)) as entry (entry.id)}{@render adviceCard(entry)}{/each}
            </div>
          {:else}
            <p class="m-0 text-[13px] text-neutral/60">Choose an operation in the plan to see all the database said of it.</p>
          {/if}
        </aside>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .plan {
    background: var(--color-surface-recessed, color-mix(in oklab, var(--color-neutral) 4%, var(--color-surface)));
    --xy-background-color: transparent;
    --xy-edge-stroke: color-mix(in oklab, var(--color-neutral) 45%, transparent);
  }
  .plan :global(.svelte-flow) { position: absolute; inset: 0; height: auto; }
  .plan :global(.svelte-flow__node) { cursor: pointer; }
  .plan :global(.plan-flow.never) { stroke-dasharray: 4 4; opacity: 0.5; }
</style>
