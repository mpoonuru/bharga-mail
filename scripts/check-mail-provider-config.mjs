// Fails official packaging when public desktop OAuth identifiers are absent.
const required = ["BHARGA_GMAIL_CLIENT_ID", "BHARGA_MS_CLIENT_ID"];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error("Missing required release fields: " + missing.join(", "));
  process.exit(1);
}

console.log("Mail provider release configuration is present.");
