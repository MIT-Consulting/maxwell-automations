import type { ReactNode } from "react";
import { fetchAuthenticatedBlob } from "./api";
import { useAuthenticatedUrl } from "./useAuthenticatedUrl";
import { cn } from "@/lib/utils";

type AuthenticatedImageProps = {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** When true, wrap the image in a clickable open-in-new-tab control. */
  openable?: boolean;
  loading?: "lazy" | "eager";
};

/** `<img>` that loads same-origin `/api/...` paths with the control token. */
export function AuthenticatedImage({
  src,
  alt,
  className,
  imgClassName,
  openable = false,
  loading = "lazy",
}: AuthenticatedImageProps) {
  const { url, error, loading: fetching } = useAuthenticatedUrl(src);

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden bg-background px-2 py-6 text-xs text-muted-foreground",
          className
        )}
      >
        Failed to load image
      </div>
    );
  }

  if (!url || fetching) {
    return (
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden bg-background px-2 py-6 text-xs text-muted-foreground",
          className
        )}
      >
        Loading…
      </div>
    );
  }

  const image = (
    <img
      src={url}
      alt={alt}
      className={imgClassName ?? className}
      loading={loading}
    />
  );

  if (!openable) return image;

  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={className}>
      {image}
    </a>
  );
}

type AuthenticatedOpenLinkProps = {
  href: string;
  download?: string;
  className?: string;
  children: ReactNode;
};

/**
 * Open/download link for token-gated attachment paths. Fetches with the control
 * token, then opens a blob: URL (plain `<a href>` cannot send the header).
 */
export function AuthenticatedOpenLink({
  href,
  download,
  className,
  children,
}: AuthenticatedOpenLinkProps) {
  const isDirect =
    href.startsWith("blob:") ||
    href.startsWith("data:") ||
    href.startsWith("http://") ||
    href.startsWith("https://");

  if (isDirect) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        download={download}
        className={className}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cn("cursor-pointer border-none bg-transparent p-0", className)}
      onClick={() => {
        void (async () => {
          try {
            const blob = await fetchAuthenticatedBlob(href);
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = objectUrl;
            a.target = "_blank";
            a.rel = "noreferrer noopener";
            if (download) a.download = download;
            // Some browsers ignore clicks on detached anchors.
            document.body.appendChild(a);
            a.click();
            a.remove();
            // Revoke after the browser has a chance to start the navigation.
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
          } catch {
            /* auth callback / UI already surfaces 401s */
          }
        })();
      }}
    >
      {children}
    </button>
  );
}
