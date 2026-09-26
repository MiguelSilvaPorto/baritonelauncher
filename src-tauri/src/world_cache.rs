//! Cache esparso do mundo já explorado pelo bot — ver `docs/SPEC.md`, seção
//! "Arquitetura". Populado pelo addon Java pelo socket local (`addon_socket.rs`,
//! mensagem `chunk_voxels`): cada chunk guarda as seções 16×16×16 que têm
//! algum bloco, com paleta + índices — o chunk inteiro, não só a superfície
//! (cavernas, minérios e o que mais estiver embaixo vêm junto).
//!
//! A mesma codificação binária trafega do addon pro Rust e do Rust pro
//! frontend (`encode_voxels`/`decode_voxels`) — um formato só, documentado em
//! `mod-addon/README.md`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Versão do payload binário de `chunk_voxels`. O addon Java e este módulo
/// precisam estar de acordo — mudar o layout sem mudar isto corrompe a
/// decodificação em vez de dar erro claro. v2 adicionou o byte de nível de
/// fluido em cada entrada de paleta (água/lava); v3 adicionou as propriedades
/// do blockstate (`facing=north,half=top,...`), que o viewer usa pra escolher
/// a variante certa do modelo (tocha de parede, escada, cerca...).
pub const VOXEL_FORMAT_VERSION: u8 = 3;

/// Bit 0: o bloco é desenhável como cubo cheio (não é ar nem decoração
/// substituível, tipo grama alta). Bit 1: o bloco esconde as faces dos
/// vizinhos (oclusão) — o viewer usa isso pro face culling sem precisar de
/// uma lista de nomes de bloco no TypeScript. Bit 2: é um bloco de fluido
/// (água/lava); nesse caso `PaletteEntry::level` diz a altura/queda da
/// superfície e o viewer desenha translúcido/animado em vez de cubo opaco.
pub const VOXEL_FLAG_RENDER: u8 = 1;
pub const VOXEL_FLAG_OCCLUDES: u8 = 2;
pub const VOXEL_FLAG_FLUID: u8 = 4;

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

/// Entrada da paleta de uma seção: o nome do bloco (path do registry, ex:
/// `"stone"`), os flags de renderização, o nível do fluido e as propriedades
/// do blockstate (v3 — ex: `"facing=north,waterlogged=false"`), que o viewer
/// usa pra escolher a variante do modelo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaletteEntry {
    pub block: String,
    pub flags: u8,
    /// Nível de fluido no formato do blockstate vanilla: `0` = fonte,
    /// `1..=7` = fluindo (quanto maior, mais raso), `>= 8` = caindo. `0`
    /// também é o valor de todo bloco que não é fluido — só interpretar
    /// quando `VOXEL_FLAG_FLUID` estiver setado.
    pub level: u8,
    /// Propriedades do blockstate, `nome=valor` separadas por vírgula e
    /// ordenadas por nome (mesma ordem estável do lado Java). Vazio pra
    /// blocos sem propriedades (a maioria).
    pub props: String,
}

impl PaletteEntry {
    /// Altura da superfície do fluido dentro do bloco, em fração de bloco:
    /// fonte (nível 0) e caindo (nível >= 8) = 8/9; fluindo nível L =
    /// (8 − L) / 9. Mesma conta do `WaterFluid#getHeight` do jogo.
    pub fn fluid_height(&self) -> f32 {
        let level = self.level.min(8);
        let surface = if level == 0 || level == 8 { 8 } else { 8 - level };
        surface as f32 / 9.0
    }
}

