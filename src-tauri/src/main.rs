// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;
use rfd::FileDialog; // <-- добавлено

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------- Модели данных ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ButtonConfig {
    id: String,
    name: String,
    /// Полный текст команды или скрипта (может быть многострочным)
    command: String,
    #[serde(default)]
    console: bool,
    #[serde(default)]
    powershell: bool,
    #[serde(default)]
    icon: String,
    /// Запускать с повышенными правами (UAC-запрос)
    #[serde(default)]
    admin: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct GroupConfig {
    id: String,
    name: String,
    buttons: Vec<ButtonConfig>,
}

fn default_app_name() -> String {
    "LAUNCHER".to_string()
}
fn default_app_logo() -> String {
    "L".to_string()
}
fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct AppConfig {
    #[serde(default)]
    password_hash: String,
    #[serde(default = "default_app_name")]
    app_name: String,
    #[serde(default = "default_app_logo")]
    app_logo: String,
    /// Сворачивать ли окно лаунчера при запуске программы
    #[serde(default = "default_true")]
    minimize_on_launch: bool,
    #[serde(default)]
    groups: Vec<GroupConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            password_hash: String::new(),
            app_name: default_app_name(),
            app_logo: default_app_logo(),
            minimize_on_launch: true,
            groups: vec![GroupConfig {
                id: "group_default".into(),
                name: "Основные".into(),
                buttons: vec![
                    ButtonConfig {
                        id: "btn_calc".into(),
                        name: "Калькулятор".into(),
                        command: "calc.exe".into(),
                        console: false,
                        powershell: false,
                        icon: "🧮".into(),
                        admin: false,
                    },
                    ButtonConfig {
                        id: "btn_notepad".into(),
                        name: "Блокнот".into(),
                        command: "notepad.exe".into(),
                        console: false,
                        powershell: false,
                        icon: "📝".into(),
                        admin: false,
                    },
                    ButtonConfig {
                        id: "btn_ping".into(),
                        name: "Ping google.com".into(),
                        command: "ping google.com -t".into(),
                        console: true,
                        powershell: false,
                        icon: "📡".into(),
                        admin: false,
                    },
                ],
            }],
        }
    }
}

struct AppState {
    config_path: Mutex<PathBuf>,
}

// ---------- Вспомогательные функции ----------

fn get_config_path() -> PathBuf {
    // Храним config.json рядом с exe-файлом (портативность)
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("config.json")
}

fn read_config(path: &PathBuf) -> AppConfig {
    if let Ok(data) = fs::read_to_string(path) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&data) {
            return cfg;
        }
    }
    let default_cfg = AppConfig::default();
    let _ = write_config(path, &default_cfg);
    default_cfg
}

fn write_config(path: &PathBuf, cfg: &AppConfig) -> Result<(), String> {
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

fn hash_password(pw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pw.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn gen_temp_name(ext: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("launcher_{}_{}.{}", std::process::id(), nanos, ext)
}

/// Собирает финальный текст скрипта: добавляет "паузу" в конце для консольных
/// команд, чтобы окно не закрывалось сразу после выполнения.
///
/// Для CMD дополнительно переключаем кодовую страницу консоли на UTF-8
/// (`chcp 65001`) — без этого cmd.exe читает .bat-файл в системной кодировке
/// (обычно CP866), и любая кириллица в путях/командах превращается в
/// "кракозябры", из-за чего команды вроде `start "" "путь"` не находят файл.
fn build_script_content(raw_command: &str, console: bool, powershell: bool) -> String {
    if powershell {
        if console {
            format!(
                "{}\r\nWrite-Host \"\"\r\nRead-Host \"Нажмите Enter для выхода\"\r\n",
                raw_command
            )
        } else {
            format!("{}\r\n", raw_command)
        }
    } else if console {
        format!(
            "@echo off\r\nchcp 65001 >nul\r\n{}\r\necho.\r\npause\r\n",
            raw_command
        )
    } else {
        format!("@echo off\r\nchcp 65001 >nul\r\n{}\r\n", raw_command)
    }
}

/// Записывает скрипт во временный файл с правильной кодировкой:
/// - .ps1 — UTF-8 с BOM (Windows PowerShell 5.1 без BOM определяет кодировку
///   по системной локали и тоже ломает кириллицу);
/// - .bat — UTF-8 без BOM (BOM в начале .bat ломает первую команду `@echo off`,
///   кодировку исправляет chcp 65001 внутри содержимого).
fn write_script_file(path: &PathBuf, content: &str, powershell: bool) -> Result<(), String> {
    let mut f = fs::File::create(path).map_err(|e| e.to_string())?;
    if powershell {
        f.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
    }
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- WinAPI: обнаружение и фокус нового окна ----------
//
// Вместо поиска окна по PID запущенного процесса (что ненадёжно для файлов,
// которые открываются через ассоциацию по умолчанию — фото, видео, xlsx и т.п.,
// где реальное окно принадлежит другому процессу, например уже запущенному
// Excel, или дочернему/грандочернему процессу относительно cmd.exe),
// делаем снимок всех видимых окон ДО запуска и после этого ищем любое НОВОЕ
// видимое окно верхнего уровня — это работает независимо от того, какой
// именно процесс его создал.
#[cfg(windows)]
mod winfocus {
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetWindow, GetWindowTextLengthW, IsIconic,
        IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };

    fn is_real_top_level_window(hwnd: HWND) -> bool {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return false;
            }
            if GetWindowTextLengthW(hwnd) == 0 {
                return false;
            }
            // Окна с владельцем — это всплывающие подсказки/попапы, а не
            // самостоятельные окна приложений, их пропускаем.
            if GetWindow(hwnd, GW_OWNER) != 0 {
                return false;
            }
            true
        }
    }

    unsafe extern "system" fn collect_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let set = &mut *(lparam as *mut HashSet<isize>);
        if is_real_top_level_window(hwnd) {
            set.insert(hwnd as isize);
        }
        TRUE
    }

    /// Снимок всех "настоящих" видимых окон верхнего уровня на текущий момент.
    pub fn snapshot_windows() -> HashSet<isize> {
        let mut set: HashSet<isize> = HashSet::new();
        unsafe {
            EnumWindows(Some(collect_proc), &mut set as *mut HashSet<isize> as LPARAM);
        }
        set
    }

    /// Ищет окно, которого не было в снимке `before`. Возвращает его HWND.
    pub fn find_new_window(before: &HashSet<isize>) -> Option<HWND> {
        let current = snapshot_windows();
        current
            .into_iter()
            .find(|hwnd_val| !before.contains(hwnd_val))
            .map(|v| v as HWND)
    }

    pub fn focus_hwnd(hwnd: HWND) {
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
        }
    }
}

