fn main() {
    println!("cargo:rerun-if-env-changed=BHARGA_GMAIL_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BHARGA_MS_CLIENT_ID");
    tauri_build::build()
}
