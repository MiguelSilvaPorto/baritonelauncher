//! Estado vital do bot e classificação de ameaças — ver `docs/SPEC.md`, seções
//! "Vida, fome e armadura" e "Combate e ameaças". `SurvivalProcess` (a lógica
//! que reage a isso) roda do lado do addon Java; aqui só o modelo transmitido
//! pelo socket.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArmorPiece {
    pub item_id: u32,
    pub durability_pct: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effect {
    pub name: String, // "poison", "regeneration", ...
    pub duration_ticks: u32,
    pub amplifier: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vitals {
    pub health: f32,
    pub max_health: f32,
    pub hunger: u8,
    pub saturation: f32,
    pub armor_points: u8,
    pub armor_pieces: [Option<ArmorPiece>; 4], // capacete, peito, perna, bota
    pub active_effects: Vec<Effect>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThreatKind {
    Creeper,
    RangedAttacker,
    MeleeMob,
    Swarm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThreatResponse {
    RaiseShield,
    RetreatAndPause,
    Ignore,
}

/// Tabela de classificação de ameaça -> resposta, ver `docs/SPEC.md`,
/// seção "Classificação de ameaça".
pub fn classify_threat(kind: ThreatKind, distance_blocks: f32) -> ThreatResponse {
    match kind {
        ThreatKind::Creeper if distance_blocks <= 3.0 => ThreatResponse::RaiseShield,
        ThreatKind::RangedAttacker => ThreatResponse::RaiseShield,
        ThreatKind::Swarm => ThreatResponse::RetreatAndPause,
        ThreatKind::MeleeMob => ThreatResponse::Ignore,
        _ => ThreatResponse::Ignore,
    }
}
