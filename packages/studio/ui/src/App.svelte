<script lang="ts">
import { AppShell, type AppShellSidebarProps } from "entasis/app-shell";
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { Confirmation, confirmation } from "entasis/confirmation";
import { Dialog } from "entasis/dialog";
import { bookmarkSimpleIcon } from "entasis/icons/bookmarkSimple";
import { copyIcon } from "entasis/icons/copy";
import { databaseIcon } from "entasis/icons/database";
import { graphIcon } from "entasis/icons/graph";
import { imageSquareIcon } from "entasis/icons/imageSquare";
import { magnifyingGlassIcon } from "entasis/icons/magnifyingGlass";
import { sidebarSimpleIcon } from "entasis/icons/sidebarSimple";
import { terminalWindowIcon } from "entasis/icons/terminalWindow";
import { trashIcon } from "entasis/icons/trash";
import type { SidebarApi } from "entasis/sidebar";
import { Theme } from "entasis/theme";
import { Toaster, toast } from "entasis/toast";
import { searchParams } from "sv-router";
import { onMount, type Snippet } from "svelte";
import type { ModelIcon } from "../../src/icons";
import DriftBanner from "./components/DriftBanner.svelte";
import ChangesBar from "./components/data/ChangesBar.svelte";
import IconPicker from "./components/IconPicker.svelte";
import KeyboardShortcuts from "./components/KeyboardShortcuts.svelte";
import Palette from "./components/Palette.svelte";
import ThemeToggle from "./components/ThemeToggle.svelte";
import {
  checkDrift,
  loadSchema,
  type StudioDescription,
  type StudioDrift,
} from "./lib/api";
import { Changes } from "./lib/changes.svelte";
import { MODEL_ICON } from "./lib/model-icons";
import { Queries, type SavedQuery } from "./lib/queries.svelte";
import { provideStudio } from "./lib/studio-context";
import { type SavedView, Views } from "./lib/views.svelte";
import {
  go,
  isActive,
  modelHref,
  navigateModel,
  openQuery,
  openView,
  p,
  queryHref,
  viewHref,
} from "./router";

let { children: content }: { children: Snippet } = $props();

// The studio's frame, entasis's AppShell: the models in its sidebar, then a page — the schema diagram or one model's
// rows — whose title, header actions and footer the page sets itself (`setPageShell`). Where the member is lives in
// the route, so the browser's back button
// follows relations back. The views the member saved are listed under the models.
let schema = $state<StudioDescription>();
/** The saved views of the project the studio opened: known once its schema is. */
let views = $state<Views>();
let queries = $state<Queries>();
/** The edits stacked until they are saved, across every model's page. */
let changes = $state<Changes>();
/** The ⌘K palette, open. */
let paletteOpen = $state(false);
let failure = $state<string>();

/** Bumped each time the server reloads the config: the open page reads again. */
let revision = $state(0);
provideStudio({
  get schema() {
    return schema;
  },
  get views() {
    return views;
  },
  get queries() {
    return queries;
  },
  get changes() {
    return changes;
  },
  get revision() {
    return revision;
  },
});
/** How the database stands against the schema, checked when it loads and reloads. */
let drift = $state<StudioDrift>();
let checking = $state(false);
async function check() {
  checking = true;
  try {
    drift = await checkDrift();
  } catch (error) {
    drift = {
      state: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    checking = false;
  }
}

onMount(() => {
  loadSchema()
    .then((loaded) => {
      schema = loaded;
      views = new Views(loaded.project);
      views.load();
      queries = new Queries(loaded.project);
      queries.load();
      changes = new Changes(loaded.project);
      check();
    })
    .catch(
      (error) =>
        (failure = error instanceof Error ? error.message : String(error))
    );
  // The server watches the config and the schema it imports: a save reloads them here.
  const events = new EventSource("/api/events");
  events.addEventListener("schema", async () => {
    try {
      schema = await loadSchema();
      revision += 1;
      toast.success({ title: "Schema reloaded" });
      check();
    } catch (error) {
      toast.danger({
        title: "The schema could not be read",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });
  // Another page kept its views (or the diagram's layout): this one reads them again.
  events.addEventListener("store", (event) => {
    if (JSON.parse(event.data).name === "views") views?.load();
    if (JSON.parse(event.data).name === "queries") queries?.load();
  });
  events.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent)) return;
    toast.danger({
      title: "Your config failed to reload",
      description: `${JSON.parse(event.data).message}\nThe previous schema is still served.`,
    });
  });
  return () => {
    events.close();
  };
});

