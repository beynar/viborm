import { useState, useCallback } from "react";
import { twMerge } from "tailwind-merge";

interface CopyMarkdownButtonProps {
  slugs: string[];
  className?: string;
}

// Cache fetched content to avoid refetching
const cache = new Map<string, string>();

export function CopyMarkdownButton({ slugs, className }: CopyMarkdownButtonProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const handleCopy = useCallback(async () => {
    const cacheKey = slugs.join("/");
    setStatus("loading");

    try {
      let content = cache.get(cacheKey);

      if (!content) {
        const url = `/api/docs-raw/${slugs.join("/")}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Failed to fetch");
        content = await response.text();
        cache.set(cacheKey, content);
      }

      await navigator.clipboard.writeText(content);
      setStatus("success");

      setTimeout(() => setStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }, [slugs]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={status === "loading"}
      className={twMerge(
        "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
        "bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-3.5",
        className,
      )}
      aria-label="Copy page as Markdown"
    >
      {status === "idle" && (
        <>
          <CopyIcon />
          Copy Markdown
        </>
      )}
      {status === "loading" && (
        <>
          <LoadingIcon />
          Copying...
        </>
      )}
      {status === "success" && (
        <>
          <CheckIcon />
          Copied!
        </>
      )}
      {status === "error" && (
        <>
          <XIcon />
          Failed
        </>
      )}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg
      className="animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
