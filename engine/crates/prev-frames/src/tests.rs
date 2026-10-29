//! Run against a real mpv. Skipped (with a note) where mpv or ffmpeg isn't
//! installed, so CI without them stays green.

use super::*;
use std::path::Path;
use std::process::Command;

fn have(tool: &str) -> bool {
    Command::new(tool).arg("-version").output().is_ok() || Command::new(tool).arg("--version").output().is_ok()
}

fn workdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("prev-frames-test-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Generate a clip with ffmpeg; returns None if this ffmpeg can't.
fn make(dir: &Path, name: &str, args: &[&str]) -> Option<String> {
    let out = dir.join(name);
    let ok = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(args)
        .arg(&out)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok.then(|| out.to_string_lossy().to_string())
}

fn hdr10_clip(dir: &Path) -> Option<String> {
    make(dir, "hdr10.mkv", &[
        "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24:d=4",
        "-f", "lavfi", "-i", "sine=f=440:d=4,aformat=channel_layouts=5.1",
        "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
        "-x265-params", "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:max-cll=1000,400:log-level=error",
        "-c:a", "eac3",
    ])
}

/// Width and height from a JPEG's SOF0/SOF2 marker.
fn jpeg_size(data_url: &str) -> (u32, u32) {
    let b64 = data_url.strip_prefix("data:image/jpeg;base64,").expect("a JPEG data URL");
    let bytes = STANDARD.decode(b64).unwrap();
    let mut i = 2;
    while i + 9 < bytes.len() {
        if bytes[i] == 0xFF && (bytes[i + 1] == 0xC0 || bytes[i + 1] == 0xC2) {
            let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            return (w, h);
        }
        i += 1;
    }
    panic!("no SOF marker");
}

macro_rules! need_tools {
    () => {
        if !have("mpv") || !have("ffmpeg") {
            eprintln!("skipped: needs mpv and ffmpeg on PATH");
            return;
        }
    };
}

#[test]
fn probes_an_hdr10_file_the_webview_could_not_open() {
    need_tools!();
    let dir = workdir("hdr");
    let Some(clip) = hdr10_clip(&dir) else { return eprintln!("skipped: ffmpeg lacks libx265") };
    let engine = FrameEngine::new("mpv");

    let p = engine.probe(&clip).unwrap();
    assert!((p.duration.unwrap() - 4.0).abs() < 0.2, "duration {:?}", p.duration);
    let v = p.video_params.unwrap();
    assert_eq!(v["gamma"], "pq");
    assert_eq!(v["max-cll"], 1000.0);
    let tracks = p.track_list.as_array().unwrap();
    assert!(tracks.iter().any(|t| t["codec"] == "hevc"));
    assert!(tracks.iter().any(|t| t["codec"] == "eac3" && t["demux-channel-count"] == 6));
    assert_eq!(jpeg_size(&p.thumbnail.unwrap()), (THUMB_WIDTH, 270), "scaled to the thumbnail width");

    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn previews_reuse_the_open_file_and_land_on_keyframes() {
    need_tools!();
    let dir = workdir("preview");
    let Some(clip) = make(&dir, "gop.mp4", &[
        "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=10", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25",
    ]) else { return };
    let engine = FrameEngine::new("mpv");

    let first = Instant::now();
    let a = engine.frame(Lane::Preview, &clip, 2.0, false).unwrap().unwrap();
    let cold = first.elapsed();
    let warm = Instant::now();
    let b = engine.frame(Lane::Preview, &clip, 7.3, false).unwrap().unwrap();
    let c = engine.frame(Lane::Preview, &clip, 9.9, false).unwrap().unwrap();
    let warm = warm.elapsed() / 2;
    assert_ne!(a, b, "different times, different frames");
    assert_ne!(b, c);
    eprintln!("preview: first {cold:?} (starts mpv), then {warm:?} per frame");
    assert!(warm < Duration::from_secs(2), "a warm preview is one seek, got {warm:?}");

    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn audio_without_cover_art_has_no_thumbnail_but_a_duration() {
    need_tools!();
    let dir = workdir("audio");
    let Some(clip) = make(&dir, "song.flac", &["-f", "lavfi", "-i", "sine=f=440:d=3", "-ar", "96000", "-c:a", "flac"]) else { return };
    let engine = FrameEngine::new("mpv");
    let p = engine.probe(&clip).unwrap();
    assert!((p.duration.unwrap() - 3.0).abs() < 0.2);
    assert!(p.thumbnail.is_none());
    assert!(p.track_list.as_array().unwrap().iter().any(|t| t["codec"] == "flac" && t["demux-samplerate"] == 96000));
    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_broken_file_is_an_error_and_the_next_file_still_works() {
    need_tools!();
    let dir = workdir("broken");
    let broken = dir.join("broken.mkv");
    std::fs::write(&broken, b"this is not a video").unwrap();
    let Some(good) = make(&dir, "ok.mp4", &["-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2", "-c:v", "libx264", "-preset", "ultrafast"]) else { return };
    let engine = FrameEngine::new("mpv");

    assert!(engine.probe(&broken.to_string_lossy()).is_err());
    let p = engine.probe(&good).expect("a fresh mpv after the failure");
    assert!(p.thumbnail.is_some());

    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn chains_scale_first_and_tone_map_only_hdr() {
    assert!(sdr_chain(THUMB_WIDTH).starts_with("lavfi=[scale=480:-2"));
    let hdr = hdr_chain(THUMB_WIDTH);
    assert!(hdr.starts_with("lavfi=[scale=480:-2,"), "scale before the expensive conversion");
    assert!(hdr.contains("tonemap=tonemap=hable") && hdr.contains("zscale=p=bt709"));
}

/// A clip whose only keyframe is its first frame, like many phone and social
/// videos: every keyframe seek lands on 0 s.
fn single_keyframe_clip(dir: &Path, secs: u32) -> Option<String> {
    make(dir, "one-gop.mp4", &[
        "-f", "lavfi", "-i", &format!("testsrc2=s=640x360:r=25:d={secs}"),
        "-c:v", "libx264", "-preset", "ultrafast", "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0",
    ])
}

#[test]
fn exact_frames_differ_every_second_where_keyframes_cannot() {
    need_tools!();
    let dir = workdir("exact");
    let Some(clip) = single_keyframe_clip(&dir, 6) else { return };
    let engine = FrameEngine::new("mpv");

    let key: Vec<String> = [1.0, 3.0, 5.0].iter().map(|&t| engine.frame(Lane::Preview, &clip, t, false).unwrap().unwrap()).collect();
    assert!(key.windows(2).all(|w| w[0] == w[1]), "one keyframe: every keyframe seek shows 0 s");

    let start = Instant::now();
    let exact: Vec<String> = [1.0, 2.0, 3.0, 4.0, 5.0].iter().map(|&t| engine.frame(Lane::Preview, &clip, t, true).unwrap().unwrap()).collect();
    eprintln!("exact frames: {:?} each", start.elapsed() / 5);
    for (i, a) in exact.iter().enumerate() {
        assert!(exact[i + 1..].iter().all(|b| a != b), "frame at {}s is unique", i + 1);
    }

    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn storyboard_has_a_frame_for_every_second() {
    need_tools!();
    let dir = workdir("storyboard");
    let Some(clip) = single_keyframe_clip(&dir, 6) else { return };
    let engine = FrameEngine::new("mpv");

    let start = Instant::now();
    let board = engine.storyboard(&clip).unwrap().expect("a 6 s clip is cheap");
    eprintln!("storyboard of 6 s: {:?}", start.elapsed());
    assert_eq!(board.step, 1.0);
    assert_eq!(board.frames.len(), 6, "0 s … 5 s");
    assert_eq!(jpeg_size(&board.frames[0]).0, STORYBOARD_WIDTH);
    for (i, a) in board.frames.iter().enumerate() {
        assert!(board.frames[i + 1..].iter().all(|b| a != b), "second {i} is its own frame");
    }
    // The storyboard's frame at 3 s is the exact frame at 3 s, not the keyframe.
    assert_ne!(board.frames[3], board.frames[0]);

    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn releasing_the_preview_lane_stops_a_storyboard() {
    need_tools!();
    let dir = workdir("storyboard-stop");
    let Some(clip) = make(&dir, "long.mp4", &[
        "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=40", "-c:v", "libx264", "-preset", "ultrafast",
    ]) else { return };
    let engine = Arc::new(FrameEngine::new("mpv"));
    let worker = {
        let (engine, clip) = (engine.clone(), clip.clone());
        std::thread::spawn(move || engine.storyboard(&clip))
    };
    std::thread::sleep(Duration::from_millis(600));
    let start = Instant::now();
    engine.release(Lane::Preview);
    let result = worker.join().unwrap().unwrap();
    assert!(result.is_none(), "a stopped storyboard returns nothing");
    assert!(start.elapsed() < Duration::from_secs(3), "stops promptly");
    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn storyboards_only_where_a_full_pass_is_cheap() {
    let (hd, uhd, eight_k) = (1920.0 * 1080.0, 3840.0 * 2160.0, 7680.0 * 4320.0);
    assert!(storyboard_affordable(hd, 14.0), "a phone clip");
    assert!(storyboard_affordable(hd, 600.0), "ten minutes of 1080p");
    assert!(!storyboard_affordable(hd, 601.0));
    assert!(storyboard_affordable(uhd, 150.0) && !storyboard_affordable(uhd, 151.0));
    assert!(!storyboard_affordable(eight_k, 326.0), "an 8K trailer: on demand instead");
    assert!(!storyboard_affordable(0.0, 10.0), "no picture");
}

#[test]
fn an_exact_frame_right_after_a_keyframe_is_really_exact() {
    // Back to back, with no pause between: the sequence that used to capture
    // the keyframe again, because mpv's own refresh after the filters were set
    // ended with a playback-restart the next grab took for its own.
    need_tools!();
    let dir = workdir("race");
    let Some(clip) = single_keyframe_clip(&dir, 8) else { return };
    for _ in 0..3 {
        let engine = FrameEngine::new("mpv");
        let start = engine.frame(Lane::Preview, &clip, 1.0, false).unwrap().unwrap();
        let key = engine.frame(Lane::Preview, &clip, 3.0, false).unwrap().unwrap();
        let exact = engine.frame(Lane::Preview, &clip, 3.0, true).unwrap().unwrap();
        assert_eq!(start, key, "one keyframe");
        assert_ne!(key, exact, "the exact frame at 3 s is not the keyframe");
        let later = engine.frame(Lane::Preview, &clip, 6.0, true).unwrap().unwrap();
        assert_ne!(exact, later);
        engine.shutdown();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_the_other_lane_has_seen_opens_without_a_redo() {
    need_tools!();
    let dir = workdir("known");
    let Some(clip) = hdr10_clip(&dir) else { return eprintln!("skipped: ffmpeg lacks libx265") };
    let engine = FrameEngine::new("mpv");
    engine.probe(&clip).unwrap(); // the library learns it is HDR
    let a = engine.frame(Lane::Preview, &clip, 1.0, true).unwrap().unwrap();
    assert_eq!(jpeg_size(&a), (THUMB_WIDTH, 270), "already filtered and scaled");
    engine.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
