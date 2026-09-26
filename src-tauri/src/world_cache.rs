//! Cache esparso do mundo já explorado pelo bot — ver `docs/SPEC.md`, seção
//! "Arquitetura". Populado pelo addon Java pelo socket local (`addon_socket.rs`,
//! mensagem `chunk_voxels`): cada chunk guarda as seções 16×16×16 que têm
//! algum bloco, com paleta + índices — o chunk inteiro, não só a superfície
//! (cavernas, minérios e o que mais estiver embaixo vêm junto) — e os tints de
//! bioma por coluna (`ChunkTints`), que é o que faz grama/folhagem/água terem a
//! cor real do bioma no viewer.
//!
//! A mesma codificação binária trafega do addon pro Rust e do Rust pro
//! frontend (`encode_voxels`/`decode_voxels`) — um formato só, documentado em
//! `mod-addon/README.md`.

use serde::{Deserialize, Serialize};
use std::cell::OnceCell;
use std::collections::HashMap;

/// Versão do payload binário de `chunk_voxels`. O addon Java e este módulo
/// precisam estar de acordo — mudar o layout sem mudar isto corrompe a
/// decodificação em vez de dar erro claro.
/// - v2: o byte de nível de fluido em cada entrada de paleta (água/lava).
/// - v3: bloco de tints de bioma por coluna no fim (`ChunkTints`).
/// - v4: props do blockstate por entrada de paleta (`facing=north,...`), que
///   escolhem a variante do modelo no viewer.
pub const VOXEL_FORMAT_VERSION: u8 = 4;
/// Versão anterior (tints, mas sem props por entrada): aceita só na leitura,
/// pro `world.cache`/addon gravado antes do v4 continuar funcionando.
pub const VOXEL_FORMAT_VERSION_LEGACY: u8 = 3;
/// Duas versões atrás (sem tints nem props): idem.
pub const VOXEL_FORMAT_VERSION_LEGACY_2: u8 = 2;

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

/// Quantas colunas tem um chunk (`x + z*16`, a mesma ordem dos índices das
/// seções): os tints são por coluna, não por seção — o jogo resolve a cor do
/// bioma no bloco que está sendo desenhado, e acima do solo isso é o bioma da
/// coluna.
pub const TINT_COLUMNS: usize = 256;

/// Cores de bioma por coluna (RGB 0..=255), no formato que o viewer aplica por
/// vértice. Quem calcula é o addon, com o `BiomeColors` do próprio client — ou
/// seja, o colormap e o modificador de bioma (pântano/floresta escura) já vêm
/// aplicados, como o jogo aplicaria; o app não tenta rededuzir cor a partir de
/// temperatura/downfall. Ver `mod-addon/README.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkTints {
    /// Cor de grama (topo do `grass_block`, lírio-d'água, cana-de-açúcar).
    pub grass: Vec<[u8; 3]>,
    /// Cor de folhagem (folhas de carvalho/jungle/acácia/dark oak/mangrove,
    /// videira).
    pub foliage: Vec<[u8; 3]>,
    /// Cor da água (bioma; o jogo usa `Biome#getWaterColor`).
    pub water: Vec<[u8; 3]>,
}

impl ChunkTints {
    /// Todas as colunas com a mesma cor — atalho pra teste/vazio.
    pub fn solid(rgb: [u8; 3]) -> Self {
        let column = vec![rgb; TINT_COLUMNS];
        Self {
            grass: column.clone(),
            foliage: column.clone(),
            water: column,
        }
    }