/** The views whose model the schema still has. */
const listed = $derived(
  (views?.list ?? []).filter((view) =>
    schema?.models.some((model) => model.name === view.model)
  )
);

type IconTarget =
  | { kind: "view"; item: SavedView }
  | { kind: "query"; item: SavedQuery };
let iconFor = $state<IconTarget>();
async function chooseIcon(target: IconTarget, icon: ModelIcon) {
  try {
    const collection = target.kind === "view" ? views : queries;
    await collection?.setIcon(target.item.id, icon);
    iconFor = undefined;
  } catch (error) {
    toast.danger({
      title: `The icon of “${target.item.name}” could not be kept`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

async function duplicateQuery(query: SavedQuery) {
  if (!queries) return;
  try {
    const id = await queries.duplicate(query.id);
    await openQuery({ id });
  } catch (error) {
    toast.danger({
      title: `The query “${query.name}” could not be duplicated`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}
async function duplicateView(view: SavedView) {
  if (!views) return;
  try {
    const id = await views.duplicate(view.id);
    await openView({ id, model: view.model });
  } catch (error) {
    toast.danger({
      title: `The view “${view.name}” could not be duplicated`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

async function removeView(view: SavedView) {
  const { confirmed } = await confirmation({
    title: `Delete the view “${view.name}”?`,
    description: "Only the view goes: the rows stay as they are.",
    confirm: { text: "Delete", color: "danger" },
    cancel: "Cancel",
  });
  if (!confirmed) return;
  const open =
    isActive("/data/:model", { model: view.model }) &&
    searchParams.toURLSearchParams().get("view") === view.id;
  try {
    await views?.remove(view.id);
  } catch (error) {
    toast.danger({
      title: `The view “${view.name}” could not be deleted`,
      description: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (open) await navigateModel(view.model);
  toast.success({ title: `The view “${view.name}” was deleted` });
}
async function removeQuery(query: SavedQuery) {
  const { confirmed } = await confirmation({
    title: `Delete the query “${query.name}”?`,
    description: "This removes the saved query only.",
    confirm: { text: "Delete", color: "danger" },
    cancel: "Cancel",
  });
  if (!confirmed) return;
  try {
    await queries?.remove(query.id);
    if (isActive("/query/:id", { id: query.id })) await go("/query");
    toast.success({ title: `The query “${query.name}” was deleted` });
  } catch (error) {
    toast.danger({
      title: "The query could not be deleted",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}
const sidebar = $derived<AppShellSidebarProps>({
  collapsible: "icon",
  theme: {
    header: { base: "group-data-[collapsible=icon]:py-md" },
    footer: { base: "group-data-[collapsible=icon]:py-md" },
  },
  items: [
    {
      items: [
        {
          label: "Search",
          icon: magnifyingGlassIcon,
          badge: "⌘K",
          onclick: () => (paletteOpen = true),
        },
        {
          label: "Schema",
          href: p("/schema"),
          icon: graphIcon,
          isActive: isActive("/schema"),
        },
        {
          label: "Query",
          href: p("/query"),
          icon: terminalWindowIcon,
          isActive: isActive("/query"),
        },
      ],
    },
    {
      label: "Models",
      items: (schema?.models ?? []).map((model) => ({
        label: model.name,
        href: modelHref(model.name),
        icon: MODEL_ICON[model.icon],
        isActive:
          isActive("/data/:model", { model: model.name }) &&
          !searchParams.has("view"),
      })),
    },
    ...(queries?.list.length
      ? [
          {
            label: "Queries",
            items: queries.list.map((query) => ({
              label: query.name,
              href: queryHref(query),
              icon: query.icon ? MODEL_ICON[query.icon] : terminalWindowIcon,
              badge: query.code === undefined ? query.model : "Code",
              isActive: isActive("/query/:id", { id: query.id }),
              action: {
                label: `Actions for the query ${query.name}`,
                menu: [
                  {
                    type: "option" as const,
                    title: "Change icon",
                    prefix: imageSquareIcon,
                    onclick: () => (iconFor = { kind: "query", item: query }),
                  },
                  {
                    type: "option" as const,
                    title: "Duplicate",
                    prefix: copyIcon,
                    onclick: () => duplicateQuery(query),
                  },
                  {
                    type: "option" as const,
                    title: "Delete query",
                    prefix: trashIcon,
                    color: "danger" as const,
                    onclick: () => removeQuery(query),
                  },
                ],
              },
            })),
          },
        ]
      : []),
    ...(listed.length
      ? [
          {
            label: "Views",
            items: listed.map((view) => ({
              label: view.name,
              href: viewHref(view),
              icon: view.icon ? MODEL_ICON[view.icon] : bookmarkSimpleIcon,
              badge: view.model,
              tooltip: `${view.name} · ${view.model}`,
              isActive:
                isActive("/data/:model", { model: view.model }) &&
                searchParams.toURLSearchParams().get("view") === view.id,
              action: {
                label: `Actions for the view ${view.name}`,
                menu: [
                  {
                    type: "option" as const,
                    title: "Change icon",
                    prefix: imageSquareIcon,
                    onclick: () => (iconFor = { kind: "view", item: view }),
                  },
                  {
                    type: "option" as const,
                    title: "Duplicate",
                    prefix: copyIcon,
                    onclick: () => duplicateView(view),
                  },
                  {
                    type: "option" as const,
                    title: "Delete view",
                    prefix: trashIcon,
                    color: "danger" as const,
                    onclick: () => removeView(view),
                  },
                ],
              },
            })),
          },
        ]
      : []),
  ],
  header: brand,
  footer: sidebarFooter,
});
</script>

<!-- The studio's name and the database it speaks to, the sidebar's fold beside them. Folded to its icons, the
     sidebar shows the database's icon, which turns into the unfold button under the pointer or the keyboard. -->
{#snippet brand(sidebar: SidebarApi)}
  {@const expanded = sidebar.open || sidebar.isMobile}
  <div class="flex h-12 items-start gap-2 overflow-hidden">
    <div class="group/brand relative grid size-8 shrink-0 place-items-center">
      <span class={['inline-flex transition-opacity', !expanded && 'group-focus-within/brand:opacity-0 group-hover/brand:opacity-0']}>{@render databaseIcon({ size: 18 })}</span>
      {#if !expanded}
        <span class="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-focus-within/brand:opacity-100 group-hover/brand:opacity-100">
          <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label="Expand the sidebar" onclick={sidebar.toggle} />
        </span>
      {/if}
    </div>
    <div class={['flex min-w-0 flex-1 items-start gap-2 pt-1 transition-opacity duration-normal', !expanded && 'pointer-events-none opacity-0']} inert={!expanded} aria-hidden={!expanded}>
      <div class="grid min-w-0 flex-1 gap-1">
        <span class="truncate text-[14px] leading-5 font-semibold">VibORM Studio</span>
        {#if schema}<span><Chip size="small" variant="soft">{schema.dialect}</Chip></span>{/if}
      </div>
      <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label="Collapse the sidebar" onclick={sidebar.toggle} />
    </div>
  </div>
{/snippet}

{#snippet sidebarFooter()}
  <!-- Keep the same rail geometry while the surrounding sidebar changes width. -->
  <div class="flex w-8 shrink-0 flex-col items-center gap-1">
    <ThemeToggle />
    <KeyboardShortcuts />
  </div>
{/snippet}

<Theme>
  {#snippet children()}
    <AppShell variant="inset" {sidebar} contentPadding="none" contentWidth="full" title="VibORM Studio">
      {#if failure}
        <p class="m-0 p-6 text-danger">The studio could not read the schema: {failure}</p>
      {:else if !schema}
        <p class="m-0 p-6 text-neutral/60">Loading the schema…</p>
      {:else}
        {#if drift?.state === 'drift'}{#key drift}<DriftBanner {drift} {checking} {check} />{/key}{/if}
        {@render content()}
      {/if}
      {#if changes}<ChangesBar {changes} />{/if}
    </AppShell>
    {#if schema}
      <Palette bind:open={paletteOpen} {schema} {views} {queries} {changes} navigate={navigateModel} />
    {/if}
    <!-- Bottom right: the changes bar holds the bottom centre. -->
    <Toaster position="bottom-right" />
    <Confirmation />
    <!-- Saved item icons share the same picker and persistence feedback. -->
    <Dialog open={iconFor !== undefined} onOpenChange={open => { if (!open) iconFor = undefined; }} size="normal" title={iconFor ? `The icon of “${iconFor.item.name}”` : ''} description="Shown in the sidebar and in ⌘K.">
      {#snippet children()}
        {#if iconFor}
          {@const target = iconFor}
          <IconPicker expanded value={target.item.icon} onValueChange={icon => chooseIcon(target, icon)} />
        {/if}
      {/snippet}
    </Dialog>
  {/snippet}
</Theme>
