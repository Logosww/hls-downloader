//! 静态链接 vcpkg FFmpeg 时，avdevice（DirectShow）的 .lib 不会带上 Windows COM / Shell 依赖，需显式传给最终 link。

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(target_os = "windows")]
    if std::env::var_os("CARGO_FEATURE_STATIC_FFMPEG").is_some() {
        for lib in ["strmiids", "uuid", "ole32", "oleaut32", "oledlg", "shlwapi"] {
            println!("cargo:rustc-link-lib={lib}");
        }
    }
}
