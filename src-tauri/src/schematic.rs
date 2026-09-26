//! Editor de schematic (estilo WorldEdit) — ver `docs/SPEC.md`, seção "Como
//! isso vira o editor estilo WorldEdit".
//!
//! O frontend mantém a camada de edição (o que o usuário pintou/apagou) e
//! manda ela inteira em `schematic_apply`; o diff contra o `WorldCache` real
//! acontece **aqui**, que é a única fonte de verdade do que já existe no
//! mundo. O que sobra vira instruções `Mine`/`Build` na fila.
//!
//! `blockstate_key` do spec vira só o nome do bloco por enquanto: propriedades
//! de blockstate (escada virada, eixo de tora, laje...) ainda não trafegam no
//! `chunk_voxels` e o viewer desenha todo bloco como cubo cheio — ver "Known
//! gaps" no README. O formato do diff é o mesmo que o `BuilderProcess` do
//! Baritone consome: lista de posição absoluta + bloco.

use crate::world_cache::{BlockPos, WorldCache};
use serde::{Deserialize, Serialize};

/// Uma edição da camada de pintura do editor: `block = None` = quebrar (vira
/// ar); `Some(nome)` = colocar esse bloco. Vem do frontend via
/// `schematic_apply`.
#[derive(Debug, Clone, Deserialize)]
pub struct BlockEdit {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub block: Option<String>,
}

/// Bloco do schematic gerado — posição absoluta + bloco. É o que a instrução
/// carrega (`AppState.schematics`) e o que o addon vai consumir quando tiver
/// executor de `Mine`/`Build`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchematicBlock {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub block: String,
}

#[derive(Debug, Default)]
pub struct SchematicDiff {
    /// Blocos que precisam sair (no mundo real não são ar).
    pub break_blocks: Vec<SchematicBlock>,
    /// Blocos que precisam ser colocados (ar ou substituindo outro).
    pub build_blocks: Vec<SchematicBlock>,
}

impl SchematicDiff {
    pub fn is_empty(&self) -> bool {
        self.break_blocks.is_empty() && self.build_blocks.is_empty()
    }
}

/// Diferença entre o mundo real e a camada de edição. Posição de chunk
/// desconhecido é ignorada: não dá pra afirmar o que tem lá e a instrução
/// mentiria — o viewer também não deixa pintar onde não conhece o terreno.
pub fn diff(world: &WorldCache, edits: &[BlockEdit]) -> SchematicDiff {
    let mut result = SchematicDiff::default();
    for edit in edits {
        let pos = BlockPos {
            x: edit.x,
            y: edit.y,
            z: edit.z,
        };
        let Some(current) = world.block_at(pos) else {
            continue; // chunk desconhecido
        };
        let desired = edit.block.as_deref().unwrap_or("air");
        if current == desired {
            continue; // já está assim — não gera instrução nenhuma
        }
        if current != "air" {
            result.break_blocks.push(SchematicBlock {
                x: pos.x,
                y: pos.y,
                z: pos.z,
                block: current.to_string(),
            });
        }
        if desired != "air" {
            result.build_blocks.push(SchematicBlock {
                x: pos.x,
                y: pos.y,
                z: pos.z,
                block: desired.to_string(),
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_cache::{ChunkPos, ChunkSection, PaletteEntry, VOXEL_FLAG_OCCLUDES, VOXEL_FLAG_RENDER};

    /// Um chunk com uma seção: `stone` em y=0 e `grass_block` em y=1; o resto
    /// da seção é ar (índice 0, como no payload real).
    fn world_with_terrain() -> WorldCache {
        let mut indices = vec![0u16; 4096];
        for lz in 0..16 {
            for lx in 0..16 {
                indices[(lz << 4) | lx] = 1; // y=0 -> stone
                indices[(1 << 8) | (lz << 4) | lx] = 2; // y=1 -> grass
            }
        }
        let palette = vec![
            PaletteEntry {
                block: "air".to_string(),
                flags: 0,
                level: 0,
            },
            PaletteEntry {
                block: "stone".to_string(),
                flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES,
                level: 0,
            },
            PaletteEntry {
                block: "grass_block".to_string(),
                flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES,
                level: 0,
            },
        ];
        let mut world = WorldCache::new();
        world.apply_voxels(
            ChunkPos { x: 0, z: 0 },
            vec![ChunkSection {
                y: 0,
                palette,
                indices,
            }],
        );
        world
    }

    fn edit(x: i32, y: i32, z: i32, block: Option<&str>) -> BlockEdit {
        BlockEdit {
            x,
            y,
            z,
            block: block.map(str::to_string),
        }
    }

    #[test]
    fn break_and_place_are_splitted_by_current_world_state() {
        let world = world_with_terrain();
        let diff = diff(
            &world,
            &[
                edit(1, 0, 1, None),              // quebrar o stone
                edit(2, 3, 2, Some("oak_planks")), // ar -> colocar
                edit(3, 1, 3, Some("dirt")),      // grama -> substituir
                edit(4, 1, 4, Some("grass_block")), // já está assim -> no-op
            ],
        );

        assert_eq!(
            diff.break_blocks,
            vec![
                SchematicBlock { x: 1, y: 0, z: 1, block: "stone".to_string() },
                SchematicBlock { x: 3, y: 1, z: 3, block: "grass_block".to_string() },
            ]
        );
        assert_eq!(
            diff.build_blocks,
            vec![
                SchematicBlock { x: 2, y: 3, z: 2, block: "oak_planks".to_string() },
                SchematicBlock { x: 3, y: 1, z: 3, block: "dirt".to_string() },
            ]
        );
    }

    #[test]
    fn unknown_chunk_edits_are_ignored() {
        let world = world_with_terrain();
        let diff = diff(&world, &[edit(1000, 5, 1000, Some("stone"))]);
        assert!(diff.is_empty(), "edição fora de chunk conhecido não gera instrução");
    }

    #[test]
    fn placing_into_air_never_breaks() {
        let world = world_with_terrain();
        let diff = diff(&world, &[edit(5, 5, 5, Some("stone"))]);
        assert!(diff.break_blocks.is_empty());
        assert_eq!(diff.build_blocks.len(), 1);
    }
}
