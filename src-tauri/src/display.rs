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

// ===========================================================================
// Matching the screen to the video (opt-in, Settings › Picture & sound).
//
// HDR: an HDR video on a screen with HDR switched off is tone-mapped down, so
// the app can switch Windows HDR on for that screen while it plays, and back.
// Refresh rate: 24p on a 60 Hz screen shows frames for 3, 2, 3, 2 refreshes
// (judder); a 24 Hz (or 120 Hz) mode shows every frame for the same time.
//
// Every change is recorded and undone when playback stops and when the app
// exits. Refresh changes are made with CDS_FULLSCREEN, which Windows treats as
// temporary: they never reach the registry, so even a crash can't leave the
// screen on 24 Hz after a restart.
// ===========================================================================

use std::sync::Mutex;

/// What to put back: screens whose HDR we turned on, and screens whose
/// refresh rate we changed.
static CHANGED: Mutex<(Vec<String>, Vec<String>)> = Mutex::new((Vec::new(), Vec::new()));

/// Switch HDR on or off for one screen. True when Windows accepted it.
#[tauri::command]
pub async fn display_set_hdr(device: String, on: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let ok = set_hdr(&device, on);
        if ok {
            // Remember only HDR we turned on; once it's off again there's nothing to undo.
            let mut changed = CHANGED.lock().unwrap();
            changed.0.retain(|d| d != &device);
            if on {
                changed.0.push(device);
            }
        }
        ok
    })
    .await
    .unwrap_or(false)
}

/// Move one screen to the mode that shows `fps` evenly. Returns the new rate in
/// Hz, or None when nothing changed (no fitting mode, or the current one fits).
#[tauri::command]
pub async fn display_match_rate(device: String, fps: f64) -> Option<u32> {
    tauri::async_runtime::spawn_blocking(move || {
        let rate = match_rate(&device, fps)?;
        let mut changed = CHANGED.lock().unwrap();
        if !changed.1.contains(&device) {
            changed.1.push(device);
        }
        Some(rate)
    })
    .await
    .ok()
    .flatten()
}

/// Undo everything this app changed on every screen.
#[tauri::command]
pub async fn display_restore() {
    let _ = tauri::async_runtime::spawn_blocking(restore_all).await;
}

pub fn restore_all() {
    let (hdr, rate) = std::mem::take(&mut *CHANGED.lock().unwrap());
    for device in hdr {
        set_hdr(&device, false);
    }
    for device in rate {
        reset_rate(&device);
    }
}

/// The real rate behind a mode Windows lists as a whole number: 23, 29, 47, 59,
/// 71 and 119 Hz are the NTSC rates (24000/1001 …).
fn actual_hz(listed: u32) -> f64 {
    match listed {
        23 | 29 | 47 | 59 | 71 | 119 => (listed + 1) as f64 * 1000.0 / 1001.0,
        _ => listed as f64,
    }
}

/// Whether a screen at `hz` shows every frame of `fps` for the same time: the
/// rate is a whole multiple of the frame rate, within 0.05 % — so 24 Hz is
/// *not* a fit for 23.976 fps (one frame doubled every 42 s).
fn fits(hz: f64, fps: f64) -> bool {
    let k = (hz / fps).round();
    k >= 1.0 && ((hz - k * fps) / (k * fps)).abs() < 0.0005
}

/// The listed rate to switch to for `fps`, given the rates the screen offers at
/// its current resolution: none when the current rate already fits, otherwise
/// the highest that fits (120 Hz over 24 Hz keeps the pointer and menus smooth).
fn pick_rate(available: &[u32], current: u32, fps: f64) -> Option<u32> {
    if !(fps > 10.0 && fps < 250.0) || fits(actual_hz(current), fps) {
        return None;
    }
    available.iter().copied().filter(|&r| fits(actual_hz(r), fps)).max()
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The display-config target behind a GDI device name ("\\.\DISPLAY1").
#[cfg(windows)]
fn target_of(device: &str) -> Option<(windows_sys::Win32::Foundation::LUID, u32)> {
    use std::mem::size_of;
    use windows_sys::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO,
        DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    unsafe {
        let (mut paths_len, mut modes_len) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths_len, &mut modes_len) != 0 {
            return None;
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
            return None;
        }
        paths.truncate(paths_len as usize);
        paths.iter().find_map(|p| {
            let mut name = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: p.sourceInfo.adapterId,
                    id: p.sourceInfo.id,
                },
                viewGdiDeviceName: [0; 32],
            };
            if DisplayConfigGetDeviceInfo(&mut name.header) != 0 {
                return None;
            }
            let len = name.viewGdiDeviceName.iter().position(|&c| c == 0).unwrap_or(32);
            (String::from_utf16_lossy(&name.viewGdiDeviceName[..len]) == device)
                .then_some((p.targetInfo.adapterId, p.targetInfo.id))
        })
    }
}

