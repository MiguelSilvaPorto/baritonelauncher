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

use crate::world_cache::{decode_voxels, ChunkPos, ChunkSection, ChunkTints, WorldCache};
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
    /// `(posição, seções, tints, payload)` — o payload é mantido porque é
    /// exatamente o formato que o `Chunk` guarda em cache; reencodá-lo no
    /// load (segundos num mundo grande, em debug) seria trabalho jogado fora.
    pub chunks: Vec<(ChunkPos, Vec<ChunkSection>, Option<ChunkTints>, Vec<u8>)>,
}

impl StoredWorld {
    pub fn apply_to(self, world: &mut WorldCache) {
        for (pos, sections, tints, payload) in self.chunks {
            world.apply_voxels_with_payload(pos, sections, tints, payload);
        }
    }
}

/// Grava o cache inteiro comprimido — wrapper de `encode` + `write` (usado
/// pelos testes e pelo fechamento do app).
pub fn save(path: &Path, world: &WorldCache, mc_version: Option<&str>) -> Result<(), String> {
    write(path, &encode(world, mc_version))
}

/// Serializa o cache **sem comprimir**: com os payloads já cacheados por
/// chunk (`Chunk::encoded_payload`), isso é só memcpy/extend — a parte que
/// precisa do lock do mundo. Comprimir/gravar (~0,5–1,3 s num mundo de
/// ~20 MB, medido com o cache real) acontece em `write`, fora do lock (ver
/// `lib.rs`, `encode_world_if_dirty`, e `docs/CHANGELOG.md`).
pub fn encode(world: &WorldCache, mc_version: Option<&str>) -> Vec<u8> {
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
        let payload = chunk.encoded_payload();
        raw.extend_from_slice(&pos.x.to_le_bytes());
        raw.extend_from_slice(&pos.z.to_le_bytes());
        raw.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        raw.extend_from_slice(&payload);
    }

    raw
}

/// Comprime e grava de forma atômica (`tmp` + rename). É a parte cara: chamar
/// **fora** do lock do mundo, de preferência numa thread de blocking.
///
/// Nível 1 (`fast`) de propósito: no cache real deste repositório (19,6 MB
/// crus) o nível padrão levava ~1,3 s e o nível 1 leva ~0,46 s, por ~0,6 MB a
/// mais no arquivo — num cache que é reescrito inteiro a cada gravação, CPU
/// ganha de tamanho.
pub fn write(path: &Path, raw: &[u8]) -> Result<(), String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(raw).map_err(|e| e.to_string())?;
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
        let payload = reader.take(len as usize)?;
        let decoded = decode_voxels(payload)
            .map_err(|err| format!("chunk ({x}, {z}) inválido: {err}"))?;
        chunks.push((
            ChunkPos { x, z },
            decoded.sections,
            decoded.tints,
            payload.to_vec(),
        ));
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
            light: vec![0xf0; 4096],
        }
    }

    fn sample_world() -> WorldCache {
        let mut world = WorldCache::new();
        world.apply_voxels(
            ChunkPos { x: -2, z: 3 },
            vec![section(-4, &["stone", "dirt"]), section(4, &["grass_block", "water"])],
            Some(ChunkTints::solid([0x79, 0xc0, 0x5a])),
        );
        world.apply_voxels(ChunkPos { x: 0, z: 0 }, vec![section(4, &["sand"])], None);
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
            assert_eq!(restored.chunks[pos].tints, chunk.tints, "tints de {pos:?} diferentes");
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

    #[test]
    fn load_keeps_the_file_payload_instead_of_re_encoding() {
        // O payload guardado no arquivo é o mesmo que o chunk carrega em
        // cache — o load não pode re-serializar (era segundos num mundo
        // grande, ver docs/CHANGELOG.md).
        let path = temp_path("payload");
        let world = sample_world();
        save(&path, &world, Some("26.3")).expect("gravação deveria funcionar");

        let stored = load(&path).expect("leitura deveria funcionar").expect("cache deveria existir");
        let mut restored = WorldCache::new();
        stored.apply_to(&mut restored);
        for (pos, chunk) in &world.chunks {
            let key = ChunkPos { x: pos.x, z: pos.z };
            assert_eq!(
                restored.chunk_voxels_bytes(key),
                chunk.encoded_payload(),
                "payload do chunk {key:?} mudou no round-trip"
            );
        }

        let _ = std::fs::remove_file(&path);
    }
}
