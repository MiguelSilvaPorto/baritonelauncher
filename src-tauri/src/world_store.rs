//! Persistência do mundo explorado — o viewer abre mostrando o que já foi
//! carregado mesmo com o jogo fechado (ver `docs/CHANGELOG.md`).
//!
//! O mundo vive num **log append-only** (`world.log`), com um registro por
//! chunk, em vez de um snapshot reescrito inteiro. Antes, cada gravação
//! periódica reencodava e recomprimia o cache inteiro: com o mundo crescendo,
//! isso virava uma travada cada vez maior enquanto o bot explorava — e o custo
//! era O(mundo) mesmo pra gravar um chunk só. Agora gravar custa o tamanho do
//! chunk; registros antigos de um chunk reescrito viram espaço morto, que é
//! recuperado quando o log cresce demais (compactação: relê os registros
//! vigentes e reescreve o log só com eles, sem recompressão).
//!
//! O que é pequeno e muda o tempo todo — versão do Minecraft do último `hello`
//! e a última posição do bot (âncora do viewer com o jogo fechado) — fica num
//! JSON ao lado (`world.json`), não no log.
//!
//! Formato do `world.log` (little-endian):
//!
//! ```text
//! "BOWL" | u8 versão (1)
//! por registro:
//!   i32 x, i32 z        posição do chunk
//!   u32 raw_len         tamanho do payload de `encode_voxels`
//!   u32 compressed_len  tamanho do zlib que vem a seguir
//!   compressed_len bytes (zlib de `encode_voxels`)
//! ```
//!
//! O índice (posição → offset do registro vigente) é reconstruído no load; os
//! voxels só entram na memória sob demanda (`WorldCache`). Um registro
//! truncado (crash no meio da escrita) é descartado: o arquivo é cortado no
//! último registro íntegro em vez de invalidar o cache inteiro.

use crate::world_cache::{
    decode_voxels, encode_voxels, BlockPos, ChunkPos, ChunkSection, ChunkTints, DecodedVoxels,
};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const LOG_MAGIC: &[u8; 4] = b"BOWL";
const LOG_VERSION: u8 = 1;
const LOG_HEADER_LEN: u64 = 5; // assinatura + versão
const RECORD_HEADER_LEN: u64 = 16; // x, z, raw_len, compressed_len
/// Tetos de sanidade: um arquivo corrompido (ou de outra origem) deve falhar
/// com erro claro em vez de tentar alocar gigabytes.
const MAX_RAW_LEN: u32 = 16 * 1024 * 1024;
const MAX_COMPRESSED_LEN: u32 = 16 * 1024 * 1024;
/// Piso do gatilho de compactação: mundo pequeno não fica reescrevendo o log
/// a cada punhado de chunks.
const MIN_COMPACT_BYTES: u64 = 8 * 1024 * 1024;

/// Log de chunks em disco + índice em memória. O payload de cada chunk é o
/// mesmo `encode_voxels`/`decode_voxels` do socket e do IPC (formato v3).
#[derive(Debug)]
pub struct WorldStore {
    log_path: PathBuf,
    log: File,
    log_bytes: u64,
    /// Tamanho do log depois da última compactação — o gatilho é o log crescer
    /// até o dobro disso (o excedente é espaço morto de chunk reescrito).
    compacted_bytes: u64,
    /// Offset do registro vigente de cada chunk (o mais recente).
    index: HashMap<ChunkPos, u64>,
}

