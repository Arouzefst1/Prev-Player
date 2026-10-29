// ===========================================================================
// Blu-ray and DVD: is this path a disc, and what's on it?
//
// A disc is the folder holding BDMV / VIDEO_TS (or that folder itself), or an
// .iso image of one. mpv plays it through libbluray / libdvdnav with the path
// as the device — the main feature, its chapters, every audio and subtitle
// stream. (Encrypted discs need the user's own keys, as with any player.)
//
// For a Blu-ray folder this also lists the titles worth offering — playlists
// (BDMV/PLAYLIST/*.mpls) a minute or longer, longest first, duplicates folded —
// so the player can switch to an extra or another cut. Read from the playlist
// files themselves, which take microseconds; nothing is decoded.
// ===========================================================================

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disc {
    /// "bluray" | "dvd"
    pub kind: &'static str,
    /// The device mpv opens: the folder holding BDMV / VIDEO_TS, or the .iso.
    pub root: String,
    /// What to call it: the folder or image name.
    pub label: String,
    /// Blu-ray folders only; empty means "let mpv pick the longest".
    pub titles: Vec<Title>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Title {
    /// The playlist number: 00800.mpls → 800 (mpv: bd://mpls/800).
    pub playlist: u32,
    pub seconds: f64,
    pub chapters: u32,
}

/// The disc at `path`, or None when it isn't one.
#[tauri::command]
pub async fn disc_probe(path: String) -> Option<Disc> {
    tauri::async_runtime::spawn_blocking(move || probe(Path::new(&path))).await.ok().flatten()
}

pub fn probe(path: &Path) -> Option<Disc> {
    if path.is_file() {
        let is_iso = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("iso"));
        return if is_iso { probe_iso(path) } else { None };
    }
    if !path.is_dir() {
        return None;
    }
    let (kind, root) = disc_root(path)?;
    let titles = if kind == "bluray" { bluray_titles(&root.join("BDMV").join("PLAYLIST")) } else { Vec::new() };
    Some(Disc { kind, label: label_of(&root), root: root.to_string_lossy().into_owned(), titles })
}

/// ("bluray" | "dvd", the folder above BDMV / VIDEO_TS).
fn disc_root(dir: &Path) -> Option<(&'static str, PathBuf)> {
    let has = |p: PathBuf| p.is_file();
    if has(dir.join("BDMV").join("index.bdmv")) {
        return Some(("bluray", dir.to_path_buf()));
    }
    if has(dir.join("VIDEO_TS").join("VIDEO_TS.IFO")) {
        return Some(("dvd", dir.to_path_buf()));
    }
    // Pointed at BDMV / VIDEO_TS itself.
    let name = dir.file_name()?.to_string_lossy().to_ascii_uppercase();
    let parent = dir.parent().unwrap_or(dir).to_path_buf();
    match name.as_str() {
        "BDMV" if has(dir.join("index.bdmv")) => Some(("bluray", parent)),
        "VIDEO_TS" if has(dir.join("VIDEO_TS.IFO")) => Some(("dvd", parent)),
        _ => None,
    }
}

fn label_of(root: &Path) -> String {
    // An image's extension goes; a folder keeps its whole name ("Heat.1995").
    let name = if root.is_file() { root.file_stem() } else { root.file_name() };
    name.map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        // A drive root ("E:\") has no name.
        .unwrap_or_else(|| root.to_string_lossy().trim_end_matches(['\\', '/']).to_string())
}

/// How far into an image to look for the disc's folder names. UDF and ISO 9660
/// keep their directories near the start; a real file system's first 64 MB
/// are plenty, and an image that's neither stops being read there.
const ISO_SCAN: usize = 64 << 20;

fn probe_iso(path: &Path) -> Option<Disc> {
    let kind = iso_kind(fs::File::open(path).ok()?, ISO_SCAN)?;
    Some(Disc { kind, root: path.to_string_lossy().into_owned(), label: label_of(path), titles: Vec::new() })
}

