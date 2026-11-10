<script lang="ts">
import { Alert } from "entasis/alert";
import { Button } from "entasis/button";
import { arrowsClockwiseIcon } from "entasis/icons/arrowsClockwise";
import type { StudioDrift } from "../lib/api";

// When the database is not what the schema says: what `viborm push` would change, the SQL it would run, and how
// to apply it. Orange when the push adds, red when it would drop or rewrite data. Dismissed until the next check.
let {
  drift,
  checking,
  check,
}: {
  drift: Extract<StudioDrift, { state: "drift" }>;
  checking: boolean;
  check: () => void;
} = $props();

// Kept until the next report: App keys the banner on it, so a check that finds the database still behind shows it again.
let dismissed = $state(false);
let shown = $state(false);
const count = $derived(drift.operations.length);
</script>

{#if !dismissed}
  <div class="px-4 pt-3">
    <Alert color={drift.destructive ? 'danger' : 'warning'} variant="soft" dismissible onDismiss={() => (dismissed = true)}>
      {#snippet title()}
        The database differs from the schema: a push would make {count === 1 ? 'one change' : `${count} changes`}{drift.destructive ? ', and lose data' : ''}
      {/snippet}
      {#snippet description()}
        <div class="grid gap-2">
          <ul class="m-0 grid list-none gap-0.5 p-0 font-mono text-xs">
            {#each drift.operations as operation, index (index)}
              <li>{operation.label}{#if operation.risk !== 'safe'}<span class="font-sans font-medium">{` · ${operation.risk}`}</span>{/if}</li>
            {/each}
          </ul>
          {#if shown}
            <pre class="m-0 max-h-64 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-5">{drift.statements.join(';\n\n')};</pre>
          {/if}
          <p class="m-0">Run <code class="font-mono">npx viborm push --dry-run</code> to review it, then <code class="font-mono">npx viborm push</code> to apply it.</p>
          <div class="flex gap-2">
            <Button size="small" variant="outline" onclick={() => (shown = !shown)}>{shown ? 'Hide the SQL' : 'Show the SQL'}</Button>
            <Button size="small" variant="ghost" prefix={arrowsClockwiseIcon} loading={checking} onclick={check}>Check again</Button>
          </div>
        </div>
      {/snippet}
    </Alert>
  </div>
{/if}
