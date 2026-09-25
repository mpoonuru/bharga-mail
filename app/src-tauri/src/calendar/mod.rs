//! Local-first calendar domain and persistence.
//!
//! Provider connectors are layered on top of this canonical model. The UI and
//! remote services never bypass the store, which keeps offline mutations and
//! their outbound operations transactional.

pub mod commands;
pub mod domain;
pub mod recurrence;
pub mod store;
