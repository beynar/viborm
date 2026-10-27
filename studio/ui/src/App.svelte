<script lang="ts">
import { onMount } from "svelte";
import RowsView from "./components/data/RowsView.svelte";
import Icon from "./components/Icon.svelte";
import SchemaDiagram from "./components/schema/SchemaDiagram.svelte";
import { loadSchema, type Scope, type StudioSchema } from "./lib/api";

// The studio's frame: the models in a sidebar, then either the schema diagram or one model's rows. Where the member
// is lives in the address (`#/schema`, `#/data/<model>?scope=…`), so the browser's back button follows relations back.
let schema = $state<StudioSchema>();
let failure = $state<string>();
let hash = $state(location.hash);

onMount(() => {
  const changed = () => (hash = location.hash);
  addEventListener("hashchange", changed);
  loadSchema()
    .then((loaded) => (schema = loaded))
    .catch(
      (error) =>
        (failure = error instanceof Error ? error.message : String(error))
    );
  return () => removeEventListener("hashchange", changed);
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
</script>

<div class="frame">
  <nav aria-label="Studio">
    <div class="brand"><Icon name="database" size={18} /><span>VibORM Studio</span></div>
    {#if schema}<div class="dialect">{schema.dialect}</div>{/if}
    <a class="item" class:current={route.view === 'schema'} href="#/schema"><Icon name="diagram" />Schema</a>
    <h2>Models</h2>
    {#each schema?.models ?? [] as model (model.name)}
      <a class="item" class:current={route.view === 'data' && route.model === model.name} href="#/data/{encodeURIComponent(model.name)}"><Icon name="table" />{model.name}</a>
    {/each}
  </nav>
  <main>
    {#if failure}
      <p class="failure" role="alert">The studio could not read the schema: {failure}</p>
    {:else if !schema}
      <p class="loading">Loading the schema…</p>
    {:else if route.view === 'schema'}
      <SchemaDiagram {schema} open={model => navigate(model)} />
    {:else if current}
      {#key hash}
        <RowsView {schema} model={current} scope={route.view === 'data' ? route.scope : undefined} {navigate} />
      {/key}
    {:else}
      <p class="loading">No model named “{route.view === 'data' ? route.model : ''}”.</p>
    {/if}
  </main>
</div>

<style>
  .frame { display: grid; grid-template-columns: 220px 1fr; height: 100%; }
  nav { display: flex; flex-direction: column; gap: 2px; padding: 12px 8px; border-right: 1px solid var(--border); background: var(--color-surface); overflow: auto; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-weight: 700; font-size: 14px; }
  .dialect { margin: 0 8px 10px; font: 11px var(--mono); color: var(--muted); }
  h2 { margin: 14px 8px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .item { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border-radius: 8px; color: inherit; }
  .item:hover { background: var(--faint); text-decoration: none; }
  .item.current { background: color-mix(in oklab, var(--color-link) 12%, transparent); color: var(--color-link); font-weight: 600; }
  main { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .loading, .failure { padding: 24px; color: var(--muted); }
  .failure { color: var(--color-danger); }
</style>
