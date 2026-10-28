// Builds the studio app into ONE html document (scripts and styles inlined),
// which `tsdown.config.ts` embeds in the CLI-only studio chunk. `vite dev`
// serves it against a running `viborm studio` (VIBORM_STUDIO_URL).
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const outDir = resolve(root, "dist");

/** Replace the emitted script and stylesheet links by their contents. */
const inlineAssets = (): Plugin => ({
  name: "viborm-studio-inline",
  apply: "build",
  enforce: "post",
  generateBundle(_options, bundle) {
    const html = bundle["index.html"];
    if (!html || html.type !== "asset") return;
    let source = String(html.source);
    for (const [name, chunk] of Object.entries(bundle)) {
      if (chunk.type === "chunk") {
        source = source.replace(
          new RegExp(
            `<script type="module" crossorigin src="[^"]*${name}"></script>`
          ),
          () =>
            `<script type="module">${chunk.code.replaceAll("</script", "<\\/script")}</script>`
        );
        delete bundle[name];
      } else if (name.endsWith(".css")) {
        source = source.replace(
          new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${name}">`),
          () => `<style>${String(chunk.source)}</style>`
        );
        delete bundle[name];
      }
    }
    html.source = source;
  },
});

export default defineConfig({
  root,
  base: "./",
  plugins: [tailwindcss(), svelte(), inlineAssets()],
  // The embedded production HTML is output, not another development entry.
  optimizeDeps: { entries: [resolve(root, "index.html")] },
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
    rolldownOptions: {
      // An entasis icon module makes each weight with `icon(...)`: marked pure, the weights the app never renders
      // are dropped (the models' icons would otherwise bring six each).
      treeshake: { manualPureFunctions: ["icon"] },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: process.env.VIBORM_STUDIO_URL ?? "http://127.0.0.1:5577",
        changeOrigin: true,
        // The studio takes API calls from its own origin only.
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        },
      },
    },
  },
});
