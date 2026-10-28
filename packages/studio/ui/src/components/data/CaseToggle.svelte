<script lang="ts">
import { Button } from "entasis/button";

// The "Aa" toggle beside a text search or condition: pressed, the client's `mode: "insensitive"` folds ASCII
// letters, on every database alike.
let {
  value,
  onValueChange,
}: { value: boolean; onValueChange: (value: boolean) => void } = $props();
</script>

<Button
  size="small"
  variant={value ? "soft" : "ghost"}
  squared
  label={value ? "Ignoring case (A = a)" : "Matching case (A ≠ a)"}
  pressed={value}
  onclick={() => onValueChange(!value)}
>
  <span class="text-[12px] font-semibold {value ? '' : 'text-neutral/55'}">Aa</span>
</Button>