impl WorldStore {
    /// Abre (ou cria) o log em `data_dir/world.log` e reconstrói o índice.
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let log_path = data_dir.join("world.log");
        let exists = log_path.is_file();
        let mut log = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&log_path)
            .map_err(|e| e.to_string())?;
        let mut log_bytes = log.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        if !exists || log_bytes == 0 {
            log.write_all(LOG_MAGIC).map_err(|e| e.to_string())?;
            log.write_all(&[LOG_VERSION]).map_err(|e| e.to_string())?;
            log_bytes = LOG_HEADER_LEN;
        }
        let mut store = Self {
            log_path,
            log,
            log_bytes,
            compacted_bytes: log_bytes,
            index: HashMap::new(),
        };
        store.rebuild_index()?;
        store.compacted_bytes = store.log_bytes;
        Ok(store)
    }

    /// Varre o log do começo reconstruindo o índice. Um registro truncado no
    /// fim (crash no meio de uma append) corta o arquivo no último íntegro —
    /// o mundo anterior continua abrindo.
    fn rebuild_index(&mut self) -> Result<(), String> {
        self.log
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        let mut header = [0u8; LOG_HEADER_LEN as usize];
        self.log
            .read_exact(&mut header)
            .map_err(|e| format!("cabeçalho do log ilegível: {e}"))?;
        if &header[..4] != LOG_MAGIC {
            return Err("assinatura do log desconhecida".to_string());
        }
        if header[4] != LOG_VERSION {
            return Err(format!("versão do log desconhecida: {}", header[4]));
        }

        let mut offset = LOG_HEADER_LEN;
        let mut record = [0u8; RECORD_HEADER_LEN as usize];
        loop {
            if offset + RECORD_HEADER_LEN > self.log_bytes {
                break; // acabou limpo (ou sobrou um cabeçalho parcial)
            }
            self.log
                .seek(SeekFrom::Start(offset))
                .and_then(|_| self.log.read_exact(&mut record))
                .map_err(|e| format!("registro ilegível em {offset}: {e}"))?;
            let x = i32::from_le_bytes([record[0], record[1], record[2], record[3]]);
            let z = i32::from_le_bytes([record[4], record[5], record[6], record[7]]);
            let raw_len = u32::from_le_bytes([record[8], record[9], record[10], record[11]]);
            let compressed_len =
                u32::from_le_bytes([record[12], record[13], record[14], record[15]]) as u64;
            let truncated = raw_len > MAX_RAW_LEN
                || compressed_len > MAX_COMPRESSED_LEN as u64
                || offset + RECORD_HEADER_LEN + compressed_len > self.log_bytes;
            if truncated {
                eprintln!(
                    "[world_store] registro truncado/corrompido em {offset}; cortando o log aí"
                );
                self.log.set_len(offset).map_err(|e| e.to_string())?;
                self.log_bytes = offset;
                break;
            }
            self.index.insert(ChunkPos { x, z }, offset);
            offset += RECORD_HEADER_LEN + compressed_len;
        }
        Ok(())
    }

    /// Grava (ou regrava) um chunk: codifica, comprime e faz append de um
    /// registro. O custo é o tamanho do chunk, não o do mundo.
    pub fn write(
        &mut self,
        pos: ChunkPos,
        sections: &[ChunkSection],
        tints: Option<&ChunkTints>,
    ) -> Result<(), String> {
        let raw = encode_voxels(sections, tints);
        let compressed = deflate(&raw)?;
        let offset = self.log_bytes;
        let mut record = Vec::with_capacity(RECORD_HEADER_LEN as usize + compressed.len());
        record.extend_from_slice(&pos.x.to_le_bytes());
        record.extend_from_slice(&pos.z.to_le_bytes());
        record.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        record.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        record.extend_from_slice(&compressed);
        self.log.write_all(&record).map_err(|e| e.to_string())?;
        self.log_bytes += record.len() as u64;
        self.index.insert(pos, offset);

        if self.log_bytes > self.compaction_threshold() {
            let bytes = self.compact()?;
            println!("[world_store] log compactado: {bytes} bytes");
        }
        Ok(())
    }

    /// Payload de um chunk lido do log (registro vigente). `None` = chunk não
    /// está no log.
    pub fn read(&mut self, pos: ChunkPos) -> Result<Option<DecodedVoxels>, String> {
        let Some(offset) = self.index.get(&pos).copied() else {
            return Ok(None);
        };
        let mut record = [0u8; RECORD_HEADER_LEN as usize];
        self.log
            .seek(SeekFrom::Start(offset))
            .and_then(|_| self.log.read_exact(&mut record))
            .map_err(|e| format!("registro de ({}, {}) ilegível: {e}", pos.x, pos.z))?;
        let compressed_len =
            u32::from_le_bytes([record[12], record[13], record[14], record[15]]) as usize;
        let mut compressed = vec![0u8; compressed_len];
        self.log
            .read_exact(&mut compressed)
            .map_err(|e| format!("payload de ({}, {}) ilegível: {e}", pos.x, pos.z))?;
        let raw = inflate(&compressed)?;
        decode_voxels(&raw).map(Some)
    }

    pub fn positions(&self) -> impl Iterator<Item = ChunkPos> + '_ {
        self.index.keys().copied()
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    fn compaction_threshold(&self) -> u64 {
        (self.compacted_bytes * 2).max(MIN_COMPACT_BYTES)
    }

    /// Reescreve o log só com os registros vigentes (os antigos de cada chunk
    /// viram espaço morto). Os registros são copiados como estão — não há
    /// descompressão nem recompressão, então a compactação é I/O.
    pub fn compact(&mut self) -> Result<u64, String> {
        let positions: Vec<ChunkPos> = self.index.keys().copied().collect();
        let tmp_path = self.log_path.with_extension("log.tmp");
        let mut out = File::create(&tmp_path).map_err(|e| e.to_string())?;
        out.write_all(LOG_MAGIC).map_err(|e| e.to_string())?;
        out.write_all(&[LOG_VERSION]).map_err(|e| e.to_string())?;

        let mut index = HashMap::with_capacity(positions.len());
        let mut offset = LOG_HEADER_LEN;
        let mut record = [0u8; RECORD_HEADER_LEN as usize];
        for pos in positions {
            let Some(old_offset) = self.index.get(&pos).copied() else {
                continue;
            };
            self.log
                .seek(SeekFrom::Start(old_offset))
                .and_then(|_| self.log.read_exact(&mut record))
                .map_err(|e| e.to_string())?;
            let compressed_len =
                u32::from_le_bytes([record[12], record[13], record[14], record[15]]) as usize;
            let mut compressed = vec![0u8; compressed_len];
            self.log
                .read_exact(&mut compressed)
                .map_err(|e| e.to_string())?;
            out.write_all(&record).map_err(|e| e.to_string())?;
            out.write_all(&compressed).map_err(|e| e.to_string())?;
            index.insert(pos, offset);
            offset += RECORD_HEADER_LEN + compressed_len as u64;
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        std::fs::rename(&tmp_path, &self.log_path).map_err(|e| e.to_string())?;

        self.log = OpenOptions::new()
            .read(true)
            .append(true)
            .open(&self.log_path)
            .map_err(|e| e.to_string())?;
        self.index = index;
        self.log_bytes = offset;
        self.compacted_bytes = offset;
        Ok(offset)
    }
}

