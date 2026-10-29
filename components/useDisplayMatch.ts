import { useEffect } from 'react';
import { subscribeMpv, mpvRefreshColorspace } from '../mpv';
import { setScreenHdr, matchScreenRate, restoreScreens } from '../display';

// ---------------------------------------------------------------------------
// Settings › Picture & sound, while the player is open: HDR on for an HDR
// picture (off again for SDR), and the refresh rate the frame rate divides
// evenly. Everything is put back when the player closes or the setting goes
// off — and by the backend on exit, whatever happens here.
// ---------------------------------------------------------------------------

/**
 * One line for every screen change, across mounts and setting flips, so a
 * restore from the last run can never land after the next run's switch.
 */
let busy: Promise<void> = Promise.resolve();
const queue = (job: () => Promise<void>) => { busy = busy.then(job, job); };

export function useDisplayMatch(autoHdr: boolean, matchRate: boolean): void {
  useEffect(() => {
    if (!autoHdr && !matchRate) return;
    let hdrDoneFor = '';
    let rateDoneFor = '';
    /** HDR is on because this hook turned it on — the only HDR it will turn off. */
    let ours = false;

    const off = subscribeMpv(s => {
      const file = s.filename;
      if (!file) return;
      const gamma = s.media.video?.gamma;
      if (autoHdr && gamma && hdrDoneFor !== file) {
        hdrDoneFor = file;
        const hdr = gamma === 'pq' || gamma === 'hlg';
        queue(async () => {
          if (hdr && !ours && await setScreenHdr(true)) {
            ours = true;
            await mpvRefreshColorspace();
          } else if (!hdr && ours) {
            ours = false;
            if (await setScreenHdr(false)) await mpvRefreshColorspace();
          }
        });
      }
      const fps = s.fps;
      if (matchRate && fps && fps > 0 && rateDoneFor !== file) {
        rateDoneFor = file;
        queue(async () => { await matchScreenRate(fps); });
      }
    });
    return () => { off(); queue(restoreScreens); };
  }, [autoHdr, matchRate]);
}
