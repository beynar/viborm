/** Upgrade old bookmarks in-place before the router starts, without adding a history entry. */
export function legacyPath(url: URL): string | undefined {
  let upgraded = false;
  const target = new URL(url);
  if (url.hash.startsWith("#/")) {
    const path = url.hash.slice(1);
    // A fragment is a local route, never an authority or a network URL.
    if (path.startsWith("//") || path.includes("\\")) return undefined;
    const legacy = new URL(path, url.origin);
    target.pathname = legacy.pathname;
    target.search = legacy.search;
    target.hash = legacy.hash;
    upgraded = true;
  }
  const saved = target.searchParams.get("query");
  if (target.pathname === "/query" && saved) {
    target.pathname = `/query/${encodeURIComponent(saved)}`;
    target.searchParams.delete("query");
    upgraded = true;
  }
  // sv-router decodes dynamic segments; malformed escapes must not prevent mounting.
  try {
    decodeURI(target.pathname);
  } catch {
    return "/not-found";
  }
  return upgraded
    ? `${target.pathname}${target.search}${target.hash}`
    : undefined;
}
