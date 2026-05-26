//! 静态链接 vcpkg FFmpeg 时，FFmpeg 的 .lib 不会带上 Windows 侧依赖，需显式传给最终 link：
//! - DirectShow：strmiids、COM、shell
//! - gdigrab / VFW：gdi32、vfw32
//! - Media Foundation（avcodec mf_*）：mfuuid（IID_IMF*）

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(target_os = "windows")]
    if std::env::var_os("CARGO_FEATURE_STATIC_FFMPEG").is_some() {
        for lib in [
            "strmiids", "uuid", "ole32", "oleaut32", "oledlg", "shlwapi", "gdi32", "vfw32",
            "mfuuid",
        ] {
            println!("cargo:rustc-link-lib={lib}");
        }
    }
}
