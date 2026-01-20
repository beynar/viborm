/// <reference types="vite/client" />

declare module "virtual:raw-mdx-content" {
  const content: Record<string, string>;
  export default content;
}
