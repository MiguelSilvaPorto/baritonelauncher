//! Estimativa de tempo de mineração/deslocamento e agendamento de janelas de
//! espera — ver `docs/SPEC.md`, seção "Agendamento por estimativa de tempo".

use crate::items::{Block, ToolTier};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EstimateConfidence {
    FromBaritonePath,
    Fallback,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TimeEstimate {
    pub ticks: u32,
    pub confidence: EstimateConfidence,
}

const TICKS_PER_SECOND: f32 = 20.0;

/// `tempo_base = dureza × (1.5 se ferramenta correta, senão 5)`,
/// `tempo_final = tempo_base ÷ multiplicador_da_ferramenta`.
pub fn estimate_mine(block: &Block, tool_tier: ToolTier, tool_matches: bool) -> TimeEstimate {
    let base = block.hardness * if tool_matches { 1.5 } else { 5.0 };
    let seconds = base / tool_tier.mining_multiplier();
    TimeEstimate {
        ticks: (seconds * TICKS_PER_SECOND).round() as u32,
        confidence: EstimateConfidence::Fallback,
    }
}

/// Blocos por segundo, andando vs. correndo — fallback quando o Baritone
/// ainda não calculou um caminho real.
pub const WALK_BLOCKS_PER_SEC: f32 = 4.3;
pub const SPRINT_BLOCKS_PER_SEC: f32 = 5.6;

/// Usa o custo de caminho já calculado pelo Baritone (`baritone_path_cost`,
/// em ticks) quando disponível; senão cai para a estimativa por distância em
/// linha reta, correndo (`fallback_speed`).
pub fn estimate_travel(
    distance_blocks: f32,
    baritone_path_cost_ticks: Option<u32>,
    fallback_speed: f32,
) -> TimeEstimate {
    if let Some(ticks) = baritone_path_cost_ticks {
        return TimeEstimate {
            ticks,
            confidence: EstimateConfidence::FromBaritonePath,
        };
    }
    let seconds = distance_blocks / fallback_speed;
    TimeEstimate {
        ticks: (seconds * TICKS_PER_SECOND).round() as u32,
        confidence: EstimateConfidence::Fallback,
    }
}

/// Escolhe, entre as tarefas candidatas, a maior que ainda cabe dentro da
/// janela restante (com margem de segurança de 80%) — ver `docs/SPEC.md`,
/// seção "O algoritmo de decisão".
pub fn pick_fill_task<'a>(
    remaining_ticks: u32,
    candidates: &'a [(String, TimeEstimate)],
) -> Option<&'a (String, TimeEstimate)> {
    const SAFETY_MARGIN: f32 = 0.8;
    let budget = remaining_ticks as f32 * SAFETY_MARGIN;
    candidates
        .iter()
        .filter(|(_, estimate)| estimate.ticks as f32 <= budget)
        .max_by_key(|(_, estimate)| estimate.ticks)
}
