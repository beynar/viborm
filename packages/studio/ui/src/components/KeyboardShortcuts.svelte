<script lang="ts">
import { Button } from "entasis/button";
import { Dialog } from "entasis/dialog";
import { keyboardIcon } from "entasis/icons/keyboard";

let open = $state(false);
const shortcuts = [
  ["⌘ / Ctrl K", "Find a model, view, query or row"],
  ["⌘ / Ctrl S", "Save staged changes"],
  ["⌘ / Ctrl Z", "Undo an editing action outside a text field"],
  ["⌘ / Ctrl Shift Z", "Redo"],
  ["⌘ / Ctrl C", "Copy the focused cell or selected rows"],
  ["⌘ / Ctrl V", "Paste a rectangle starting at the focused cell"],
  ["Enter / double-click", "Edit a cell"],
  ["Escape", "Cancel an editor or close a popup"],
  ["Arrow keys", "Move between cells"],
  ["⌘ / Ctrl Enter", "Run query code"],
];
function keys(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "/") {
    event.preventDefault();
    open = !open;
  }
}
</script>
<svelte:window onkeydown={keys} />
<Button size="small" variant="ghost" squared prefix={keyboardIcon} label="Keyboard shortcuts" onclick={() => open = true} />
<Dialog bind:open title="Keyboard shortcuts">
  <dl class="m-0 grid gap-3 text-sm">{#each shortcuts as [key, action]}<div class="flex justify-between gap-5"><dt>{action}</dt><dd class="m-0 shrink-0 font-mono text-xs text-neutral/65">{key}</dd></div>{/each}</dl>
</Dialog>
