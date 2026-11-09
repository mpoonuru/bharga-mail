//! macOS web view tuning and renderer recovery.
//!
//! WebKit caps page rendering at ~60 fps by default ("Prefer Page Rendering
//! Updates near 60fps"), even on 120 Hz ProMotion displays. Native apps scroll
//! at 120 Hz, so the reader looked smeared next to them. Measured with the real
//! report email in a WKWebView: 17 ms median frames with the cap, 8 ms without.
//! The flag is only read when the web content process starts, so it must be on
//! the configuration the web view is created with; setting it later, reloading
//! or navigating does not take effect.

use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_foundation::NSString;
use objc2_web_kit::WKWebViewConfiguration;

struct RecoveryState {
    pending: AtomicBool,
}

impl RecoveryState {
    const fn new() -> Self {
        Self { pending: AtomicBool::new(false) }
    }

    fn renderer_terminated(&self) {
        self.pending.store(true, Ordering::Release);
    }

    fn page_loaded(&self) -> bool {
        self.pending.swap(false, Ordering::AcqRel)
    }

    fn needs_reload(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }
}

static RECOVERY: RecoveryState = RecoveryState::new();

pub fn renderer_terminated<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    RECOVERY.renderer_terminated();
    log::error!("webview: renderer terminated; reloading frontend");
    if let Err(error) = webview.reload() {
        log::error!("webview: renderer recovery reload failed: {error}");
    }
}

pub fn page_loaded() {
    if RECOVERY.page_loaded() {
        log::info!("webview: frontend loaded; renderer recovery complete");
    }
}

pub fn reload_on_reopen(window: &tauri::WebviewWindow) {
    if !RECOVERY.needs_reload() {
        return;
    }
    log::warn!("webview: reopening with renderer recovery pending; reloading frontend");
    if let Err(error) = window.reload() {
        log::error!("webview: reopen recovery reload failed: {error}");
    }
}

const FRAME_CAP_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// A fresh web view configuration with the 60 fps rendering cap turned off.
pub fn configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    match disable_frame_cap(&config) {
        Ok(()) => {
            log::info!("webview: 60 fps rendering cap disabled (renders at display refresh rate)")
        }
        // Private WebKit API: if Apple renames it, keep the default and say so.
        Err(reason) => log::warn!("webview: could not disable 60 fps rendering cap: {reason}"),
    }
    config
}

fn disable_frame_cap(config: &WKWebViewConfiguration) -> Result<(), &'static str> {
    unsafe {
        let class = AnyClass::get(c"WKPreferences").ok_or("WKPreferences class missing")?;
        let has_features: Bool = msg_send![class, respondsToSelector: sel!(_features)];
        if !has_features.as_bool() {
            return Err("WKPreferences._features unavailable");
        }
        let prefs = config.preferences();
        let can_set: Bool = msg_send![&*prefs, respondsToSelector: sel!(_setEnabled:forFeature:)];
        if !can_set.as_bool() {
            return Err("WKPreferences._setEnabled:forFeature: unavailable");
        }
        let features: *mut AnyObject = msg_send![class, _features];
        if features.is_null() {
            return Err("WebKit returned no feature list");
        }
        let target = NSString::from_str(FRAME_CAP_FEATURE);
        let count: usize = msg_send![features, count];
        for index in 0..count {
            let feature: *mut AnyObject = msg_send![features, objectAtIndex: index];
            if feature.is_null() {
                continue;
            }
            let key: *mut NSString = msg_send![feature, key];
            if !key.is_null() && (*key).isEqualToString(&target) {
                let _: () = msg_send![&*prefs, _setEnabled: Bool::NO, forFeature: feature];
                return Ok(());
            }
        }
        Err("feature not found in this WebKit version")
    }
}

#[cfg(test)]
mod tests {
    use super::RecoveryState;

    #[test]
    fn recovery_stays_pending_until_a_page_loads() {
        let state = RecoveryState::new();
        assert!(!state.needs_reload());

        state.renderer_terminated();
        assert!(state.needs_reload());
        assert!(state.needs_reload(), "a failed reload must remain retryable");

        assert!(state.page_loaded());
        assert!(!state.needs_reload());
        assert!(!state.page_loaded(), "an ordinary page load is not a recovery");
    }
}
