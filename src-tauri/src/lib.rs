mod addon_socket;
mod instructions;
mod items;
mod storage_index;
mod texture_atlas;
mod time_estimate;
mod vitals;
mod world_cache;
mod world_store;

use instructions::{Instruction, InstructionKind, InstructionQueue, InstructionStatus, InstructionTarget};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use storage_index::{ItemTotal, StorageIndex};
use tauri::Manager;
use vitals::Vitals;
use world_cache::{BlockPos, ChunkPos, WorldCache, WorldSummary};

/// Estado compartilhado do app. `world` (`chunk_voxels`), `vitals`,
/// `connection` e `bot_pos` são alimentados de verdade pelo addon Java via
/// `addon_socket` (ver `docs/SPEC.md`, seção "Arquitetura"); `queue` também é
/// real desde o canal reverso (`queue_push`/`instruction_status`), `storage`
/// é o único que ainda nasce vazio. Nenhum comando aqui inventa dados — o que
/// não está conectado ainda mostra estado vazio honesto na UI.
#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) world: Mutex<WorldCache>,
    storage: Mutex<StorageIndex>,
    queue: Mutex<InstructionQueue>,
    pub(crate) vitals: Mutex<Option<Vitals>>,
    pub(crate) connection: Mutex<ConnectionStatus>,
    /// Canal de escrita pro addon Java (uma conexão = um canal), registrado
    /// por `addon_socket::handle_connection`. `None` = ninguém conectado; os
    /// comandos de fila continuam aceitando instruções, que ficam `Queued` e
    /// só são despachadas quando o `hello` chega.
    pub(crate) addon_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
    /// Última posição (pés do jogador) reportada pelo addon. Mapeada no
    /// grid do viewer em `src/main.ts` (`worldToScreen`).
    pub(crate) bot_pos: Mutex<Option<BlockPos>>,
    /// Versão do Minecraft reportada no `hello` do addon — usada pra achar
    /// o client jar certo em `texture_atlas.rs`. Real, não hardcoded: se o
    /// addon nunca conectou ainda, isso fica `None` e o comando do atlas
    /// devolve erro honesto em vez de chutar uma versão. Fica também no
    /// cache de mundo em disco (`world_store.rs`), pro atlas continuar
    /// funcionando com o jogo fechado.
    pub(crate) mc_version: Mutex<Option<String>>,
    /// Incrementado a cada chunk novo aplicado (`chunk_voxels`). O gravador
    /// periódico do `world_store` compara com a última revisão salva e só
    /// reescreve o arquivo quando algo mudou de verdade.
    pub(crate) world_revision: AtomicU64,
}

/// Ids de instrução são gerados aqui (nunca pelo addon) — só precisam ser
/// únicos dentro de uma sessão do app.
static NEXT_INSTRUCTION_ID: AtomicU64 = AtomicU64::new(1);

/// Manda uma linha JSON pro addon, se houver alguém conectado. Silencioso de
/// propósito quando não há: quem chama decide o que fazer com a instrução
/// (hoje, ela fica `Queued` até o `hello`).
pub(crate) fn send_to_addon(state: &AppState, line: String) {
    let sender = state.addon_tx.lock().unwrap().clone();
    if let Some(sender) = sender {
        let _ = sender.send(line);
    }
}

/// Despacha a próxima instrução `Queued` pro addon, se não houver nenhuma
/// `Active` e houver conexão. Chamado em três momentos: quando o usuário
/// enfileira (`queue_push`), quando o addon conecta (`hello` — cobre
/// instruções criadas offline) e quando a ativa termina (`instruction_status`
/// terminal). Só `TravelTo`/`Explore` têm executor no addon hoje; tipos sem
/// executor ficam `Queued` de propósito (a UI ainda não os cria).
pub(crate) fn dispatch_next_instruction(state: &AppState) {
    if state.addon_tx.lock().unwrap().is_none() {
        return; // sem conexão: a fila espera o próximo `hello`
    }

    let next = {
        let mut queue = state.queue.lock().unwrap();
        if queue.active().is_some() {
            return;
        }
        queue.activate_next_queued()
    };
    let Some(instruction) = next else {
        return;
    };

    let Some(line) = encode_instruction(&instruction) else {
        // Tipo sem executor ainda — devolve pra fila em vez de mentir que
        // está ativo.
        let mut queue = state.queue.lock().unwrap();
        if let Some(item) = queue.by_id_mut(&instruction.id) {
            item.status = InstructionStatus::Queued;
        }
        return;
    };

    println!("[fila] despachando {} ({})", instruction.label, instruction.id);
    send_to_addon(state, line);
}

