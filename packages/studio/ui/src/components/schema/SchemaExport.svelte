<script lang="ts">
import { getNodesBounds, Panel, useSvelteFlow } from "@xyflow/svelte";
import { Button } from "entasis/button";
import { downloadSimpleIcon } from "entasis/icons/downloadSimple";
import { Popover } from "entasis/popover";
import { toast } from "entasis/toast";
import { toPng, toSvg } from "html-to-image";

// The diagram as a picture, PNG or SVG, every card in it whatever the view, at its own size: drawn from the canvas's
// viewport (cards, lines, their crow's feet), moved for the copy to frame the cards' bounds with a margin. The page's
// colours come along.
let { name }: { name: string } = $props();
const flow = useSvelteFlow();
const MARGIN = 48;

async function save(format: "png" | "svg") {
  const viewport = document.querySelector<HTMLElement>(
    ".schema .svelte-flow__viewport"
  );
  if (!viewport) return;
  const bounds = getNodesBounds(flow.getNodes());
  const width = Math.ceil(bounds.width + MARGIN * 2);
  const height = Math.ceil(bounds.height + MARGIN * 2);

  const background = getComputedStyle(
    viewport.closest(".schema")!
  ).backgroundColor;
  // The copy takes each element's computed style, but not an SVG shape's: the lines and their ends would lose their
  // stroke. Each shape holds its own for the time of the copy.
  const shapes = [
    ...viewport.querySelectorAll<SVGElement>("path, circle, line, polyline"),
  ].map((shape) => {
    const before = shape.getAttribute("style");
    const computed = getComputedStyle(shape);
    shape.setAttribute(
      "style",
      [
        before ?? "",
        `stroke:${computed.stroke}`,
        `stroke-width:${computed.strokeWidth}`,
        `stroke-dasharray:${computed.strokeDasharray}`,
        `stroke-linecap:${computed.strokeLinecap}`,
        `fill:${computed.fill}`,
        `opacity:${computed.opacity}`,
      ].join(";")
    );
    return { shape, before };
  });
  try {
    const draw = format === "png" ? toPng : toSvg;
    const url = await draw(viewport, {
      width,
      height,
      backgroundColor: background,
      pixelRatio: 2,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${MARGIN - bounds.x}px, ${MARGIN - bounds.y}px) scale(1)`,
      },
    });
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.${format}`;
    link.click();
  } catch (error) {
    toast.danger({
      title: "The diagram could not be drawn",
      description: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const { shape, before } of shapes) {
      if (before === null) shape.removeAttribute("style");
      else shape.setAttribute("style", before);
    }
  }
}
</script>

<Panel position="top-right">
  <Popover position="bottom-end">
    {#snippet trigger(popover)}
      <Button variant="outline" size="small" prefix={downloadSimpleIcon} {@attach popover.trigger}>Export</Button>
    {/snippet}
    {#snippet children(popover)}
      <div class="grid gap-1">
        <p class="m-0 px-2 pb-1 text-[12px] text-neutral/60">Every model, as the diagram stands</p>
        <Button size="small" variant="ghost" onclick={() => (save('png'), popover.close())}>Export as PNG</Button>
        <Button size="small" variant="ghost" onclick={() => (save('svg'), popover.close())}>Export as SVG</Button>
      </div>
    {/snippet}
  </Popover>
</Panel>
