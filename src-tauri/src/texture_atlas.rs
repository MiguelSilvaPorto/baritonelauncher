//! Atlas de texturas de bloco — ver `docs/SPEC.md`, seção "Blocos 3D".
//!
//! **Nunca baixa nem empacota nada da Mojang.** Lê só o `.jar` do client que
//! o usuário já tem instalado localmente (mesmo layout do launcher oficial:
//! `~/.minecraft/versions/<versão>/<versão>.jar`, o que o instalador do
//! NeoForge/Mojang já usa — ver `mod-addon/README.md`, "Ambiente já
//! instalado"). O atlas gerado fica cacheado em `src-tauri/.cache/`
//! (gitignored — texturas da Mojang não podem ir pro repositório público).
//!
//! v0 deliberadamente simples: só texturas 16×16 (pula animadas tipo
//! água/lava/fogo, que vêm como PNG mais alto com frames empilhados — exige
//! animação no shader, não implementado), empacotadas num grid uniforme
//! (não é bin-packing real, mas com tiles todos do mesmo tamanho não faz
//! diferença de espaço desperdiçado).

use base64::Engine;
use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const TILE_SIZE: u32 = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct UvRect {
    pub u0: f32,
    pub v0: f32,
    pub u1: f32,
    pub v1: f32,
}

#[derive(Debug, Serialize)]
pub struct TextureAtlas {
    /// PNG do atlas como data URL — simples de consumir no frontend sem
    /// precisar de um protocolo de asset customizado do Tauri.
    pub image_data_url: String,
    /// Nome da textura (ex: `"grass_block_top"`) -> retângulo UV normalizado (0..1).
    pub textures: HashMap<String, UvRect>,
}

fn cache_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".cache")
}

/// Onde o client jar já instalado deveria estar. Não baixa nada se não
/// encontrar — devolve `None` e quem chamou decide o que fazer (hoje: erro
/// honesto pedindo pra instalar a versão certa).
fn find_local_client_jar(mc_version: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home)
        .join(".minecraft/versions")
        .join(mc_version)
        .join(format!("{mc_version}.jar"));
    path.is_file().then_some(path)
}

/// Gera (ou reaproveita do cache local) o atlas de texturas de bloco pra
/// versão pedida.
pub fn build_or_load_atlas(mc_version: &str) -> Result<TextureAtlas, String> {
    let png_path = cache_dir().join(format!("atlas_{mc_version}.png"));
    let json_path = cache_dir().join(format!("atlas_{mc_version}.json"));

    if png_path.is_file() && json_path.is_file() {
        return load_cached(&png_path, &json_path);
    }

    let jar_path = find_local_client_jar(mc_version).ok_or_else(|| {
        format!(
            "Client jar do Minecraft {mc_version} não encontrado em \
             ~/.minecraft/versions/{mc_version}/{mc_version}.jar — instale essa \
             versão pelo launcher oficial primeiro."
        )
    })?;

    build_atlas(&jar_path, mc_version)
}

fn to_data_url(png_bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes)
    )
}

fn load_cached(png_path: &Path, json_path: &Path) -> Result<TextureAtlas, String> {
    let png_bytes = std::fs::read(png_path).map_err(|e| e.to_string())?;
    let raw_json = std::fs::read_to_string(json_path).map_err(|e| e.to_string())?;
    let textures: HashMap<String, UvRect> = serde_json::from_str(&raw_json).map_err(|e| e.to_string())?;
    Ok(TextureAtlas {
        image_data_url: to_data_url(&png_bytes),
        textures,
    })
}

fn build_atlas(jar_path: &Path, mc_version: &str) -> Result<TextureAtlas, String> {
    let file = std::fs::File::open(jar_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut raw: Vec<(String, RgbaImage)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let Some(stem) = name
            .strip_prefix("assets/minecraft/textures/block/")
            .and_then(|s| s.strip_suffix(".png"))
        else {
            continue;
        };

        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let Ok(img) = image::load_from_memory(&bytes) else {
            continue;
        };
        if img.width() != TILE_SIZE || img.height() != TILE_SIZE {
            continue; // animada (frames empilhados) ou atípica — pulada por enquanto
        }
        raw.push((stem.to_string(), img.to_rgba8()));
    }
    raw.sort_by(|a, b| a.0.cmp(&b.0)); // saída determinística, cache estável

    if raw.is_empty() {
        return Err(format!("Nenhuma textura de bloco 16x16 encontrada em {jar_path:?}"));
    }

    let cols = (raw.len() as f64).sqrt().ceil() as u32;
    let rows = (raw.len() as u32).div_ceil(cols);
    let atlas_w = cols * TILE_SIZE;
    let atlas_h = rows * TILE_SIZE;

    let mut atlas = RgbaImage::new(atlas_w, atlas_h);
    let mut textures = HashMap::with_capacity(raw.len());

    for (idx, (name, tile)) in raw.iter().enumerate() {
        let col = idx as u32 % cols;
        let row = idx as u32 / cols;
        let x = col * TILE_SIZE;
        let y = row * TILE_SIZE;
        image::imageops::overlay(&mut atlas, tile, x as i64, y as i64);
        textures.insert(
            name.clone(),
            UvRect {
                u0: x as f32 / atlas_w as f32,
                v0: y as f32 / atlas_h as f32,
                u1: (x + TILE_SIZE) as f32 / atlas_w as f32,
                v1: (y + TILE_SIZE) as f32 / atlas_h as f32,
            },
        );
    }

    std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;
    let png_path = cache_dir().join(format!("atlas_{mc_version}.png"));
    let json_path = cache_dir().join(format!("atlas_{mc_version}.json"));

    DynamicImage::ImageRgba8(atlas.clone())
        .save(&png_path)
        .map_err(|e| e.to_string())?;
    std::fs::write(
        &json_path,
        serde_json::to_string(&textures).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let mut png_bytes = Vec::new();
    DynamicImage::ImageRgba8(atlas)
        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(TextureAtlas {
        image_data_url: to_data_url(&png_bytes),
        textures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Integração real contra o jar instalado nesta máquina — pula sozinho
    /// (não falha) se não existir, pra não quebrar em outro ambiente/CI.
    #[test]
    fn builds_atlas_from_local_jar_if_present() {
        let Some(jar) = find_local_client_jar("26.3") else {
            eprintln!("skip: sem client jar local pra testar contra");
            return;
        };
        let atlas = build_atlas(&jar, "26.3-test").expect("atlas deveria construir");
        assert!(
            atlas.textures.len() > 500,
            "esperava centenas de texturas, achei {}",
            atlas.textures.len()
        );
        assert!(
            atlas.textures.contains_key("grass_block_top"),
            "textura conhecida ausente"
        );
        let rect = atlas.textures["grass_block_top"];
        assert!(rect.u1 > rect.u0 && rect.v1 > rect.v0, "UV rect inválido: {rect:?}");

        // limpa o cache de teste pra não sujar o diretório real
        let _ = std::fs::remove_file(cache_dir().join("atlas_26.3-test.png"));
        let _ = std::fs::remove_file(cache_dir().join("atlas_26.3-test.json"));
    }
}
