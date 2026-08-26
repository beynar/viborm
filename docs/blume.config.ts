import { defineConfig } from "blume";

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
  ],
  deployment: {
    output: "server",
    adapter: "cloudflare",
    site: "https://viborm.dev",
  },
  ai: {
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
  seo: {
    agentReadability: true,
  },
});
