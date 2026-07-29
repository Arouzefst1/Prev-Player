// ===========================================================================
// Picture-in-Picture — window geometry engine.
//
// The native build has no <video> element (mpv paints the picture behind a
// transparent WebView), so browser PiP is off the table. Real PiP here means
// turning the OS window itself into a small, borderless, always-on-top
// mini-player — and that only *feels* like PiP if the geometry is right:
//
//   • the window hugs the video's aspect ratio, so there are no black bars;
//   • it's genuinely small — the app's 800×600 minimum has to be lifted first
//     (otherwise "PiP" is just a slightly smaller window, which is the bug this
//     module exists to fix);
//   • it stays inside the monitor's WORK area (never under the taskbar);
//   • it snaps to the nearest corner when you let go of it;
//   • it remembers how big you like it — as a fraction of the screen, so the
//     size carries over between a 21:9 movie and a 9:16 phone clip;
//   • resizing keeps the aspect locked from whichever edge you grabbed.
//
// Everything here works in PHYSICAL pixels (what the monitor APIs report),
// except the min-size constraints, which Tauri takes in logical pixels.
// ===========================================================================

import type { Monitor, Window as TauriWindow } from '@tauri-apps/api/window';

/** Window minimums from `src-tauri/tauri.conf.json` — restored when PiP exits. */
const APP_MIN_W_LOGICAL = 800;
const APP_MIN_H_LOGICAL = 600;

/** Smallest a mini-player may get, in logical px (aspect-corrected below). */
const PIP_MIN_W_LOGICAL = 200;
const PIP_MIN_H_LOGICAL = 112;

/** Default footprint: fraction of the work area's AREA the mini-player covers. */
const DEFAULT_AREA_FRAC = 0.055;
const MIN_AREA_FRAC = 0.015;
const MAX_AREA_FRAC = 0.32;

/** Corner snapping: pull-in distance and the gap left against the edge (logical px). */
const SNAP_LOGICAL = 44;
const EDGE_MARGIN_LOGICAL = 18;

const PREFS_KEY = 'prevplayer_pip_prefs_v1';

export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** What the window looked like before PiP, so exiting restores it exactly. */
export interface PrePipState {
  w: number; h: number; x: number; y: number;
  fullscreen: boolean;
  maximized: boolean;
}

/** Remembered across sessions: preferred footprint + last resting place. */
interface PipPrefs {
  areaFrac: number;
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --------------------------------------------------------------------------
// Preferences
// --------------------------------------------------------------------------

export function loadPipPrefs(): PipPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.areaFrac !== 'number' || typeof p?.x !== 'number' || typeof p?.y !== 'number') return null;
    return { areaFrac: clamp(p.areaFrac, MIN_AREA_FRAC, MAX_AREA_FRAC), x: p.x, y: p.y };
  } catch {
    return null;
  }
}

export function savePipPrefs(rect: Rect, mon: Monitor | null): void {
  try {
    const workArea = mon?.workArea.size;
    const frac = workArea ? (rect.w * rect.h) / (workArea.width * workArea.height) : DEFAULT_AREA_FRAC;
    const prefs: PipPrefs = { areaFrac: clamp(frac, MIN_AREA_FRAC, MAX_AREA_FRAC), x: rect.x, y: rect.y };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full / disabled — PiP just forgets its size, nothing breaks */
  }
}

// --------------------------------------------------------------------------
// Aspect-aware sizing
// --------------------------------------------------------------------------

/**
 * The aspect ratio to shape the window to. mpv reports `dwidth/dheight` (the
 * DISPLAY aspect, so anamorphic DVDs come out right); until it does — or for
 * audio, which has no picture at all — we fall back to sane defaults.
 */
export function resolveAspect(videoAspect: number | null | undefined, isAudio: boolean): number {
  if (isAudio) return 2.4;                       // a slim "now playing" strip
  if (videoAspect && isFinite(videoAspect) && videoAspect > 0.2 && videoAspect < 5) return videoAspect;
  return 16 / 9;
}

/** Aspect-consistent floor, in physical px. */
export function pipMinSize(aspect: number, scaleFactor: number): Size {
  let w = PIP_MIN_W_LOGICAL;
  let h = w / aspect;
  if (h < PIP_MIN_H_LOGICAL) { h = PIP_MIN_H_LOGICAL; w = h * aspect; }
  return { w: Math.round(w * scaleFactor), h: Math.round(h * scaleFactor) };
}