    /// O payload só é válido com exatamente uma cor por coluna nos três mapas
    /// — o decoder rejeita qualquer outro tamanho.
    fn is_valid(&self) -> bool {
        self.grass.len() == TINT_COLUMNS
            && self.foliage.len() == TINT_COLUMNS
            && self.water.len() == TINT_COLUMNS
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Chunk {
    /// Só as seções com pelo menos um bloco não-ar; seção ausente = ar.
    pub sections: Vec<ChunkSection>,
    /// Tints de bioma por coluna. `None` = payload antigo (v2) ou chunk sem
    /// essa informação — o viewer cai nas aproximações fixas.
    pub tints: Option<ChunkTints>,
    pub dirty: bool,
    /// Payload de `encode_voxels` derivado de `sections`, pronto pra ir pro
    /// socket/arquivo — ver `encoded_payload`. Serializar um mundo de ~20 MB
    /// leva segundos em build debug; recalcular isso a cada gravação (ou a
    /// cada pedido de chunk) seguraria o lock do mundo por muito tempo, então
    /// o resultado fica cacheado por versão das seções e fora do serde (é
    /// derivado, não dado).
    #[serde(skip)]
    encoded: OnceCell<Vec<u8>>,
}

impl Chunk {
    /// Payload do chunk no formato do `chunk_voxels`, calculado na primeira
    /// leitura se ainda não tiver sido (caminho de teste; o de produção já
    /// entrega pronto em `apply_voxels`/`apply_voxels_with_payload`).
    pub fn encoded_payload(&self) -> &[u8] {
        self.encoded
            .get_or_init(|| encode_voxels(&self.sections, self.tints.as_ref()))
    }

    fn set_sections(
        &mut self,
        sections: Vec<ChunkSection>,
        tints: Option<ChunkTints>,
        payload: Option<Vec<u8>>,
    ) {
        self.sections = sections;
        self.tints = tints;
        let cell = OnceCell::new();
        if let Some(payload) = payload {
            let _ = cell.set(payload);
        }
        self.encoded = cell;
    }
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
    /// Substitui o conteúdo do chunk por um snapshot completo (o addon manda
    /// o chunk inteiro no load). Sem merge: se o chunk for reenviado (ex:
    /// recarregado depois de sair e voltar ao render distance), o snapshot
    /// novo manda. O payload binário é montado aqui, por chunk — assim a
    /// gravação do mundo (`world_store.rs`) só copia bytes prontos.
    pub fn apply_voxels(
        &mut self,
        pos: ChunkPos,
        sections: Vec<ChunkSection>,
        tints: Option<ChunkTints>,
    ) {
        let payload = encode_voxels(&sections, tints.as_ref());
        let chunk = self.chunks.entry(pos).or_default();
        chunk.set_sections(sections, tints, Some(payload));
        chunk.dirty = true;
    }

    /// Igual a `apply_voxels`, mas recebe o payload já pronto (o arquivo de
    /// cache guarda exatamente esses bytes) — evita re-serializar o mundo
    /// inteiro ao carregar do disco.
    pub fn apply_voxels_with_payload(
        &mut self,
        pos: ChunkPos,
        sections: Vec<ChunkSection>,
        tints: Option<ChunkTints>,
        payload: Vec<u8>,
    ) {
        let chunk = self.chunks.entry(pos).or_default();
        chunk.set_sections(sections, tints, Some(payload));
        chunk.dirty = true;
    }

    /// Payload binário de um chunk pro frontend (mesmo formato do addon, ver
    /// `encode_voxels`). Vazio se o chunk não existe neste cache — o viewer
    /// trata isso como "ainda não pronto", não como chunk vazio.
    pub fn chunk_voxels_bytes(&self, pos: ChunkPos) -> Vec<u8> {
        match self.chunks.get(&pos) {
            Some(chunk) => chunk.encoded_payload().to_vec(),
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

/// Payload decodificado de `chunk_voxels`.
pub struct DecodedVoxels {
    pub sections: Vec<ChunkSection>,
    /// `None` em payload v2 (cache antigo) ou quando o addon não conseguiu
    /// resolver os tints de bioma.
    pub tints: Option<ChunkTints>,
}

/// Decodifica o payload de `chunk_voxels` (ver `VOXEL_FORMAT_VERSION` e
/// `mod-addon/README.md`):
///
/// ```text
/// u8  versão do formato (4; 3 = sem props, 2 = sem props nem tints)
/// u8  quantidade de seções
/// por seção:
///   i8  Y da seção
///   u16 tamanho da paleta
///   por entrada: u16 tamanho do nome, bytes UTF-8, u8 flags, u8 nível de
///                fluido, u16 tamanho das props, bytes UTF-8 (só na v4)
///   u16[4096] índices (ordem x + z*16 + y*256)
/// u8  tem_tints (v3/v4; 0 = sem tints)
/// se tem_tints:
///   256 × (u8 r, u8 g, u8 b)  grama,   coluna x + z*16
///   256 × (u8 r, u8 g, u8 b)  folhagem, coluna x + z*16
///   256 × (u8 r, u8 g, u8 b)  água,     coluna x + z*16
/// ```
pub fn decode_voxels(bytes: &[u8]) -> Result<DecodedVoxels, String> {
    let mut reader = VoxelReader::new(bytes);
    let version = reader.u8()?;
    if !matches!(
        version,
        VOXEL_FORMAT_VERSION | VOXEL_FORMAT_VERSION_LEGACY | VOXEL_FORMAT_VERSION_LEGACY_2
    ) {
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
            // Props do blockstate só existem a partir da v4; v2/v3 (cache
            // antigo, addon desatualizado) vêm sem.
            let props = if version >= VOXEL_FORMAT_VERSION {
                let props_len = reader.u16()? as usize;
                if props_len > 512 {
                    return Err(format!(
                        "props de blockstate grandes demais: {props_len} bytes"
                    ));
                }
                std::str::from_utf8(reader.take(props_len)?)
                    .map_err(|err| format!("props não é UTF-8: {err}"))?
                    .to_string()
            } else {
                String::new()
            };
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

    // v2 termina aqui (sem tints); v3/v4 trazem a flag + o bloco por coluna.
    let tints = if version >= VOXEL_FORMAT_VERSION_LEGACY {
        match reader.u8()? {
            0 => None,
            1 => Some(ChunkTints {
                grass: decode_tint_columns(&mut reader)?,
                foliage: decode_tint_columns(&mut reader)?,
                water: decode_tint_columns(&mut reader)?,
            }),
            other => return Err(format!("flag de tints inválida: {other}")),
        }
    } else {
        None
    };

    Ok(DecodedVoxels { sections, tints })
}

fn decode_tint_columns(reader: &mut VoxelReader<'_>) -> Result<Vec<[u8; 3]>, String> {
    let mut columns = Vec::with_capacity(TINT_COLUMNS);
    for _ in 0..TINT_COLUMNS {
        columns.push([reader.u8()?, reader.u8()?, reader.u8()?]);
    }
    Ok(columns)
}

/// Reencoda seções no mesmo formato que o addon manda (sem compressão — pro
/// IPC local do Tauri isso não compensa; do addon pra cá, sim, ver
/// `addon_socket.rs`). `tints` malformado (tamanho errado) é gravado como
/// ausente em vez de gerar um payload que o decoder rejeitaria.
pub fn encode_voxels(sections: &[ChunkSection], tints: Option<&ChunkTints>) -> Vec<u8> {
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
    match tints.filter(|tints| tints.is_valid()) {
        Some(tints) => {
            out.push(1);
            for color in tints
                .grass
                .iter()
                .chain(&tints.foliage)
                .chain(&tints.water)
            {
                out.extend_from_slice(color);
            }
        }
        None => out.push(0),
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

    /// Tints sintéticos com uma cor por coluna (a cor não importa; o que os
    /// testes cobrem é o formato).
    fn example_tints() -> ChunkTints {
        ChunkTints {
            grass: (0..TINT_COLUMNS)
                .map(|i| [(i & 0xff) as u8, 0x79, 0x5a])
                .collect(),
            foliage: vec![[0x59, 0xae, 0x30]; TINT_COLUMNS],
            water: vec![[0x3f, 0x76, 0xe4]; TINT_COLUMNS],
        }
    }

    #[test]
    fn voxels_round_trip_with_tints() {
        let sections = example_sections();
        let tints = example_tints();
        let encoded = encode_voxels(&sections, Some(&tints));
        let decoded = decode_voxels(&encoded).expect("payload deveria decodificar");
        assert_eq!(decoded.sections, sections);
        assert_eq!(decoded.tints, Some(tints));
    }

    #[test]
    fn voxels_round_trip_without_tints() {
        let sections = example_sections();
        let encoded = encode_voxels(&sections, None);
        let decoded = decode_voxels(&encoded).expect("payload deveria decodificar");
        assert_eq!(decoded.sections, sections);
        assert_eq!(decoded.tints, None, "sem tints = viewer usa os fixos");
    }

    #[test]
    fn voxels_accept_legacy_v2_payload() {
        // Payload v2 (o `world.cache` de antes dos tints e das props):
        // versão + zero seções, sem o bloco de tints no fim.
        let legacy = [VOXEL_FORMAT_VERSION_LEGACY_2, 0];
        let decoded = decode_voxels(&legacy).expect("payload v2 deveria decodificar");
        assert!(decoded.sections.is_empty());
        assert_eq!(decoded.tints, None);
    }

    #[test]
    fn voxels_accept_legacy_v3_payload_without_props() {
        // v3 = tints, mas sem props por entrada de paleta (addon/cache de
        // antes dos modelos): a leitura tem que aceitar e devolver props
        // vazias, caindo no cubo.
        let mut payload = Vec::new();
        payload.push(VOXEL_FORMAT_VERSION_LEGACY);
        payload.push(1); // uma seção
        payload.push(0); // Y da seção = 0
        payload.extend_from_slice(&1u16.to_le_bytes()); // paleta: 1 entrada
        payload.extend_from_slice(&5u16.to_le_bytes());
        payload.extend_from_slice(b"stone");
        payload.push(VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES);
        payload.push(0); // nível de fluido
        for _ in 0..4096 {
            payload.extend_from_slice(&0u16.to_le_bytes());
        }
        payload.push(0); // sem tints
        let decoded = decode_voxels(&payload).expect("payload v3 deveria decodificar");
        assert_eq!(decoded.sections.len(), 1);
        assert_eq!(decoded.sections[0].palette[0].block, "stone");
        assert_eq!(decoded.sections[0].palette[0].props, "");
    }

    #[test]
    fn voxels_reject_tints_with_wrong_column_count() {
        let mut tints = example_tints();
        tints.water.pop();
        let encoded = encode_voxels(&example_sections(), Some(&tints));
        // `encode` grava como "sem tints" em vez de um payload quebrado.
        let decoded = decode_voxels(&encoded).expect("payload deveria decodificar");
        assert_eq!(decoded.tints, None);
    }

    #[test]
    fn voxels_reject_truncated_payload() {
        let encoded = encode_voxels(&example_sections(), Some(&example_tints()));
        for cut in [0, 1, 2, 10, encoded.len() - 1, encoded.len() - 100] {
            assert!(
                decode_voxels(&encoded[..cut]).is_err(),
                "payload cortado em {cut} deveria falhar"
            );
        }
        // O bloco de tints é obrigatório na v3: cortar logo depois das seções
        // (sem a flag) também falha.
        let no_tint_flag = encode_voxels(&example_sections(), None);
        assert!(decode_voxels(&no_tint_flag[..no_tint_flag.len() - 1]).is_err());
    }

    #[test]
    fn voxels_reject_unknown_version() {
        let mut encoded = encode_voxels(&example_sections(), None);
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

    #[test]
    fn encoded_payload_follows_the_sections() {
        let mut world = WorldCache::new();
        let sections = example_sections();
        let pos = ChunkPos { x: 0, z: 0 };
        world.apply_voxels(pos, sections.clone(), None);
        assert_eq!(
            world.chunk_voxels_bytes(pos),
            encode_voxels(&sections, None),
            "payload cacheado deveria ser o encode das seções"
        );

        // Reaplicar um snapshot novo invalida o payload antigo.
        let other = vec![ChunkSection {
            y: 9,
            palette: vec![PaletteEntry {
                block: "sand".to_string(),
                flags: VOXEL_FLAG_RENDER,
                level: 0,
                props: String::new(),
            }],
            indices: vec![0; 4096],
        }];
        world.apply_voxels(pos, other.clone(), None);
        assert_eq!(world.chunk_voxels_bytes(pos), encode_voxels(&other, None));
    }
}
