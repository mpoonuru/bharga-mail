// Normalizes native provider failures without exposing raw OAuth or transport data.
import type {
  MailConnectionError,
  MailConnectionErrorCode,
} from "@/types";

const ERROR_CODES: ReadonlySet<MailConnectionErrorCode> = new Set([
  "not_configured",
  "cancelled",
  "offline",
  "consent_denied",
  "tenant_restricted",
  "redirect_mismatch",
  "credential_rejected",
  "provider_unavailable",
  "initial_sync_failed",
  "unexpected",
]);

const FALLBACK: MailConnectionError = {
  code: "unexpected",
  message: "The account could not be connected. Try again.",
  retryable: true,
};

export function toMailConnectionError(error: unknown): MailConnectionError {
  if (!error || typeof error !== "object") return FALLBACK;
  const candidate = error as Partial<MailConnectionError>;
  if (
    typeof candidate.code !== "string"
    || !ERROR_CODES.has(candidate.code as MailConnectionErrorCode)
    || typeof candidate.message !== "string"
    || typeof candidate.retryable !== "boolean"
  ) {
    return FALLBACK;
  }
  const accountId = candidate.code === "initial_sync_failed"
    && typeof candidate.accountId === "string"
    && candidate.accountId.trim().length > 0
    ? candidate.accountId
    : undefined;
  return {
    code: candidate.code as MailConnectionErrorCode,
    message: candidate.message,
    retryable: candidate.retryable,
    ...(accountId ? { accountId } : {}),
  };
}
