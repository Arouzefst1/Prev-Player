// Whether the screen this window is on is in HDR — asked of Windows by the
// backend (src-tauri/src/display.rs). Null off Windows, or when it can't tell.

import type { DisplayHdr } from './media';

interface Reported extends DisplayHdr { device: string }

export async function currentDisplayHdr(): Promise<DisplayHdr | null> {
  try {
    const [{ invoke }, { currentMonitor }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/window'),
    ]);
    const [displays, monitor] = await Promise.all([
      invoke<Reported[]>('display_hdr'),
      currentMonitor(),
    ]);
    if (!displays?.length) return null;
    // Tauri names a monitor by its GDI device ("\\.\DISPLAY1"), as Windows does.
    const name = monitor?.name?.toLowerCase();
    const here = displays.find(d => name && d.device.toLowerCase() === name)
      ?? (displays.length === 1 ? displays[0] : undefined);
    return here ? { supported: here.supported, enabled: here.enabled } : null;
  } catch {
    return null;
  }
}

/** The backend's name for the screen this window is on, and its HDR state. */
async function here(): Promise<Reported | null> {
  try {
    const [{ invoke }, { currentMonitor }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/window'),
    ]);
    const [displays, monitor] = await Promise.all([invoke<Reported[]>('display_hdr'), currentMonitor()]);
    const name = monitor?.name?.toLowerCase();
    return displays?.find(d => name && d.device.toLowerCase() === name) ?? (displays?.length === 1 ? displays[0] : null);
  } catch {
    return null;
  }
}

/**
 * Settings › Picture & sound: switch Windows HDR on or off for this screen.
 * Only for a screen that can do HDR; true when it changed.
 */
export async function setScreenHdr(on: boolean): Promise<boolean> {
  const screen = await here();
  if (!screen || !screen.supported || screen.enabled === on) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('display_set_hdr', { device: screen.device, on }).catch(() => false);
}

/** Move this screen to a refresh rate `fps` divides evenly. The new rate, or null if unchanged. */
export async function matchScreenRate(fps: number): Promise<number | null> {
  const screen = await here();
  if (!screen) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number | null>('display_match_rate', { device: screen.device, fps }).catch(() => null);
}

/** Undo every HDR and refresh-rate change the app made. */
export async function restoreScreens(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('display_restore').catch(() => {});
}
