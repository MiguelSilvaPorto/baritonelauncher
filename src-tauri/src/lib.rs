mod addon_socket;
mod instructions;
mod items;
mod player_skin;
mod schematic;
mod settings;
mod storage_index;
mod texture_atlas;
mod time_estimate;
mod vitals;
mod world_cache;
mod world_store;

use instructions::{
    ExploreParams, ExploreStyle, Instruction, InstructionKind, InstructionQueue, InstructionStatus,
    InstructionTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
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
    /// Mesma posição de `bot_pos` + yaw/pitch do jogador — o viewer usa os
    /// ângulos pra orientar o modelo (ver `addon_socket::BotPose`).
    pub(crate) bot_pose: Mutex<Option<addon_socket::BotPose>>,
    /// Skin real do jogador (PNG), mandada pelo addon quando muda — ver
    /// `player_skin.rs`.
    pub(crate) player_skin: Mutex<Option<player_skin::PlayerSkin>>,
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
    /// Lista de blocos de cada schematic aplicado no editor, por id de
    /// instrução (`Mine`/`Build`). Fica fora do `Instruction` de propósito: a
    /// fila é pollada a cada segundo e um schematic inteiro dentro dela
    /// inflaria o IPC — o card mostra só contagem/centro.
    pub(crate) schematics: Mutex<HashMap<String, Vec<schematic::SchematicBlock>>>,
    /// Preferências do usuário (aba Config — `settings.rs`), carregadas no
    /// `setup()` e gravadas por `settings_set`/`settings_reset`. O frontend só
    /// aplica o que veio daqui: o backend é a fonte da verdade e prende cada
    /// campo na faixa válida.
    pub(crate) settings: Mutex<settings::Settings>,
}

/// Ids de instrução são gerados aqui (nunca pelo addon) — só precisam ser
/// únicos dentro de uma sessão do app.
static NEXT_INSTRUCTION_ID: AtomicU64 = AtomicU64::new(1);

/// Limites do raio de exploração em blocos — validados em `queue_push`. O teto
/// existe porque cada faixa/anél vira waypoint no addon.
const MIN_EXPLORE_RADIUS: u32 = 16;
const MAX_EXPLORE_RADIUS: u32 = 5000;

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
        // Só instruções com executor (ver `encode_instruction`): as outras
        // (Mine/Build do editor de schematic) ficam na fila sem bloquear as
        // que sabem rodar — ver o doc-comment de `activate_next_queued`.
        queue.activate_next_queued(|instruction| encode_instruction(instruction).is_some())
    };
    let Some(instruction) = next else {
        return;
    };

    let Some(line) = encode_instruction(&instruction) else {
        // Inalcançável enquanto o predicado acima e `encode_instruction`
        // andarem juntos, mas devolver pra fila é melhor que mentir `Active`
        // se um dia saírem de sincronia.
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
        InstructionKind::Explore => Some({
            let mut payload = match instruction.target {
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
            };
            // Com raio + estilo, o addon percorre uma lista de waypoints em vez
            // de usar o `explore` nativo (que não tem forma definida).
            if let Some(params) = instruction.explore {
                payload["radius"] = json!(params.radius);
                payload["style"] = json!(match params.style {
                    ExploreStyle::Circles => "circles",
                    ExploreStyle::Zigzag => "zigzag",
                });
            }
            payload.to_string()
        }),

        _ => None,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ConnectionStatus {
    pub(crate) connected: bool,
    /// Preenchido quando `connected` é `true` — endereço do addon Java.
    pub(crate) endpoint: Option<String>,
}

/// Resposta de `schematic_apply`: só contagens e ids. A lista de blocos em si
/// fica no `AppState` (`schematics`) — a fila é pollada a cada segundo e
/// carregar centenas de blocos na resposta inflaria o IPC sem necessidade.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SchematicApplyResult {
    pub(crate) breaks: usize,
    pub(crate) builds: usize,
    pub(crate) instruction_ids: Vec<String>,
}

