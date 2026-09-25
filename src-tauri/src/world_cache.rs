//! Cache esparso do mundo já explorado pelo bot — ver `docs/SPEC.md`, seção
//! "Arquitetura". Populado por deltas de chunk vindos do addon Java pelo
//! socket local; hoje é só a estrutura de dados (sem socket ligado ainda).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChunkPos {
    pub x: i32,
    pub z: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BlockPos {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Estratégia aprendida para atravessar um trecho de líquido — ver
/// `docs/SPEC.md`, seção "Água e lava — tratados como obstáculo, nunca como rota".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrossingStrategy {
    Parkour,
    Bridge,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Chunk {
    /// Posições não-ar dentro do chunk, blockstate_key resolvida via `BlockDef`.
    pub blocks: HashMap<BlockPos, String>,
    pub dirty: bool,
}

#[derive(Debug, Default)]
pub struct WorldCache {
    pub chunks: HashMap<ChunkPos, Chunk>,
    /// Trechos de água/lava já testados, ver `CrossingStrategy`.
    pub crossing_hints: HashMap<BlockPos, CrossingStrategy>,
}

impl WorldCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    pub fn mark_dirty(&mut self, pos: ChunkPos) {
        if let Some(chunk) = self.chunks.get_mut(&pos) {
            chunk.dirty = true;
        }
    }

    pub fn apply_delta(&mut self, pos: ChunkPos, blocks: HashMap<BlockPos, String>) {
        let chunk = self.chunks.entry(pos).or_default();
        chunk.blocks.extend(blocks);
        chunk.dirty = true;
    }
}

/// Resumo leve do estado do mundo cacheado, para o chip de progresso do viewer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSummary {
    pub chunks_explored: u32,
    pub chunks_total_estimate: u32,
    pub bot_pos: Option<BlockPos>,
}
