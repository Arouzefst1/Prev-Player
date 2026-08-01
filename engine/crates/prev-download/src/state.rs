//! Resume state, in SQLite.
//!
//! The only durable thing about a download is this row: which chunks landed.
//! Because that is a packed bitmap (see [`prev_core::ChunkMap`]), flushing it
//! is a sub-kilobyte write even for a 100 GB transfer, so it can be persisted
//! often enough that a power cut costs seconds of work rather than hours.
//!
//! Calls are synchronous. A SQLite write of this size is measured in
//! microseconds, so wrapping it in async plumbing would cost more than it saves.

use prev_core::{ChunkMap, EngineError, Result, TransferState};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub name: String,
    pub url: String,
    pub transport: String,
    /// Final resting place once complete.
    pub dest: String,
    /// The single in-progress file every worker writes into.
    pub partial: String,
    pub total: u64,
    pub chunk_size: u32,
    pub chunks_total: u32,
    pub chunks_done: u32,
    pub state: TransferState,
    pub sha256: Option<String>,
    pub hash_url: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl DownloadRecord {
    pub fn transferred(&self) -> u64 {
        let plan = prev_core::ChunkPlan::new(self.total, self.chunk_size);
        if self.chunks_done == 0 {
            0
        } else if self.chunks_done >= self.chunks_total {
            self.total
        } else {
            // Approximation for display only; the authoritative figure comes
            // from the live ChunkMap while a job is running.
            self.chunks_done as u64 * plan.chunk_size as u64
        }
    }
}

pub struct StateStore {
    conn: Mutex<Connection>,
}

impl StateStore {
    /// Open (creating if needed) the state database.
    ///
    /// Any row still marked `running` was interrupted by a crash or a force
    /// quit, so it is demoted to `paused` — the user can resume it, and nothing
    /// claims to be transferring when no worker exists.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path).map_err(|e| EngineError::State(e.to_string()))?;
        Self::init(&conn)?;
        let store = Self { conn: Mutex::new(conn) };
        store.demote_orphans()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(|e| EngineError::State(e.to_string()))?;
        Self::init(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn init(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS downloads (
                 id           TEXT PRIMARY KEY,
                 name         TEXT NOT NULL,
                 url          TEXT NOT NULL,
                 transport    TEXT NOT NULL,
                 dest         TEXT NOT NULL,
                 partial      TEXT NOT NULL,
                 total        INTEGER NOT NULL,
                 chunk_size   INTEGER NOT NULL,
                 chunks_total INTEGER NOT NULL,
                 chunks_done  INTEGER NOT NULL DEFAULT 0,
                 map          BLOB,
                 state        TEXT NOT NULL,
                 sha256       TEXT,
                 hash_url     TEXT,
                 error        TEXT,
                 created_at   INTEGER NOT NULL,
                 updated_at   INTEGER NOT NULL
             );",
        )
        .map_err(|e| EngineError::State(e.to_string()))
    }

    fn demote_orphans(&self) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE downloads SET state = 'paused' WHERE state IN ('running', 'verifying')",
                [],
            )
            .map(|_| ())
            .map_err(|e| EngineError::State(e.to_string()))
    }

    pub fn insert(&self, rec: &DownloadRecord, map: &ChunkMap) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO downloads
                 (id,name,url,transport,dest,partial,total,chunk_size,chunks_total,chunks_done,
                  map,state,sha256,hash_url,error,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![
                    rec.id,
                    rec.name,
                    rec.url,
                    rec.transport,
                    rec.dest,
                    rec.partial,
                    rec.total as i64,
                    rec.chunk_size as i64,
                    rec.chunks_total as i64,
                    map.done() as i64,
                    map.to_bytes(),
                    rec.state.as_str(),
                    rec.sha256,
                    rec.hash_url,
                    rec.error,
                    rec.created_at,
                    rec.updated_at,
                ],
            )
            .map(|_| ())
            .map_err(|e| EngineError::State(e.to_string()))
    }

    /// The hot path: persist which chunks have landed.
    pub fn save_progress(&self, id: &str, map: &ChunkMap) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE downloads SET map = ?1, chunks_done = ?2, updated_at = ?3 WHERE id = ?4",
                params![map.to_bytes(), map.done() as i64, now(), id],
            )
            .map(|_| ())
            .map_err(|e| EngineError::State(e.to_string()))
    }

    pub fn set_state(&self, id: &str, state: TransferState, error: Option<&str>) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE downloads SET state = ?1, error = ?2, updated_at = ?3 WHERE id = ?4",
                params![state.as_str(), error, now(), id],
            )
            .map(|_| ())
            .map_err(|e| EngineError::State(e.to_string()))
    }

    pub fn set_sha256(&self, id: &str, sha: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE downloads SET sha256 = ?1, updated_at = ?2 WHERE id = ?3",
                params![sha, now(), id],
            )
            .map(|_| ())
            .map_err(|e| EngineError::State(e.to_string()))
    }

    pub fn load(&self, id: &str) -> Result<Option<(DownloadRecord, ChunkMap)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM downloads WHERE id = ?1")
            .map_err(|e| EngineError::State(e.to_string()))?;
        stmt.query_row(params![id], row_to_record)
            .optional()
            .map_err(|e| EngineError::State(e.to_string()))
    }

    pub fn all(&self) -> Result<Vec<(DownloadRecord, ChunkMap)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM downloads ORDER BY created_at DESC")
            .map_err(|e| EngineError::State(e.to_string()))?;
        let rows = stmt
            .query_map([], row_to_record)
            .map_err(|e| EngineError::State(e.to_string()))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| EngineError::State(e.to_string()))
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM downloads WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(|e| EngineError::State(e.to_string()))
    }

    /// Drop finished rows whose destination file no longer exists — the user
    /// deleted the media, so the history entry is noise.
    pub fn prune_missing(&self) -> Result<usize> {
        let stale: Vec<String> = self
            .all()?
            .into_iter()
            .filter(|(r, _)| r.state == TransferState::Completed && !PathBuf::from(&r.dest).exists())
            .map(|(r, _)| r.id)
            .collect();
        for id in &stale {
            self.remove(id)?;
        }
        Ok(stale.len())
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<(DownloadRecord, ChunkMap)> {
    let chunks_total: i64 = row.get("chunks_total")?;
    let blob: Option<Vec<u8>> = row.get("map")?;
    let map = match blob {
        Some(b) => ChunkMap::from_bytes(chunks_total as u32, &b),
        None => ChunkMap::new(chunks_total as u32),
    };
    let state: String = row.get("state")?;
    let rec = DownloadRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        url: row.get("url")?,
        transport: row.get("transport")?,
        dest: row.get("dest")?,
        partial: row.get("partial")?,
        total: row.get::<_, i64>("total")? as u64,
        chunk_size: row.get::<_, i64>("chunk_size")? as u32,
        chunks_total: chunks_total as u32,
        chunks_done: map.done(),
        state: parse_state(&state),
        sha256: row.get("sha256")?,
        hash_url: row.get("hash_url")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    };
    Ok((rec, map))
}

