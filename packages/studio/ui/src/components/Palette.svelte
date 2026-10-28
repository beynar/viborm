<script lang="ts">
import { Command, type CommandGroup, type CommandItem } from "entasis/command";
import { bookmarkSimpleIcon } from "entasis/icons/bookmarkSimple";
import { floppyDiskIcon } from "entasis/icons/floppyDisk";
import { graphIcon } from "entasis/icons/graph";
import { magnifyingGlassIcon } from "entasis/icons/magnifyingGlass";
import { moonIcon } from "entasis/icons/moon";
import { terminalWindowIcon } from "entasis/icons/terminalWindow";
import { xIcon } from "entasis/icons/x";
import { useTheme } from "entasis/theme";
import type { Scope, StudioDescription } from "../lib/api";
import type { Changes } from "../lib/changes.svelte";
import { MODEL_ICON } from "../lib/model-icons";
import { parseDraft } from "../lib/values";
import type { Views } from "../lib/views.svelte";

// ⌘K: go anywhere the studio has (the schema, a model, a saved view), open one row by its key
// ("user 7"), or act (save or drop the changes, switch the theme).
let {
  open = $bindable(false),
  schema,
  views,
  changes,
  navigate,
  go,
}: {
  open?: boolean;
  schema: StudioDescription;
  views: Views | undefined;
  changes: Changes | undefined;
  navigate: (model: string, scope?: Scope) => void;
  /** An address in the studio (`#/schema`, `#/query`, a view's). */
  go: (hash: string) => void;
} = $props();

const SPACES = /\s+/;
const theme = useTheme();
let search = $state("");

/** "user 7": a model and its one key's value, typed. */
const byKey = $derived.by(() => {
  const [name, ...rest] = search.trim().split(SPACES);
  const typed = rest.join(" ");
  const model = schema.models.find(
    (candidate) => candidate.name.toLowerCase() === name?.toLowerCase()
  );
  const field = model?.fields.find(
    (candidate) =>
      model.key?.fields.length === 1 && candidate.name === model.key.fields[0]
  );
  if (!(model && field && typed)) return undefined;
  try {
    return { model, field, value: parseDraft(field, typed), typed };
  } catch {
    return undefined;
  }
});

const items = $derived.by<CommandGroup[]>(() => {
  const groups: CommandGroup[] = [];
  if (byKey) {
    groups.push({
      heading: "Row",
      items: [
        {
          value: "row",
          label: `Open ${byKey.model.name} ${byKey.typed}`,
          description: `${byKey.field.name} = ${byKey.typed}`,
          icon: MODEL_ICON[byKey.model.icon],
          keywords: [search],
        },
      ],
    });
  }
  groups.push({
    heading: "Go to",
    items: [
      { value: "go:#/schema", label: "Schema", icon: graphIcon },
      {
        value: "go:#/query",
        label: "Query",
        description: "A read through the client, with its SQL",
        icon: terminalWindowIcon,
        keywords: ["sql", "findMany", "playground"],
      },
      ...schema.models.map((model) => ({
        value: `model:${model.name}`,
        label: model.name,
        description: model.table === model.name ? undefined : model.table,
        icon: MODEL_ICON[model.icon],
      })),
      ...(views?.list ?? [])
        .filter((view) =>
          schema.models.some((model) => model.name === view.model)
        )
        .map((view) => ({
          value: `view:${view.id}`,
          label: view.name,
          description: `View of ${view.model}`,
          icon: view.icon ? MODEL_ICON[view.icon] : bookmarkSimpleIcon,
          keywords: [view.model, "view"],
        })),
    ],
  });
  const actions: CommandItem[] = [];
  if (changes?.list.length) {
    actions.push(
      {
        value: "save",
        label: `Save ${changes.list.length === 1 ? "the change" : `the ${changes.list.length} changes`}`,
        icon: floppyDiskIcon,
        shortcut: "⌘S",
      },
      { value: "discard", label: "Drop the changes", icon: xIcon }
    );
  }
  actions.push({
    value: "theme",
    label: theme.resolvedTheme === "dark" ? "Light mode" : "Dark mode",
    icon: moonIcon,
    keywords: ["theme", "dark", "light"],
  });
  groups.push({ heading: "Actions", items: actions });
  return groups;
});

function run(value: string) {
  if (value === "row" && byKey) {
    navigate(byKey.model.name, {
      where: { [byKey.field.name]: byKey.value },
      label: `${byKey.model.name} ${byKey.typed}`,
    });
  } else if (value.startsWith("go:")) go(value.slice(3));
  else if (value.startsWith("model:")) navigate(value.slice(6));
  else if (value.startsWith("view:")) {
    const view = views?.find(value.slice(5));
    if (view)
      go(
        `#/data/${encodeURIComponent(view.model)}?view=${encodeURIComponent(view.id)}`
      );
  } else if (value === "save") changes?.save();
  else if (value === "discard") changes?.discard();
  else if (value === "theme")
    theme.theme = theme.resolvedTheme === "dark" ? "light" : "dark";
  search = "";
}
</script>

<Command
  dialog
  shortcut="k"
  bind:open
  bind:search
  {items}
  placeholder="Go to a model, a view, or a row (user 7)…"
  onSelect={run}
>
  {#snippet footer()}
    <div class="flex items-center gap-3 border-t border-neutral-muted px-3 py-2 text-xs text-neutral/60">
      <span class="inline-flex items-center gap-1">{@render magnifyingGlassIcon({ size: 12 })} A model and a key opens that row</span>
      <span class="ml-auto">↵ Open · Esc Close</span>
    </div>
  {/snippet}
</Command>
