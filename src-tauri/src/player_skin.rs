//! Skin do próprio jogador — o viewer desenha o modelo do Minecraft de
//! verdade (cabeça/tronco/braços/pernas) com a textura que o jogador usa no
//! jogo, em vez de um marcador genérico. Ver `docs/SPEC.md` e
//! `src/player_model.ts`.
//!
//! Os bytes chegam do addon Java (mensagem `player_skin`, ver
//! `addon_socket.rs`) já como PNG: o addon lê o que o client já tem carregado
//! — o cache de texturas pra skin baixada/customizada, o resource pack/jar
//! instalado pra skin padrão. Nada é baixado da CDN da Mojang aqui (regra 10
//! do AGENTS.md; mesmo padrão de `texture_atlas.rs`).

use serde::{Deserialize, Serialize};

/// Teto do PNG em bytes — uma skin 64×64 fica na casa de poucos KB; o teto
/// existe só pra uma mensagem corrompida não virar alocação gigante.
const MAX_SKIN_BYTES: usize = 512 * 1024;

/// Assinatura de um PNG (`\x89PNG\r\n\x1a\n`), pra descartar payload que não
/// seja imagem antes de mandar pro frontend.
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Skin do jogador como o viewer precisa: nome, variante do modelo
/// (`"slim"`/`"wide"`) e a imagem pronta pra usar como `src` de um `<img>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSkin {
    pub name: String,
    /// `"slim"` (Alex — braço de 3px de largura) ou `"wide"` (Steve — 4px).
    /// Qualquer outro valor cai em `"wide"`, que é o padrão do jogo.
    pub model: String,
    /// PNG em data URL; o frontend usa direto como textura do modelo.
    pub image_data_url: String,
}

impl PlayerSkin {
    /// Valida o base64 (e a assinatura de PNG) e monta a data URL. Erro = a
    /// mensagem é ignorada com log em `addon_socket.rs`, sem derrubar a
    /// conexão.
    pub fn from_png_base64(name: String, model: String, png_base64: &str) -> Result<Self, String> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png_base64)
            .map_err(|err| format!("base64 inválido: {err}"))?;
        if bytes.len() > MAX_SKIN_BYTES {
            return Err(format!(
                "PNG grande demais: {} bytes (teto {MAX_SKIN_BYTES})",
                bytes.len()
            ));
        }
        if !bytes.starts_with(&PNG_MAGIC) {
            return Err("payload não é um PNG".to_string());
        }

        Ok(Self {
            name,
            model: if model == "slim" { "slim" } else { "wide" }.to_string(),
            image_data_url: format!("data:image/png;base64,{png_base64}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn png_base64() -> String {
        // 1×1 PNG transparente — só pra passar na checagem de assinatura.
        let png: [u8; 67] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    #[test]
    fn accepts_a_png_and_normalizes_the_model() {
        let skin = PlayerSkin::from_png_base64(
            "Miguel".to_string(),
            "slim".to_string(),
            &png_base64(),
        )
        .expect("PNG deveria ser aceito");
        assert_eq!(skin.name, "Miguel");
        assert_eq!(skin.model, "slim");
        assert!(skin.image_data_url.starts_with("data:image/png;base64,"));

        let unknown = PlayerSkin::from_png_base64(
            "Miguel".to_string(),
            "huge".to_string(),
            &png_base64(),
        )
        .expect("PNG deveria ser aceito");
        assert_eq!(unknown.model, "wide");
    }

    #[test]
    fn rejects_non_png_and_invalid_base64() {
        assert!(PlayerSkin::from_png_base64(
            "x".to_string(),
            "wide".to_string(),
            &base64::engine::general_purpose::STANDARD.encode(b"not a png"),
        )
        .is_err());
        assert!(PlayerSkin::from_png_base64("x".to_string(), "wide".to_string(), "???").is_err());
    }
}
