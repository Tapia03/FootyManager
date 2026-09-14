use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

// Guarda os dois processos de fundo (banco local + API REST local) pra dar
// pra matar os dois quando o app fechar. Ver project_desktop_windows_offline.md
// na memoria do projeto pra entender a arquitetura completa (Fase 3).
#[derive(Default)]
struct Sidecars {
    local_db: Mutex<Option<CommandChild>>,
    postgrest: Mutex<Option<CommandChild>>,
}

const DB_PORT: &str = "54329";
const API_PORT: &str = "3111";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecars::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_data_dir = app.path().app_data_dir()?;
            eprintln!("[diag] app_data_dir = {:?}", app_data_dir);
            let data_dir = app_data_dir.join("db");
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("create_dir_all({:?}) falhou: {e}", data_dir))?;
            let resource_dir = app.path().resource_dir()?;
            eprintln!("[diag] resource_dir = {:?}", resource_dir);
            let server_script = resource_dir.join("server").join("local-db-server.mjs");
            eprintln!(
                "[diag] server_script = {:?} (existe: {})",
                server_script,
                server_script.exists()
            );

            log::info!("[sidecars] script do banco local: {:?}", server_script);
            log::info!("[sidecars] diretorio de dados: {:?}", data_dir);

            let (mut db_rx, db_child) = app
                .shell()
                .sidecar("node")?
                .args([
                    server_script.to_string_lossy().to_string(),
                    "--data-dir".to_string(),
                    data_dir.to_string_lossy().to_string(),
                    "--port".to_string(),
                    DB_PORT.to_string(),
                ])
                .spawn()?;

            *app.state::<Sidecars>().local_db.lock().unwrap() = Some(db_child);

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Espera o marcador de "pronto" do local-db-server antes de
                // subir o PostgREST — senao ele tenta conectar cedo demais.
                while let Some(event) = db_rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            log::info!("[local-db] {}", text.trim());
                            if text.contains("LOCAL_DB_READY") {
                                break;
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            log::warn!("[local-db:stderr] {}", String::from_utf8_lossy(&line).trim());
                        }
                        CommandEvent::Error(err) => {
                            log::error!("[local-db:error] {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!("[local-db] terminou inesperadamente: {:?}", payload);
                            return;
                        }
                        _ => {}
                    }
                }

                eprintln!("[diag] LOCAL_DB_READY recebido, preparando sidecar postgrest...");
                let db_uri = format!("postgres://postgres@127.0.0.1:{DB_PORT}/postgres");
                let sidecar = match app_handle.shell().sidecar("postgrest") {
                    Ok(cmd) => cmd,
                    Err(e) => {
                        eprintln!("[diag] falha ao preparar sidecar postgrest: {e}");
                        log::error!("[postgrest] falha ao preparar sidecar: {e}");
                        return;
                    }
                };

                let spawned = sidecar
                    .env("PGRST_DB_URI", db_uri)
                    .env("PGRST_DB_SCHEMAS", "public")
                    .env("PGRST_DB_ANON_ROLE", "authenticated")
                    .env("PGRST_DB_PREPARED_STATEMENTS", "false")
                    .env("PGRST_SERVER_HOST", "127.0.0.1")
                    .env("PGRST_SERVER_PORT", API_PORT)
                    .spawn();

                match spawned {
                    Ok((mut pg_rx, pg_child)) => {
                        eprintln!("[diag] postgrest sidecar spawnou, pid {}", pg_child.pid());
                        *app_handle.state::<Sidecars>().postgrest.lock().unwrap() = Some(pg_child);
                        while let Some(event) = pg_rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    log::info!("[postgrest] {}", String::from_utf8_lossy(&line).trim())
                                }
                                CommandEvent::Stderr(line) => {
                                    log::warn!("[postgrest] {}", String::from_utf8_lossy(&line).trim())
                                }
                                CommandEvent::Error(err) => log::error!("[postgrest:error] {err}"),
                                CommandEvent::Terminated(payload) => {
                                    log::warn!("[postgrest] terminou: {:?}", payload);
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[diag] postgrest spawn() falhou: {e}");
                        log::error!("[postgrest] falha ao subir: {e}");
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Mata os dois processos de fundo quando o app fecha de verdade
            // (nao so a janela — RunEvent::ExitRequested cobre isso melhor
            // que on_window_event pra um app com um so processo de fundo
            // por instancia).
            if let RunEvent::ExitRequested { .. } = event {
                let postgrest_child = app_handle.state::<Sidecars>().postgrest.lock().unwrap().take();
                if let Some(child) = postgrest_child {
                    let _ = child.kill();
                }
                let local_db_child = app_handle.state::<Sidecars>().local_db.lock().unwrap().take();
                if let Some(child) = local_db_child {
                    let _ = child.kill();
                }
            }
        });
}
