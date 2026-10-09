import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";

export default defineConfig({
  title: "VibORM",
  description:
    "Type-safe ORM for PostgreSQL, MySQL, and SQLite with a Prisma-inspired API.",
  logo: {
    href: "/",
    text: "VibORM",
  },
  basePath: "/docs",
  content: {
    root: "content/docs",
  },
  github: {
    dir: "docs",
    owner: "beynar",
    repo: "viborm",
  },
  navigation: {
    sidebar: {
      display: "group",
    },
    tabs: [
      { label: "ORM", path: "/docs" },
      { label: "Extensions", path: "/extensions" },
      { label: "Internals", path: "/internals" },
    ],
  },
  redirects: [
    {
      from: "/client/extensions",
      to: "/extensions",
      status: 308,
    },
    { from: "/cache", to: "/extensions/cache", status: 308 },
    {
      from: "/cache/drivers",
      to: "/extensions/cache/drivers",
      status: 308,
    },
    {
      from: "/cache/drivers/cloudflare-kv",
      to: "/extensions/cache/drivers/cloudflare-kv",
      status: 308,
    },
    {
      from: "/cache/drivers/custom",
      to: "/extensions/cache/drivers/custom",
      status: 308,
    },
    {
      from: "/cache/drivers/memory",
      to: "/extensions/cache/drivers/memory",
      status: 308,
    },
    {
      from: "/instrumentation",
      to: "/extensions/instrumentation",
      status: 308,
    },
    {
      from: "/instrumentation/logging",
      to: "/extensions/instrumentation/logging",
      status: 308,
    },
    {
      from: "/instrumentation/tracing",
      to: "/extensions/instrumentation/tracing",
      status: 308,
    },
  ],
  deployment: cloudflare({
    output: "server",
    site: "https://viborm.dev",
  }),
  integrations: [
    {
      name: "viborm:build-resources",
      hooks: {
        "astro:config:setup": ({ command, updateConfig }) => {
          // Parallel page/OG rendering overlaps native allocations after bundling.
          updateConfig({ build: { concurrency: 1 } });
          if (command === "build") {
            updateConfig({
              vite: {
                plugins: [
                  {
                    name: "viborm:build-without-dev-prebundling",
                    configEnvironment: {
                      order: "post",
                      handler(name, config) {
                        if (name === "prerender") {
                          // Astro replaces environment build options before this
                          // hook. Only its discarded prerender bundle skips
                          // tree-shaking; the Worker and client stay optimized.
                          config.build = {
                            ...config.build,
                            rolldownOptions: {
                              ...config.build?.rolldownOptions,
                              treeshake: false,
                            },
                          };
                        }
                        // Astro's build-time content server adds dev entries
                        // after root defaults; clear each final environment.
                        // Production bundles already own these dependencies.
                        config.optimizeDeps = {
                          ...config.optimizeDeps,
                          noDiscovery: true,
                          include: [],
                        };
                      },
                    },
                  },
                ],
              },
            });
          }
        },
        "astro:config:done": ({ config, logger }) => {
          logger.info(`Prerender concurrency: ${config.build.concurrency}`);
        },
      },
    },
  ],
  agents: {
    agentReadability: true,
    llmsTxt: true,
    webmcp: true,
    mcp: {
      enabled: true,
      route: "/mcp",
      name: "VibORM MCP",
      instructions:
        "You are a helpful assistant that can help with VibORM questions.",
    },
  },
});
