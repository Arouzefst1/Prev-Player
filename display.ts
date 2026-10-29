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
