use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

// ---------- 文書 ----------

fn docs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let dir = docs.join("Fumi");
    // 旧名（Daihon）のフォルダがあれば引き継ぐ
    if migrate_enabled() {
        merge_dir(&docs.join("Daihon"), &dir);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// テスト用に引き継ぎを止めるスイッチ（FUMI_NO_MIGRATE=1）
fn migrate_enabled() -> bool {
    std::env::var_os("FUMI_NO_MIGRATE").is_none()
}

/// old の中身のうち new にまだないものを移す。使用中で移せなかったものは次回に回す。
/// 空になった old は消す。
fn merge_dir(old: &Path, new: &Path) {
    if !old.is_dir() {
        return;
    }
    if !new.exists() && fs::rename(old, new).is_ok() {
        return;
    }
    let _ = fs::create_dir_all(new);
    if let Ok(entries) = fs::read_dir(old) {
        for e in entries.flatten() {
            let to = new.join(e.file_name());
            if !to.exists() {
                let _ = fs::rename(e.path(), &to);
            } else if e.path().is_dir() && to.is_dir() {
                merge_dir(&e.path(), &to);
            }
        }
    }
    let _ = fs::remove_dir(old);
}

/// 旧名（local.daihon.editor）の設定・履歴・音声キャッシュを引き継ぐ。
/// WebView（設定の localStorage）が作られる前に呼ぶこと。
fn migrate_old_app_dirs() {
    if !migrate_enabled() {
        return;
    }
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            merge_dir(&base.join("local.daihon.editor"), &base.join("app.fumi.editor"));
        }
    }
}

/// Irodori-TTS-Server を探す（実行ファイルの上の階層と、ホームフォルダの直下）
#[tauri::command]
fn find_server_dir() -> Option<String> {
    let mut cands = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors().skip(1).take(8) {
            cands.push(dir.join("Irodori-TTS-Server"));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        cands.push(PathBuf::from(home).join("Irodori-TTS-Server"));
    }
    cands
        .into_iter()
        .find(|d| d.join("pyproject.toml").exists())
        .map(|d| d.to_string_lossy().to_string())
}

/// 文章の場所。`name` は「Fumi フォルダ内の自動名（2026-11-11-001.md）」か「自分で保存したファイルの絶対パス」
fn doc_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let p = Path::new(name);
    if p.is_absolute() {
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext != "md" && ext != "txt" && ext != "markdown" {
            return Err(format!(".md / .txt 以外は開けません: {name}"));
        }
        return Ok(p.to_path_buf());
    }
    if name.is_empty()
        || !name.ends_with(".md")
        || name.contains(['/', '\\', ':'])
        || name.starts_with('.')
    {
        return Err(format!("不正なファイル名: {name}"));
    }
    Ok(docs_dir(app)?.join(name))
}

#[derive(Serialize)]
struct DocInfo {
    name: String,
    modified: u64,
    content: String,
}

