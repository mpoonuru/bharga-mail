// Single account-onboarding surface shared by Sidebar and Settings.
import { useEffect, useRef, useState } from "react";

import { AccountForm } from "@/components/AccountForm";
import { Icon } from "@/components/icons";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/bridge";
import { toMailConnectionError } from "@/lib/mailProviders";
import { useApp } from "@/store";
import type {
  MailConnectionError,
  MailProviderCapability,
  MailProviderKind,
} from "@/types";

const PROVIDER_ORDER: MailProviderKind[] = ["gmail", "microsoft", "imap"];
const PROVIDER_COPY = {
  gmail: {
    title: "Continue with Google",
    ready: "Sign in securely in your browser",
    icon: "cloud",
  },
  microsoft: {
    title: "Continue with Microsoft",
    ready: "Microsoft 365 and Outlook accounts",
    icon: "cloud",
  },
  imap: {
    title: "Other IMAP / SMTP",
    ready: "Enter incoming and outgoing mail servers",
    icon: "server",
  },
} as const;

function unavailableCopy(capability: MailProviderCapability): string {
  if (capability.reason === "desktop_required") return "Desktop app required";
  if (capability.reason === "build_not_configured") return "Not configured in this build";
  return "Unavailable";
}

function unavailableCapability(provider: MailProviderKind): MailProviderCapability {
  return {
    provider,
    available: false,
    configured: false,
    reason: "unsupported",
  };
}

export function AccountConnectorDialog() {
  const open = useApp((state) => state.accountConnectorOpen);
  const opener = useApp((state) => state.accountConnectorOpener);
  const close = useApp((state) => state.closeAccountConnector);
  const connectGmail = useApp((state) => state.connectGmail);
  const connectMicrosoft = useApp((state) => state.connectMicrosoft);
  const load = useApp((state) => state.load);
  const setAccount = useApp((state) => state.setAccount);
  const [screen, setScreen] = useState<"chooser" | "imap">("chooser");
  const [capabilities, setCapabilities] = useState<MailProviderCapability[] | null>(null);
  const [pending, setPending] = useState<Exclude<MailProviderKind, "imap"> | null>(null);
  const [error, setError] = useState<MailConnectionError | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [status, setStatus] = useState("");
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setScreen("chooser");
    setCapabilities(null);
    setError(null);
    setCapabilityError(false);
    void api.listMailProviderCapabilities()
      .then((next) => {
        if (active) setCapabilities(next);
      })
      .catch(() => {
        if (!active) return;
        setCapabilities(PROVIDER_ORDER.map(unavailableCapability));
        setCapabilityError(true);
      });
    return () => {
      active = false;
    };
  }, [open]);

  async function connect(provider: "gmail" | "microsoft") {
    if (pendingRef.current) return;
    const capability = capabilities?.find((candidate) => candidate.provider === provider);
    if (!capability?.available) return;
    pendingRef.current = true;
    setPending(provider);
    setError(null);
    try {
      const accountId = provider === "gmail"
        ? await connectGmail()
        : await connectMicrosoft();
      await load();
      setAccount(accountId);
      setStatus("Account connected.");
      close();
    } catch (cause) {
      const failure = toMailConnectionError(cause);
      if (failure.code === "initial_sync_failed" && failure.accountId) {
        try {
          await load();
          setAccount(failure.accountId);
          setStatus(failure.message);
          close();
        } catch {
          setError(failure);
        }
        return;
      }
      if (failure.code !== "cancelled") setError(failure);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  const fallbackFocus = typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-account-connector-fallback='true']")
      ?? document.querySelector<HTMLElement>(".compose-btn");

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        title={screen === "chooser" ? "Add mail account" : "Add IMAP / SMTP account"}
        maxWidth={560}
        returnFocus={opener}
        fallbackFocus={fallbackFocus}
      >
        {screen === "chooser" ? (
          <>
            <div className="account-connector-list">
              {PROVIDER_ORDER.map((provider) => {
                const capability = capabilities?.find((candidate) => candidate.provider === provider)
                  ?? unavailableCapability(provider);
                const copy = PROVIDER_COPY[provider];
                const isPending = pending === provider;
                return (
                  <button
                    key={provider}
                    type="button"
                    disabled={!capability.available || pending !== null || capabilities === null}
                    aria-busy={isPending || undefined}
                    onClick={() => {
                      if (provider === "imap") setScreen("imap");
                      else void connect(provider);
                    }}
                  >
                    <Icon name={copy.icon} size={20} />
                    <span>
                      <b>{copy.title}</b>
                      <small>
                        {isPending
                          ? "Waiting for secure sign-in…"
                          : capability.available
                            ? copy.ready
                            : unavailableCopy(capability)}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
            {capabilityError && (
              <div className="settings-alert error" role="alert">
                Update Bharga Mail to configure account providers.
              </div>
            )}
            {error && <div className="settings-alert error" role="alert">{error.message}</div>}
          </>
        ) : (
          <AccountForm
            onClose={() => setScreen("chooser")}
            onStatus={(message) => {
              setStatus(message);
              close();
            }}
          />
        )}
      </Modal>
      <span className="sr-only" role="status" aria-live="polite">{status}</span>
    </>
  );
}
