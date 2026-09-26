//! Preferências do usuário (aba Config), persistidas em `settings.json` no
//! diretório de dados do app.
//!
//! Ao contrário do `world_store.rs` — que tem formato binário versionado pra
//! um cache grande — aqui é JSON simples: o arquivo é minúsculo, legível, e o
//! `serde(default)` tolera a evolução do modelo (campo novo cai no padrão em
//! vez de invalidar o arquivo do usuário). O backend é a fonte da verdade:
//! `Settings::sanitized` prende cada campo na faixa aceita e os comandos
//! devolvem o valor efetivo, pra UI mostrar o que de fato valeu.
//!
//! Os padrões espelham exatamente as constantes que existiam no frontend
//! (`src/viewer3d.ts`, `src/main.ts`) — o app abre com o comportamento de
//! sempre até o usuário mexer em algo.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Settings {
    /// Distância (blocos) em que o fog fecha o horizonte do viewer. O teto não
    /// é estético: o viewer só mantém montada uma janela de chunks ao redor do
    /// bot/câmera (`CHUNK_KEEP_RADIUS_MAX` em `viewer3d.ts`), e um fog além
    /// dela mostraria o vazio em vez de terreno (o `updateFog` fecha a névoa
    /// antes da borda).
    pub(crate) fog_far: f32,
    /// Teto de tempo por frame (ms) pra montar as malhas dos chunks.
    pub(crate) mesh_budget_ms: f32,
    /// Teto do device pixel ratio do canvas 3D (nitidez × custo de GPU).
    pub(crate) max_pixel_ratio: f32,
    /// Teto de FPS do viewer — 0 = sem limite (vsync do sistema).
    pub(crate) fps_cap: u32,
    /// Intervalo do polling de estado (fila, vitais, mundo), em ms.
    pub(crate) state_interval_ms: u32,
    /// Intervalo do polling da pose do jogador, em ms.
    pub(crate) pose_interval_ms: u32,
    /// Chunks pedidos por atualização de estado (ver `main.ts`, `refreshState`).
    pub(crate) chunks_per_refresh: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            fog_far: 260.0,
            mesh_budget_ms: 8.0,
            max_pixel_ratio: 2.0,
            fps_cap: 0,
            state_interval_ms: 1000,
            pose_interval_ms: 250,
            chunks_per_refresh: 16,
        }
    }
}

/// `f32` inválido (NaN/infinito) vira o padrão em vez de se espalhar pro
/// viewer; valor finito é preso na faixa.
fn clamp_f32(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

impl Settings {
    /// Prende cada campo na faixa aceita — os mesmos `min`/`max`/`step` dos
    /// controles da aba Config. É a defesa do backend contra um
    /// `settings.json` editado à mão: um fog de 5 blocos ou um polling de 1 ms
    /// não podem chegar no viewer.
    pub(crate) fn sanitized(mut self) -> Self {
        let defaults = Self::default();
        self.fog_far = clamp_f32(self.fog_far, 100.0, 400.0, defaults.fog_far);
        self.mesh_budget_ms = clamp_f32(self.mesh_budget_ms, 2.0, 20.0, defaults.mesh_budget_ms);
        self.max_pixel_ratio = clamp_f32(self.max_pixel_ratio, 1.0, 2.0, defaults.max_pixel_ratio);
        self.fps_cap = self.fps_cap.clamp(0, 240);
        self.state_interval_ms = self.state_interval_ms.clamp(250, 10_000);
        self.pose_interval_ms = self.pose_interval_ms.clamp(100, 5_000);
        self.chunks_per_refresh = self.chunks_per_refresh.clamp(1, 64);
        self
    }
}

/// Grava as preferências de forma atômica (`tmp` + rename): um crash no meio
/// da escrita não deixa um JSON truncado no lugar do bom. Chamado a cada
/// mudança na aba Config — o arquivo tem centenas de bytes, não precisa de
/// gravação periódica como o `world_store`.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Lê as preferências do disco. `Ok(None)` = arquivo não existe (primeira
/// execução) — não é erro. Arquivo corrompido vira `Err` e quem chamou decide
/// (hoje: loga e segue com os padrões).
pub fn load(path: &Path) -> Result<Option<Settings>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|e| format!("JSON inválido: {e}"))?;
    Ok(Some(settings.sanitized()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bosettings-test-{}-{name}.json", std::process::id()))
    }

    #[test]
    fn save_then_load_round_trips() {
        let path = temp_path("round-trip");
        let settings = Settings {
            fog_far: 400.0,
            mesh_budget_ms: 12.0,
            max_pixel_ratio: 1.5,
            fps_cap: 60,
            state_interval_ms: 2000,
            pose_interval_ms: 500,
            chunks_per_refresh: 32,
        };
        save(&path, &settings).expect("gravação deveria funcionar");

        let loaded = load(&path).expect("leitura deveria funcionar").expect("arquivo deveria existir");
        assert_eq!(loaded, settings);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert!(load(&path).expect("ausência não é erro").is_none());
    }

    #[test]
    fn corrupted_file_is_rejected() {
        let path = temp_path("corrupted");
        std::fs::write(&path, b"{ isto nao e json").expect("escrever lixo deveria funcionar");
        assert!(load(&path).is_err(), "JSON inválido deveria ser rejeitado");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn out_of_range_values_are_clamped() {
        let path = temp_path("clamped");
        std::fs::write(
            &path,
            br#"{
                "fog_far": 5.0,
                "mesh_budget_ms": 9999.0,
                "max_pixel_ratio": 0.1,
                "fps_cap": 100000,
                "state_interval_ms": 1,
                "pose_interval_ms": 999999,
                "chunks_per_refresh": 0
            }"#,
        )
        .expect("escrever o arquivo deveria funcionar");

        let loaded = load(&path).expect("leitura deveria funcionar").expect("arquivo deveria existir");
        assert_eq!(loaded.fog_far, 100.0);
        assert_eq!(loaded.mesh_budget_ms, 20.0);
        assert_eq!(loaded.max_pixel_ratio, 1.0);
        assert_eq!(loaded.fps_cap, 240);
        assert_eq!(loaded.state_interval_ms, 250);
        assert_eq!(loaded.pose_interval_ms, 5000);
        assert_eq!(loaded.chunks_per_refresh, 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn partial_json_falls_back_to_defaults() {
        let path = temp_path("partial");
        std::fs::write(&path, br#"{ "fog_far": 400.0 }"#).expect("escrever o arquivo deveria funcionar");

        let loaded = load(&path).expect("leitura deveria funcionar").expect("arquivo deveria existir");
        assert_eq!(loaded.fog_far, 400.0);
        assert_eq!(loaded, Settings { fog_far: 400.0, ..Settings::default() });

        let _ = std::fs::remove_file(&path);
    }
}
