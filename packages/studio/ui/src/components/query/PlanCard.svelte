<script lang="ts" module>
import type { PlanNode } from "../../lib/api";

/** The icon of an operation's kind: what it does to the rows. */
export function kindLabel(node: PlanNode): string {
  if (node.fullScan) return "Scan";
  if (node.kind === "index") return "Index";
  return node.kind === "other"
    ? ""
    : node.kind[0]!.toUpperCase() + node.kind.slice(1);
}
</script>

<script lang="ts">
import { Handle, type Node, type NodeProps, Position } from "@xyflow/svelte";
import { arrowsDownUpIcon } from "entasis/icons/arrowsDownUp";
import { funnelIcon } from "entasis/icons/funnel";
import { gitMergeIcon } from "entasis/icons/gitMerge";
import { lightningIcon } from "entasis/icons/lightning";
import { listNumbersIcon } from "entasis/icons/listNumbers";
import { rowsIcon } from "entasis/icons/rows";
import { stackIcon } from "entasis/icons/stack";
import { tableIcon } from "entasis/icons/table";
import { treeStructureIcon } from "entasis/icons/treeStructure";
import { warningIcon } from "entasis/icons/warning";
import { compact, ms, PLAN_CARD_WIDTH, type PlanCardData } from "../../lib/plan-graph";

// One operation of a plan: what it is and what it reads (a table, an index), how long it took on its own and its
// share of the statement's time (the bar, redder the more), the rows it handed up against those the planner
// expected (a factor when they are far apart), how many times it ran, the pages it found in memory or read, and
// the first thing it compares. An operation the query never reached is faded.
let { data, selected }: NodeProps<Node<PlanCardData>> = $props();
const node = $derived(data.node);

const ICONS = {
  scan: tableIcon,
  index: lightningIcon,
  join: gitMergeIcon,
  sort: arrowsDownUpIcon,
  aggregate: stackIcon,
  limit: listNumbersIcon,
  subquery: treeStructureIcon,
  materialize: rowsIcon,
  filter: funnelIcon,
  other: rowsIcon,
} as const;

/** How far the rows that came are from those expected: a factor, when it is large enough to matter. */
const misestimate = $derived.by(() => {
  const expected = node.estimate?.rows;
  if (!node.actual || expected === undefined || data.underLimit) return undefined;
  const came = node.actual.rows;
  const ratio = Math.max(expected, came) / Math.max(Math.min(expected, came), 1);
  return ratio >= 10 && Math.max(expected, came) >= 100 ? Math.round(ratio) : undefined;
});
const heat = $derived(
  data.share === undefined
    ? undefined
    : data.share >= 0.5
      ? "bg-danger"
      : data.share >= 0.2
        ? "bg-warning"
        : "bg-success"
);
const condition = $derived(node.conditions[0]);
const table = $derived(node.relation ?? node.alias);
</script>

<div
  class={[
    'plan-card grid gap-1.5 rounded-lg border bg-surface p-2.5 text-[12px] shadow-sm transition-[opacity,box-shadow]',
    selected ? 'border-primary ring-2 ring-primary/40' : 'border-neutral-muted',
    node.neverExecuted && 'opacity-50',
  ]}
  style:width="{PLAN_CARD_WIDTH}px"
>
  <Handle type="source" position={Position.Top} isConnectable={false} class="!opacity-0" />
  <Handle type="target" position={Position.Bottom} isConnectable={false} class="!opacity-0" />

  <div class="flex min-w-0 items-center gap-1.5">
    <span class={['inline-flex shrink-0', node.kind === 'index' ? 'text-success' : 'text-neutral/60']}>{@render ICONS[node.kind]({ size: 14 })}</span>
    <span class="truncate text-[13px] font-semibold" title={node.operation}>{node.operation}</span>
    {#if node.actual}
      <span class="ml-auto shrink-0 font-mono tabular-nums" title="Its own time, its inputs' taken out">{ms(node.actual.self)}</span>
    {/if}
  </div>

  {#if table || node.index}
    <div class="flex min-w-0 flex-wrap items-center gap-1">
      {#if table}<span class="truncate font-mono text-neutral/80">{node.relation && node.alias && node.alias !== node.relation ? `${node.relation} ${node.alias}` : table}</span>{/if}
      {#if node.index}<span class="truncate rounded bg-success-muted px-1 font-mono text-[11px] text-success" title="Index">{node.index}</span>{/if}
      {#if node.fullScan}<span class="rounded bg-neutral-muted px-1 text-[11px] font-medium text-neutral/70" title="A scan access path; a limit or parent operation may stop it early">scan path</span>{/if}
    </div>
  {/if}

  {#if heat}
    <div class="h-1.5 overflow-hidden rounded-full bg-neutral-muted" title="{Math.round((data.share ?? 0) * 100)}% of the statement's time">
      <div class={['h-full rounded-full', heat]} style:width="{Math.max(2, (data.share ?? 0) * 100)}%"></div>
    </div>
  {/if}

  {#if node.neverExecuted}
    <span class="text-neutral/60 italic">Never executed</span>
  {:else if node.actual}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-neutral/75">
      <span title="Rows it handed up, per loop">
        <span class="font-medium text-neutral tabular-nums">{compact(node.actual.rows)}</span> rows
        {#if node.estimate?.rows !== undefined}<span class="text-neutral/50">/ est. {compact(node.estimate.rows)}</span>{/if}
      </span>
      {#if misestimate}
        <span class="inline-flex items-center gap-0.5 rounded bg-warning-muted px-1 text-[11px] font-medium text-warning" title="The planner's estimate was off by this factor">{@render warningIcon({ size: 11 })}×{compact(misestimate)}</span>
      {/if}
      {#if node.actual.loops > 1}<span class="tabular-nums" title={node.actual.parallel ? 'Workers running it side by side' : 'It ran this many times'}>× {compact(node.actual.loops)} {node.actual.parallel ? 'workers' : 'loops'}</span>{/if}
    </div>
  {:else if node.estimate?.rows !== undefined}
    <span class="text-neutral/75"><span class="font-medium text-neutral tabular-nums">{compact(node.estimate.rows)}</span> rows expected</span>
  {/if}

  {#if node.buffers && (node.buffers.hit > 0 || node.buffers.read > 0)}
    <div class="flex gap-3 text-neutral/70" title="Pages of 8 kB: found in shared memory (hit), read from disk or the OS cache (read)">
      <span><span class="tabular-nums">{compact(node.buffers.hit)}</span> hit</span>
      {#if node.buffers.read > 0}<span class="text-warning"><span class="tabular-nums">{compact(node.buffers.read)}</span> read</span>{/if}
      {#if node.buffers.tempRead + node.buffers.tempWritten > 0}<span class="text-danger"><span class="tabular-nums">{compact(node.buffers.tempRead + node.buffers.tempWritten)}</span> temp</span>{/if}
    </div>
  {/if}

  {#if condition}
    <div class="truncate font-mono text-[11px] text-neutral/60" title="{condition.label}: {condition.text}"><span class="text-neutral/45">{condition.label}</span> {condition.text}</div>
  {:else if node.detail && node.detail !== node.operation}
    <div class="truncate font-mono text-[11px] text-neutral/60" title={node.detail}>{node.detail}</div>
  {/if}
</div>
