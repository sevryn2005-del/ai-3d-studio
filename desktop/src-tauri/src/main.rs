//! AI 3D Studio 데스크톱 셸 (Windows 우선, Tauri 2).
//!
//! 하는 일은 세 가지뿐이다 (CLAUDE.md 2장: 웹과 같은 프론트엔드 + 같은 로컬 백엔드).
//! 1. 묶음 안의 로컬 모드 엔진(`engine/ai3d-engine[.exe]`, PyInstaller)을 빈 포트로 실행한다.
//! 2. `/api/health` 가 응답하면 창을 `http://127.0.0.1:<포트>/` 로 옮긴다 (프론트엔드·API 같은 출처).
//! 3. 앱이 끝나면 엔진을 종료한다. 셸이 비정상 종료돼도 엔진은 `--parent-pid` 로 스스로 끝난다.
//!
//! 화면은 Tauri API 를 쓰지 않으며, 원격(127.0.0.1) 페이지에는 IPC 권한을 주지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow};

/// 엔진 첫 시작(CadQuery 로드 포함)을 기다리는 최대 시간
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

struct Engine(Mutex<Option<Child>>);

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// 엔진 실행 파일: 환경 변수 `AI3D_ENGINE_PATH`(개발용) → 설치 폴더의 resources/engine/
fn engine_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("AI3D_ENGINE_PATH") {
        return Ok(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "ai3d-engine.exe" } else { "ai3d-engine" };
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("engine").join(exe))
}

fn log_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("AI3DStudio"));
    let _ = fs::create_dir_all(&dir);
    dir.join("engine.log")
}

fn start_engine(exe: &Path, port: u16, log: &Path) -> std::io::Result<Child> {
    let out = File::create(log)?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(exe);
    cmd.args([
        "--port",
        &port.to_string(),
        "--no-browser",
        "--parent-pid",
        &std::process::id().to_string(),
    ])
    .stdin(Stdio::null())
    .stdout(out)
    .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// HTTP 클라이언트 의존성 없이 상태 확인 (루프백 Host 헤더: 엔진의 로컬 보호 규칙과 일치)
fn health_ok(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"),
        Err(_) => false,
    }
}

fn show_error(window: &WebviewWindow, message: &str, log: &Path) {
    let js = format!(
        "window.showEngineError && window.showEngineError({}, {})",
        serde_json::to_string(message).unwrap_or_default(),
        serde_json::to_string(&log.display().to_string()).unwrap_or_default()
    );
    let _ = window.eval(&js);
}

/// 엔진을 시작하고 준비되면 창을 엔진 화면으로 옮긴다 (별도 스레드)
fn launch(app: AppHandle) {
    let window = app.get_webview_window("main").expect("main window");
    let log = log_path(&app);
    let fail = |msg: &str| show_error(&window, msg, &log);

    let exe = match engine_path(&app) {
        Ok(p) if p.exists() => p,
        Ok(p) => return fail(&format!("CAD 엔진 파일이 없습니다: {}", p.display())),
        Err(e) => return fail(&format!("설치 폴더를 찾지 못했습니다: {e}")),
    };
    let port = match free_port() {
        Ok(p) => p,
        Err(e) => return fail(&format!("사용할 포트를 찾지 못했습니다: {e}")),
    };
    let child = match start_engine(&exe, port, &log) {
        Ok(c) => c,
        Err(e) => return fail(&format!("CAD 엔진을 시작하지 못했습니다: {e}")),
    };
    app.state::<Engine>().0.lock().unwrap().replace(child);

    let started = Instant::now();
    loop {
        if health_ok(port) {
            break;
        }
        let exited = app
            .state::<Engine>()
            .0
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten());
        if let Some(status) = exited {
            return fail(&format!("CAD 엔진이 시작 중에 종료되었습니다 ({status})"));
        }
        if started.elapsed() > STARTUP_TIMEOUT {
            return fail("CAD 엔진 시작 시간이 초과되었습니다. 앱을 다시 실행해 보세요.");
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    let url = Url::parse(&format!("http://127.0.0.1:{port}/")).expect("valid url");
    if let Err(e) = window.navigate(url) {
        fail(&format!("화면을 열지 못했습니다: {e}"));
    }
}

fn stop_engine(app: &AppHandle) {
    if let Some(mut child) = app.state::<Engine>().0.lock().unwrap().take() {
        let _ = child.kill(); // CAD 워커는 파이프가 닫혀 스스로 끝난다
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Engine(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || launch(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("AI 3D Studio 를 시작하지 못했습니다")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_engine(app);
            }
        });
}
