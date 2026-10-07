use std::{
    fs,
    path::{Path, PathBuf},
};

use log::{info, warn};
use serde::Serialize;
use specta::Type;
use tauri::{webview::PlatformWebview, AppHandle, Manager};

use crate::{error::Error, AppState};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct IndexRemoval {
    pub removed: u32,
    pub failed: u32,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearCachesResult {
    pub removed_indexes: u32,
    pub failed_indexes: u32,
    pub webview_cleared: bool,
}

/// Clears every cache of the app (backend memory, search indexes, webview HTTP
/// cache) without touching user data such as settings stored in localStorage.
#[tauri::command]
#[specta::specta]
pub async fn clear_app_caches(
    databases_dir: PathBuf,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ClearCachesResult, Error> {
    clear_memory_caches(&state);
    let indexes = remove_search_indexes(&databases_dir);
    let webview_cleared = match clear_webview_cache(&app).await {
        Ok(()) => true,
        Err(e) => {
            warn!("Failed to clear webview cache: {}", e);
            false
        }
    };

    Ok(ClearCachesResult {
        removed_indexes: indexes.removed,
        failed_indexes: indexes.failed,
        webview_cleared,
    })
}

async fn clear_webview_cache(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("no window labeled 'main' found")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let _ = tx.send(clear_platform_webview_cache(webview));
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

// Only the HTTP caches are cleared: the webviews' "clear all browsing data"
// APIs would also wipe localStorage, where the user's settings live.

#[cfg(target_os = "linux")]
fn clear_platform_webview_cache(webview: PlatformWebview) -> Result<(), String> {
    use webkit2gtk::{
        gio::Cancellable, glib::TimeSpan, WebContextExt, WebViewExt, WebsiteDataManagerExtManual,
        WebsiteDataTypes,
    };

    let manager = webview
        .inner()
        .context()
        .and_then(|context| context.website_data_manager())
        .ok_or("webview has no website data manager")?;
    manager.clear(
        WebsiteDataTypes::DISK_CACHE | WebsiteDataTypes::MEMORY_CACHE,
        TimeSpan::from_seconds(0),
        None::<&Cancellable>,
        |result| {
            if let Err(e) = result {
                warn!("Failed to clear webview cache: {}", e);
            }
        },
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn clear_platform_webview_cache(webview: PlatformWebview) -> Result<(), String> {
    use webview2_com::{
        ClearBrowsingDataCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
        },
    };
    use windows::core::Interface;

    unsafe {
        webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_13>())
            .and_then(|core| core.Profile())
            .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
            .and_then(|profile| {
                profile.ClearBrowsingData(
                    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                    &ClearBrowsingDataCompletedHandler::create(Box::new(|_| Ok(()))),
                )
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
fn clear_platform_webview_cache(webview: PlatformWebview) -> Result<(), String> {
    use objc2_foundation::{NSDate, NSSet};
    use objc2_web_kit::{WKWebView, WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache};

    unsafe {
        let webview: &WKWebView = &*webview.inner().cast::<WKWebView>();
        let store = webview.configuration().websiteDataStore();
        let types = NSSet::from_slice(&[WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]);
        let date = NSDate::dateWithTimeIntervalSince1970(0.0);
        let handler = block2::RcBlock::new(|| {});
        store.removeDataOfTypes_modifiedSince_completionHandler(&types, &date, &handler);
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn clear_platform_webview_cache(_webview: PlatformWebview) -> Result<(), String> {
    Err("clearing the webview cache is not supported on this platform".to_string())
}

/// Drops every in-memory cache kept by the backend. Must run before deleting
/// search index files so the preloaded mmap is released (required on Windows).
pub fn clear_memory_caches(state: &AppState) {
    *state.db_cache.lock().unwrap() = None;
    state.line_cache.clear();
    state.pgn_offsets.clear();
    crate::puzzle::clear_puzzle_cache();
}

/// Deletes the position-search index files (`*.ecsi`) found directly in `dir`.
/// They are regenerated on the next position search.
pub fn remove_search_indexes(dir: &Path) -> IndexRemoval {
    let mut result = IndexRemoval::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return result;
    };

    for path in entries.flatten().map(|entry| entry.path()) {
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "ecsi") {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                info!("Removed search index {:?}", path);
                result.removed += 1;
            }
            Err(e) => {
                warn!("Failed to remove search index {:?}: {}", path, e);
                result.failed += 1;
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use std::fs::{create_dir, write};

    use super::*;
    use crate::db::{get_index_path, MmapSearchIndex, SearchIndex};
    use tempfile::tempdir;

    #[test]
    fn remove_search_indexes_only_deletes_ecsi_files() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("games.db3");
        write(&db, b"db").unwrap();
        write(get_index_path(&db), b"index").unwrap();
        write(dir.path().join("other.ecsi"), b"index").unwrap();
        write(dir.path().join("notes.txt"), b"text").unwrap();
        let sub = dir.path().join("sub");
        create_dir(&sub).unwrap();
        write(sub.join("nested.ecsi"), b"index").unwrap();

        let result = remove_search_indexes(dir.path());

        assert_eq!(
            result,
            IndexRemoval {
                removed: 2,
                failed: 0
            }
        );
        assert!(db.exists());
        assert!(!get_index_path(&db).exists());
        assert!(!dir.path().join("other.ecsi").exists());
        assert!(dir.path().join("notes.txt").exists());
        assert!(sub.join("nested.ecsi").exists());
    }

    #[test]
    fn remove_search_indexes_on_missing_dir_does_nothing() {
        let dir = tempdir().unwrap();

        let result = remove_search_indexes(&dir.path().join("missing"));

        assert_eq!(result, IndexRemoval::default());
    }

    #[test]
    fn clear_memory_caches_drops_preloaded_index_and_pgn_offsets() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("ref.ecsi");
        SearchIndex::new().write_to(&index_path).unwrap();

        let state = AppState::default();
        *state.db_cache.lock().unwrap() = Some(MmapSearchIndex::open(&index_path).unwrap());
        state
            .pgn_offsets
            .insert("file.pgn".to_string(), vec![1, 2, 3]);

        clear_memory_caches(&state);

        assert!(state.db_cache.lock().unwrap().is_none());
        assert!(state.pgn_offsets.is_empty());
        assert!(state.line_cache.is_empty());
    }
}