/// Serializa a instrução no formato que o addon Java entende (ver
/// `mod-addon/README.md`, "Protocolo do socket"). `None` = tipo ainda sem
/// executor do lado Java.
fn encode_instruction(instruction: &Instruction) -> Option<String> {
    let id = &instruction.id;
    match instruction.kind {
        InstructionKind::TravelTo => {
            let target = instruction.target?;
            Some(json!({
                "type": "instruction",
                "id": id,
                "kind": "travel_to",
                "x": target.x,
                "z": target.z,
            }).to_string())
        }
        InstructionKind::Explore => Some(match instruction.target {
            Some(target) => json!({
                "type": "instruction",
                "id": id,
                "kind": "explore",
                "x": target.x,
                "z": target.z,
            }),
            // Sem alvo: o addon usa a posição atual do bot como origem.
            None => json!({
                "type": "instruction",
                "id": id,
                "kind": "explore",
            }),
        }.to_string()),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ConnectionStatus {
    pub(crate) connected: bool,
    /// Preenchido quando `connected` é `true` — endereço do addon Java.
    pub(crate) endpoint: Option<String>,
}

mod commands {
    use super::*;
    use tauri::State;

    /// Estado da conexão com o addon Java, atualizado em tempo real por
    /// `addon_socket` quando o addon conecta/desconecta.
    #[tauri::command]
    fn connection_status(state: State<AppState>) -> ConnectionStatus {
        state.connection.lock().unwrap().clone()
    }

    #[tauri::command]
    fn world_summary(state: State<AppState>) -> WorldSummary {
        let world = state.world.lock().unwrap();
        WorldSummary {
            chunks_explored: world.chunk_count() as u32,
            chunks_total_estimate: 0,
            bot_pos: *state.bot_pos.lock().unwrap(),
        }
    }

    /// Coordenadas dos chunks já vistos com conteúdo real (ver
    /// `addon_socket.rs`, `chunk_voxels`). O viewer usa isso pra saber quais
    /// chunks ainda precisa buscar com `chunk_voxels`.
    #[tauri::command]
    fn world_chunks(state: State<AppState>) -> Vec<ChunkPos> {
        state.world.lock().unwrap().chunks.keys().copied().collect()
    }

    /// Os `limit` chunks em cache mais próximos do ponto dado, já ordenados
    /// por distância (`world_cache::nearest_chunks`). É o que o viewer usa
    /// pra carregar o terreno ao redor do bot primeiro, em vez de pedir o
    /// cache inteiro — que cresce sem limite — em ordem arbitrária de
    /// `HashMap`. `limit` tem teto pra uma chamada malformada não devolver
    /// o mundo todo.
    #[tauri::command]
    fn world_chunks_near(state: State<AppState>, x: i32, z: i32, limit: u32) -> Vec<ChunkPos> {
        let world = state.world.lock().unwrap();
        world_cache::nearest_chunks(world.chunks.keys(), x, z, (limit as usize).min(4096))
    }

    /// Voxels de um chunk (seções com paleta + índices, ver
    /// `world_cache.rs`) como bytes crus — o viewer faz o face culling e monta
    /// a geometria. Resposta vazia = chunk não está no cache; é resposta
    /// binária de propósito (um `Vec<u8>` vira array JSON gigante e lento).
    #[tauri::command]
    fn chunk_voxels(state: State<AppState>, x: i32, z: i32) -> tauri::ipc::Response {
        let bytes = state
            .world
            .lock()
            .unwrap()
            .chunk_voxels_bytes(ChunkPos { x, z });
        tauri::ipc::Response::new(bytes)
    }

    #[tauri::command]
    fn queue_snapshot(state: State<AppState>) -> Vec<Instruction> {
        state.queue.lock().unwrap().items.clone()
    }

    /// Enfileira uma instrução e devolve a fila atualizada. Se o addon está
    /// conectado e nada está ativo, ela já sai despachada na mesma hora
    /// (`dispatch_next_instruction`); senão fica `Queued` até a vez.
    #[tauri::command]
    fn queue_push(
        state: State<AppState>,
        kind: InstructionKind,
        target: Option<InstructionTarget>,
    ) -> Result<Vec<Instruction>, String> {
        let label = match kind {
            InstructionKind::TravelTo => {
                let target = target.ok_or("Ir para precisa de coordenadas (x, z).")?;
                format!("Ir para ({}, {})", target.x, target.z)
            }
            InstructionKind::Explore => match target {
                Some(target) => format!("Explorar a partir de ({}, {})", target.x, target.z),
                None => "Explorar".to_string(),
            },
            // A UI ainda não cria esses tipos; falha alto em vez de enfileirar
            // algo que nenhum lado sabe executar.
            _ => return Err("Esse tipo de instrução ainda não é executável.".to_string()),
        };

        let instruction = Instruction {
            id: format!("i{}", NEXT_INSTRUCTION_ID.fetch_add(1, Ordering::Relaxed)),
            kind,
            label,
            status: InstructionStatus::Queued,
            progress: 0.0,
            target,
        };
        state.queue.lock().unwrap().push(instruction);
        dispatch_next_instruction(&state);
        Ok(state.queue.lock().unwrap().items.clone())
    }

    /// Cancela uma instrução por id (ativa ou ainda na fila) e devolve a fila
    /// atualizada. Cancelar a ativa avisa o addon (`cancel` → `cancelEverything`
    /// do Baritone) e libera a próxima da fila.
    #[tauri::command]
    fn queue_cancel(state: State<AppState>, id: String) -> Vec<Instruction> {
        let was_active = {
            let mut queue = state.queue.lock().unwrap();
            match queue.by_id_mut(&id) {
                Some(item) if item.status == InstructionStatus::Active => {
                    item.status = InstructionStatus::Canceled;
                    true
                }
                Some(item) if item.status == InstructionStatus::Queued => {
                    item.status = InstructionStatus::Canceled;
                    false
                }
                // Terminais não mudam; id desconhecido é ignorado.
                _ => false,
            }
        };

        if was_active {
            send_to_addon(&state, json!({ "type": "cancel", "id": id }).to_string());
            dispatch_next_instruction(&state);
        }
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

    /// Gera (ou reaproveita do cache local) o atlas de texturas de bloco a
    /// partir do client jar que o usuário já tem instalado — nunca baixa
    /// nada. Precisa saber a versão do MC, que só existe depois que o addon
    /// mandou `hello` ao menos uma vez.
    #[tauri::command]
    fn get_texture_atlas(state: State<AppState>) -> Result<crate::texture_atlas::TextureAtlas, String> {
        let version = state
            .mc_version
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Ainda não sei a versão do Minecraft — conecte o addon primeiro.".to_string())?;
        crate::texture_atlas::build_or_load_atlas(&version)
    }

    pub(super) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        builder.invoke_handler(tauri::generate_handler![
            connection_status,
            world_summary,
            world_chunks,
            world_chunks_near,
            chunk_voxels,
            queue_snapshot,
            queue_push,
            queue_cancel,
            storage_totals,
            vitals_snapshot,
            get_texture_atlas,
        ])
    }
}

/// De quanto em quanto tempo o mundo é gravado em disco, quando há mudança.
/// Curto o suficiente pra não perder trabalho de uma sessão, longo o
/// suficiente pra um backfill de reconexão (centenas de chunks) virar uma
/// gravação só.
const WORLD_SAVE_INTERVAL_SECS: u64 = 5;

/// Caminho do cache de mundo: diretório de dados do app (no Linux,
/// `~/.local/share/dev.baritone.orchestrator/world.cache`). Fora do repo de
/// propósito — é dado do usuário, não artefato do projeto.
fn world_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("world.cache"))
        .map_err(|err| err.to_string())
}

