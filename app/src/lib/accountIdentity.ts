// Central account-identity rules keep multi-account sending deterministic and fail closed.
import type { Account } from "@/types";

export interface SendAccountResolution {
  accounts: Account[];
  explicitId?: string;
  threadAccountId?: string;
  selectedId?: string | null;
}

export interface ReplyRecipientInput {
  self: string;
  sender: string;
  to: string[];
  cc: string[];
}

export function accountAddress(accounts: Account[], accountId: string): string {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new Error("The message account is no longer connected.");
  return account.email.trim().toLowerCase();
}

export function resolveSendAccountId(input: SendAccountResolution): string {
  const candidate = input.explicitId
    ?? input.threadAccountId
    ?? input.selectedId
    ?? (input.accounts.length === 1 ? input.accounts[0].id : undefined);
  if (!candidate) throw new Error("Choose a connected account before sending.");
  if (!input.accounts.some((account) => account.id === candidate)) {
    throw new Error("The selected sending account is no longer connected.");
  }
  return candidate;
}

export function replyRecipients(input: ReplyRecipientInput): { to: string; cc: string } {
  const self = input.self.trim().toLowerCase();
  const seen = new Set<string>();
  const unique = (values: string[]) => values.filter((value) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === self || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  const to = unique([input.sender, ...input.to]);
  const cc = unique(input.cc);
  return { to: to.join(", "), cc: cc.join(", ") };
}
