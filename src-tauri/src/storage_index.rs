//! Índice de armazenamento (baús mapeados e catalogados) — ver `docs/SPEC.md`,
//! seção "O que é". Persistência real (disco/sqlite) ainda não implementada;
//! hoje só a estrutura de dados e a agregação por item.

use crate::world_cache::BlockPos;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChestEntry {
    pub pos: BlockPos,
    /// item_id -> quantidade
    pub contents: HashMap<u32, u32>,
}

#[derive(Debug, Default)]
pub struct StorageIndex {
    pub chests: Vec<ChestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemTotal {
    pub item_id: u32,
    pub total: u32,
    pub chest_count: u32,
}

impl StorageIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_chest(&mut self, entry: ChestEntry) {
        if let Some(existing) = self.chests.iter_mut().find(|c| c.pos == entry.pos) {
            *existing = entry;
        } else {
            self.chests.push(entry);
        }
    }

    /// Quantidade total de um item somada em todos os baús indexados —
    /// primeiro passo da árvore de resolução "como conseguir X".
    pub fn total_of(&self, item_id: u32) -> u32 {
        self.chests
            .iter()
            .filter_map(|c| c.contents.get(&item_id))
            .sum()
    }

    /// Totais agregados por item, para o rodapé do painel de fila.
    pub fn aggregated_totals(&self) -> Vec<ItemTotal> {
        let mut totals: HashMap<u32, (u32, u32)> = HashMap::new();
        for chest in &self.chests {
            for (&item_id, &qty) in &chest.contents {
                let entry = totals.entry(item_id).or_insert((0, 0));
                entry.0 += qty;
                entry.1 += 1;
            }
        }
        totals
            .into_iter()
            .map(|(item_id, (total, chest_count))| ItemTotal {
                item_id,
                total,
                chest_count,
            })
            .collect()
    }
}
