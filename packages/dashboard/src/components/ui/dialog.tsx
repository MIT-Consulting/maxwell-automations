"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Modal dialogs set `body { pointer-events: none }` and only the dialog
 * layer re-enables them. Portaled Select / Popover live outside
 * Dialog.Content, so clicks on those layers look like "outside" interacts.
 * Only treat a true backdrop (overlay) click as dismiss — and never while a
 * nested layer is open (dismissing a Select would otherwise click-through to
 * the overlay and close the whole dialog).
 *
 * Select also sets `pointer-events: none` on Dialog.Content while open, so
 * "click off the menu" lands on the overlay. Select may unmount before the
 * dialog's outside handler runs; a capture-phase timestamp covers that race.
 */
function isDialogOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest('[data-slot="dialog-overlay"]'))
    : false
}

const NESTED_LAYER_SELECTOR = [
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
].join(",")

/** Ignore dialog outside-dismiss briefly after a nested-layer pointerdown. */
let suppressOutsideDismissUntil = 0
let nestedLayerGuardInstalled = false

function hasOpenNestedLayer(): boolean {
  return Boolean(document.querySelector(NESTED_LAYER_SELECTOR))
}

function ensureNestedLayerGuard(): void {
  if (nestedLayerGuardInstalled || typeof document === "undefined") return
  nestedLayerGuardInstalled = true
  const bump = (): void => {
    if (hasOpenNestedLayer()) {
      suppressOutsideDismissUntil = Date.now() + 800
    }
  }
  document.addEventListener("pointerdown", bump, true)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") bump()
  }, true)
}

function outsideEventTarget(
  event: { target: EventTarget | null; detail?: { originalEvent?: Event } }
): EventTarget | null {
  return event.detail?.originalEvent?.target ?? event.target
}

/** True when this outside event should dismiss the dialog (backdrop only). */
function shouldDismissOnOutside(target: EventTarget | null): boolean {
  ensureNestedLayerGuard()
  if (Date.now() < suppressOutsideDismissUntil) return false
  if (hasOpenNestedLayer()) return false
  return isDialogOverlayTarget(target)
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onPointerDownOutside,
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className
        )}
        onPointerDownOutside={(event) => {
          if (!shouldDismissOnOutside(outsideEventTarget(event))) {
            event.preventDefault()
          }
          onPointerDownOutside?.(event)
        }}
        onInteractOutside={(event) => {
          if (!shouldDismissOnOutside(outsideEventTarget(event))) {
            event.preventDefault()
          }
          onInteractOutside?.(event)
        }}
        onEscapeKeyDown={(event) => {
          ensureNestedLayerGuard()
          // Escape / Android back often hits the dialog after the Select
          // already closed — keep the dialog up for that beat.
          if (
            hasOpenNestedLayer() ||
            Date.now() < suppressOutsideDismissUntil
          ) {
            event.preventDefault()
          }
          onEscapeKeyDown?.(event)
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
