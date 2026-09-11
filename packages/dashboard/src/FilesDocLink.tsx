import type { JSX, ReactNode, MouseEvent } from "react";
import { cn } from "@/lib/utils";
import {
  filesArtifactHref,
  handleFilesDeepLinkClick,
} from "./filesDeepLink";

export type FilesDocLinkProps = {
  workspaceId: string;
  path: string;
  children: ReactNode;
  className?: string;
  title?: string;
};

/** Same-origin Files deep link that navigates in-SPA on primary click. */
export function FilesDocLink({
  workspaceId,
  path,
  children,
  className,
  title,
}: FilesDocLinkProps): JSX.Element {
  const href = filesArtifactHref(workspaceId, path);
  return (
    <a
      className={cn(
        "text-primary underline-offset-2 hover:underline",
        className
      )}
      href={href}
      title={title ?? path}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        e.stopPropagation();
        handleFilesDeepLinkClick(e, href);
      }}
    >
      {children}
    </a>
  );
}
