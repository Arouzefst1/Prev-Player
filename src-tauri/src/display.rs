// ===========================================================================
// Is the screen in HDR?
//
// mpv shows HDR as HDR only when Windows has HDR switched on for that screen —
// otherwise it tone-maps to SDR, which is correct but not what someone with an
// HDR TV expects. Newer mpv builds say which they did (`video-target-params`);
// this asks Windows directly, so the app can tell the user either way, and can
// say so before anything plays.
//
// Windows 11 24H2 changed the meaning of the old "advanced colour enabled"
// flag: it is now also set for colour-managed SDR. So the 24H2 query (which
// reports the HDR toggle and the active mode separately) is tried first, and
// the old one, read the old way, only where that query doesn't exist.
// ===========================================================================

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DisplayHdr {
    /// GDI device name ("\\.\DISPLAY1") — what Tauri reports as a monitor's name.
    pub device: String,
    /// The screen can do HDR.
    pub supported: bool,
    /// HDR is on for it right now.
    pub enabled: bool,
}

/// Every active screen and its HDR state. Empty off Windows, or if Windows
/// won't say.
#[tauri::command]
pub async fn display_hdr() -> Vec<DisplayHdr> {
    tauri::async_runtime::spawn_blocking(query).await.unwrap_or_default()
}

#[cfg(windows)]
fn query() -> Vec<DisplayHdr> {
    use std::mem::size_of;
    use windows_sys::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
        DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    use windows_sys::Win32::Foundation::LUID;

    /// DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO_2 (Windows 11 24H2+),
    /// newer than the windows-sys bindings.
    const GET_ADVANCED_COLOR_INFO_2: i32 = 15;
    /// DISPLAYCONFIG_ADVANCED_COLOR_MODE_HDR.
    const MODE_HDR: i32 = 2;

    /// DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO and its _2 successor share this
    /// shape; _2 adds the active mode at the end. Declared here so neither
    /// needs the GDI bindings for one enum field.
    #[repr(C)]
    #[derive(Default)]
    struct ColorInfo {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
        /// A C bitfield; see the bit tests below.
        value: u32,
        color_encoding: i32,
        bits_per_color_channel: u32,
        active_color_mode: i32, // _2 only
    }

    fn header(kind: i32, size: usize, adapter: LUID, id: u32) -> DISPLAYCONFIG_DEVICE_INFO_HEADER {
        DISPLAYCONFIG_DEVICE_INFO_HEADER { r#type: kind, size: size as u32, adapterId: adapter, id }
    }

    /// (supported, enabled) for one target.
    unsafe fn hdr_of(adapter: LUID, id: u32) -> Option<(bool, bool)> {
        // 24H2: bit 4 highDynamicRangeSupported, bit 5 highDynamicRangeUserEnabled.
        let mut info = ColorInfo { header: header(GET_ADVANCED_COLOR_INFO_2, size_of::<ColorInfo>(), adapter, id), ..Default::default() };
        if DisplayConfigGetDeviceInfo(&mut info.header) == 0 {
            let supported = info.value & (1 << 4) != 0;
            let enabled = info.active_color_mode == MODE_HDR || info.value & (1 << 5) != 0;
            return Some((supported, supported && enabled));
        }
        // Before 24H2: bit 0 advancedColorSupported, bit 1 advancedColorEnabled,
        // bit 2 wideColorEnforced (colour-managed SDR, not HDR). The old struct
        // has no mode field, so its size stops short of it.
        let size = size_of::<ColorInfo>() - size_of::<i32>();
        let mut info = ColorInfo { header: header(DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO, size, adapter, id), ..Default::default() };
        if DisplayConfigGetDeviceInfo(&mut info.header) != 0 {
            return None;
        }
        let wide_only = info.value & (1 << 2) != 0;
        let supported = info.value & 1 != 0 && !wide_only;
        Some((supported, supported && info.value & (1 << 1) != 0))
    }

    unsafe {
        let (mut paths_len, mut modes_len) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths_len, &mut modes_len) != 0 {
            return Vec::new();
        }
        let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = vec![Default::default(); paths_len as usize];
        let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = vec![Default::default(); modes_len as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut paths_len,
            paths.as_mut_ptr(),
            &mut modes_len,
            modes.as_mut_ptr(),
            std::ptr::null_mut(),
        ) != 0
        {
            return Vec::new();
        }
        paths.truncate(paths_len as usize);

        paths
            .iter()
            .filter_map(|p| {
                let mut name = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                    header: header(
                        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                        size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(),
                        p.sourceInfo.adapterId,
                        p.sourceInfo.id,
                    ),
                    viewGdiDeviceName: [0; 32],
                };
                if DisplayConfigGetDeviceInfo(&mut name.header) != 0 {
                    return None;
                }
                let len = name.viewGdiDeviceName.iter().position(|&c| c == 0).unwrap_or(32);
                let device = String::from_utf16_lossy(&name.viewGdiDeviceName[..len]);
                let (supported, enabled) = hdr_of(p.targetInfo.adapterId, p.targetInfo.id)?;
                Some(DisplayHdr { device, supported, enabled })
            })
            .collect()
    }
}

#[cfg(not(windows))]
fn query() -> Vec<DisplayHdr> {
    Vec::new()
}