#[tauri::command]
fn list_docs(app: AppHandle) -> Result<Vec<DocInfo>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(docs_dir(&app)?).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        out.push(DocInfo { name, modified, content });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
fn read_doc(app: AppHandle, name: String) -> Result<String, String> {
    fs::read_to_string(doc_path(&app, &name)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_doc(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let path = doc_path(&app, &name)?;
    let mut tmp = path.clone().into_os_string();
    tmp.push(".fumi-tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 自動名の下書きを、自分で選んだ場所へ移す（履歴も一緒に移す）
#[tauri::command]
fn move_doc(app: AppHandle, from: String, to: String, content: String) -> Result<(), String> {
    write_doc(app.clone(), to.clone(), content)?;
    let old_hist = hist_dir(&app, &from)?;
    let new_hist = hist_dir(&app, &to)?;
    if old_hist != new_hist {
        if let Ok(entries) = fs::read_dir(&old_hist) {
            for e in entries.flatten() {
                let _ = fs::rename(e.path(), new_hist.join(e.file_name()));
            }
        }
        let _ = fs::remove_dir(&old_hist);
    }
    let old = doc_path(&app, &from)?;
    if old != doc_path(&app, &to)? {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

/// 自分で保存・オープンしたファイル（絶対パス）の情報。消えていたものは返さない
#[tauri::command]
fn stat_docs(paths: Vec<String>) -> Vec<DocInfo> {
    paths
        .into_iter()
        .filter_map(|p| {
            let path = Path::new(&p);
            if !path.is_absolute() {
                return None;
            }
            let meta = fs::metadata(path).ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(DocInfo { name: p.clone(), modified, content: fs::read_to_string(path).ok()? })
        })
        .collect()
}

/// prefix は "2026-11-11" の形。空いている連番の名前を返す。
#[tauri::command]
fn new_doc_name(app: AppHandle, prefix: String) -> Result<String, String> {
    let dir = docs_dir(&app)?;
    for n in 1..10000 {
        let name = format!("{prefix}-{n:03}.md");
        if !dir.join(&name).exists() {
            return Ok(name);
        }
    }
    Err("ファイル名を決められません".into())
}

#[tauri::command]
fn docs_folder(app: AppHandle) -> Result<String, String> {
    Ok(docs_dir(&app)?.to_string_lossy().to_string())
}

// ---------- 音声 ----------

#[derive(Deserialize, Clone)]
struct TtsReq {
    text: String,
    #[serde(default)]
    reference: Option<String>,
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    seed: Option<u64>,
    #[serde(default)]
    label: Option<String>,
    /// サーバーの voices フォルダにある声のID（ファイル名から拡張子を除いたもの）
    #[serde(default)]
    voice_id: Option<String>,
    /// 話す速さ（1.0 が標準。サーバーの speed にそのまま渡す）
    #[serde(default)]
    speed: Option<f64>,
}

fn request_body(req: &TtsReq) -> serde_json::Value {
    let mut ir = serde_json::Map::new();
    let voice_id = req.voice_id.as_deref().map(str::trim).filter(|v| !v.is_empty());
    match req.reference.as_deref().map(str::trim) {
        _ if voice_id.is_some() => {}
        Some(r) if !r.is_empty() => {
            ir.insert("ref_wav".into(), json!(r));
        }
        _ => {
            ir.insert("no_ref".into(), json!(true));
        }
    }
    if let Some(c) = req.caption.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        ir.insert("caption".into(), json!(c));
    }
    if let Some(s) = req.seed {
        ir.insert("seed".into(), json!(s));
    }
    let mut body = json!({
        "model": "irodori-tts",
        "input": req.text,
        "response_format": "wav",
        "irodori": ir,
    });
    if let Some(v) = voice_id {
        body["voice"] = json!(v);
    }
    if let Some(s) = req.speed.filter(|s| (s - 1.0).abs() > 1e-3) {
        body["speed"] = json!(s.clamp(0.25, 4.0));
    }
    body
}

// ---------- 声のライブラリ（サーバーの voices フォルダ） ----------

const VOICE_EXTS: [&str; 8] = ["wav", "flac", "mp3", "m4a", "ogg", "opus", "aac", "webm"];

fn voices_dir(server_dir: &str) -> PathBuf {
    PathBuf::from(server_dir.trim()).join("voices")
}

/// voices フォルダの音声ファイルの ID（拡張子なしのファイル名）一覧
#[tauri::command]
fn list_voice_files(server_dir: String) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(voices_dir(&server_dir))
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let p = e.path();
                    let ext = p.extension()?.to_string_lossy().to_lowercase();
                    if !VOICE_EXTS.contains(&ext.as_str()) {
                        return None;
                    }
                    Some(p.file_stem()?.to_string_lossy().to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v.dedup();
    v
}

/// 音声ファイルを voices フォルダにコピーして、声のIDを返す
#[tauri::command]
fn add_voice_file(server_dir: String, src: String) -> Result<String, String> {
    let src = PathBuf::from(src);
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| VOICE_EXTS.contains(&e.as_str()))
        .ok_or("対応していない形式です（wav / flac / mp3 / m4a / ogg / opus）")?;
    let stem: String = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "voice".into())
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let dir = voices_dir(&server_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let existing = list_voice_files(server_dir.clone());
    let mut id = stem.clone();
    let mut n = 2;
    while existing.contains(&id) {
        id = format!("{stem}_{n}");
        n += 1;
    }
    fs::copy(&src, dir.join(format!("{id}.{ext}"))).map_err(|e| e.to_string())?;
    Ok(id)
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())
}

fn cache_path(app: &AppHandle, body_str: &str) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("tts");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    Ok(cache_dir.join(format!("{:016x}.wav", fnv(body_str))))
}

/// WAV の先頭だけ読んで長さ（秒）を返す
fn wav_file_seconds(path: &Path) -> Option<f64> {
    use std::io::Read;
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len() as usize;
    let mut head = vec![0u8; 4096.min(len)];
    f.read_exact(&mut head).ok()?;
    if head.len() < 12 || &head[0..4] != b"RIFF" {
        return None;
    }
    let (mut i, mut byte_rate) = (12usize, 0u32);
    while i + 8 <= head.len() {
        let size = u32::from_le_bytes([head[i + 4], head[i + 5], head[i + 6], head[i + 7]]) as usize;
        if &head[i..i + 4] == b"fmt " && i + 20 <= head.len() {
            byte_rate = u32::from_le_bytes([head[i + 16], head[i + 17], head[i + 18], head[i + 19]]);
        }
        if &head[i..i + 4] == b"data" {
            let data = (len - (i + 8)).min(size);
            return (byte_rate > 0).then(|| data as f64 / byte_rate as f64);
        }
        i += 8 + size + (size & 1);
    }
    None
}

/// 生成済み（キャッシュにある）行の長さ。まだのものは null
#[tauri::command]
fn tts_durations(app: AppHandle, reqs: Vec<TtsReq>) -> Vec<Option<f64>> {
    reqs.iter()
        .map(|r| cache_path(&app, &request_body(r).to_string()).ok().and_then(|p| wav_file_seconds(&p)))
        .collect()
}

async fn synth(app: &AppHandle, server: &str, req: &TtsReq) -> Result<Vec<u8>, String> {
    let body = request_body(req);
    let body_str = body.to_string();
    let cache = cache_path(app, &body_str)?;
    if let Ok(bytes) = fs::read(&cache) {
        return Ok(bytes);
    }
    let url = format!("{}/v1/audio/speech", server.trim_end_matches('/'));
    let res = client()?
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("TTSサーバーに接続できません ({url}): {e}"))?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "TTSエラー {status}: {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let bytes = bytes.to_vec();
    let _ = fs::write(&cache, &bytes);
    Ok(bytes)
}

#[tauri::command]
async fn tts(app: AppHandle, server: String, req: TtsReq) -> Result<tauri::ipc::Response, String> {
    let bytes = synth(&app, &server, &req).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn tts_health(server: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/health", server.trim_end_matches('/'));
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("接続できません: {e}"))?;
    res.json().await.map_err(|e| e.to_string())
}

// ---------- TTSサーバーの起動・停止（このアプリが起動した子プロセスだけを扱う） ----------

#[derive(Default)]
struct ServerProc(Mutex<Option<Child>>);

fn find_uv() -> PathBuf {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        for rel in [".local\\bin\\uv.exe", ".cargo\\bin\\uv.exe"] {
            let p = Path::new(&home).join(rel);
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from("uv")
}

fn server_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("server.log"))
}

