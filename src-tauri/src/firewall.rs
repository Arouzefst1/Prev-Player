// ===========================================================================
// Letting the other device in: Windows Firewall.
//
// A Local Wi-Fi share is a server on this PC, and Windows Firewall blocks
// incoming connections to it on any network marked Public — which is what
// Windows picks for a home Wi-Fi unless told otherwise. The first time the app
// listens, Windows asks; its prompt only ticks "Private networks", and pressing
// Cancel there writes *block* rules, which outrank any allow rule. Either way
// the receiver can't connect, however right everything else is.
//
// Changing that needs administrator rights, so it is one deliberate click
// ("Allow through firewall") and one UAC prompt: remove the inbound block rules
// Windows made for this program, then allow it inbound on every network profile
// — from the local subnet only, so a share is never opened to the internet.
// ===========================================================================

/// The rule's name in Windows Defender Firewall, so it's recognisable there.
const RULE: &str = "PREV Player (Local Wi-Fi sharing)";

/// Exit code for "the UAC prompt was declined" (Windows' ERROR_CANCELLED).
#[cfg_attr(not(windows), allow(dead_code))]
const CANCELLED: i32 = 1223;

#[tauri::command]
pub async fn lan_allow_firewall() -> Result<(), String> {
    // It waits on the UAC prompt, so never on the UI thread.
    tauri::async_runtime::spawn_blocking(allow)
        .await
        .map_err(|e| format!("firewall task failed: {e}"))?
}

/// The PowerShell that runs elevated. Rules are matched on the program path
/// case-insensitively: the ones Windows writes from its prompt don't always
/// spell the path the way `current_exe()` does.
///
/// Every removal names one rule by its unique `-Name`, inside loops that do
/// nothing when nothing matched. Never `… | Remove-NetFirewallRule` at the end
/// of a filter: a firewall cmdlet left with an empty pipeline must not get the
/// chance to act on every rule on the machine.
#[cfg_attr(not(windows), allow(dead_code))]
fn elevated_script(exe: &str) -> String {
    let exe = exe.replace('\'', "''");
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $exe = '{exe}'\n\
         foreach ($f in @(Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -ieq $exe }})) {{\n\
         \x20 foreach ($r in @(Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $f)) {{\n\
         \x20   if ($r.Direction -eq 'Inbound' -and $r.Action -eq 'Block') {{ Remove-NetFirewallRule -Name $r.Name }}\n\
         \x20 }}\n\
         }}\n\
         foreach ($r in @(Get-NetFirewallRule -DisplayName '{RULE}' -ErrorAction SilentlyContinue)) {{\n\
         \x20 Remove-NetFirewallRule -Name $r.Name\n\
         }}\n\
         New-NetFirewallRule -DisplayName '{RULE}' -Direction Inbound -Action Allow -Program $exe `\n\
         \x20 -Protocol TCP -Profile Any -RemoteAddress LocalSubnet | Out-Null\n"
    )
}

/// The un-elevated half: ask Windows to run `encoded` (an -EncodedCommand
/// payload) as administrator, and exit with its result. Start-Process throws
/// when the UAC prompt is declined.
#[cfg_attr(not(windows), allow(dead_code))]
fn launcher(encoded: &str) -> String {
    format!(
        "try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}'; \
         exit $p.ExitCode }} catch {{ exit {CANCELLED} }}"
    )
}

#[cfg(windows)]
fn allow() -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // -EncodedCommand (UTF-16LE, base64) so no path or quote in the script ever
    // has to survive a second round of command-line quoting.
    let script = elevated_script(&exe.to_string_lossy());
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(launcher(&STANDARD.encode(utf16)))
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("couldn't start PowerShell: {e}"))?;
    match status.code() {
        Some(0) => Ok(()),
        Some(CANCELLED) => Err("Windows didn't get permission — the prompt was cancelled.".into()),
        _ => Err("Windows Firewall couldn't be changed on this PC.".into()),
    }
}

#[cfg(not(windows))]
fn allow() -> Result<(), String> {
    Ok(()) // Only Windows blocks the share server out of the box.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quote_in_the_install_path_cannot_break_out_of_the_script() {
        let s = elevated_script(r"C:\Users\O'Brien\AppData\Local\PREV Player\prev-player.exe");
        assert!(s.contains(r"$exe = 'C:\Users\O''Brien\AppData\Local\PREV Player\prev-player.exe'"), "{s}");
    }

    #[test]
    fn the_rule_admits_only_this_program_from_the_local_network() {
        let s = elevated_script(r"C:\x\prev-player.exe");
        assert!(s.contains("-Direction Inbound -Action Allow -Program $exe"));
        assert!(s.contains("-RemoteAddress LocalSubnet"), "never the internet");
        assert!(s.contains("-Profile Any"), "Public is the profile that was blocking");
        assert!(s.contains("$r.Action -eq 'Block'"), "Windows' own block rules outrank an allow");
    }

    #[test]
    fn nothing_is_ever_removed_through_an_open_ended_pipeline() {
        let s = elevated_script(r"C:\x\prev-player.exe");
        assert!(!s.contains("| Remove-NetFirewallRule"), "{s}");
        assert_eq!(s.matches("Remove-NetFirewallRule -Name $r.Name").count(), 2, "{s}");
    }

    #[test]
    fn a_declined_prompt_is_told_apart_from_a_failure() {
        let l = launcher("QUJD");
        assert!(l.contains("'-EncodedCommand','QUJD'") && l.contains("-Verb RunAs"));
        assert!(l.contains(&format!("catch {{ exit {CANCELLED} }}")));
    }
}
