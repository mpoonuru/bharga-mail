// Truthful local-data posture; avoids claiming full database encryption that is not implemented.
import { Icon } from "@/components/icons";

const SECURITY_FACTS = [
  {
    icon: "shieldCheck" as const,
    title: "Credentials",
    text: "Account and AI credentials are AES-256-GCM encrypted in the local database under one master key held by the operating system keychain.",
  },
  {
    icon: "server" as const,
    title: "Local mail data",
    text: "Synced message content and metadata are stored locally. The mail database is not currently claimed as fully encrypted at rest.",
  },
  {
    icon: "shieldWarning" as const,
    title: "Remote content",
    text: "Remote images are blocked by default to reduce tracking. You can load them explicitly for an individual message.",
  },
  {
    icon: "tasks" as const,
    title: "Telemetry",
    text: "Product analytics and telemetry are not enabled. Diagnostics are exported only when you explicitly copy or download them.",
  },
];

export function SecurityDataSettings() {
  return (
    <div className="settings-section">
      <h2>Security and data</h2>
      <p className="sub">Understand what is protected, what remains local, and where current boundaries are.</p>
      <div className="settings-group security-facts">
        {SECURITY_FACTS.map((fact) => (
          <div className="settings-row" key={fact.title}>
            <span className="security-fact-icon"><Icon name={fact.icon} size={17} /></span>
            <div><b>{fact.title}</b><p>{fact.text}</p></div>
          </div>
        ))}
      </div>
      <div className="settings-callout">Removing an account deletes its locally synced mail and encrypted credentials from this device; it does not delete server mail.</div>
    </div>
  );
}
