<script lang="ts">
import { Code } from "entasis/code";
import { warningCircleIcon } from "entasis/icons/warningCircle";
import type { StudioSpan } from "../../lib/api";

// What the query did, as the project's instrumentation traced it: each span a row, nested under the one it ran in,
// its bar where and as long as it ran on the query's time, then a span's attributes when it is chosen (the SQL it
// ran and its parameters, the driver, the model and the operation). The trace a collector would receive, kept here.
let { spans, duration }: { spans: readonly StudioSpan[]; duration: number } =
  $props();

/** The spans in tree order, each with its depth. */
const rows = $derived.by(() => {
  const children = new Map<number | undefined, StudioSpan[]>();
  const known = new Set(spans.map((span) => span.id));
  for (const span of spans) {
    // A span whose parent was not reported (a span of the application's own, outside the query) is a root.
    const parent =
      span.parent !== undefined && known.has(span.parent)
        ? span.parent
        : undefined;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const out: { span: StudioSpan; depth: number }[] = [];
  const visit = (parent: number | undefined, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      out.push({ span, depth });
      visit(span.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return out;
});

/** The time the bars are drawn on: the query's, or the last span's end when it ran past it. */
const total = $derived(
  Math.max(duration, ...spans.map((span) => span.start + span.duration), 0.001)
);
const percent = (time: number) => `${(Math.max(0, time) / total) * 100}%`;
const TICKS = [0, 0.5, 1];
const ms = (time: number) =>
  time >= 100
    ? `${Math.round(time)} ms`
    : `${time.toFixed(time >= 10 ? 1 : 2)} ms`;

const VIBORM = /^viborm\./;
/** A span said as it reads: `viborm.execute` → execute, with the model and the operation it served. */
function said(span: StudioSpan): { kind: string; detail: string } {
  const kind = span.name.replace(VIBORM, "");
  const model = span.attributes["db.collection.name"];
  const operation = span.attributes["db.operation.name"];
  const detail =
    model !== undefined && operation !== undefined
      ? `${model}.${operation}`
      : String(operation ?? model ?? "");
  return { kind, detail };
}

/**
 * Where the time went: in the database (the statements' spans), and in VibORM around them (validating the
 * arguments, building the SQL, reading the rows back), for the operations traced.
 */
const split = $derived.by(() => {
  const sum = (name: string) =>
    spans
      .filter((span) => span.name === name)
      .reduce((time, span) => time + span.duration, 0);
  const operations = sum("viborm.operation");
  const database = sum("viborm.execute");
  return operations > 0
    ? { operations, database, viborm: Math.max(0, operations - database) }
    : undefined;
});

const TONES: Record<string, string> = {
  operation: "bg-primary/70",
  execute: "bg-success/70",
  transaction: "bg-warning/70",
  connect: "bg-neutral/40",
  disconnect: "bg-neutral/40",
};
const toneOf = (span: StudioSpan) =>
  span.error ? "bg-danger/70" : (TONES[said(span).kind] ?? "bg-info/60");

let chosen = $state<number>();
const selected = $derived(
  spans.find((span) => span.id === chosen) ?? rows[0]?.span
);
/** Its attributes, the SQL apart and its parameters gathered in order. */
const details = $derived.by(() => {
  if (!selected) return undefined;
  const entries = Object.entries(selected.attributes);
  const parameters = entries
    .filter(([key]) => key.startsWith("db.query.parameter."))
    .sort(
      ([left], [right]) =>
        Number(left.split(".").at(-1)) - Number(right.split(".").at(-1))
    )
    .map(([, value]) => value);
  const sql = selected.attributes["db.query.text"];
  return {
    sql: typeof sql === "string" ? sql : undefined,
    parameters,
    attributes: entries.filter(
      ([key]) =>
        key !== "db.query.text" && !key.startsWith("db.query.parameter.")
    ),
  };
});
</script>

{#if spans.length === 0}
  <p class="m-0 text-[13px] text-neutral/60">The instrumentation reported no span for this query.</p>
{:else}
  <div class="grid gap-3">
    {#if split}
      <p class="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-neutral/70">
        <span><span class="font-medium text-neutral tabular-nums">{ms(split.operations)}</span> in all</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-sm bg-success/70"></span><span class="font-medium text-neutral tabular-nums">{ms(split.database)}</span> in the database</span>
        <span class="inline-flex items-center gap-1.5" title="Validating the arguments, building the SQL, reading the rows back"><span class="size-2 rounded-sm bg-primary/70"></span><span class="font-medium text-neutral tabular-nums">{ms(split.viborm)}</span> in VibORM</span>
      </p>
    {/if}
    <div class="overflow-hidden rounded-lg border border-neutral-muted bg-surface">
      <!-- The time axis. -->
      <div class="grid grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)_5rem] border-b border-neutral-muted text-[11px] text-neutral/50">
        <span class="px-3 py-1.5">Span</span>
        <div class="relative h-full">
          {#each TICKS as tick (tick)}
            <span class={['absolute top-1.5 whitespace-nowrap', tick === 1 ? '-translate-x-full' : tick > 0 && '-translate-x-1/2']} style:left="{tick * 100}%">{ms(total * tick)}</span>
          {/each}
        </div>
        <span class="px-3 py-1.5 text-right">Duration</span>
      </div>
      {#each rows as { span, depth } (span.id)}
        {@const name = said(span)}
        <button type="button" class={['grid w-full grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)_5rem] items-center border-b border-neutral-muted text-left text-[13px] last:border-b-0 hover:bg-neutral-muted/40', selected?.id === span.id && 'bg-neutral-muted/60']} onclick={() => (chosen = span.id)}>
          <span class="flex min-w-0 items-center gap-1.5 px-3 py-2" style:padding-left="{12 + depth * 16}px">
            {#if depth > 0}<span class="text-neutral/30">└</span>{/if}
            <span class="font-medium">{name.kind}</span>
            {#if name.detail}<span class="truncate font-mono text-[12px] text-neutral/60">{name.detail}</span>{/if}
            {#if span.error}<span class="inline-flex shrink-0 text-danger" title={span.error}>{@render warningCircleIcon({ size: 13 })}</span>{/if}
          </span>
          <span class="relative h-7">
            {#each TICKS.slice(1, -1) as tick (tick)}
              <span class="absolute inset-y-0 w-px bg-neutral-muted" style:left="{tick * 100}%"></span>
            {/each}
            <span class={['absolute top-1/2 h-3 min-w-[3px] -translate-y-1/2 rounded-sm', toneOf(span)]} style:left={percent(span.start)} style:width={percent(span.duration)}></span>
          </span>
          <span class="px-3 text-right font-mono text-[12px] tabular-nums">{ms(span.duration)}</span>
        </button>
      {/each}
    </div>

    {#if selected && details}
      {@const name = said(selected)}
      <div class="grid gap-3 rounded-lg border border-neutral-muted bg-surface p-4">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="font-mono text-[13px] font-medium">{selected.name}</span>
          <span class="text-[12px] text-neutral/60">starts at {ms(selected.start)} · lasts {ms(selected.duration)}</span>
        </div>
        {#if selected.error}
          <p class="m-0 text-[13px] text-danger">{selected.error}</p>
        {/if}
        {#if details.sql}
          <Code language="sql" code={details.sql} wrap title="db.query.text" />
        {/if}
        {#if details.parameters.length}
          <div class="grid gap-1">
            <span class="text-[11px] font-semibold tracking-wide text-neutral/55 uppercase">Parameters</span>
            <div class="flex flex-wrap gap-1.5">
              {#each details.parameters as parameter, index (index)}
                <span class="rounded border border-neutral-muted px-1.5 py-0.5 font-mono text-[12px]"><span class="text-neutral/45">${index + 1}</span> {String(parameter)}</span>
              {/each}
            </div>
          </div>
        {/if}
        {#if details.attributes.length}
          <dl class="m-0 grid grid-cols-[minmax(10rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
            {#each details.attributes as [key, value] (key)}
              <dt class="font-mono text-[12px] text-neutral/60">{key}</dt>
              <dd class="m-0 min-w-0 truncate font-mono text-[12px]" title={String(value)}>{String(value)}</dd>
            {/each}
          </dl>
        {/if}
        {#if name.kind === 'operation' && !details.sql}
          <p class="m-0 text-[12px] text-neutral/50">Choose an execute span for the SQL it ran.</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}
