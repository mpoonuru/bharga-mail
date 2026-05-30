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
    /// 1. honor explicit role assignment, 2. respect the privacy preset,
    /// 3. fall back to any ready model that can do the job.
    pub fn resolve(&self, role: Role) -> Option<&'a ModelConfig> {
        let assigned = self
            .profile
            .models
            .iter()
            .filter(|m| m.ready && m.roles.contains(&role))
            .find(|m| self.allowed(m));
        if assigned.is_some() {
            return assigned;
        }
        // fallback: any ready, privacy-allowed model
        self.profile.models.iter().find(|m| m.ready && self.allowed(m))
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
    fn local_preset_only_routes_to_local_models() {
        let mut p = default_profile();
        p.privacy = Privacy::Local;
        for m in &mut p.models {
            m.ready = true;
        }
        let r = Router::new(&p);
        let m = r.resolve(Role::Draft).expect("a model");
        assert!(matches!(m.kind, ProviderKind::Local));
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
}