/// Carrega o mundo persistido (se existir) no `AppState` e restaura a versão
/// do MC do último `hello` — é isso que deixa o viewer e o atlas de texturas
/// funcionarem com o jogo fechado. Cache ausente é normal (primeira
/// execução); cache ilegível é logado e ignorado, nunca derruba o app.
fn load_persisted_world(app: &tauri::AppHandle) {
    let path = match world_cache_path(app) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("[world_store] sem diretório de dados ({err}); cache desligado");
            return;
        }
    };
    match world_store::load(&path) {
        Ok(Some(stored)) => {
            let chunks = stored.chunks.len();
            let state = app.state::<AppState>();
            if let Some(version) = stored.mc_version.clone() {
                *state.mc_version.lock().unwrap() = Some(version);
            }
            stored.apply_to(&mut state.world.lock().unwrap());
            println!("[world_store] {chunks} chunks carregados de {}", path.display());
        }
        Ok(None) => {}
        Err(err) => eprintln!("[world_store] cache ignorado ({err})"),
    }
}

/// Grava o cache agora, se a revisão mudou desde a última gravação.
fn save_world_if_dirty(app: &tauri::AppHandle, last_saved: &mut u64) {
    let state = app.state::<AppState>();
    let revision = state.world_revision.load(Ordering::Relaxed);
    if revision == *last_saved {
        return;
    }
    let Ok(path) = world_cache_path(app) else {
        return;
    };
    let version = state.mc_version.lock().unwrap().clone();
    let world = state.world.lock().unwrap();
    match world_store::save(&path, &world, version.as_deref()) {
        Ok(()) => *last_saved = revision,
        Err(err) => eprintln!("[world_store] falha ao gravar: {err}"),
    }
}

/// Gravação periódica em background (`setup()`), em vez de a cada chunk: o
/// handler do socket aplica centenas de chunks num backfill de reconexão, e
/// gravar por chunk transformaria isso em centenas de arquivos escritos.
async fn world_store_task(app: tauri::AppHandle) {
    let mut last_saved = 0u64;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(WORLD_SAVE_INTERVAL_SECS)).await;
        save_world_if_dirty(&app, &mut last_saved);
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
                if let Some(window) = app.get_webview_window("main") {
                    let icon_bytes = include_bytes!("../icons/icon.png");
                    if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                        let _ = window.set_icon(icon);
                    }
                }
            }

            load_persisted_world(app.handle());
            tauri::async_runtime::spawn(world_store_task(app.handle().clone()));
            tauri::async_runtime::spawn(addon_socket::listen(app.handle().clone()));

            Ok(())
        });

    commands::register(builder)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Gravação final no fechamento: o intervalo do gravador periódico
            // pode deixar os últimos segundos de exploração fora do disco.
            if let tauri::RunEvent::Exit = event {
                let mut last_saved = 0u64;
                save_world_if_dirty(app, &mut last_saved);
            }
        });
}
