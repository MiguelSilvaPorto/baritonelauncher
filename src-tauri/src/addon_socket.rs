//! Socket local entre este app e o addon Java (ver `docs/SPEC.md`, seção
//! "Arquitetura", e `mod-addon/`). Protocolo v0 — deliberadamente o menor
//! recorte ponta a ponta possível, não o protocolo final do spec:
//!
//! - Transporte: TCP em `127.0.0.1:31173` (loopback only, nunca exposto).
//! - Framing: uma mensagem JSON por linha (`\n`-delimited), sem comprimento
//!   prefixado — simples de implementar dos dois lados sem biblioteca extra
//!   no addon Java (usa só `java.net.Socket`, sem WebSocket).
//! - Mensagens hoje: `hello` (handshake), `vitals` (vida/fome/armadura,
//!   ~1x/segundo), `position` (pés do jogador, ~4x/segundo) e `chunk_voxels`
//!   (o chunk inteiro, seção por seção, comprimido — ver abaixo). Baús ainda
//!   não trafegam por aqui.
//! - Canal reverso (app → addon, mesmo socket): `instruction` (`travel_to` ou
//!   `explore`) e `cancel` (id da instrução). O addon responde com
//!   `instruction_status` (`active` com `progress`, ou `done`/`failed`), que
//!   atualiza a fila de verdade — ver `instructions.rs` e `lib.rs`,
//!   `dispatch_next_instruction`.
//!
//! `chunk_voxels` carrega o conteúdo real do chunk — paleta + índices por
//! seção 16×16×16, com o campo `"data"` em base64 de um payload zlib (layout
//! em `world_cache.rs`, `decode_voxels`) —, não só a superfície: é o que deixa
//! o viewer mostrar relevo, cavernas e o que mais estiver embaixo. O cache é
//! cumulativo (`WorldCache.chunks[pos]`): chunk que sai do render distance do
//! client **não** é removido daqui, de propósito — `WorldCache` é sobre o que
//! já foi explorado, não sobre o que está visível agora. Blocos que mudam
//! depois do load (o bot minerando, por exemplo) ainda não são reenviados —
//! cada chunk é um snapshot do momento em que carregou.
//!
//! O addon Java correspondente está em
//! `mod-addon/src/main/java/dev/baritone/orchestrator/addon/BaritoneOrchestratorAddonClient.java`.

use crate::instructions::InstructionStatus as QueueInstructionStatus;
use crate::vitals::Vitals;
use crate::world_cache::{decode_voxels, BlockPos, ChunkPos, ChunkSection};
use crate::AppState;
use base64::Engine;
use flate2::read::ZlibDecoder;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const SOCKET_ADDR: &str = "127.0.0.1:31173";

/// Teto do payload descomprimido por chunk — um chunk de verdade fica bem
/// abaixo disso (poucas dezenas de KB); o teto existe só pra um payload
/// corrompido não virar alocação gigante.
const MAX_CHUNK_PAYLOAD_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AddonMessage {
    Hello {
        #[allow(dead_code)]
        addon_version: String,
        #[allow(dead_code)]
        baritone_version: String,
        mc_version: String,
    },
    Vitals {
        health: f32,
        max_health: f32,
        hunger: u8,
        saturation: f32,
        armor_points: u8,
    },
    Position {
        x: i32,
        y: i32,
        z: i32,
    },
    ChunkVoxels {
        x: i32,
        z: i32,
        /// Payload binário (ver `world_cache::decode_voxels`) comprimido com
        /// zlib e codificado em base64.
        data: String,
    },
    /// Estado de execução de uma instrução do canal reverso. `progress` é
    /// opcional (só faz sentido em `active`; `explore` não tem progresso
    /// mensurável e não manda o campo).
    InstructionStatus {
        id: String,
        status: AddonInstructionState,
        progress: Option<f32>,
    },
}

/// Estados que o addon reporta — subconjunto do `InstructionStatus` da fila
/// (`Paused`/`Canceled` são decisões do app, não do addon).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AddonInstructionState {
    Active,
    Done,
    Failed,
}

