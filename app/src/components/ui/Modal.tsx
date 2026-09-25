import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "@/components/icons";
import { containTabKey, focusableElements } from "@/lib/focus";
import { registerOpenModal } from "@/lib/modalStack";
import { OVERLAY_FADE, useMotionTransition } from "@/lib/motion";

interface CommonProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  returnFocus?: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
}

type AccessibleName =
  | { title: string; ariaLabel?: never }
  | { title?: never; ariaLabel: string };

type Props = CommonProps & AccessibleName;

// Centered modal dialog with backdrop, scroll-lock, and Esc-to-close.
export function Modal({ open, onClose, title, ariaLabel, children, maxWidth = 640, returnFocus, fallbackFocus }: Props) {
  const overlayTransition = useMotionTransition(OVERLAY_FADE);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    openerRef.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    document.body.style.overflow = "hidden";
    const unregisterModal = registerOpenModal();
    const panel = panelRef.current;
    const initialFocus = panel ? focusableElements(panel)[0] ?? panel : null;
    initialFocus?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.target instanceof HTMLElement) {
          const listbox = e.target.closest<HTMLElement>('[role="listbox"]');
          const selectButton = listbox
            ? document.getElementById(listbox.dataset.selectOwner ?? "")
            : e.target.closest<HTMLElement>('[data-select-open="true"]');
          if (selectButton) {
            e.preventDefault();
            e.stopImmediatePropagation();
            selectButton.click();
            selectButton.focus();
            return;
          }
        }
        e.preventDefault();
        onCloseRef.current();
      } else if (panelRef.current) {
        containTabKey(e, panelRef.current);
      }
    };
    // Capture Escape before global shortcut handlers can synchronously rerender
    // the tree and unregister this dialog's listener during the same event.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prev;
      unregisterModal();
      window.removeEventListener("keydown", onKey, true);
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      else if (fallbackFocus?.isConnected) fallbackFocus.focus();
      openerRef.current = null;
    };
  }, [fallbackFocus, open, returnFocus]);

  const close = () => onCloseRef.current();

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={overlayTransition}
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <motion.div
            ref={panelRef}
            className="modal-panel glass-card"
            style={{ maxWidth }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : ariaLabel}
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={overlayTransition}
          >
            {title && (
              <div className="modal-head">
                <b id={titleId}>{title}</b>
                <button className="iconbtn" type="button" aria-label="Close dialog" onClick={close} title="Close"><Icon name="close" /></button>
              </div>
            )}
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