/// Uma seção 16×16×16 do chunk (a mesma divisão do `LevelChunkSection` do
/// jogo). `indices` tem sempre 4096 posições, na ordem `x + z*16 + y*256` —
/// igual à do `PalettedContainer` vanilla.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkSection {
    /// Y da seção (Y do mundo / 16) — absoluto, pode ser negativo
    /// (mundo moderno começa em -64, ou seja seção -4).
    pub y: i8,
    pub palette: Vec<PaletteEntry>,
    pub indices: Vec<u16>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Chunk {
    /// Só as seções com pelo menos um bloco não-ar; seção ausente = ar.
    pub sections: Vec<ChunkSection>,
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

    /// Substitui o conteúdo do chunk por um snapshot completo (o addon manda
    /// o chunk inteiro no load). Sem merge: se o chunk for reenviado (ex:
    /// recarregado depois de sair e voltar ao render distance), o snapshot
    /// novo manda.
    pub fn apply_voxels(&mut self, pos: ChunkPos, sections: Vec<ChunkSection>) {
        let chunk = self.chunks.entry(pos).or_default();
        chunk.sections = sections;
        chunk.dirty = true;
    }

    /// Payload binário de um chunk pro frontend (mesmo formato do addon, ver
    /// `encode_voxels`). Vazio se o chunk não existe neste cache — o viewer
    /// trata isso como "ainda não pronto", não como chunk vazio.
    pub fn chunk_voxels_bytes(&self, pos: ChunkPos) -> Vec<u8> {
        match self.chunks.get(&pos) {
            Some(chunk) => encode_voxels(&chunk.sections),
            None => Vec::new(),
        }
    }

    /// Nome do bloco numa posição de mundo. `None` = chunk desconhecido
    /// (diferente de ar); seção ausente num chunk carregado = ar, como no
    /// jogo. É o que o diff do editor de schematic (`schematic.rs`) usa pra
    /// saber o que existe de verdade antes de gerar a instrução.
    pub fn block_at(&self, pos: BlockPos) -> Option<&str> {
        let chunk = self.chunks.get(&ChunkPos {
            x: pos.x >> 4,
            z: pos.z >> 4,
        })?;
        // `>>` com sinal: -1 >> 4 = -1 (seção -1), igual à divisão do jogo.
        let Some(section) = chunk.sections.iter().find(|s| s.y as i32 == pos.y >> 4) else {
            return Some("air");
        };
        let index = (((pos.y & 15) << 8) | ((pos.z & 15) << 4) | (pos.x & 15)) as usize;
        let entry = section
            .indices
            .get(index)
            .and_then(|slot| section.palette.get(*slot as usize));
        Some(entry.map(|e| e.block.as_str()).unwrap_or("air"))
    }
}

/// Chunks em cache mais próximos de um ponto (coordenadas de chunk),
/// ordenados por distância em linha reta e limitados a `limit`.
///
/// O viewer usa isso pra priorizar o terreno ao redor do bot: `WorldCache`
/// cresce de forma cumulativa e um `HashMap` não tem ordem, então sem isso a
/// fila de carregamento saía em ordem arbitrária — chunks distantes podiam
/// chegar antes do chão onde o bot está.
pub fn nearest_chunks<'a>(
    positions: impl Iterator<Item = &'a ChunkPos>,
    x: i32,
    z: i32,
    limit: usize,
) -> Vec<ChunkPos> {
    let mut chunks: Vec<ChunkPos> = positions.copied().collect();
    chunks.sort_by_key(|pos| {
        let dx = (pos.x - x) as i64;
        let dz = (pos.z - z) as i64;
        dx * dx + dz * dz
    });
    chunks.truncate(limit);
    chunks
}

/// Avança por bytes com checagem de limites — payload vindo do socket nunca
/// é confiável o bastante pra indexar direto (addon de versão errada, linha
/// corrompida).
struct VoxelReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> VoxelReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "payload estourou o índice".to_string())?;
        if end > self.bytes.len() {
            return Err(format!(
                "payload truncado no byte {} (faltavam {n})",
                self.pos
            ));
        }
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn i8(&mut self) -> Result<i8, String> {
        Ok(self.u8()? as i8)
    }

    fn u16(&mut self) -> Result<u16, String> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }
}