fn parse_state(s: &str) -> TransferState {
    match s {
        "queued" => TransferState::Queued,
        "running" => TransferState::Running,
        "paused" => TransferState::Paused,
        "verifying" => TransferState::Verifying,
        "completed" => TransferState::Completed,
        "cancelled" => TransferState::Cancelled,
        _ => TransferState::Failed,
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> DownloadRecord {
        DownloadRecord {
            id: id.into(),
            name: "Movie.mkv".into(),
            url: "http://h/s/1".into(),
            transport: "lan".into(),
            dest: "C:/dl/Movie.mkv".into(),
            partial: "C:/dl/Movie.mkv.partial".into(),
            total: 1000,
            chunk_size: 100,
            chunks_total: 10,
            chunks_done: 0,
            state: TransferState::Running,
            sha256: None,
            hash_url: Some("http://h/h/1".into()),
            error: None,
            created_at: now(),
            updated_at: now(),
        }
    }

    #[test]
    fn round_trips_a_record_and_its_chunk_map() {
        let store = StateStore::open_in_memory().unwrap();
        let rec = record("d1");
        let mut map = ChunkMap::new(10);
        map.set(0);
        map.set(3);
        store.insert(&rec, &map).unwrap();

        let (got, got_map) = store.load("d1").unwrap().unwrap();
        assert_eq!(got.name, "Movie.mkv");
        assert_eq!(got.chunks_done, 2);
        assert_eq!(got.hash_url.as_deref(), Some("http://h/h/1"));
        assert!(got_map.has(0) && got_map.has(3) && !got_map.has(1));
    }

    #[test]
    fn progress_updates_are_incremental() {
        let store = StateStore::open_in_memory().unwrap();
        let mut map = ChunkMap::new(10);
        store.insert(&record("d1"), &map).unwrap();

        for i in 0..7 {
            map.set(i);
        }
        store.save_progress("d1", &map).unwrap();

        let (rec, got) = store.load("d1").unwrap().unwrap();
        assert_eq!(rec.chunks_done, 7);
        assert_eq!(got.done(), 7);
        assert_eq!(got.missing().collect::<Vec<_>>(), vec![7, 8, 9]);
    }

    #[test]
    fn state_transitions_and_errors_persist() {
        let store = StateStore::open_in_memory().unwrap();
        store.insert(&record("d1"), &ChunkMap::new(10)).unwrap();
        store.set_state("d1", TransferState::Failed, Some("network unreachable")).unwrap();
        let (rec, _) = store.load("d1").unwrap().unwrap();
        assert_eq!(rec.state, TransferState::Failed);
        assert_eq!(rec.error.as_deref(), Some("network unreachable"));
    }

    #[test]
    fn a_crash_leaves_no_row_claiming_to_be_running() {
        let dir = std::env::temp_dir().join(format!("prev-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("state.db");
        let _ = std::fs::remove_file(&db);

        {
            let store = StateStore::open(&db).unwrap();
            store.insert(&record("d1"), &ChunkMap::new(10)).unwrap();
            // Process dies here — the row still says "running".
        }

        let store = StateStore::open(&db).unwrap();
        let (rec, _) = store.load("d1").unwrap().unwrap();
        assert_eq!(rec.state, TransferState::Paused, "an orphaned job must be resumable, not 'running'");

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_newest_first_and_removes() {
        let store = StateStore::open_in_memory().unwrap();
        let mut a = record("a");
        a.created_at = 100;
        let mut b = record("b");
        b.created_at = 200;
        store.insert(&a, &ChunkMap::new(10)).unwrap();
        store.insert(&b, &ChunkMap::new(10)).unwrap();

        let all = store.all().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].0.id, "b");

        store.remove("b").unwrap();
        assert_eq!(store.all().unwrap().len(), 1);
        assert!(store.load("b").unwrap().is_none());
    }
}
