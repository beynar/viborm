<script lang="ts">
import { Button } from "entasis/button";
import { moonIcon } from "entasis/icons/moon";
import { sunIcon } from "entasis/icons/sun";
import { useTheme } from "entasis/theme";

// Light or dark, an icon in the sidebar's footer: the theme `Theme` holds, which it keeps across visits.
const theme = useTheme();
const dark = $derived(theme.resolvedTheme === "dark");
</script>

<Button size="small" variant="ghost" squared prefix={dark ? sunIcon : moonIcon} label={dark ? 'Light mode' : 'Dark mode'} onclick={() => (theme.theme = dark ? 'light' : 'dark')} />
