# Library Drag Reorder, Folders/Playlists & Playback Controls

Add drag-to-reorder in the library, a tab system with Videos + Folders (playlists), and playlist playback controls (shuffle, loop, sequential).

## Proposed Changes

### 1. Storage Layer — Folders/Playlists Persistence

#### [MODIFY] [utils.ts](file:///f:/Program/Python/video%20player/Video-player/utils.ts)

Add a `folderStore` alongside the existing `videoStore` using a new IndexedDB object store:

```typescript
interface VideoFolder {
  id: string;
  name: string;
  videoIds: string[];    // Ordered list of video IDs
  createdAt: number;
  color?: string;        // Accent color for folder icon
}
```

- `folderStore.save(folder)`, `folderStore.delete(id)`, `folderStore.getAll()`
- Also add a `videoOrder` store to persist the user's custom video ordering in the "Videos" tab
- Bump IndexedDB version from 1 → 2 to add the new object stores

---

### 2. Drag-and-Drop Reorder System

#### [MODIFY] [VideoLibrary.tsx](file:///f:/Program/Python/video%20player/Video-player/components/VideoLibrary.tsx)

**Pure vanilla drag-and-drop** (no library needed) — only in **list view** where it makes most sense:

- Add a **drag handle** (☰ three horizontal lines SVG) to each video row
- Track `draggedIndex`, `dragOverIndex` via state/refs
- On drag start: capture the dragged item, apply `opacity: 0.4` + `scale(0.98)` to the source
- On drag over: calculate drop position, show an **animated insertion line** (red bar) at the drop target
- On drag end: reorder the array and call `onReorderVideos(newOrder)` callback
- Smooth `transform` transitions on the items that shift to make room

**Animation details:**
- Items shift up/down with `transform: translateY(±itemHeight)` + `transition: transform 0.2s ease`
- Dragged item gets a slight `box-shadow` + `scale(1.02)` lift effect
- Drop target shows a 2px red line indicator

---

### 3. Tabbed Library UI — Videos + Folders

#### [MODIFY] [VideoLibrary.tsx](file:///f:/Program/Python/video%20player/Video-player/components/VideoLibrary.tsx)

Major overhaul of the component to support two tabs:

**Tab Bar** (below the header/search):
```
[ 🎬 Videos ]  [ 📁 Folders ]
```
- Pill-style active indicator with smooth slide animation
- Active tab gets red-500 underline/fill

**Videos Tab** (current behavior + drag reorder):
- Existing grid/list views with all current features
- List view gets the drag handle for reordering
- Videos shown in user's custom order (persisted)

**Folders Tab:**
- Shows folder cards in a grid (folder icon + name + video count)
- "**+ New Folder**" button — opens inline name input
- Click a folder → shows its videos in order (1st at top → last at bottom)
- Inside a folder view:
  - Header: `← Back to Folders` + folder name
  - Drag-to-reorder for videos within the folder
  - **Play All** button with shuffle/loop/sequential controls
  - **Add Videos** button → shows a picker from the library videos
  - Remove video from folder button (doesn't delete from library)

---

### 4. Playlist Playback Controls

#### [MODIFY] [VideoLibrary.tsx](file:///f:/Program/Python/video%20player/Video-player/components/VideoLibrary.tsx)

When inside a folder, show a **playback control bar** at the bottom:

| Button | Icon | Behavior |
|--------|------|----------|
| **Shuffle** | 🔀 Crossed arrows SVG | Randomize video order for playback |
| **Loop** | 🔁 Loop arrows SVG | After last video, restart from first |
| **Sequential** | ⏭ Skip-forward SVG | Play 1st → 2nd → ... → last, then stop |
| **Play All** | ▶ Play button | Start playback from first video |

- Active states: filled/red icon when enabled
- Smooth toggle animations (scale bounce + color transition)

#### [MODIFY] [App.tsx](file:///f:/Program/Python/video%20player/Video-player/App.tsx)

- Add `playFolderPlaylist(folder, mode)` handler
- Accepts shuffle/loop/sequential modes
- Creates a playlist from folder's video IDs (in order or shuffled)
- Manages `onEnded` to play next video or loop
- New state: `playlistMode: 'sequential' | 'loop' | 'shuffle'`
- New state: `folders: VideoFolder[]`
- New callbacks: `onReorderVideos`, `onCreateFolder`, `onDeleteFolder`, `onAddToFolder`, `onRemoveFromFolder`, `onReorderFolder`

---

### 5. New Props Flow

```
App.tsx
 ├─ folders state (from folderStore)
 ├─ videoOrder state (custom ordering)
 ├─ playlistMode state
 │
 └─ VideoLibrary
      ├─ videos (ordered by videoOrder)
      ├─ folders
      ├─ onReorderVideos(newOrder)
      ├─ onCreateFolder(name)
      ├─ onDeleteFolder(id)
      ├─ onAddToFolder(folderId, videoIds)
      ├─ onRemoveFromFolder(folderId, videoId)
      ├─ onReorderFolder(folderId, newVideoIds)
      └─ onPlayFolder(folderId, mode)
```

---

## Open Questions

> [!IMPORTANT]
> **Folder video picker**: When adding videos to a folder, should it show a checklist of all library videos, or should you also be able to drag-drop from the Videos tab?

> [!NOTE]
> **Grid view drag**: Drag-to-reorder will only work in **list view** since grid reordering is awkward with varying sizes. Grid view will remain read-only. Is this acceptable?

## Verification Plan

### Automated Tests
- TypeScript compilation check (`npx tsc --noEmit`)
- Dev server runs without errors

### Manual Verification  
- Drag handle appears on list view items
- Dragging shows animation (lift, shift, insertion indicator)
- Drop reorders correctly and persists on refresh
- Tabs switch smoothly with animation
- Folders can be created, renamed, deleted
- Videos can be added to/removed from folders
- Play All / Shuffle / Loop work correctly for folder playlists
- Sequential playback advances through folder videos in order
