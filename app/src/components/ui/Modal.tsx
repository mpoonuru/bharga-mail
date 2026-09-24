import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "@/components/icons";
import { containTabKey, focusableElements } from "@/lib/focus";
import { OVERLAY_FADE, useMotionTransition } from "@/lib/motion";

interface CommonProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}

type AccessibleName =
  | { title: string; ariaLabel?: never }
  | { title?: never; ariaLabel: string };

type Props = CommonProps & AccessibleName;

// Centered modal dialog with backdrop, scroll-lock, and Esc-to-close.
export function Modal({ open, onClose, title, ariaLabel, children, maxWidth = 640 }: Props) {
  const overlayTransition = useMotionTransition(OVERLAY_FADE);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const initialFocus = panel ? focusableElements(panel)[0] ?? panel : null;
    initialFocus?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (panelRef.current) {
        containTabKey(e, panelRef.current);
      }
    };
    // Capture Escape before global shortcut handlers can synchronously rerender
    // the tree and unregister this dialog's listener during the same event.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey, true);
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      openerRef.current = null;
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={overlayTransition}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
                <button className="iconbtn" type="button" aria-label="Close dialog" onClick={onClose} title="Close"><Icon name="close" /></button>
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
