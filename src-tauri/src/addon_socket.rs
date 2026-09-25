//! Socket local entre este app e o addon Java (ver `docs/SPEC.md`, seção
//! "Arquitetura", e `mod-addon/`). Protocolo v0 — deliberadamente o menor
//! recorte ponta a ponta possível, não o protocolo final do spec:
//!
//! - Transporte: TCP em `127.0.0.1:31173` (loopback only, nunca exposto).
//! - Framing: uma mensagem JSON por linha (`\n`-delimited), sem comprimento
//!   prefixado — simples de implementar dos dois lados sem biblioteca extra
//!   no addon Java (usa só `java.net.Socket`, sem WebSocket).
//! - Mensagens hoje: `hello` (handshake), `vitals` (vida/fome/armadura,
//!   ~1x/segundo) e `position` (pés do jogador, ~4x/segundo). Chunks e baús
//!   ainda não trafegam por aqui — são o próximo passo, não implementado
//!   ainda.
//!
//! O addon Java correspondente está em
//! `mod-addon/src/main/java/dev/baritone/orchestrator/addon/BaritoneOrchestratorAddonClient.java`.

use crate::vitals::Vitals;
use crate::world_cache::BlockPos;
use crate::AppState;
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

const SOCKET_ADDR: &str = "127.0.0.1:31173";

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum AddonMessage {
    Hello {
        #[allow(dead_code)]
        addon_version: String,
        #[allow(dead_code)]
        baritone_version: String,
        #[allow(dead_code)]
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
    let mut lines = BufReader::new(stream).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<AddonMessage>(&line) else {
            continue;
        };

        match message {
            AddonMessage::Hello { .. } => {
                let mut connection = state.connection.lock().unwrap();
                connection.connected = true;
                connection.endpoint = Some(peer.clone());
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
        }
    }

    // Conexão caiu (addon fechou, `#stop`, saiu do mundo, etc.).
    let mut connection = state.connection.lock().unwrap();
    connection.connected = false;
    connection.endpoint = None;
    drop(connection);
    *state.vitals.lock().unwrap() = None;
    *state.bot_pos.lock().unwrap() = None;
}
