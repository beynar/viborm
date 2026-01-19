// Import raw MDX content from virtual module that bundles all content at build time
import rawContent from "virtual:raw-mdx-content";

export function getRawContent(slugs: string[]): string | null {
  const basePath = slugs.join("/");

  // Try different path patterns
  const patterns = [
    `/content/docs/${basePath}.mdx`,
    `/content/docs/${basePath}/index.mdx`,
  ];

  for (const pattern of patterns) {
    const content = rawContent[pattern];
    if (content) {
      return content;
    }
  }

  return null;
}

// Export all available paths for debugging
export function getAvailablePaths(): string[] {
  return Object.keys(rawContent);
}