/// Blu-ray if the image names a BDMV folder, DVD if it names VIDEO_TS. UDF
/// stores 8-bit names after a compression byte of 8; ISO 9660 as plain ASCII.
fn iso_kind(mut image: impl Read, limit: usize) -> Option<&'static str> {
    const CHUNK: usize = 1 << 20;
    let mut buf = vec![0u8; CHUNK + 16];
    let mut carry = 0usize; // bytes kept from the last chunk, so a name split across reads still matches
    let mut read = 0usize;
    let mut dvd = false;
    while read < limit {
        let n = image.read(&mut buf[carry..carry + CHUNK]).ok()?;
        if n == 0 {
            break;
        }
        read += n;
        let window = &buf[..carry + n];
        if contains(window, b"\x08BDMV") || contains(window, b"BDMV\x00") {
            return Some("bluray");
        }
        dvd |= contains(window, b"VIDEO_TS");
        carry = 15.min(window.len());
        let tail = window.len() - carry;
        buf.copy_within(tail..tail + carry, 0);
    }
    dvd.then_some("dvd")
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The titles worth offering from a BDMV/PLAYLIST folder, longest first.
fn bluray_titles(dir: &Path) -> Vec<Title> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(Title, Vec<u8>)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            let number: u32 = name.strip_suffix(".mpls")?.parse().ok()?;
            let bytes = fs::read(e.path()).ok()?;
            let (seconds, chapters, clips) = parse_mpls(&bytes)?;
            Some((Title { playlist: number, seconds, chapters }, clips))
        })
        .collect();
    // Longest first; between equals, the lower number (usually the original).
    found.sort_by(|a, b| b.0.seconds.total_cmp(&a.0.seconds).then(a.0.playlist.cmp(&b.0.playlist)));
    // Discs carry many copies of the same cut (and decoys): one per clip list.
    let mut seen: Vec<Vec<u8>> = Vec::new();
    found.retain(|(_, clips)| {
        if seen.contains(clips) {
            return false;
        }
        seen.push(clips.clone());
        true
    });
    let long: Vec<Title> = found.iter().filter(|(t, _)| t.seconds >= 60.0).map(|(t, _)| t.clone()).collect();
    let mut titles = if long.is_empty() { found.into_iter().map(|(t, _)| t).collect() } else { long };
    titles.truncate(12);
    titles
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// (seconds, chapters, the clip names in order) from an .mpls playlist.
/// Times are 45 kHz ticks; a chapter is an "entry mark" (type 1).
fn parse_mpls(b: &[u8]) -> Option<(f64, u32, Vec<u8>)> {
    if b.get(0..4)? != b"MPLS" {
        return None;
    }
    let list = be32(b, 8)? as usize;
    let marks = be32(b, 12)? as usize;
    let items = be16(b, list + 6)? as usize;
    let mut at = list + 10;
    let mut ticks: u64 = 0;
    let mut clips = Vec::new();
    for _ in 0..items {
        let len = be16(b, at)? as usize;
        let item = at + 2;
        clips.extend_from_slice(b.get(item..item + 5)?);
        let (start, end) = (be32(b, item + 12)?, be32(b, item + 16)?);
        ticks += end.saturating_sub(start) as u64;
        at = item + len;
    }
    let count = be16(b, marks + 4)? as usize;
    let chapters = (0..count)
        .filter(|i| b.get(marks + 6 + i * 14 + 1) == Some(&1))
        .count() as u32;
    Some((ticks as f64 / 45_000.0, chapters, clips))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal .mpls: the given (clip, seconds) play items and `chapters` entry marks.
    fn mpls(items: &[(&str, u32)], chapters: usize) -> Vec<u8> {
        let mut list = Vec::new();
        list.extend_from_slice(&[0, 0]); // reserved
        list.extend_from_slice(&(items.len() as u16).to_be_bytes());
        list.extend_from_slice(&0u16.to_be_bytes()); // sub-paths
        for (clip, secs) in items {
            let mut item = Vec::new();
            item.extend_from_slice(clip.as_bytes());
            item.extend_from_slice(b"M2TS");
            item.extend_from_slice(&[0, 1, 0]); // flags, STC id
            item.extend_from_slice(&1000u32.to_be_bytes());
            item.extend_from_slice(&(1000 + secs * 45_000).to_be_bytes());
            item.extend_from_slice(&[0; 12]);
            list.extend_from_slice(&(item.len() as u16).to_be_bytes());
            list.extend_from_slice(&item);
        }
        let mut marks = Vec::new();
        marks.extend_from_slice(&(chapters as u16 + 1).to_be_bytes());
        for i in 0..chapters {
            marks.extend_from_slice(&[0, 1]);
            marks.extend_from_slice(&[0, 0]);
            marks.extend_from_slice(&(i as u32 * 45_000 * 60).to_be_bytes());
            marks.extend_from_slice(&[0xff, 0xff, 0, 0, 0, 0]);
        }
        marks.extend_from_slice(&[0, 2, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0]); // a link point, not a chapter
        let list_at = 40u32;
        let marks_at = list_at + 4 + list.len() as u32;
        let mut out = b"MPLS0200".to_vec();
        out.extend_from_slice(&list_at.to_be_bytes());
        out.extend_from_slice(&marks_at.to_be_bytes());
        out.resize(40, 0);
        out.extend_from_slice(&(list.len() as u32).to_be_bytes());
        out.extend_from_slice(&list);
        out.extend_from_slice(&(marks.len() as u32).to_be_bytes());
        out.extend_from_slice(&marks);
        out
    }

    #[test]
    fn reads_a_playlist() {
        let (secs, chapters, clips) = parse_mpls(&mpls(&[("00001", 3600), ("00002", 1800)], 24)).unwrap();
        assert_eq!(secs, 5400.0);
        assert_eq!(chapters, 24);
        assert_eq!(clips, b"0000100002");
        assert!(parse_mpls(b"nope").is_none());
        assert!(parse_mpls(b"MPLS0200\0\0").is_none());
    }

    /// A fresh folder called `name`, inside a temp folder of its own.
    fn temp(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("prev-disc-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bluray_folder_lists_its_titles() {
        let root = temp("Dune.Part.Two.2024");
        let pl = root.join("BDMV").join("PLAYLIST");
        fs::create_dir_all(&pl).unwrap();
        fs::write(root.join("BDMV").join("index.bdmv"), b"INDX0200").unwrap();
        fs::write(pl.join("00800.mpls"), mpls(&[("00055", 9960)], 40)).unwrap(); // the film
        fs::write(pl.join("00801.mpls"), mpls(&[("00055", 9960)], 40)).unwrap(); // decoy copy
        fs::write(pl.join("00010.mpls"), mpls(&[("00020", 1260)], 6)).unwrap(); // making-of
        fs::write(pl.join("00002.mpls"), mpls(&[("00003", 12)], 0)).unwrap(); // studio logo

        for path in [root.clone(), root.join("BDMV")] {
            let disc = probe(&path).unwrap();
            assert_eq!(disc.kind, "bluray");
            assert_eq!(PathBuf::from(&disc.root), root);
            assert_eq!(disc.label, "Dune.Part.Two.2024");
            let got: Vec<(u32, u32, u32)> = disc.titles.iter().map(|t| (t.playlist, t.seconds as u32, t.chapters)).collect();
            assert_eq!(got, vec![(800, 9960, 40), (10, 1260, 6)]);
        }
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn dvd_folder() {
        let root = temp("Amelie");
        fs::create_dir_all(root.join("VIDEO_TS")).unwrap();
        fs::write(root.join("VIDEO_TS").join("VIDEO_TS.IFO"), b"DVDVIDEO-VMG").unwrap();
        let disc = probe(&root.join("VIDEO_TS")).unwrap();
        assert_eq!((disc.kind, disc.titles.len()), ("dvd", 0));
        assert_eq!(PathBuf::from(&disc.root), root);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn ordinary_folders_and_files_are_not_discs() {
        let root = temp("Holiday");
        fs::write(root.join("clip.mp4"), b"....").unwrap();
        fs::write(root.join("fake.iso"), vec![0u8; 4096]).unwrap();
        assert!(probe(&root).is_none());
        assert!(probe(&root.join("clip.mp4")).is_none());
        assert!(probe(&root.join("fake.iso")).is_none());
        let mut iso = vec![0u8; 1 << 20];
        iso[70_000..70_009].copy_from_slice(b"\x08VIDEO_TS");
        fs::write(root.join("Amelie (2001).iso"), iso).unwrap();
        let disc = probe(&root.join("Amelie (2001).iso")).unwrap();
        assert_eq!((disc.kind, disc.label.as_str()), ("dvd", "Amelie (2001)"));
        assert!(probe(&root.join("missing")).is_none());
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn tells_iso_images_apart() {
        // UDF file identifier: compression id 8, then the name.
        let mut bd = vec![0u8; 3 << 20];
        bd[(2 << 20) - 2..(2 << 20) + 3].copy_from_slice(b"\x08BDMV"); // straddles a read boundary
        assert_eq!(iso_kind(&bd[..], ISO_SCAN), Some("bluray"));
        let mut dvd = vec![0u8; 1 << 20];
        dvd[40_000..40_008].copy_from_slice(b"VIDEO_TS");
        assert_eq!(iso_kind(&dvd[..], ISO_SCAN), Some("dvd"));
        assert_eq!(iso_kind(&vec![0u8; 1 << 20][..], ISO_SCAN), None);
        // Past the scan limit doesn't count.
        let mut late = vec![0u8; 3 << 20];
        late[(3 << 20) - 10..(3 << 20) - 2].copy_from_slice(b"VIDEO_TS");
        assert_eq!(iso_kind(&late[..], 1 << 20), None);
    }
}