/// Centro horizontal (x, z) de um schematic — só pro card da fila mostrar de
/// onde ele é; o destino real é a lista de blocos.
fn schematic_center(blocks: &[schematic::SchematicBlock]) -> Option<InstructionTarget> {
    let min_x = blocks.iter().map(|b| b.x).min()?;
    let max_x = blocks.iter().map(|b| b.x).max()?;
    let min_z = blocks.iter().map(|b| b.z).min()?;
    let max_z = blocks.iter().map(|b| b.z).max()?;
    Some(InstructionTarget {
        x: (min_x + max_x) / 2,
        z: (min_z + max_z) / 2,
    })
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
    /// `explore` só vale para `Explore` (raio + padrão de varredura).
    #[tauri::command]
    fn queue_push(
        state: State<AppState>,
        kind: InstructionKind,
        target: Option<InstructionTarget>,
        explore: Option<ExploreParams>,
    ) -> Result<Vec<Instruction>, String> {
        if let Some(params) = explore {
            if !(MIN_EXPLORE_RADIUS..=MAX_EXPLORE_RADIUS).contains(&params.radius) {
                return Err(format!(
                    "Raio de exploração precisa ficar entre {MIN_EXPLORE_RADIUS} e {MAX_EXPLORE_RADIUS} blocos."
                ));
            }
        }

        let label = match kind {
            InstructionKind::TravelTo => {
                let target = target.ok_or("Ir para precisa de coordenadas (x, z).")?;
                format!("Ir para ({}, {})", target.x, target.z)
            }
            InstructionKind::Explore => {
                let origin = match target {
                    Some(target) => format!(" a partir de ({}, {})", target.x, target.z),
                    None => String::new(),
                };
                match explore {
                    Some(params) => format!(
                        "Explorar {} blocos em {}{}",
                        params.radius,
                        match params.style {
                            ExploreStyle::Circles => "círculos",
                            ExploreStyle::Zigzag => "zigue-zague",
                        },
                        origin
                    ),
                    None => format!("Explorar{origin}"),
                }
            }
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
            explore,
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

    /// Aplica a camada de edição do editor de schematic: o diff contra o
    /// `WorldCache` real (feito em `schematic.rs`, não no frontend) vira
    /// instruções `Mine`/`Build` na fila. Elas ficam `Queued` de verdade —
    /// o addon ainda não tem executor pra esses tipos (ver "Known gaps"),
    /// mas o schematic fica guardado em `AppState.schematics` pro dia em que
    /// tiver. Devolve só as contagens/ids; a lista de blocos não volta.
    #[tauri::command]
    fn schematic_apply(
        state: State<AppState>,
        edits: Vec<schematic::BlockEdit>,
    ) -> Result<SchematicApplyResult, String> {
        let diff = {
            let world = state.world.lock().unwrap();
            schematic::diff(&world, &edits)
        };
        if diff.is_empty() {
            return Ok(SchematicApplyResult {
                breaks: 0,
                builds: 0,
                instruction_ids: Vec::new(),
            });
        }

        let mut ids = Vec::new();
        {
            let mut queue = state.queue.lock().unwrap();
            for (kind, blocks) in [
                (InstructionKind::Mine, &diff.break_blocks),
                (InstructionKind::Build, &diff.build_blocks),
            ] {
                if blocks.is_empty() {
                    continue;
                }
                let id = format!("i{}", NEXT_INSTRUCTION_ID.fetch_add(1, Ordering::Relaxed));
                let label = match kind {
                    InstructionKind::Mine => format!("Quebrar {} blocos (editor)", blocks.len()),
                    _ => format!("Construir {} blocos (editor)", blocks.len()),
                };
                queue.push(Instruction {
                    id: id.clone(),
                    kind,
                    label,
                    status: InstructionStatus::Queued,
                    progress: 0.0,
                    target: schematic_center(blocks),
                    // Não é explore: o editor manda a lista de blocos
                    // (`AppState.schematics`), não raio/padrão de varredura.
                    explore: None,
                });
                state
                    .schematics
                    .lock()
                    .unwrap()
                    .insert(id.clone(), blocks.clone());
                ids.push(id);
            }
        }
        dispatch_next_instruction(&state);
        Ok(SchematicApplyResult {
            breaks: diff.break_blocks.len(),
            builds: diff.build_blocks.len(),
            instruction_ids: ids,
        })
    }

    #[tauri::command]
    fn storage_totals(state: State<AppState>) -> Vec<ItemTotal> {
        state.storage.lock().unwrap().aggregated_totals()
    }

    #[tauri::command]
    fn vitals_snapshot(state: State<AppState>) -> Option<Vitals> {
        state.vitals.lock().unwrap().clone()
    }

    /// Pose real do jogador (pés + yaw/pitch) reportada pelo addon a cada
    /// `position` — ver `addon_socket.rs`. O viewer usa pra posicionar e
    /// orientar o modelo do jogador.
    #[tauri::command]
    fn bot_pose(state: State<AppState>) -> Option<addon_socket::BotPose> {
        *state.bot_pose.lock().unwrap()
    }

    /// Skin real do jogador (PNG em data URL + variante do modelo), mandada
    /// pelo addon — ver `player_skin.rs`. `None` enquanto o addon não mandou
    /// (o viewer mostra o modelo sem textura, não uma skin inventada).
    #[tauri::command]
    fn player_skin(state: State<AppState>) -> Option<player_skin::PlayerSkin> {
        state.player_skin.lock().unwrap().clone()
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

    /// Preferências atuais (aba Config) — o que está em memória, já
    /// carregado do disco no `setup()` ou com os padrões.
    #[tauri::command]
    fn settings_get(state: State<AppState>) -> crate::settings::Settings {
        state.settings.lock().unwrap().clone()
    }

    /// Grava preferências e devolve o valor **efetivo** (já preso na faixa
    /// válida em `settings::sanitized`) — a UI mostra o que o backend aceitou,
    /// não o que ela pediu. Grava em disco antes de aplicar em memória: um
    /// erro de escrita vira erro pro usuário em vez de uma preferência que
    /// vale só até o próximo boot.
    #[tauri::command]
    fn settings_set(
        app: tauri::AppHandle,
        state: State<AppState>,
        settings: crate::settings::Settings,
    ) -> Result<crate::settings::Settings, String> {
        let effective = settings.sanitized();
        let path = settings_path(&app)?;
        crate::settings::save(&path, &effective)?;
        *state.settings.lock().unwrap() = effective.clone();
        Ok(effective)
    }

    /// Volta todas as preferências pro padrão (os mesmos valores que o app
    /// tinha antes da aba Config existir) e grava — devolve o efetivo.
    #[tauri::command]
    fn settings_reset(app: tauri::AppHandle, state: State<AppState>) -> Result<crate::settings::Settings, String> {
        let defaults = crate::settings::Settings::default();
        let path = settings_path(&app)?;
        crate::settings::save(&path, &defaults)?;
        *state.settings.lock().unwrap() = defaults.clone();
        Ok(defaults)
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
            schematic_apply,
            storage_totals,
            vitals_snapshot,
            bot_pose,
            player_skin,
            get_texture_atlas,
            settings_get,
            settings_set,
            settings_reset,
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

/// Caminho das preferências — mesmo diretório de dados do app, ao lado do
/// `world.cache` (`settings.json`, ver `settings.rs`).
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|err| err.to_string())
}

/// Carrega as preferências salvas pro `AppState`. Arquivo ausente é normal
/// (primeira execução) e os padrões já estão no `AppState`; arquivo ilegível é
/// logado e ignorado — o app abre com os padrões em vez de não abrir.
fn load_persisted_settings(app: &tauri::AppHandle) {
    let Ok(path) = settings_path(app) else {
        eprintln!("[settings] sem diretório de dados; usando padrões");
        return;
    };
    match settings::load(&path) {
        Ok(Some(loaded)) => {
            let state = app.state::<AppState>();
            *state.settings.lock().unwrap() = loaded;
            println!("[settings] preferências carregadas de {}", path.display());
        }
        Ok(None) => {}
        Err(err) => eprintln!("[settings] preferências ignoradas ({err}); usando padrões"),
    }
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
            load_persisted_settings(app.handle());
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