#[cfg(windows)]
fn set_hdr(device: &str, on: bool) -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::Devices::Display::{DisplayConfigSetDeviceInfo, DISPLAYCONFIG_DEVICE_INFO_HEADER};

    /// DISPLAYCONFIG_SET_HDR_STATE (24H2+) and DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE
    /// share this shape: the header, then one flag in bit 0.
    #[repr(C)]
    struct SetState {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
        value: u32,
    }
    /// DISPLAYCONFIG_DEVICE_INFO_SET_HDR_STATE — 24H2 split HDR from colour management.
    const SET_HDR_STATE: i32 = 16;
    /// DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE — HDR before 24H2.
    const SET_ADVANCED_COLOR_STATE: i32 = 10;

    let Some((adapter, id)) = target_of(device) else { return false };
    [SET_HDR_STATE, SET_ADVANCED_COLOR_STATE].into_iter().any(|kind| unsafe {
        let packet = SetState {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER { r#type: kind, size: size_of::<SetState>() as u32, adapterId: adapter, id },
            value: on as u32,
        };
        DisplayConfigSetDeviceInfo(&packet.header) == 0
    })
}

#[cfg(windows)]
fn match_rate(device: &str, fps: f64) -> Option<u32> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Graphics::Gdi::{
        ChangeDisplaySettingsExW, EnumDisplaySettingsW, CDS_FULLSCREEN, DEVMODEW, DISP_CHANGE_SUCCESSFUL,
        DM_DISPLAYFREQUENCY, DM_INTERLACED, ENUM_CURRENT_SETTINGS,
    };
    let name = wide(device);
    unsafe {
        let mode = |i: u32| -> Option<DEVMODEW> {
            let mut dm: DEVMODEW = zeroed();
            dm.dmSize = size_of::<DEVMODEW>() as u16;
            (EnumDisplaySettingsW(name.as_ptr(), i, &mut dm) != 0).then_some(dm)
        };
        let current = mode(ENUM_CURRENT_SETTINGS)?;
        let same_shape = |m: &DEVMODEW| {
            m.dmPelsWidth == current.dmPelsWidth
                && m.dmPelsHeight == current.dmPelsHeight
                && m.dmBitsPerPel == current.dmBitsPerPel
                && m.Anonymous2.dmDisplayFlags & DM_INTERLACED == 0
        };
        let rates: Vec<u32> = (0..).map_while(mode).filter(same_shape).map(|m| m.dmDisplayFrequency).collect();
        let rate = pick_rate(&rates, current.dmDisplayFrequency, fps)?;
        let mut next = current;
        next.dmDisplayFrequency = rate;
        next.dmFields = DM_DISPLAYFREQUENCY;
        let result = ChangeDisplaySettingsExW(name.as_ptr(), &next, std::ptr::null_mut(), CDS_FULLSCREEN, std::ptr::null());
        (result == DISP_CHANGE_SUCCESSFUL).then_some(rate)
    }
}

/// Back to the mode saved in the registry — the one the user chose.
#[cfg(windows)]
fn reset_rate(device: &str) {
    use windows_sys::Win32::Graphics::Gdi::ChangeDisplaySettingsExW;
    let name = wide(device);
    unsafe {
        ChangeDisplaySettingsExW(name.as_ptr(), std::ptr::null(), std::ptr::null_mut(), 0, std::ptr::null());
    }
}

#[cfg(not(windows))]
fn set_hdr(_device: &str, _on: bool) -> bool {
    false
}

#[cfg(not(windows))]
fn match_rate(_device: &str, _fps: f64) -> Option<u32> {
    None
}

#[cfg(not(windows))]
fn reset_rate(_device: &str) {}

#[cfg(test)]
mod tests {
    use super::pick_rate;

    #[test]
    fn film_on_a_tv_goes_to_23_not_24() {
        assert_eq!(pick_rate(&[23, 24, 25, 29, 30, 50, 59, 60], 60, 23.976), Some(23));
        assert_eq!(pick_rate(&[23, 24, 25, 29, 30, 50, 59, 60], 60, 24.0), Some(24));
    }

    #[test]
    fn prefers_the_fastest_even_rate() {
        assert_eq!(pick_rate(&[24, 48, 60, 120, 165], 60, 24.0), Some(120));
        assert_eq!(pick_rate(&[50, 60, 100, 120], 60, 25.0), Some(100));
        // 144 Hz is 6 × 24: already even, nothing to change.
        assert_eq!(pick_rate(&[24, 60, 120, 144], 144, 24.0), None);
    }

    #[test]
    fn leaves_a_fitting_screen_alone() {
        assert_eq!(pick_rate(&[24, 60, 120], 120, 24.0), None);
        assert_eq!(pick_rate(&[59, 60], 60, 30.0), None);
        assert_eq!(pick_rate(&[59, 60], 59, 29.97), None);
    }

    #[test]
    fn no_fitting_mode_or_no_frame_rate() {
        assert_eq!(pick_rate(&[60, 75], 60, 23.976), None);
        assert_eq!(pick_rate(&[24, 60], 60, 0.0), None);
    }
}
