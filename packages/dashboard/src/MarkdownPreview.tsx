import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import {
  handleFilesDeepLinkClick,
  resolveMarkdownFilesLink,
  type MarkdownDocLinkContext,
} from "./filesDeepLink";

/** Exact class set the transcript's chat bubbles have always used. */
export const MD_CHAT_CLASS = cn(
  "text-[13px] leading-relaxed",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:pl-5",
  "[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline",
  "[&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:no-scrollbar [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-2.5",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-1.5 [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs"
);

const MD_DOCUMENT_CLASS = cn(
  "text-[15px] leading-relaxed",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold",
  "[&_h2]:mb-2.5 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold",
  "[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:pl-5",
  "[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline",
  "[&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]",
  "[&_pre]:no-scrollbar [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-3 [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-border [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-sm",
  "[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-sm"
);

export type MarkdownPreviewProps = {
  children: string;
  variant?: "chat" | "document";
  /** When set, relative markdown links resolve inside the Files view. */
  docLinkContext?: MarkdownDocLinkContext | null;
};

export function MarkdownPreview({
  children,
  variant = "chat",
  docLinkContext = null,
}: MarkdownPreviewProps): JSX.Element {
  return (
    <div className={variant === "document" ? MD_DOCUMENT_CLASS : MD_CHAT_CLASS}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren, node: _node, ...props }) => {
            const resolved =
              typeof href === "string"
                ? resolveMarkdownFilesLink(href, docLinkContext)
                : null;
            if (resolved) {
              return (
                <a
                  {...props}
                  href={resolved.href}
                  onClick={(e) => {
                    handleFilesDeepLinkClick(e, resolved.href);
                  }}
                >
                  {linkChildren}
                </a>
              );
            }
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
