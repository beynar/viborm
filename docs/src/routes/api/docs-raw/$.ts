import { createFileRoute } from "@tanstack/react-router";
// import { getAvailablePaths } from "@/lib/raw-content";

export const Route = createFileRoute("/api/docs-raw/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = params._splat?.split("/").filter(Boolean) ?? [];

        // Debug: list available paths
        // if (slugs[0] === "_debug") {
        //   const paths = getAvailablePaths();
        //   return new Response(JSON.stringify(paths, null, 2), {
        //     headers: { "Content-Type": "application/json" },
        //   });
        // }

        const content = "lekazlkea";

        if (!content) {
          return new Response(`Not found: ${slugs.join("/")}`, { status: 404 });
        }

        return new Response(content, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
