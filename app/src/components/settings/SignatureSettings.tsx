// Signature destination wrapper keeps rich editing separate from other settings.
import { SignatureManager } from "@/components/SignatureManager";

export function SignatureSettings() {
  return (
    <div className="settings-section">
      <h2>Signatures</h2>
      <p className="sub">Create reusable rich-text signatures and choose the default for new mail and replies.</p>
      <div className="settings-group settings-group-padded">
        <SignatureManager />
      </div>
    </div>
  );
}
