//! Atlas de texturas de bloco — ver `docs/SPEC.md`, seção "Blocos 3D".
//!
//! **Nunca baixa nem empacota nada da Mojang.** Lê só o `.jar` do client que
//! o usuário já tem instalado localmente (mesmo layout do launcher oficial:
//! `~/.minecraft/versions/<versão>/<versão>.jar`, o que o instalador do
//! NeoForge/Mojang já usa — ver `mod-addon/README.md`, "Ambiente já
//! instalado"). O atlas gerado fica cacheado em `src-tauri/.cache/`
//! (gitignored — texturas da Mojang não podem ir pro repositório público).
//!
//! v0 deliberadamente simples: um tile 16×16 por textura, empacotado num
//! grid uniforme (não é bin-packing real, mas com tiles todos do mesmo
//! tamanho não faz diferença de espaço desperdiçado). Texturas animadas
//! (água, lava, fogo...) vêm como PNG mais alto com os frames empilhados:
//! cada frame vira um tile `"{nome}_f{n}"` (o nome puro continua no mapa,
//! apontando pro frame 0), e é isso que permite o viewer animar água/lava de
//! verdade em vez de mostrar um fotograma congelado. Frames de 32×32
//! (`water_flow`, `lava_flow`) são reduzidos pra 16×16 — o atlas é uniforme
//! 16×16; texturas estáticas de outro tamanho (ex: 32×32 de placa) continuam
//! puladas. Um tile branco sintético (`__white`) entra no fim do atlas como
//! fallback tingível pra bloco sem textura resolvida — o viewer pinta o bloco
//! com cor sólida por cima dele em vez de fingir que é outro bloco.

use base64::Engine;
use image::{DynamicImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const TILE_SIZE: u32 = 16;

/// Sobe isto sempre que a extração/empacotamento mudar de formato: o cache
/// em disco é reaproveitado sem checar conteúdo (`build_or_load_atlas`),
/// então sem a versão no nome um atlas antigo continuaria valendo pra sempre.
const ATLAS_CACHE_VERSION: u32 = 4;

/// Nome do tile sintético (não existe no jar) usado como fallback de textura
/// — o viewer pinta o bloco só com vertex color por cima dele.
pub const WHITE_TILE_NAME: &str = "__white";

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

/// Caminho do par PNG+JSON do atlas em cache pra uma versão — centralizado
/// aqui pra `build_or_load_atlas`, `build_atlas` e o teste usarem o mesmo
/// nome (a versão do formato acima faz parte do nome).
fn cache_paths(mc_version: &str) -> (PathBuf, PathBuf) {
    let base = cache_dir().join(format!("atlas_v{ATLAS_CACHE_VERSION}_{mc_version}"));
    (base.with_extension("png"), base.with_extension("json"))
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
    let (png_path, json_path) = cache_paths(mc_version);

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

        // Estática 16×16 → um tile; animada com frames empilhados na vertical
        // (water_still 16×512, lava_flow 32×512…) → um tile por frame. Frames
        // de 32×32 são reduzidos pra 16×16: o atlas é uniforme, e é o que
        // deixa água/lava fluindo no shader (`water_flow` nunca é 16×16).
        let (frame_size, frame_count) = match (img.width(), img.height()) {
            (TILE_SIZE, TILE_SIZE) => (TILE_SIZE, 1),
            (TILE_SIZE, h) if h > TILE_SIZE && h % TILE_SIZE == 0 => (TILE_SIZE, h / TILE_SIZE),
            (32, h) if h > 32 && h % 32 == 0 => (32, h / 32),
            _ => continue, // atípica/estática de outro tamanho (ex: 32×32 de placa) — pulada
        };

        if frame_count == 1 {
            raw.push((stem.to_string(), img.to_rgba8()));
            continue;
        }

        for frame in 0..frame_count {
            let cropped = img.crop_imm(0, frame * frame_size, frame_size, frame_size);
            let tile = if frame_size == TILE_SIZE {
                cropped
            } else {
                cropped.resize_exact(TILE_SIZE, TILE_SIZE, image::imageops::FilterType::Triangle)
            };
            raw.push((format!("{stem}_f{frame}"), tile.to_rgba8()));
        }
    }

    // Fallback tingível pra bloco cujo nome não resolve pra textura nenhuma
    // (mod, nome com variante...): branco puro pra multiplicar só a cor do
    // vértice. Sem ele, o viewer teria que usar a textura de outro bloco.
    raw.push((
        WHITE_TILE_NAME.to_string(),
        RgbaImage::from_pixel(TILE_SIZE, TILE_SIZE, Rgba([255, 255, 255, 255])),
    ));
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

    // Textura animada também fica no mapa pelo nome "puro", apontando pro
    // frame 0 — quem só quer um frame estático (blocos opacos, lava parada)
    // continua funcionando sem saber da animação. O viewer acha os outros
    // frames procurando `"{nome}_f1"`, `"_f2"`… em ordem.
    let frame_zero: Vec<(String, UvRect)> = textures
        .iter()
        .filter_map(|(name, rect)| name.strip_suffix("_f0").map(|stem| (stem.to_string(), *rect)))
        .collect();
    for (stem, rect) in frame_zero {
        textures.insert(stem, rect);
    }

    std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;
    let (png_path, json_path) = cache_paths(mc_version);

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
        assert!(
            atlas.textures.contains_key("water_still"),
            "textura animada (alias do frame 0) deveria entrar no atlas"
        );
        assert!(
            atlas.textures.contains_key("water_still_f0"),
            "primeiro frame da textura animada deveria entrar no atlas"
        );
        assert!(
            atlas.textures.contains_key("water_still_f1"),
            "segundo frame da textura animada deveria entrar no atlas"
        );
        // water_flow é 32×32 por frame — precisa ser reduzida, não pulada.
        assert!(
            atlas.textures.contains_key("water_flow_f0"),
            "frame de textura 32×32 (water_flow) deveria ser reduzido e entrar no atlas"
        );
        assert!(
            atlas.textures.contains_key(WHITE_TILE_NAME),
            "tile sintético de fallback deveria entrar no atlas"
        );

        // limpa o cache de teste pra não sujar o diretório real
        let (png_path, json_path) = cache_paths("26.3-test");
        let _ = std::fs::remove_file(png_path);
        let _ = std::fs::remove_file(json_path);
    }
}