fn deflate(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(input).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn inflate(compressed: &[u8]) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    ZlibDecoder::new(compressed)
        .take(MAX_RAW_LEN as u64)
        .read_to_end(&mut raw)
        .map_err(|e| format!("zlib inválido: {e}"))?;
    if raw.len() as u64 == MAX_RAW_LEN as u64 {
        return Err("payload descomprimido passou do teto".to_string());
    }
    Ok(raw)
}

/// Metadados pequenos e voláteis do mundo (`world.json`) — deliberadamente
/// fora do log: são poucos bytes reescritos com frequência (a posição do bot
/// muda 4x/s), e reescrever o mundo por causa disso seria absurdo. JSON pelo
/// mesmo motivo do `settings.json`: minúsculo, legível, `serde(default)`
/// tolera campo novo.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorldMeta {
    #[serde(default)]
    pub mc_version: Option<String>,
    /// Onde o bot foi visto por último — sobrevive ao disconnect de propósito
    /// (o viewer abre aí com o jogo fechado; ver `main.ts`).
    #[serde(default)]
    pub last_bot_pos: Option<BlockPos>,
}

pub fn load_meta(path: &Path) -> Result<Option<WorldMeta>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("meta ilegível: {e}"))
}

pub fn save_meta(path: &Path, meta: &WorldMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Importa o cache antigo (`world.cache`, snapshot único reescrito inteiro) pro
/// log novo — sem isso, atualizar o app perderia o mundo já explorado.
///
/// Só roda com o log vazio (primeira abertura no formato novo; se o log já tem
/// chunks, o mundo já está lá). O arquivo antigo **não** é apagado nem
/// renomeado: uma build de outro formato pode continuar usando ele, e apagar
/// seria tirar o mundo de baixo dela. Devolve a versão do Minecraft que veio
/// nele, se havia.
pub fn import_legacy_cache(data_dir: &Path, store: &mut WorldStore) -> Result<Option<String>, String> {
    let cache_path = data_dir.join("world.cache");
    if !cache_path.is_file() || store.len() > 0 {
        return Ok(None);
    }
    let stored = load_legacy(&cache_path)?;
    let chunks = stored.chunks.len();
    for (pos, sections, tints) in stored.chunks {
        store.write(pos, &sections, tints.as_ref())?;
    }
    println!(
        "[world_store] {chunks} chunks importados do cache antigo ({})",
        cache_path.display()
    );
    Ok(stored.mc_version)
}

/// Conteúdo de um cache lido do formato antigo (snapshot), pronto pra
/// importar.
pub struct StoredWorld {
    /// Versão do Minecraft do último `hello` — `None` se o cache foi salvo
    /// antes de qualquer conexão.
    pub mc_version: Option<String>,
    pub chunks: Vec<(ChunkPos, Vec<ChunkSection>, Option<ChunkTints>)>,
}

/// Formato antigo (container `BOWC` v1): usados na leitura, pra abrir (e
/// importar) o `world.cache` gravado antes do log. Nada escreve mais nesse
/// formato.
const LEGACY_MAGIC: &[u8; 4] = b"BOWC";
const LEGACY_FORMAT_VERSION: u8 = 1;
const MAX_LEGACY_CHUNKS: u32 = 4_000_000;
const MAX_LEGACY_CHUNK_PAYLOAD: u32 = 32 * 1024 * 1024;

pub fn load_legacy(path: &Path) -> Result<StoredWorld, String> {
    let compressed = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    ZlibDecoder::new(compressed.as_slice())
        .read_to_end(&mut raw)
        .map_err(|err| format!("zlib inválido: {err}"))?;

    let mut reader = LegacyReader::new(&raw);
    if reader.take(4)? != LEGACY_MAGIC.as_slice() {
        return Err("assinatura desconhecida".to_string());
    }
    let version = reader.u8()?;
    if version != LEGACY_FORMAT_VERSION {
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
    if chunk_count > MAX_LEGACY_CHUNKS {
        return Err(format!("chunks demais no cache: {chunk_count}"));
    }
    let mut chunks = Vec::with_capacity(chunk_count as usize);
    let mut skipped = 0usize;
    for _ in 0..chunk_count {
        let x = reader.i32()?;
        let z = reader.i32()?;
        let len = reader.u32()?;
        if len > MAX_LEGACY_CHUNK_PAYLOAD {
            return Err(format!("payload de chunk grande demais: {len}"));
        }
        match decode_voxels(reader.take(len as usize)?) {
            Ok(decoded) => chunks.push((ChunkPos { x, z }, decoded.sections, decoded.tints)),
            // Payload de um formato mais novo (outra build do app) ou corrompido:
            // pula o chunk em vez de invalidar o cache inteiro — o que dá pra
            // ler ainda importa.
            Err(_) => skipped += 1,
        }
    }
    if chunks.is_empty() && skipped > 0 {
        return Err(format!(
            "nenhum dos {skipped} chunks do cache antigo pôde ser lido (formato mais novo?)"
        ));
    }
    if skipped > 0 {
        eprintln!("[world_store] {skipped} chunks ignorados ao importar o cache antigo (payload de versão desconhecida)");
    }

    Ok(StoredWorld { mc_version, chunks })
}

/// Cursor com checagem de limites pro container antigo.
struct LegacyReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> LegacyReader<'a> {
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
    use crate::world_cache::{PaletteEntry, VOXEL_FLAG_OCCLUDES, VOXEL_FLAG_RENDER, WorldCache};

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

    fn sample_sections() -> Vec<ChunkSection> {
        vec![section(-4, &["stone", "dirt"]), section(4, &["grass_block", "water"])]
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bowl-test-{}-{name}", std::process::id()))
    }

    #[test]
    fn store_round_trip_and_dedupe() {
        let dir = temp_dir("round-trip");
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = WorldStore::open(&dir).expect("log deveria abrir");

        let pos = ChunkPos { x: -2, z: 3 };
        store
            .write(pos, &sample_sections(), Some(&ChunkTints::solid([1, 2, 3])))
            .expect("escrita deveria funcionar");
        let decoded = store.read(pos).expect("leitura ok").expect("chunk existe");
        assert_eq!(decoded.sections, sample_sections());
        assert_eq!(decoded.tints, Some(ChunkTints::solid([1, 2, 3])));

        // Regravar o mesmo chunk: o índice aponta pro registro novo, o antigo
        // vira espaço morto e a contagem continua 1.
        store
            .write(pos, &sample_sections(), None)
            .expect("reescrita deveria funcionar");
        let decoded = store.read(pos).expect("leitura ok").expect("chunk existe");
        assert_eq!(decoded.tints, None);
        assert_eq!(store.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_reloads_index_from_disk() {
        let dir = temp_dir("reload");
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut store = WorldStore::open(&dir).expect("log deveria abrir");
            store
                .write(ChunkPos { x: 1, z: 1 }, &sample_sections(), None)
                .unwrap();
            store
                .write(ChunkPos { x: 2, z: -5 }, &sample_sections(), None)
                .unwrap();
        }
        let mut store = WorldStore::open(&dir).expect("log deveria reabrir");
        assert_eq!(store.len(), 2);
        assert!(store
            .read(ChunkPos { x: 2, z: -5 })
            .unwrap()
            .is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_drops_truncated_tail() {
        let dir = temp_dir("truncated");
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut store = WorldStore::open(&dir).expect("log deveria abrir");
            store
                .write(ChunkPos { x: 0, z: 0 }, &sample_sections(), None)
                .unwrap();
            store
                .write(ChunkPos { x: 1, z: 0 }, &sample_sections(), None)
                .unwrap();
        }
        // Simula um crash no meio da última append: corta bytes do fim.
        let log_path = dir.join("world.log");
        let len = std::fs::metadata(&log_path).unwrap().len();
        let file = OpenOptions::new().write(true).open(&log_path).unwrap();
        file.set_len(len - 10).unwrap();
        drop(file);

        let mut store = WorldStore::open(&dir).expect("log deveria abrir mesmo truncado");
        assert_eq!(store.len(), 1, "só o registro íntegro deveria sobrar");
        assert!(store.read(ChunkPos { x: 0, z: 0 }).unwrap().is_some());
        assert!(store.read(ChunkPos { x: 1, z: 0 }).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_compacts_keeping_latest_records() {
        let dir = temp_dir("compact");
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = WorldStore::open(&dir).expect("log deveria abrir");
        for i in 0..20i32 {
            store
                .write(ChunkPos { x: i, z: 0 }, &sample_sections(), None)
                .unwrap();
        }
        // Reescreve os mesmos chunks várias vezes: o log incha de espaço morto.
        for round in 0..5 {
            for i in 0..20i32 {
                store
                    .write(ChunkPos { x: i, z: 0 }, &sample_sections(), None)
                    .unwrap();
            }
            let _ = round;
        }
        let before = store.log_bytes;
        let after = store.compact().expect("compactação deveria funcionar");
        assert!(after < before, "compactado ({after}) deveria ser menor que {before}");
        assert_eq!(store.len(), 20, "nenhum chunk pode sumir na compactação");
        assert!(store.read(ChunkPos { x: 7, z: 0 }).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_cache_is_imported_once() {
        let dir = temp_dir("legacy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_legacy_cache(&dir, Some("26.3"), &[ChunkPos { x: 4, z: -1 }]);
        let cache_path = dir.join("world.cache");

        let mut store = WorldStore::open(&dir).expect("log deveria abrir");
        let version = import_legacy_cache(&dir, &mut store)
            .expect("importação deveria funcionar")
            .expect("versão do MC deveria vir no cache antigo");
        assert_eq!(version, "26.3");
        assert_eq!(store.len(), 1);
        assert!(cache_path.is_file(), "o cache antigo não é apagado (outra build pode usá-lo)");

        // Com o log já povoado, a importação não roda de novo.
        assert!(import_legacy_cache(&dir, &mut store).unwrap().is_none());
        assert_eq!(store.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn meta_round_trip() {
        let dir = temp_dir("meta");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("world.json");
        assert!(load_meta(&path).unwrap().is_none(), "ausente não é erro");

        let meta = WorldMeta {
            mc_version: Some("26.3".to_string()),
            last_bot_pos: Some(BlockPos { x: 10, y: 64, z: -20 }),
        };
        save_meta(&path, &meta).unwrap();
        assert_eq!(load_meta(&path).unwrap(), Some(meta.clone()));

        // JSON parcial (campo novo no futuro / arquivo editado à mão) cai no
        // padrão em vez de invalidar tudo.
        std::fs::write(&path, "{\"mc_version\":\"26.3\"}").unwrap();
        let partial = load_meta(&path).unwrap().unwrap();
        assert_eq!(partial.last_bot_pos, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lazy_world_cache_reads_chunks_back_from_disk() {
        let dir = temp_dir("lazy");
        let _ = std::fs::remove_dir_all(&dir);
        let mut world = WorldCache::open(&dir).expect("store deveria abrir");
        world.apply_voxels(
            ChunkPos { x: -1, z: 2 },
            sample_sections(),
            Some(ChunkTints::solid([9, 9, 9])),
        );
        assert_eq!(world.chunk_count(), 1);
        // O chunk está quente; limpa o set de trabalho e confere que o dado
        // volta do log sob demanda.
        world.hot_chunks.clear();
        assert_eq!(world.chunk_count(), 1, "contagem vem do índice, não da memória");
        let bytes = world.chunk_voxels_bytes(ChunkPos { x: -1, z: 2 });
        let decoded = decode_voxels(&bytes).expect("payload deveria decodificar");
        assert_eq!(decoded.sections, sample_sections());
        assert_eq!(decoded.tints, Some(ChunkTints::solid([9, 9, 9])));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Grava um `world.cache` no formato antigo (container BOWC v1) pra testar
    /// a importação.
    fn write_legacy_cache(dir: &Path, mc_version: Option<&str>, positions: &[ChunkPos]) {
        let mut raw = Vec::new();
        raw.extend_from_slice(LEGACY_MAGIC);
        raw.push(LEGACY_FORMAT_VERSION);
        let version = mc_version.unwrap_or("");
        raw.extend_from_slice(&(version.len() as u16).to_le_bytes());
        raw.extend_from_slice(version.as_bytes());
        raw.extend_from_slice(&(positions.len() as u32).to_le_bytes());
        for pos in positions {
            let payload = encode_voxels(&sample_sections(), None);
            raw.extend_from_slice(&pos.x.to_le_bytes());
            raw.extend_from_slice(&pos.z.to_le_bytes());
            raw.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            raw.extend_from_slice(&payload);
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw).unwrap();
        std::fs::write(dir.join("world.cache"), encoder.finish().unwrap()).unwrap();
    }
}