/**
 * Aspect-consistent ceiling, in physical px — PiP that fills the screen isn't PiP.
 *
 * Portrait clips need a taller ceiling than landscape ones. A 9:16 video is
 * height-limited (its width is never the binding constraint), so the same 60%
 * height cap that comfortably fits a 16:9 movie leaves a phone video looking
 * tiny. Tall content therefore gets most of the screen's height to grow into,
 * while its width stays modest — which is what keeps it feeling like PiP.
 * Both limits stay aspect-consistent, so growing never introduces black bars.
 */
export function pipMaxSize(aspect: number, mon: Monitor): Size {
  const work = mon.workArea.size;
  const isTall = aspect < 1;
  let w = work.width * (isTall ? 0.45 : 0.55);
  let h = w / aspect;
  const capH = work.height * (isTall ? 0.85 : 0.6);
  if (h > capH) { h = capH; w = h * aspect; }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Fit a size to `aspect`, driving from whichever axis the user is actually
 * dragging, then clamp into [min, max]. Because min and max are themselves
 * aspect-consistent, the clamps can't fight the ratio — this always converges.
 */
export function fitToAspect(
  w: number, h: number, aspect: number, min: Size, max: Size, driveFromWidth: boolean,
): Size {
  let W = driveFromWidth ? w : h * aspect;
  let H = driveFromWidth ? w / aspect : h;
  if (W < min.w) { W = min.w; H = W / aspect; }
  if (H < min.h) { H = min.h; W = H * aspect; }
  if (W > max.w) { W = max.w; H = W / aspect; }
  if (H > max.h) { H = max.h; W = H * aspect; }
  return { w: Math.round(W), h: Math.round(H) };
}

/** The mini-player's size for a given aspect + remembered footprint. */
export function computePipSize(aspect: number, areaFrac: number, mon: Monitor): Size {
  const work = mon.workArea.size;
  const area = work.width * work.height * clamp(areaFrac, MIN_AREA_FRAC, MAX_AREA_FRAC);
  const w = Math.sqrt(area * aspect);
  return fitToAspect(w, w / aspect, aspect, pipMinSize(aspect, mon.scaleFactor), pipMaxSize(aspect, mon), true);
}

// --------------------------------------------------------------------------
// Placement
// --------------------------------------------------------------------------

/** Keep a rect fully inside the monitor's work area. */
export function clampToWorkArea(rect: Rect, mon: Monitor): { x: number; y: number } {
  const wa = mon.workArea;
  const maxX = wa.position.x + wa.size.width - rect.w;
  const maxY = wa.position.y + wa.size.height - rect.h;
  return {
    x: Math.round(clamp(rect.x, wa.position.x, Math.max(wa.position.x, maxX))),
    y: Math.round(clamp(rect.y, wa.position.y, Math.max(wa.position.y, maxY))),
  };
}

/** True when the rect's centre sits on one of the connected monitors. */
export function isOnScreen(rect: Rect, monitors: Monitor[]): boolean {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return monitors.some((m) => {
    const wa = m.workArea;
    return cx >= wa.position.x && cx <= wa.position.x + wa.size.width
        && cy >= wa.position.y && cy <= wa.position.y + wa.size.height;
  });
}

/** Bottom-right of the work area — the default resting spot, like every other PiP. */
export function defaultPipPosition(size: Size, mon: Monitor): { x: number; y: number } {
  const wa = mon.workArea;
  const margin = Math.round(EDGE_MARGIN_LOGICAL * mon.scaleFactor);
  return {
    x: wa.position.x + wa.size.width - size.w - margin,
    y: wa.position.y + wa.size.height - size.h - margin,
  };
}

/**
 * Magnetic corners: if an edge of the window has come to rest near an edge of
 * the work area, pull it flush (with a small margin). Returns null when the
 * window is already where it should be, so callers can skip a pointless move.
 */
export function snapPosition(rect: Rect, mon: Monitor): { x: number; y: number } | null {
  const wa = mon.workArea;
  const snap = SNAP_LOGICAL * mon.scaleFactor;
  const margin = Math.round(EDGE_MARGIN_LOGICAL * mon.scaleFactor);

  const left = wa.position.x;
  const top = wa.position.y;
  const right = wa.position.x + wa.size.width;
  const bottom = wa.position.y + wa.size.height;

  let { x, y } = rect;
  if (Math.abs(rect.x - left) < snap) x = left + margin;
  else if (Math.abs(right - (rect.x + rect.w)) < snap) x = right - rect.w - margin;
  if (Math.abs(rect.y - top) < snap) y = top + margin;
  else if (Math.abs(bottom - (rect.y + rect.h)) < snap) y = bottom - rect.h - margin;

  const clamped = clampToWorkArea({ ...rect, x, y }, mon);
  if (Math.abs(clamped.x - rect.x) < 2 && Math.abs(clamped.y - rect.y) < 2) return null;
  return clamped;
}

/**
 * Re-anchor after a size change (e.g. the next video is portrait): keep the
 * corner the window is nearest to pinned, so it grows inward instead of
 * sliding off the screen.
 */
export function anchoredPosition(old: Rect, next: Size, mon: Monitor): { x: number; y: number } {
  const wa = mon.workArea;
  const centreX = old.x + old.w / 2;
  const centreY = old.y + old.h / 2;
  const onRight = centreX > wa.position.x + wa.size.width / 2;
  const onBottom = centreY > wa.position.y + wa.size.height / 2;
  const x = onRight ? old.x + old.w - next.w : old.x;
  const y = onBottom ? old.y + old.h - next.h : old.y;
  return clampToWorkArea({ x, y, w: next.w, h: next.h }, mon);
}

// --------------------------------------------------------------------------
// Window transitions
// --------------------------------------------------------------------------

/** The monitor the window currently sits on, with a primary-monitor fallback. */
export async function activeMonitor(): Promise<Monitor | null> {
  const { currentMonitor, primaryMonitor } = await import('@tauri-apps/api/window');
  try {
    return (await currentMonitor()) ?? (await primaryMonitor());
  } catch {
    return null;
  }
}

/**
 * Shrink the window into a mini-player. Returns the state needed to undo it.
 *
 * The order matters: leave fullscreen and un-maximize FIRST (a maximized window
 * ignores setSize), then drop the app's 800×600 floor — without that the window
 * physically cannot become small, which is exactly what made the old PiP look
 * like nothing more than a resize.
 */
export async function enterPipWindow(videoAspect: number | null, isAudio: boolean): Promise<PrePipState> {
  const winApi = await import('@tauri-apps/api/window');
  const win = winApi.getCurrentWindow();

  const wasFullscreen = await win.isFullscreen();
  if (wasFullscreen) await win.setFullscreen(false);
  const wasMaximized = await win.isMaximized().catch(() => false);
  if (wasMaximized) await win.unmaximize().catch(() => {});

  const size = await win.innerSize();
  const pos = await win.outerPosition();
  const prev: PrePipState = {
    w: size.width, h: size.height, x: pos.x, y: pos.y,
    fullscreen: wasFullscreen, maximized: wasMaximized,
  };

  const mon = await activeMonitor();
  const ratio = resolveAspect(videoAspect, isAudio);

  // Everything below mutates the real window. If any step fails we must NOT
  // leave it half-transformed — a borderless, always-on-top, max-size-capped
  // window that the UI doesn't know is in PiP is unrecoverable from the UI:
  // the full-size chrome renders into a window that can no longer grow, and
  // the next toggle would capture that broken geometry as the restore point.
  try {
    await applyPipChrome(win, ratio, mon);
  } catch (e) {
    await exitPipWindow(prev);
    throw e;
  }

  return prev;
}

/** The window mutations that turn the main window into the mini-player. */
async function applyPipChrome(win: TauriWindow, ratio: number, mon: Monitor | null): Promise<void> {
  const winApi = await import('@tauri-apps/api/window');

  await win.setDecorations(false);
  await win.setResizable(true);
  await win.setAlwaysOnTop(true);
  // An undecorated window loses the OS drop shadow; ask for it back so the
  // mini-player reads as a floating panel and not a flat rectangle.
  try { await win.setShadow(true); } catch { /* not supported everywhere */ }

  if (mon) {
    const prefs = loadPipPrefs();
    const target = computePipSize(ratio, prefs?.areaFrac ?? DEFAULT_AREA_FRAC, mon);

    // Drop the floor BEFORE resizing and raise the ceiling only after — doing it
    // the other way round makes the window visibly bounce off the max on its way
    // down from full size.
    const min = pipMinSize(ratio, mon.scaleFactor);
    await win.setMinSize(new winApi.PhysicalSize(min.w, min.h));
    await win.setSize(new winApi.PhysicalSize(target.w, target.h));
    const max = pipMaxSize(ratio, mon);
    await win.setMaxSize(new winApi.PhysicalSize(max.w, max.h));

    let place = defaultPipPosition(target, mon);
    if (prefs) {
      const remembered: Rect = { x: prefs.x, y: prefs.y, w: target.w, h: target.h };
      const monitors = await winApi.availableMonitors().catch(() => [mon]);
      if (isOnScreen(remembered, monitors.length ? monitors : [mon])) {
        place = clampToWorkArea(remembered, mon);
      }
    }
    await win.setPosition(new winApi.PhysicalPosition(place.x, place.y));
  } else {
    // No monitor info (rare) — fall back to a fixed 16:9-ish mini window.
    await win.setMinSize(new winApi.LogicalSize(PIP_MIN_W_LOGICAL, PIP_MIN_H_LOGICAL));
    await win.setSize(new winApi.LogicalSize(440, Math.round(440 / ratio)));
  }
}

/** Restore everything PiP changed: constraints, chrome, size, position, state. */
export async function exitPipWindow(prev: PrePipState | null): Promise<void> {
  const winApi = await import('@tauri-apps/api/window');
  const win = winApi.getCurrentWindow();

  await win.setAlwaysOnTop(false).catch(() => {});
  await win.setMaxSize(null).catch(() => {});
  // Put the app's own floor back BEFORE resizing, so the window can grow again.
  await win.setMinSize(new winApi.LogicalSize(APP_MIN_W_LOGICAL, APP_MIN_H_LOGICAL)).catch(() => {});
  await win.setDecorations(true).catch(() => {});

  if (!prev) return;
  if (prev.fullscreen) {
    await win.setFullscreen(true).catch(() => {});
  } else if (prev.maximized) {
    await win.maximize().catch(() => {});
  } else {
    await win.setSize(new winApi.PhysicalSize(prev.w, prev.h)).catch(() => {});
    await win.setPosition(new winApi.PhysicalPosition(prev.x, prev.y)).catch(() => {});
  }
}

/** Push the aspect-consistent min/max into the OS so manual resizes stay sane. */
export async function applySizeConstraints(win: TauriWindow, aspect: number, mon: Monitor): Promise<void> {
  const { PhysicalSize } = await import('@tauri-apps/api/window');
  const min = pipMinSize(aspect, mon.scaleFactor);
  const max = pipMaxSize(aspect, mon);
  // Deliberately not swallowed: if the OS refuses these, the window can be
  // dragged outside the aspect-consistent bounds and the picture letterboxes.
  try {
    await win.setMinSize(new PhysicalSize(min.w, min.h));
    await win.setMaxSize(new PhysicalSize(max.w, max.h));
  } catch (e) {
    console.error('[pip] size constraints rejected', e);
  }
}

/**
 * Reshape an already-open mini-player to a new aspect (the next video in the
 * queue is a portrait clip, say) while keeping its footprint and its corner.
 */
export async function reshapePipWindow(aspect: number): Promise<void> {
  const winApi = await import('@tauri-apps/api/window');
  const win = winApi.getCurrentWindow();
  const mon = await activeMonitor();
  if (!mon) return;

  const size = await win.innerSize();
  const pos = await win.outerPosition();
  const current: Rect = { x: pos.x, y: pos.y, w: size.width, h: size.height };

  const areaFrac = (current.w * current.h) / (mon.workArea.size.width * mon.workArea.size.height);
  const next = computePipSize(aspect, areaFrac, mon);
  if (Math.abs(next.w - current.w) < 3 && Math.abs(next.h - current.h) < 3) return;

  await applySizeConstraints(win, aspect, mon);
  await win.setSize(new winApi.PhysicalSize(next.w, next.h));
  const place = anchoredPosition(current, next, mon);
  await win.setPosition(new winApi.PhysicalPosition(place.x, place.y));
}
