<script lang="ts">
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { Confirmation } from "entasis/confirmation";
import { databaseIcon } from "entasis/icons/database";
import { graphIcon } from "entasis/icons/graph";
import { moonIcon } from "entasis/icons/moon";
import { sunIcon } from "entasis/icons/sun";
import { tableIcon } from "entasis/icons/table";
import { Theme } from "entasis/theme";
import { Toaster, toast } from "entasis/toast";
import { onMount } from "svelte";
import RowsView from "./components/data/RowsView.svelte";
import SchemaDiagram from "./components/schema/SchemaDiagram.svelte";
import { loadSchema, type Scope, type StudioSchema } from "./lib/api";

// The studio's frame: the models in a sidebar, then either the schema diagram or one model's rows. Where the member
// is lives in the address (`#/schema`, `#/data/<model>?scope=…`), so the browser's back button follows relations back.
let schema = $state<StudioSchema>();
let failure = $state<string>();
let hash = $state(location.hash);

/** Bumped each time the server reloads the config: the open rows read again. */
let revision = $state(0);

onMount(() => {
  const changed = () => (hash = location.hash);
  addEventListener("hashchange", changed);
  loadSchema()
    .then((loaded) => (schema = loaded))
    .catch(
      (error) =>
        (failure = error instanceof Error ? error.message : String(error))
    );
  // The server watches the config and the schema it imports: a save reloads them here.
  const events = new EventSource("./api/events");
  events.addEventListener("schema", async () => {
    try {
      schema = await loadSchema();
      revision += 1;
      toast.success({ title: "Schema reloaded" });
    } catch (error) {
      toast.danger({
        title: "The schema could not be read",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });
  events.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent)) return;
    toast.danger({
      title: "Your config failed to reload",
      description: `${JSON.parse(event.data).message}\nThe previous schema is still served.`,
    });
  });
  return () => {
    removeEventListener("hashchange", changed);
    events.close();
  };
});

type Route =
  | { view: "schema" }
  | { view: "data"; model: string; scope?: Scope };
const route = $derived.by<Route>(() => {
  const [path = "", query = ""] = hash.slice(1).split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "data" || !parts[1]) return { view: "schema" };
  const encoded = new URLSearchParams(query).get("scope");
  let scope: Scope | undefined;
  try {
    scope = encoded ? JSON.parse(encoded) : undefined;
  } catch {
    scope = undefined;
  }
  return {
    view: "data",
    model: decodeURIComponent(parts[1]),
    ...(scope ? { scope } : {}),
  };
});

function navigate(model: string, scope?: Scope) {
  location.hash = `#/data/${encodeURIComponent(model)}${scope ? `?${new URLSearchParams({ scope: JSON.stringify(scope) })}` : ""}`;
}

const current = $derived(
  route.view === "data"
    ? schema?.models.find((model) => model.name === route.model)
    : undefined
);
const NAV =
  "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-neutral/80 no-underline hover:bg-neutral/5";
const CURRENT = "bg-neutral/8 font-medium text-neutral";
</script>

<Theme>
  {#snippet children(theme)}
    <div class="grid h-full grid-cols-[232px_1fr]">
      <nav class="flex min-h-0 flex-col gap-0.5 overflow-auto border-r border-neutral/10 bg-surface-recessed p-3" aria-label="Studio">
        <div class="mb-1 flex items-center gap-2 px-2 py-1.5">
          {@render databaseIcon({ size: 18 })}
          <span class="text-[14px] font-semibold">VibORM Studio</span>
        </div>
        {#if schema}<div class="mb-3 px-2"><Chip size="small" variant="soft">{schema.dialect}</Chip></div>{/if}
        <a class="{NAV} {route.view === 'schema' ? CURRENT : ''}" href="#/schema" aria-current={route.view === 'schema' ? 'page' : undefined}>
          {@render graphIcon({ size: 16 })}Schema
        </a>
        <h2 class="mt-4 mb-1 px-2 text-[11px] font-medium tracking-wide text-neutral/50 uppercase">Models</h2>
        {#each schema?.models ?? [] as model (model.name)}
          {@const selected = route.view === 'data' && route.model === model.name}
          <a class="{NAV} {selected ? CURRENT : ''}" href="#/data/{encodeURIComponent(model.name)}" aria-current={selected ? 'page' : undefined}>
            {@render tableIcon({ size: 16 })}<span class="truncate">{model.name}</span>
          </a>
        {/each}
        <div class="mt-auto pt-3">
          <Button
            size="small"
            variant="ghost"
            prefix={theme.resolvedTheme === 'dark' ? sunIcon : moonIcon}
            onclick={() => (theme.theme = theme.resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            {theme.resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </nav>
      <main class="relative flex min-h-0 min-w-0 flex-col">
        {#if failure}
          <p class="m-0 p-6 text-danger">The studio could not read the schema: {failure}</p>
        {:else if !schema}
          <p class="m-0 p-6 text-neutral/60">Loading the schema…</p>
        {:else if route.view === 'schema'}
          <SchemaDiagram {schema} />
        {:else if current}
          {#key `${hash}#${revision}`}
            <RowsView model={current} models={schema.models} scope={route.scope} {navigate} />
          {/key}
        {:else}
          <p class="m-0 p-6 text-neutral/60">No model named “{route.model}”.</p>
        {/if}
      </main>
    </div>
    <Toaster />
    <Confirmation />
  {/snippet}
</Theme>