fn kill_tree(child: &mut Child) {
    let pid = child.id();
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd.status();
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
fn server_start(
    app: AppHandle,
    state: tauri::State<ServerProc>,
    dir: String,
    port: u16,
) -> Result<u32, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(child.id());
        }
    }
    let dir = PathBuf::from(dir.trim());
    if !dir.join("pyproject.toml").exists() {
        return Err(format!("サーバーのフォルダが見つかりません: {}", dir.display()));
    }
    let log = fs::File::create(server_log_path(&app)?).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(find_uv());
    cmd.args(["run", "--no-sync", "python", "-m", "irodori_openai_tts", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .current_dir(&dir)
        .env("IRODORI_PRELOAD", "true")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log2);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("起動できません: {e}"))?;
    let pid = child.id();
    *guard = Some(child);
    Ok(pid)
}

#[tauri::command]
fn server_stop(state: tauri::State<ServerProc>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        kill_tree(&mut child);
    }
    Ok(())
}

#[tauri::command]
fn server_running(state: tauri::State<ServerProc>) -> Result<bool, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(match guard.as_mut() {
        Some(c) => c.try_wait().map_err(|e| e.to_string())?.is_none(),
        None => false,
    })
}

#[tauri::command]
fn server_log(app: AppHandle) -> Result<String, String> {
    let text = fs::read(server_log_path(&app)?)
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    Ok(lines[lines.len().saturating_sub(30)..].join("\n"))
}

// ---------- 履歴 ----------

