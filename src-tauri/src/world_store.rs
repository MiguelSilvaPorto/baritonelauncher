//! Persistência do mundo explorado em disco — o viewer abre mostrando o que
//! já foi carregado mesmo com o jogo fechado (ver `docs/CHANGELOG.md`).
//!
//! Um arquivo só (`world.cache`, no diretório de dados do app — ver
//! `lib.rs`, `world_cache_path`), comprimido com zlib e escrito de forma
//! atômica (`tmp` + rename): um crash no meio da gravação não deixa um cache
//! truncado no lugar do bom. O cabeçalho guarda também a versão do Minecraft
//! do último `hello`, porque o atlas de texturas (`texture_atlas.rs`) precisa
//! dela pra achar o client jar — sem isso o viewer não abriria offline.
//!
//! Formato v1 (little-endian, tudo dentro do zlib):
//!
//! ```text
//! "BOWC"              magic
//! u8                  versão do formato
//! u16 + UTF-8         versão do Minecraft ("" = desconhecida)
//! u32                 quantidade de chunks
//! por chunk:
//!   i32 x, i32 z      posição do chunk
//!   u32 len + bytes   payload de `encode_voxels` (world_cache.rs)
//! ```
//!
//! `ChunkSection` já tem ida e volta binária testada (`encode_voxels`/
//! `decode_voxels`), então o cache reaproveita exatamente o mesmo formato —
//! nada de um segundo esquema pra dessincronizar. `crossing_hints` (política
//! aprendida de água/lava) ainda é volátil, e nada o popula hoje.

use crate::world_cache::{decode_voxels, encode_voxels, ChunkPos, ChunkSection, WorldCache};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::{Read, Write};
use std::path::Path;

const MAGIC: &[u8; 4] = b"BOWC";
const FORMAT_VERSION: u8 = 1;
/// Tetos de sanidade: um arquivo corrompido (ou de outra origem) deve falhar
/// com erro claro em vez de tentar alocar gigabytes.
const MAX_CHUNKS: u32 = 4_000_000;
const MAX_CHUNK_PAYLOAD: u32 = 32 * 1024 * 1024;

/// Conteúdo de um cache lido do disco, pronto pra aplicar no `WorldCache`.
pub struct StoredWorld {
    /// Versão do Minecraft do último `hello` — `None` se o cache foi salvo
    /// antes de qualquer conexão.
    pub mc_version: Option<String>,
    pub chunks: Vec<(ChunkPos, Vec<ChunkSection>)>,
}

impl StoredWorld {
    pub fn apply_to(self, world: &mut WorldCache) {
        for (pos, sections) in self.chunks {
            world.apply_voxels(pos, sections);
        }
    }
}

