// Reports which OAuth providers an installer can offer without blocking community packages.
const providers = [
  ["Gmail", "BHARGA_GMAIL_CLIENT_ID"],
  ["Microsoft", "BHARGA_MS_CLIENT_ID"],
];

const enabled = providers
  .filter(([, field]) => process.env[field]?.trim())
  .map(([provider]) => provider);
const disabled = providers
  .filter(([, field]) => !process.env[field]?.trim())
  .map(([provider]) => provider);

if (disabled.length === 0) {
  console.log("Official package: Gmail and Microsoft sign-in enabled.");
} else {
  const enabledSummary = enabled.length > 0
    ? `${enabled.join(" and ")} sign-in enabled; `
    : "";
  console.log(
    `Community package: ${enabledSummary}${disabled.join(" and ")} sign-in disabled. `
      + "IMAP/SMTP remains available; forks and managed builds can inject public OAuth client IDs.",
  );
}