fn hist_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    doc_path(app, name)?; // 名前の検証
    // 自分で保存したファイルはパスのハッシュでフォルダを分ける
    let key = if Path::new(name).is_absolute() {
        format!("file-{:016x}", fnv(&name.to_lowercase()))
    } else {
        name.trim_end_matches(".md").to_string()
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history")
        .join(key);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn hist_list(dir: &Path) -> Vec<u64> {
    let mut v: Vec<u64> = fs::read_dir(dir)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md")?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// 直前の版が60秒以内なら置き換える（1分より細かい版は残さない）。force なら必ず新しい版にする。
#[tauri::command]
fn history_add(app: AppHandle, name: String, content: String, force: bool) -> Result<(), String> {
    let dir = hist_dir(&app, &name)?;
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    if let Some(&last) = hist_list(&dir).last() {
        let last_path = dir.join(format!("{last}.md"));
        if fs::read_to_string(&last_path).ok().as_deref() == Some(content.as_str()) {
            return Ok(());
        }
        if !force && now.saturating_sub(last) < 60_000 && hist_list(&dir).len() > 1 {
            let _ = fs::remove_file(&last_path);
        }
    }
    fs::write(dir.join(format!("{now}.md")), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn history_list(app: AppHandle, name: String) -> Result<Vec<u64>, String> {
    Ok(hist_list(&hist_dir(&app, &name)?))
}

#[tauri::command]
fn history_read(app: AppHandle, name: String, ts: u64) -> Result<String, String> {
    fs::read_to_string(hist_dir(&app, &name)?.join(format!("{ts}.md"))).map_err(|e| e.to_string())
}

struct Wav {
    fmt: Vec<u8>,
    data: Vec<u8>,
}

fn parse_wav(b: &[u8]) -> Result<Wav, String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("WAVではありません".into());
    }
    let mut i = 12;
    let mut fmt = None;
    let mut data = None;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let size = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        let start = i + 8;
        let end = start.saturating_add(size).min(b.len());
        match id {
            b"fmt " => fmt = Some(b[start..end].to_vec()),
            b"data" => data = Some(b[start..end].to_vec()),
            _ => {}
        }
        i = end + (size & 1);
    }
    Ok(Wav {
        fmt: fmt.ok_or("fmtチャンクがありません")?,
        data: data.ok_or("dataチャンクがありません")?,
    })
}

fn write_wav(path: &Path, fmt: &[u8], data: &[u8]) -> Result<(), String> {
    let mut out = Vec::with_capacity(data.len() + fmt.len() + 28);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((4 + 8 + fmt.len() + 8 + data.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
    out.extend_from_slice(fmt);
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    fs::write(path, out).map_err(|e| e.to_string())
}

fn silence_bytes(fmt: &[u8], ms: u32) -> usize {
    if fmt.len() < 14 {
        return 0;
    }
    let rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]) as u64;
    let align = u16::from_le_bytes([fmt[12], fmt[13]]) as u64;
    (rate * ms as u64 / 1000 * align) as usize
}

fn safe_file_part(s: &str) -> String {
    s.chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .take(24)
        .collect()
}

/// split=false: out は書き出すWAVのパス。split=true: out はフォルダ。
#[tauri::command]
async fn export_audio(
    app: AppHandle,
    server: String,
    items: Vec<TtsReq>,
    gap_ms: u32,
    out: String,
    split: bool,
) -> Result<(), String> {
    let total = items.len();
    let mut fmt: Option<Vec<u8>> = None;
    let mut joined = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let _ = app.emit("export-progress", (i, total));
        let wav = parse_wav(&synth(&app, &server, item).await?)?;
        if split {
            let label = safe_file_part(item.label.as_deref().unwrap_or(""));
            let path = Path::new(&out).join(format!("{:03}_{label}.wav", i + 1));
            write_wav(&path, &wav.fmt, &wav.data)?;
            continue;
        }
        match &fmt {
            None => fmt = Some(wav.fmt.clone()),
            Some(f) if *f != wav.fmt => return Err("音声の形式がそろっていません".into()),
            Some(f) => joined.extend(std::iter::repeat_n(0u8, silence_bytes(f, gap_ms))),
        }
        joined.extend_from_slice(&wav.data);
    }
    if !split {
        let fmt = fmt.ok_or("書き出すセリフがありません")?;
        write_wav(Path::new(&out), &fmt, &joined)?;
    }
    let _ = app.emit("export-progress", (total, total));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_old_app_dirs();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerProc::default())
        .invoke_handler(tauri::generate_handler![
            list_docs,
            read_doc,
            write_doc,
            new_doc_name,
            docs_folder,
            tts,
            tts_health,
            export_audio,
            server_start,
            server_stop,
            server_running,
            server_log,
            history_add,
            history_list,
            history_read,
            list_voice_files,
            add_voice_file,
            tts_durations,
            find_server_dir,
            move_doc,
            stat_docs
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // アプリ終了時、自分が起動したTTSサーバーは必ず止める
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut g) = app.state::<ServerProc>().0.lock() {
                    if let Some(mut child) = g.take() {
                        kill_tree(&mut child);
                    }
                }
            }
        });
}
