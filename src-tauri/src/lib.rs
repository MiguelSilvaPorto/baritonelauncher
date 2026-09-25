mod instructions;
mod items;
mod storage_index;
mod time_estimate;
mod vitals;
mod world_cache;

use instructions::{Instruction, InstructionQueue};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use storage_index::{ItemTotal, StorageIndex};
use vitals::Vitals;
use world_cache::{WorldCache, WorldSummary};

/// Estado compartilhado do app. Hoje tudo nasce vazio: o socket local que
/// recebe chunks/vitals/inventário do addon Java (ver `docs/SPEC.md`,
/// seção "Arquitetura") ainda não existe, então não há nenhum dado real para
/// mostrar até o addon existir e conectar. Nenhum comando aqui inventa dados
/// — a UI mostra estado vazio honesto enquanto isso.
#[derive(Default)]
struct AppState {
    world: Mutex<WorldCache>,
    storage: Mutex<StorageIndex>,
    queue: Mutex<InstructionQueue>,
    vitals: Mutex<Option<Vitals>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectionStatus {
    connected: bool,
    /// Preenchido quando `connected` é `true` — endereço do addon Java.
    endpoint: Option<String>,
}

mod commands {
    use super::*;
    use tauri::State;

    /// Estado da conexão com o addon Java. Sempre `connected: false` por
    /// enquanto — o socket TCP/WebSocket local descrito no spec ainda não
    /// foi implementado.
    #[tauri::command]
    fn connection_status() -> ConnectionStatus {
        ConnectionStatus {
            connected: false,
            endpoint: None,
        }
    }

    #[tauri::command]
    fn world_summary(state: State<AppState>) -> WorldSummary {
        let world = state.world.lock().unwrap();
        WorldSummary {
            chunks_explored: world.chunk_count() as u32,
            chunks_total_estimate: 0,
            bot_pos: None,
        }
    }

    #[tauri::command]
    fn queue_snapshot(state: State<AppState>) -> Vec<Instruction> {
        state.queue.lock().unwrap().items.clone()
    }

    #[tauri::command]
    fn storage_totals(state: State<AppState>) -> Vec<ItemTotal> {
        state.storage.lock().unwrap().aggregated_totals()
    }

    #[tauri::command]
    fn vitals_snapshot(state: State<AppState>) -> Option<Vitals> {
        state.vitals.lock().unwrap().clone()
    }

    pub(super) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        builder.invoke_handler(tauri::generate_handler![
            connection_status,
            world_summary,
            queue_snapshot,
            storage_totals,
            vitals_snapshot,
        ])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let icon_bytes = include_bytes!("../icons/icon.png");
                    if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                        let _ = window.set_icon(icon);
                    }
                }
            }
            Ok(())
        });

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