#[cfg(windows)]
fn spawn_focus_thread(before_windows: std::collections::HashSet<isize>) {
    std::thread::spawn(move || {
        for _ in 0..100 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Some(hwnd) = winfocus::find_new_window(&before_windows) {
                winfocus::focus_hwnd(hwnd);
                break;
            }
        }
    });
}

// ---------- WinAPI: запуск с повышенными правами (UAC) ----------
//
// Обычный CreateProcess (через std::process::Command) не умеет запрашивать
// повышение прав — для этого нужен ShellExecuteExW с глаголом "runas",
// который и показывает стандартный запрос UAC.
#[cfg(windows)]
mod winadmin {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Запускает `file` с параметрами `params` через глагол "runas" (запрос UAC).
    /// Возвращает HANDLE процесса (для последующего ожидания завершения) либо
    /// строку ошибки, если пользователь отклонил запрос или запуск не удался.
    pub fn run_elevated(file: &str, params: &str, show_console: bool) -> Result<HANDLE, String> {
        let file_w = wide(file);
        let params_w = wide(params);
        let verb_w = wide("runas");

        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            hwnd: 0 as HWND,
            lpVerb: verb_w.as_ptr(),
            lpFile: file_w.as_ptr(),
            lpParameters: params_w.as_ptr(),
            lpDirectory: std::ptr::null(),
            nShow: if show_console { SW_SHOWNORMAL } else { SW_HIDE } as i32,
            hInstApp: 0,
            lpIDList: std::ptr::null_mut(),
            lpClass: std::ptr::null(),
            hkeyClass: 0,
            dwHotKey: 0,
            Anonymous: unsafe { std::mem::zeroed() },
            hProcess: 0,
        };

        let ok = unsafe { ShellExecuteExW(&mut info as *mut SHELLEXECUTEINFOW) };
        if ok == 0 {
            // Код 1223 (ERROR_CANCELLED) — пользователь нажал "Нет" в окне UAC
            return Err("Запуск с правами администратора отменён или не удался (UAC)".into());
        }
        Ok(info.hProcess)
    }

    /// Блокирует поток до завершения процесса, затем закрывает хендл.
    pub fn wait_and_close(handle: HANDLE) {
        if handle != 0 {
            unsafe {
                WaitForSingleObject(handle, INFINITE);
                CloseHandle(handle);
            }
        }
    }
}

#[tauri::command]
fn get_config(state: State<AppState>) -> AppConfig {
    let path = state.config_path.lock().unwrap();
    read_config(&path)
}

#[tauri::command]
fn has_password(state: State<AppState>) -> bool {
    let path = state.config_path.lock().unwrap();
    let cfg = read_config(&path);
    !cfg.password_hash.is_empty()
}

#[tauri::command]
fn verify_password(state: State<AppState>, password: String) -> bool {
    let path = state.config_path.lock().unwrap();
    let cfg = read_config(&path);
    if cfg.password_hash.is_empty() {
        return true;
    }
    hash_password(&password) == cfg.password_hash
}

#[tauri::command]
fn set_password(
    state: State<AppState>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    let path = state.config_path.lock().unwrap();
    let mut cfg = read_config(&path);
    if !cfg.password_hash.is_empty() && hash_password(&old_password) != cfg.password_hash {
        return Err("Неверный старый пароль".into());
    }
    cfg.password_hash = if new_password.is_empty() {
        String::new()
    } else {
        hash_password(&new_password)
    };
    write_config(&path, &cfg)
}

