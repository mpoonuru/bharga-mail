//! Compile-time public OAuth identifiers and truthful mail-provider readiness.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailProviderKind {
    Gmail,
    Microsoft,
    Imap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MailProviderCapabilityReason {
    Ready,
    BuildNotConfigured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailProviderCapability {
    pub provider: MailProviderKind,
    pub available: bool,
    pub configured: bool,
    pub reason: MailProviderCapabilityReason,
}

fn configured(value: Option<&str>) -> bool {
    value.is_some_and(|candidate| !candidate.trim().is_empty())
}

pub(crate) fn capabilities_from(
    gmail_client_id: Option<&str>,
    microsoft_client_id: Option<&str>,
) -> Vec<MailProviderCapability> {
    let oauth_capability = |provider, is_configured| MailProviderCapability {
        provider,
        available: is_configured,
        configured: is_configured,
        reason: if is_configured {
            MailProviderCapabilityReason::Ready
        } else {
            MailProviderCapabilityReason::BuildNotConfigured
        },
    };

    vec![
        oauth_capability(MailProviderKind::Gmail, configured(gmail_client_id)),
        oauth_capability(MailProviderKind::Microsoft, configured(microsoft_client_id)),
        MailProviderCapability {
            provider: MailProviderKind::Imap,
            available: true,
            configured: true,
            reason: MailProviderCapabilityReason::Ready,
        },
    ]
}

pub fn gmail_client_id() -> Option<&'static str> {
    option_env!("BHARGA_GMAIL_CLIENT_ID").filter(|candidate| !candidate.trim().is_empty())
}

pub fn microsoft_client_id() -> Option<&'static str> {
    option_env!("BHARGA_MS_CLIENT_ID").filter(|candidate| !candidate.trim().is_empty())
}

pub fn mail_provider_capabilities() -> Vec<MailProviderCapability> {
    capabilities_from(gmail_client_id(), microsoft_client_id())
}

#[cfg(test)]
mod tests {
    use super::{capabilities_from, MailProviderCapabilityReason};

    #[test]
    fn missing_or_blank_client_ids_fail_closed() {
        let capabilities = capabilities_from(None, Some("   "));
        assert!(!capabilities[0].available);
        assert!(!capabilities[0].configured);
        assert_eq!(
            capabilities[0].reason,
            MailProviderCapabilityReason::BuildNotConfigured
        );
        assert!(!capabilities[1].available);
    }

    #[test]
    fn non_empty_client_ids_enable_oauth_providers() {
        let capabilities = capabilities_from(Some("google-public-id"), Some("microsoft-public-id"));
        assert!(capabilities[0].available);
        assert!(capabilities[0].configured);
        assert!(capabilities[1].available);
        assert!(capabilities[1].configured);
        assert!(capabilities[2].available);
    }
}
