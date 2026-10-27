// The diagram and the rows table scroll inside themselves, so each needs a
// definite height: from where it starts down to the page's sticky footer (or
// the page's end), measured as the page shell lays them out.
import type { Attachment } from "svelte/attachments";

export const fillPage: Attachment<HTMLElement> = (element) => {
  let frame = 0;
  const measure = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      element.style.height = "";
      const page = element.closest<HTMLElement>("[data-slot=page-shell]");
      const footer = page?.querySelector<HTMLElement>(
        "[data-slot=page-shell-footer]"
      );
      const bottom = Math.min(
        page?.getBoundingClientRect().bottom ?? innerHeight,
        innerHeight
      );
      const height =
        bottom -
        (footer?.offsetHeight ?? 0) -
        element.getBoundingClientRect().top;
      element.style.height = `${Math.max(240, Math.floor(height))}px`;
    });
  };
  measure();
  addEventListener("resize", measure);
  const resized = new ResizeObserver(measure);
  const page = element.closest("[data-slot=page-shell]");
  for (const part of page?.querySelectorAll(
    "[data-slot=page-shell-header], [data-slot=page-shell-footer]"
  ) ?? []) {
    resized.observe(part);
  }
  return () => {
    cancelAnimationFrame(frame);
    removeEventListener("resize", measure);
    resized.disconnect();
  };
};