#[tauri::command]
fn save_config(state: State<AppState>, config: AppConfig) -> Result<(), String> {
    let path = state.config_path.lock().unwrap();
    let existing = read_config(&path);
    let mut new_cfg = config;
    // защита от случайного сброса пароля при сохранении из формы без него
    if new_cfg.password_hash.is_empty() && !existing.password_hash.is_empty() {
        new_cfg.password_hash = existing.password_hash;
    }
    write_config(&path, &new_cfg)
}

/// Открывает нативный диалог выбора файла и возвращает выбранный путь.
/// Поддерживает как локальные, так и сетевые (\\server\share\...) пути.
#[tauri::command]
fn pick_file(app: tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_file(move |file_path| {
        let _ = tx.send(file_path);
    });
    match rx.recv() {
        Ok(Some(fp)) => Some(fp.to_string()),
        _ => None,
    }
}

// ========== НОВЫЕ КОМАНДЫ ЭКСПОРТА/ИМПОРТА ==========

#[tauri::command]
fn export_config(state: State<AppState>) -> Result<String, String> {
    let path = state.config_path.lock().unwrap();
    let cfg = read_config(&path);
    
    let dialog = FileDialog::new()
        .set_file_name("config.json")
        .save_file()
        .ok_or("Диалог сохранения отменён")?;
    
    let data = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&dialog, data).map_err(|e| e.to_string())?;
    
    Ok(dialog.to_string_lossy().to_string())
}

#[tauri::command]
fn import_config(state: State<AppState>) -> Result<(), String> {
    let dialog = FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .ok_or("Диалог выбора отменён")?;
    
    let data = std::fs::read_to_string(&dialog).map_err(|e| e.to_string())?;
    let cfg: AppConfig = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    
    let path = state.config_path.lock().unwrap();
    write_config(&path, &cfg)?;
    
    Ok(())
}

// =================================================

#[tauri::command]
fn launch_program(
    state: State<AppState>,
    window: tauri::Window,
    command: String,
    console: bool,
    powershell: bool,
    admin: bool,
) -> Result<(), String> {
    let minimize = {
        let path = state.config_path.lock().unwrap();
        read_config(&path).minimize_on_launch
    };
    if minimize {
        let _ = window.minimize();
    }

    #[cfg(windows)]
    {
        let ext = if powershell { "ps1" } else { "bat" };
        let tmp_path = std::env::temp_dir().join(gen_temp_name(ext));
        let content = build_script_content(&command, console, powershell);
        write_script_file(&tmp_path, &content, powershell)?;

        let tmp_path_str = tmp_path.to_string_lossy().to_string();

        // Снимок окон делаем непосредственно перед запуском, чтобы затем
        // найти любое новое окно — независимо от того, какой именно процесс
        // его в итоге создал (сам запущенный .exe, дочерний процесс, или уже
        // работающее приложение, которому просто передали файл на открытие).
        let before_windows = winfocus::snapshot_windows();

        if admin {
            // Запуск с повышенными правами: обычный CreateProcess (через
            // std::process::Command) не умеет запрашивать UAC, поэтому здесь
            // используется ShellExecuteExW с глаголом "runas".
            let (file, params) = if powershell {
                (
                    "powershell.exe".to_string(),
                    format!(
                        "-NoProfile -ExecutionPolicy Bypass -File \"{}\"",
                        tmp_path_str
                    ),
                )
            } else {
                ("cmd.exe".to_string(), format!("/c \"{}\"", tmp_path_str))
            };

            let handle = winadmin::run_elevated(&file, &params, console)?;
            spawn_focus_thread(before_windows);

            std::thread::spawn(move || {
                winadmin::wait_and_close(handle);
                let _ = fs::remove_file(&tmp_path);
            });
        } else {
            let mut cmd = if powershell {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &tmp_path_str]);
                c
            } else {
                let mut c = Command::new("cmd");
                c.args(["/c", &tmp_path_str]);
                c
            };

            let flag = if console { CREATE_NEW_CONSOLE } else { CREATE_NO_WINDOW };
            cmd.creation_flags(flag);

            let child = cmd
                .spawn()
                .map_err(|e| format!("Не удалось запустить: {}", e))?;

            spawn_focus_thread(before_windows);

            // Поток очистки временного файла после завершения процесса-обёртки
            // (cmd/powershell). Если файл открылся в уже запущенном приложении
            // (переиспользование инстанса), обёртка всё равно корректно завершится,
            // как только ассоциированный обработчик примет файл.
            std::thread::spawn(move || {
                let mut child = child;
                let _ = child.wait();
                let _ = fs::remove_file(&tmp_path);
            });
        }
    }

    #[cfg(not(windows))]
    {
        // Заглушка для разработки/тестирования UI не на Windows
        let _ = Command::new("sh").arg("-c").arg(&command).spawn();
    }

    Ok(())
}

fn main() {
    let config_path = get_config_path();
    let _ = read_config(&config_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config_path: Mutex::new(config_path),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            has_password,
            verify_password,
            set_password,
            save_config,
            pick_file,
            launch_program,
            export_config,   // <-- добавлено
            import_config,   // <-- добавлено
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}