/// Decodifica o payload de `chunk_voxels` (formato 3 — ver
/// `VOXEL_FORMAT_VERSION` e `mod-addon/README.md`):
///
/// ```text
/// u8  versão do formato
/// u8  quantidade de seções
/// por seção:
///   i8  Y da seção
///   u16 tamanho da paleta
///   por entrada: u16 tamanho do nome, bytes UTF-8, u8 flags, u8 nível de
///                fluido, u16 tamanho das props, bytes UTF-8
///   u16[4096] índices (ordem x + z*16 + y*256)
/// ```
pub fn decode_voxels(bytes: &[u8]) -> Result<Vec<ChunkSection>, String> {
    let mut reader = VoxelReader::new(bytes);
    let version = reader.u8()?;
    if version != VOXEL_FORMAT_VERSION {
        return Err(format!(
            "versão de payload desconhecida: {version} (esperava {VOXEL_FORMAT_VERSION})"
        ));
    }

    let section_count = reader.u8()? as usize;
    if section_count > 64 {
        return Err(format!("seções demais no chunk: {section_count}"));
    }

    let mut sections = Vec::with_capacity(section_count);
    for _ in 0..section_count {
        let y = reader.i8()?;
        let palette_len = reader.u16()? as usize;
        if palette_len == 0 || palette_len > 4096 {
            return Err(format!("tamanho de paleta inválido: {palette_len}"));
        }

        let mut palette = Vec::with_capacity(palette_len);
        for _ in 0..palette_len {
            let name_len = reader.u16()? as usize;
            if name_len == 0 || name_len > 512 {
                return Err(format!("nome de bloco inválido: {name_len} bytes"));
            }
            let block = std::str::from_utf8(reader.take(name_len)?)
                .map_err(|err| format!("nome de bloco não é UTF-8: {err}"))?
                .to_string();
            let flags = reader.u8()?;
            let level = reader.u8()?;
            let props_len = reader.u16()? as usize;
            if props_len > 512 {
                return Err(format!("props de blockstate grandes demais: {props_len} bytes"));
            }
            let props = std::str::from_utf8(reader.take(props_len)?)
                .map_err(|err| format!("props não é UTF-8: {err}"))?
                .to_string();
            palette.push(PaletteEntry {
                block,
                flags,
                level,
                props,
            });
        }

        let mut indices = Vec::with_capacity(4096);
        for _ in 0..4096 {
            indices.push(reader.u16()?);
        }

        sections.push(ChunkSection {
            y,
            palette,
            indices,
        });
    }

    Ok(sections)
}

/// Reencoda seções no mesmo formato que o addon manda (sem compressão — pro
/// IPC local do Tauri isso não compensa; do addon pra cá, sim, ver
/// `addon_socket.rs`).
pub fn encode_voxels(sections: &[ChunkSection]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 * 1024);
    out.push(VOXEL_FORMAT_VERSION);
    out.push(sections.len().min(u8::MAX as usize) as u8);
    for section in sections {
        out.push(section.y as u8);
        out.extend_from_slice(&(section.palette.len() as u16).to_le_bytes());
        for entry in &section.palette {
            let name = entry.block.as_bytes();
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(name);
            out.push(entry.flags);
            out.push(entry.level);
            let props = entry.props.as_bytes();
            out.extend_from_slice(&(props.len() as u16).to_le_bytes());
            out.extend_from_slice(props);
        }
        for index in &section.indices {
            out.extend_from_slice(&index.to_le_bytes());
        }
    }
    out
}

