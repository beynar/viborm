<script lang="ts">
import SchemaDiagram from "../components/schema/SchemaDiagram.svelte";
import { useStudio } from "../lib/studio-context";

const studio = useStudio();
</script>

{#if studio.schema}<SchemaDiagram schema={studio.schema} />{/if}
