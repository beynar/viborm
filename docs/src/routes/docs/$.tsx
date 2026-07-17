import browserCollections from "fumadocs-mdx:collections/browser";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type * as PageTree from "fumadocs-core/page-tree";
import * as TabsComponents from "fumadocs-ui/components/tabs";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { useMemo } from "react";
import { Mermaid } from "@/components/mermaid";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const legacyDriverPath = legacyDriverPaths[params._splat ?? ""];
    if (legacyDriverPath) {
      throw redirect({ href: legacyDriverPath, statusCode: 308 });
    }

    const slugs = params._splat?.split("/") ?? [];
    const data = await loader({ data: slugs });
    await clientLoader.preload(data.path);
    return data;
  },
});

const legacyDriverPaths: Record<string, string> = {
  "drivers/pg": "/docs/drivers/postgresql/pg",
  "drivers/postgres": "/docs/drivers/postgresql/postgres",
  "drivers/pglite": "/docs/drivers/postgresql/pglite",
  "drivers/neon-http": "/docs/drivers/postgresql/neon-http",
  "drivers/bun-sql": "/docs/drivers/postgresql/bun-sql",
  "drivers/mysql2": "/docs/drivers/mysql/mysql2",
  "drivers/planetscale": "/docs/drivers/mysql/planetscale",
  "drivers/sqlite3": "/docs/drivers/sqlite/sqlite3",
  "drivers/libsql": "/docs/drivers/sqlite/libsql",
  "drivers/bun-sqlite": "/docs/drivers/sqlite/bun-sqlite",
  "drivers/d1": "/docs/drivers/sqlite/d1",
};

const loader = createServerFn({
  method: "GET",
})
  .inputValidator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      tree: source.pageTree as object,
      path: page.path,
    };
  });

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX
            components={{
              Mermaid,
              ...defaultMdxComponents,
              ...TabsComponents,
            }}
          />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const data = Route.useLoaderData();
  const content = clientLoader.useContent(data.path);
  const tree = useMemo(
    () => transformPageTree(data.tree as PageTree.Root),
    [data.tree]
  );

  return (
    <DocsLayout {...baseOptions()} tree={tree}>
      {content}
    </DocsLayout>
  );
}

function transformPageTree(root: PageTree.Root): PageTree.Root {
  function mapNode<T extends PageTree.Node>(item: T): T {
    if (typeof item.icon === "string") {
      item = {
        ...item,
        icon: (
          <span
            dangerouslySetInnerHTML={{
              __html: item.icon,
            }}
          />
        ),
      };
    }

    if (item.type === "folder") {
      return {
        ...item,
        index: item.index ? mapNode(item.index) : undefined,
        children: item.children.map(mapNode),
      };
    }

    return item;
  }

  return {
    ...root,
    children: root.children.map(mapNode),
    fallback: root.fallback ? transformPageTree(root.fallback) : undefined,
  };
}
