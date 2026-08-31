import { cp, mkdir } from "node:fs/promises";

const generatedFiles = [
  "agent-readability.json",
  "llms-full.txt",
  "llms.txt",
  "robots.txt",
  "sitemap.xml",
];

await Promise.all(
  generatedFiles.map((file) => cp(`dist/${file}`, `dist/client/${file}`))
);

await mkdir("dist/client/.well-known", { recursive: true });
await cp("dist/.well-known/api-catalog", "dist/client/.well-known/api-catalog");
