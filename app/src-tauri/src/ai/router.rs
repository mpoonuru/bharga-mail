//! Per-task model routing. Given a [`Role`] and the user's [`AiProfile`] +
//! [`Privacy`] preset, pick the model that should handle the task — with
//! graceful fallback when a model lacks a needed capability.

use super::{AiProfile, ModelConfig, Privacy, ProviderKind, Role};

pub struct Router<'a> {
    profile: &'a AiProfile,
}

impl<'a> Router<'a> {
    pub fn new(profile: &'a AiProfile) -> Self {
        Self { profile }
    }

    /// Resolve which model should run a given task.
    /// Honor explicit role assignment and the privacy preset. We deliberately
    /// do not fall back to another provider: silently moving mail content to a
    /// different cloud is a privacy boundary violation.
    pub fn resolve(&self, role: Role) -> Option<&'a ModelConfig> {
        self.profile
            .models
            .iter()
            .filter(|m| m.ready && m.roles.contains(&role))
            .find(|m| self.allowed(m))
    }

    fn allowed(&self, m: &ModelConfig) -> bool {
        let is_local = matches!(m.kind, ProviderKind::Local);
        match self.profile.privacy {
            Privacy::Local => is_local,
            Privacy::Cloud | Privacy::Hybrid => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::default_profile;

    #[test]
    fn local_preset_rejects_a_cloud_only_assignment() {
        let mut p = default_profile();
        p.privacy = Privacy::Local;
        for m in &mut p.models {
            m.ready = true;
        }
        let r = Router::new(&p);
        assert!(r.resolve(Role::Draft).is_none());
    }

    #[test]
    fn hybrid_prefers_assigned_model() {
        let mut p = default_profile();
        for m in &mut p.models {
            m.ready = true;
        }
        let r = Router::new(&p);
        let m = r.resolve(Role::Triage).expect("a model");
        assert_eq!(m.id, "llama");
    }

    #[test]
    fn unavailable_assignment_does_not_fall_back_to_another_cloud_provider() {
        let mut p = default_profile();
        let assigned = p
            .models
            .iter_mut()
            .find(|model| model.id == "claude")
            .unwrap();
        assigned.ready = false;
        let mut fallback = assigned.clone();
        fallback.id = "other-cloud".into();
        fallback.ready = true;
        fallback.roles.clear();
        p.models.push(fallback);

        assert!(Router::new(&p).resolve(Role::Draft).is_none());
    }
}
