# Release notes

A release goes out by itself when a version that has no release yet lands on
`main` (see `.github/workflows/release.yml`). Its section here becomes the
release:

- the heading, `## <version> — <summary>`: the release title, and the line
  installed apps receive with the update;
- everything under it, up to the next `## `: the release's description.

Newest first.

## 1.6.1 — switching videos, instant opening, audio thumbnails, smoother seek bar

**Switching videos just works.** Picking another video from the library while
one is playing always plays the new one, short or long. No more black screen
stuck on the previous video's time.

**Files open instantly.** Opening a file while another is playing starts it
straight away.

**Audio thumbnails.** Songs and other audio files show a music tile in the
library instead of a broken picture.

**A seek bar that keeps up.** Dragging along the bar, the knob, the preview and
a thin line to the bar stay right under your pointer, however fast you move.

This release installs itself quietly in the background for anyone on 1.5.2 or newer.
