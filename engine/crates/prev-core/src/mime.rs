//! Media MIME types, by file extension.
//!
//! The engine itself is format-blind — it moves byte ranges and never looks
//! inside them — so this table exists purely for the benefit of clients that
//! sniff `Content-Type`.
//!
//! It matters mostly for **browsers**, which decide whether to play inline or
//! download based on this header alone. Players like mpv and VLC probe the
//! actual bytes and ignore it, so an unknown extension costs them nothing.
//!
//! Shared by the share server and the playback endpoint, which previously kept
//! two tables that had already drifted apart.

pub fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        // -- video containers ------------------------------------------------
        "mp4" | "m4v" | "mp4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" | "qt" => "video/quicktime",
        "avi" | "divx" => "video/x-msvideo",
        "wmv" | "asf" => "video/x-ms-asf",
        "flv" | "f4v" => "video/x-flv",
        "ts" | "m2ts" | "mts" | "m2t" => "video/mp2t",
        "mpg" | "mpeg" | "m2v" | "mpe" | "m1v" => "video/mpeg",
        "vob" => "video/dvd",
        "ogv" => "video/ogg",
        "3gp" => "video/3gpp",
        "3g2" => "video/3gpp2",
        "rm" | "rmvb" => "application/vnd.rn-realmedia",
        "mxf" => "application/mxf",

        // -- audio -----------------------------------------------------------
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "m4r" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "wav" | "wave" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wma" => "audio/x-ms-wma",
        "ac3" => "audio/ac3",
        "eac3" => "audio/eac3",
        "dts" | "dtshd" => "audio/vnd.dts",
        "mka" => "audio/x-matroska",
        "aif" | "aiff" => "audio/aiff",
        "ape" => "audio/x-ape",
        "wv" => "audio/x-wavpack",
        "mid" | "midi" => "audio/midi",

        // -- subtitles -------------------------------------------------------
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        "ass" | "ssa" => "text/x-ssa",
        "sub" | "idx" => "application/octet-stream",

        // Unknown: let the client sniff. Players do this anyway.
        _ => "application/octet-stream",
    }
}

/// Does this look like something a player would open? Used to filter a folder
/// share, not to gate transfers — the engine will happily move any file.
pub fn is_media(name: &str) -> bool {
    content_type(name) != "application/octet-stream"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_the_containers_people_actually_have() {
        // The formats the native engine exists to support.
        assert_eq!(content_type("Movie.mkv"), "video/x-matroska");
        assert_eq!(content_type("Movie.avi"), "video/x-msvideo");
        assert_eq!(content_type("Movie.wmv"), "video/x-ms-asf");
        assert_eq!(content_type("clip.m2ts"), "video/mp2t");
        assert_eq!(content_type("VTS_01_1.VOB"), "video/dvd");
        assert_eq!(content_type("phone.3gp"), "video/3gpp");
        assert_eq!(content_type("track.mka"), "audio/x-matroska");
        assert_eq!(content_type("track.dts"), "audio/vnd.dts");
        assert_eq!(content_type("subs.ass"), "text/x-ssa");
    }

    #[test]
    fn is_case_insensitive_because_windows_is() {
        assert_eq!(content_type("MOVIE.MKV"), content_type("movie.mkv"));
        assert_eq!(content_type("Clip.Mp4"), "video/mp4");
    }

    #[test]
    fn unknown_extensions_fall_back_rather_than_guessing() {
        assert_eq!(content_type("archive.7z"), "application/octet-stream");
        assert_eq!(content_type("no-extension"), "application/octet-stream");
        assert_eq!(content_type(""), "application/octet-stream");
        assert!(!is_media("notes.txt"));
        assert!(is_media("film.mkv"));
    }

    #[test]
    fn a_dotted_release_name_uses_only_the_last_extension() {
        assert_eq!(content_type("Movie.2024.1080p.BluRay.x265.mkv"), "video/x-matroska");
    }
}