/// Resumo leve do estado do mundo cacheado, para o chip de progresso do viewer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSummary {
    pub chunks_explored: u32,
    pub chunks_total_estimate: u32,
    pub bot_pos: Option<BlockPos>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_sections() -> Vec<ChunkSection> {
        vec![
            ChunkSection {
                y: -4,
                palette: vec![
                    PaletteEntry {
                        block: "air".to_string(),
                        flags: 0,
                        level: 0,
                        props: String::new(),
                    },
                    PaletteEntry {
                        block: "stone".to_string(),
                        flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES,
                        level: 0,
                        props: String::new(),
                    },
                ],
                indices: (0..4096).map(|i| (i % 2) as u16).collect(),
            },
            ChunkSection {
                y: 4,
                palette: vec![
                    PaletteEntry {
                        block: "grass_block".to_string(),
                        flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES,
                        level: 0,
                        props: "snowy=false".to_string(),
                    },
                    PaletteEntry {
                        block: "water".to_string(),
                        flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_FLUID,
                        level: 0, // fonte
                        props: "level=0".to_string(),
                    },
                    PaletteEntry {
                        block: "water".to_string(),
                        flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_FLUID,
                        level: 5, // fluindo raso
                        props: "level=5".to_string(),
                    },
                    PaletteEntry {
                        block: "short_grass".to_string(),
                        flags: 0,
                        level: 0,
                        props: String::new(),
                    },
                    PaletteEntry {
                        block: "oak_stairs".to_string(),
                        flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES,
                        level: 0,
                        props: "facing=east,half=bottom,shape=straight,waterlogged=false".to_string(),
                    },
                ],
                indices: (0..4096).map(|i| (i % 5) as u16).collect(),
            },
        ]
    }

    #[test]
    fn voxels_round_trip() {
        let sections = example_sections();
        let encoded = encode_voxels(&sections);
        let decoded = decode_voxels(&encoded).expect("payload deveria decodificar");
        assert_eq!(decoded, sections);
    }

    #[test]
    fn voxels_reject_truncated_payload() {
        let encoded = encode_voxels(&example_sections());
        for cut in [0, 1, 2, 10, encoded.len() - 1] {
            assert!(
                decode_voxels(&encoded[..cut]).is_err(),
                "payload cortado em {cut} deveria falhar"
            );
        }
    }

    #[test]
    fn voxels_reject_unknown_version() {
        let mut encoded = encode_voxels(&example_sections());
        encoded[0] = 99;
        assert!(decode_voxels(&encoded).is_err());
    }

    #[test]
    fn fluid_height_follows_vanilla_levels() {
        let water = |level: u8| PaletteEntry {
            block: "water".to_string(),
            flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_FLUID,
            level,
            props: format!("level={level}"),
        };
        assert!((water(0).fluid_height() - 8.0 / 9.0).abs() < f32::EPSILON); // fonte
        assert!((water(1).fluid_height() - 7.0 / 9.0).abs() < f32::EPSILON);
        assert!((water(7).fluid_height() - 1.0 / 9.0).abs() < f32::EPSILON);
        assert!((water(8).fluid_height() - 8.0 / 9.0).abs() < f32::EPSILON); // caindo
        assert!((water(15).fluid_height() - 8.0 / 9.0).abs() < f32::EPSILON);
    }

    #[test]
    fn nearest_chunks_sorts_by_distance_and_truncates() {
        let chunks = [
            ChunkPos { x: 0, z: 0 },
            ChunkPos { x: 3, z: 0 },
            ChunkPos { x: 1, z: 0 },
            ChunkPos { x: -1, z: 0 },
            ChunkPos { x: 0, z: 5 },
        ];

        // Distâncias de (0,0): 0, 1, 1, 9, 25 — empate em 1 mantém a ordem
        // original (sort estável), então (1,0) vem antes de (-1,0).
        assert_eq!(
            nearest_chunks(chunks.iter(), 0, 0, 3),
            vec![
                ChunkPos { x: 0, z: 0 },
                ChunkPos { x: 1, z: 0 },
                ChunkPos { x: -1, z: 0 },
            ]
        );

        // A âncora é o alvo, não a origem.
        assert_eq!(
            nearest_chunks(chunks.iter(), 3, 0, 1),
            vec![ChunkPos { x: 3, z: 0 }]
        );

        // `limit` maior que o conjunto devolve tudo.
        assert_eq!(nearest_chunks(chunks.iter(), 0, 0, 99).len(), chunks.len());
    }
}
