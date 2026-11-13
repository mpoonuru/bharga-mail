import dayjs from "dayjs";
import { Icon } from "@/components/icons";
import { useApp } from "@/store";
import type { OutgoingMessage } from "@/types";

function draftStatus(draft: OutgoingMessage) {
  if (draft.status === "dead") return "Failed";
  if (draft.status === "sending") return "Sending";
  return dayjs.unix(draft.scheduledTs).isAfter(dayjs()) ? "Scheduled" : "Retrying";
}

export function DraftsView() {
  const { outbox, deadLetters, accounts, openDraft, retryDeadLetter, discardDeadLetter } = useApp();
  const drafts = [...outbox, ...deadLetters].sort((a, b) => b.scheduledTs - a.scheduledTs);

  return (
    <div className="drafts-page">
      <h1>Drafts</h1>
      <p className="sub">Outgoing messages saved on this Mac, including sends awaiting retry.</p>
      {drafts.length === 0 ? (
        <div className="settings-empty">No outgoing drafts.</div>
      ) : (
        <div className="draft-list">
          {drafts.map((draft) => {
            const status = draftStatus(draft);
            const failed = draft.status === "dead";
            const account = accounts.find((candidate) => candidate.id === draft.accountId);
            return (
              <article className="draft-row" key={`${draft.status}:${draft.id}`}>
                <button
                  type="button"
                  className="draft-open"
                  disabled={draft.status === "sending"}
                  onClick={() => openDraft(draft)}
                >
                  <span className="draft-row-head">
                    <b>{draft.subject || "(No subject)"}</b>
                    <span className={`draft-status${failed ? " failed" : ""}`}>{status}</span>
                  </span>
                  <span className="draft-recipient">To: {draft.to}</span>
                  <span className="draft-meta">
                    {account?.email ?? draft.accountId} ·{" "}
                    {dayjs(draft.scheduledTs * 1000).format("MMM D, HH:mm")}
                    {draft.attachments.length > 0 &&
                      ` · ${draft.attachments.length} attachment${draft.attachments.length === 1 ? "" : "s"}`}
                  </span>
                  {draft.error && <span className="draft-error">{draft.error}</span>}
                </button>
                {failed && (
                  <div className="draft-actions">
                    <button
                      type="button"
                      className="af-btn ghost"
                      onClick={() => void retryDeadLetter(draft.id)}
                    >
                      <Icon name="reply" size={13} /> Retry
                    </button>
                    <button
                      type="button"
                      className="af-btn ghost"
                      onClick={() => void discardDeadLetter(draft.id)}
                    >
                      <Icon name="trash" size={13} /> Discard
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