/// Grava o cache inteiro. Chamado de forma periódica e no fechamento do app
/// (ver `lib.rs`) — não é por chunk, de propósito: um backfill de reconexão
/// aplica centenas de chunks de uma vez.
pub fn save(path: &Path, world: &WorldCache, mc_version: Option<&str>) -> Result<(), String> {
    let mut raw = Vec::with_capacity(1 << 20);
    raw.extend_from_slice(MAGIC);
    raw.push(FORMAT_VERSION);

    let version = mc_version.unwrap_or("");
    let version_bytes = version.as_bytes();
    let version_len = version_bytes.len().min(u16::MAX as usize);
    raw.extend_from_slice(&(version_len as u16).to_le_bytes());
    raw.extend_from_slice(&version_bytes[..version_len]);

    raw.extend_from_slice(&(world.chunks.len() as u32).to_le_bytes());
    for (pos, chunk) in &world.chunks {
        let payload = encode_voxels(&chunk.sections);
        raw.extend_from_slice(&pos.x.to_le_bytes());
        raw.extend_from_slice(&pos.z.to_le_bytes());
        raw.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        raw.extend_from_slice(&payload);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).map_err(|e| e.to_string())?;
    let compressed = encoder.finish().map_err(|e| e.to_string())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &compressed).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Lê o cache do disco. `Ok(None)` = arquivo não existe (primeira execução,
/// nunca conectou) — não é erro. Cache corrompido/versão desconhecida vira
/// `Err`, e quem chamou decide (hoje: ignora e loga, começando vazio).
pub fn load(path: &Path) -> Result<Option<StoredWorld>, String> {
    if !path.is_file() {
        return Ok(None);
    }

    let compressed = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    ZlibDecoder::new(compressed.as_slice())
        .read_to_end(&mut raw)
        .map_err(|err| format!("zlib inválido: {err}"))?;

    let mut reader = Reader::new(&raw);
    if reader.take(4)? != MAGIC.as_slice() {
        return Err("assinatura desconhecida".to_string());
    }
    let version = reader.u8()?;
    if version != FORMAT_VERSION {
        return Err(format!("versão de cache desconhecida: {version}"));
    }

    let version_len = reader.u16()? as usize;
    let mc_version = match reader.take(version_len)? {
        [] => None,
        bytes => Some(
            std::str::from_utf8(bytes)
                .map_err(|err| format!("versão do MC não é UTF-8: {err}"))?
                .to_string(),
        ),
    };

    let chunk_count = reader.u32()?;
    if chunk_count > MAX_CHUNKS {
        return Err(format!("chunks demais no cache: {chunk_count}"));
    }
    let mut chunks = Vec::with_capacity(chunk_count as usize);
    for _ in 0..chunk_count {
        let x = reader.i32()?;
        let z = reader.i32()?;
        let len = reader.u32()?;
        if len > MAX_CHUNK_PAYLOAD {
            return Err(format!("payload de chunk grande demais: {len}"));
        }
        let sections = decode_voxels(reader.take(len as usize)?)
            .map_err(|err| format!("chunk ({x}, {z}) inválido: {err}"))?;
        chunks.push((ChunkPos { x, z }, sections));
    }

    Ok(Some(StoredWorld { mc_version, chunks }))
}

/// Cursor com checagem de limites — mesmo espírito do `VoxelReader` do
/// `world_cache.rs`, mas pro cabeçalho do arquivo (que tem u32/i32).
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "cache estourou o índice".to_string())?;
        if end > self.bytes.len() {
            return Err(format!("cache truncado no byte {}", self.pos));
        }
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_cache::{PaletteEntry, VOXEL_FLAG_OCCLUDES, VOXEL_FLAG_RENDER};

    fn section(y: i8, blocks: &[&str]) -> ChunkSection {
        ChunkSection {
            y,
            palette: blocks
                .iter()
                .map(|block| PaletteEntry {
                    block: block.to_string(),
                    flags: VOXEL_FLAG_RENDER | VOXEL_FLAG_OCCLUDES,
                    level: 0,
                })
                .collect(),
            indices: (0..4096).map(|i| (i % blocks.len()) as u16).collect(),
        }
    }

    fn sample_world() -> WorldCache {
        let mut world = WorldCache::new();
        world.apply_voxels(
            ChunkPos { x: -2, z: 3 },
            vec![section(-4, &["stone", "dirt"]), section(4, &["grass_block", "water"])],
        );
        world.apply_voxels(ChunkPos { x: 0, z: 0 }, vec![section(4, &["sand"])]);
        world
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bowc-test-{}-{name}.bin", std::process::id()))
    }

    #[test]
    fn round_trip_keeps_chunks_and_version() {
        let path = temp_path("round-trip");
        let world = sample_world();
        save(&path, &world, Some("26.3")).expect("gravação deveria funcionar");

        let stored = load(&path).expect("leitura deveria funcionar").expect("cache deveria existir");
        assert_eq!(stored.mc_version.as_deref(), Some("26.3"));

        let mut restored = WorldCache::new();
        stored.apply_to(&mut restored);
        assert_eq!(restored.chunk_count(), world.chunk_count());
        for (pos, chunk) in &world.chunks {
            assert_eq!(restored.chunks[pos].sections, chunk.sections, "chunk {pos:?} diferente");
        }

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
        std::fs::write(&path, b"isso nao e zlib").expect("escrever lixo deveria funcionar");
        assert!(load(&path).is_err(), "lixo deveria ser rejeitado");
        let _ = std::fs::remove_file(&path);
    }
}
