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
      {label:"Documentation", path:"/docs"},
      {label:"Internal", path:"/internals"},
    ]
  },
  redirects: [
    // {
    //   from: "/",
    //   to: "/docs",
    //   status: 308,
    // } 
  ],
  deployment: {
  output: "server",
  adapter: "cloudflare", // or "vercel" | "netlify" | "cloudflare"
  site: "https://viborm.com",
},
  ai:{
    llmsTxt:true,
    webmcp:true,
    mcp:{
      enabled:true,
      route:"/mcp",
      name:"VibORM MCP",
      instructions:"You are a helpful assistant that can help with VibORM questions.",
    },
  },
  seo: {
 
    agentReadability: true,
}
});