/// Roda pro resto da vida do app (`tauri::async_runtime::spawn`ada uma vez em
/// `run()`). Se a porta já estiver em uso (ex: outra instância do app
/// rodando), loga e desiste — não derruba o app por causa disso.
pub async fn listen(app: AppHandle) {
    let listener = match TcpListener::bind(SOCKET_ADDR).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("[addon_socket] falha ao abrir {SOCKET_ADDR}: {err}");
            return;
        }
    };
    println!("[addon_socket] aguardando addon Java em {SOCKET_ADDR}");

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(err) => {
                eprintln!("[addon_socket] falha ao aceitar conexão: {err}");
                continue;
            }
        };
        tauri::async_runtime::spawn(handle_connection(stream, app.clone()));
    }
}

async fn handle_connection(stream: TcpStream, app: AppHandle) {
    let peer = stream
        .peer_addr()
        .map(|addr| addr.to_string())
        .unwrap_or_else(|_| "addon".to_string());

    let state = app.state::<AppState>();

    // O socket é dividido em leitura (aqui) e escrita (tarefa própria
    // consumindo o canal) — os comandos Tauri mandam linhas pro canal via
    // `AppState.addon_tx` sem precisar alcançar o `TcpStream`.
    let (read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *state.addon_tx.lock().unwrap() = Some(tx.clone());

    let writer = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if write_half.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
    });

    let mut lines = BufReader::new(read_half).lines();

    // Mensagens que o app não reconheceu nesta conexão, agrupadas pelo
    // `"type"` do JSON. Sem isso, um addon desatualizado (ex: ainda mandando o
    // protocolo antigo, `chunk_surface`) some em silêncio e o viewer fica
    // vazio sem nenhum erro visível — foi exatamente o que aconteceu quando o
    // jar do addon não foi rebuildado junto com o app. `logged` limita o aviso
    // à primeira ocorrência de cada tipo, pra um addon velho não inundar o
    // log (ele manda uma mensagem por chunk carregado).
    let mut ignored: HashMap<String, u32> = HashMap::new();
    let mut logged: HashSet<String> = HashSet::new();
    let mut invalid_lines: u32 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        let message = match serde_json::from_str::<AddonMessage>(&line) {
            Ok(message) => message,
            Err(err) => {
                // O `"type"` só é extraído no caminho de falha (o fluxo normal
                // não paga uma segunda desserialização) — é ele que diz *qual*
                // mensagem foi ignorada.
                let kind = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("type")
                            .and_then(|kind| kind.as_str())
                            .map(str::to_string)
                    });
                match kind {
                    Some(kind) => {
                        *ignored.entry(kind.clone()).or_insert(0) += 1;
                        if logged.insert(kind.clone()) {
                            eprintln!(
                                "[addon_socket] mensagem ignorada (type \"{kind}\"): {err} — \
                                 confira se o jar do addon foi buildado junto com o app (o \
                                 protocolo muda dos dois lados)"
                            );
                        }
                    }
                    None => {
                        invalid_lines += 1;
                        if invalid_lines == 1 {
                            eprintln!("[addon_socket] linha sem JSON/type ignorada: {err}");
                        }
                    }
                }
                continue;
            }
        };

        match message {
            AddonMessage::Hello { mc_version, .. } => {
                let mut connection = state.connection.lock().unwrap();
                connection.connected = true;
                connection.endpoint = Some(peer.clone());
                drop(connection);
                *state.mc_version.lock().unwrap() = Some(mc_version);
                // Instruções enfileiradas enquanto o addon estava offline
                // saem agora (o `hello` é o sinal de que dá pra escrever).
                crate::dispatch_next_instruction(&state);
            }
            AddonMessage::Vitals {
                health,
                max_health,
                hunger,
                saturation,
                armor_points,
            } => {
                // O addon ainda não manda `armor_pieces`/`active_effects`
                // (ver docs/SPEC.md, "Vida, fome e armadura") — fica vazio
                // até isso ser implementado, não inventado aqui.
                *state.vitals.lock().unwrap() = Some(Vitals {
                    health,
                    max_health,
                    hunger,
                    saturation,
                    armor_points,
                    armor_pieces: [None, None, None, None],
                    active_effects: Vec::new(),
                });
            }
            AddonMessage::Position { x, y, z } => {
                *state.bot_pos.lock().unwrap() = Some(BlockPos { x, y, z });
            }
            AddonMessage::ChunkVoxels { x, z, data } => match decode_chunk_payload(&data) {
                Ok(sections) => {
                    state
                        .world
                        .lock()
                        .unwrap()
                        .apply_voxels(ChunkPos { x, z }, sections);
                    // Avisa o gravador periódico (`lib.rs`, `world_store`)
                    // que há coisa nova pra persistir.
                    state.world_revision.fetch_add(1, Ordering::Relaxed);
                }
                Err(err) => eprintln!("[addon_socket] chunk_voxels inválido em ({x}, {z}): {err}"),
            },
            AddonMessage::InstructionStatus { id, status, progress } => {
                let status = match status {
                    AddonInstructionState::Active => QueueInstructionStatus::Active,
                    AddonInstructionState::Done => QueueInstructionStatus::Done,
                    AddonInstructionState::Failed => QueueInstructionStatus::Failed,
                };
                let terminal = state
                    .queue
                    .lock()
                    .unwrap()
                    .apply_remote_status(&id, status, progress);
                if terminal {
                    crate::dispatch_next_instruction(&state);
                }
            }
        }
    }

    // Fim da conexão: fecha o resumo do que foi ignorado — um addon velho
    // pode mandar centenas de mensagens, e o aviso por tipo só aparece uma vez.
    if !ignored.is_empty() {
        let mut kinds: Vec<(String, u32)> = ignored.into_iter().collect();
        kinds.sort_by(|a, b| b.1.cmp(&a.1));
        let summary = kinds
            .iter()
            .map(|(kind, count)| format!("{kind} × {count}"))
            .collect::<Vec<_>>()
            .join(", ");
        eprintln!("[addon_socket] mensagens ignoradas nesta conexão: {summary}");
    }
    if invalid_lines > 0 {
        eprintln!("[addon_socket] {invalid_lines} linha(s) sem JSON/type ignorada(s) nesta conexão");
    }

    writer.abort();
    // Só desregistra o canal se ele ainda for o desta conexão — uma
    // reconexão pode já ter registrado o dela.
    let mut addon_tx = state.addon_tx.lock().unwrap();
    if addon_tx.as_ref().is_some_and(|registered| registered.same_channel(&tx)) {
        *addon_tx = None;
    }
    drop(addon_tx);

    // Conexão caiu (addon fechou, `#stop`, saiu do mundo, etc.).
    let mut connection = state.connection.lock().unwrap();
    connection.connected = false;
    connection.endpoint = None;
    drop(connection);
    *state.vitals.lock().unwrap() = None;
    *state.bot_pos.lock().unwrap() = None;
}

/// base64 → zlib → `decode_voxels`. O payload do addon vai comprimido porque
/// um chunk inteiro cru passa de 100 KB; zlib derruba isso pra poucos KB no
/// terreno típico.
fn decode_chunk_payload(data: &str) -> Result<Vec<ChunkSection>, String> {
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|err| format!("base64 inválido: {err}"))?;

    let mut raw = Vec::new();
    ZlibDecoder::new(compressed.as_slice())
        .take(MAX_CHUNK_PAYLOAD_BYTES)
        .read_to_end(&mut raw)
        .map_err(|err| format!("zlib inválido: {err}"))?;
    if raw.len() as u64 == MAX_CHUNK_PAYLOAD_BYTES {
        return Err("payload descomprimido passou do teto".to_string());
    }

    decode_voxels(&raw)
}
