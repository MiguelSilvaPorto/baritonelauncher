//! Mobs vivos ao redor do jogador — ver `docs/SPEC.md`, seção "Combate e
//! ameaças" (detecção). O addon Java varre as entidades num raio e manda um
//! snapshot pelo socket (`entities`, ver `addon_socket.rs`); este módulo é só
//! o modelo recebido — a reação (`SurvivalProcess`) ainda não existe, então
//! nada aqui decide lutar/fugir.

use serde::{Deserialize, Serialize};

/// Categoria do mob, classificada pelo addon a partir do tipo real do jogo
/// (`NeutralMob`/`Enemy`/`MobCategory` — ver `mobCategory` no addon). É o que
/// deixa a UI destacar ameaça sem precisar de uma tabela de mobs própria.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MobCategory {
    /// Ataca o jogador (zumbi, esqueleto, creeper...).
    Hostile,
    /// Só reage se provocado (lobo, abelha, enderman, piglin zumbificado...).
    Neutral,
    /// Bicho de fazenda/ambiente (vaca, galinha, morcego, peixe...).
    Passive,
    /// O que sobra (villager, golem de neve, suporte de armadura...).
    Other,
}

/// Uma entidade viva reportada pelo addon. `id` é o id de rede da entidade
/// (único dentro de uma sessão do mundo) e é a chave que o viewer usa pra
/// manter o marcador estável entre snapshots. `kind` é o nome de registro
/// (`zombie`, `cow`...) e `name` é o nome exibido no jogo, já localizado pelo
/// client (com o nome customizado, se o mob tiver um).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NearbyMob {
    pub id: i32,
    pub kind: String,
    pub name: String,
    pub category: MobCategory,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub health: f32,
    pub max_health: f32,
    /// Distância real até o jogador no momento da varredura, em blocos — quem
    /// mede é o addon (que tem as duas posições), não o app.
    pub distance: f32,
    /// Altura da hitbox — o rótulo do viewer senta em cima do mob em vez de
    /// atravessar o corpo dele (galinha e enderman não têm a mesma altura).
    pub height: f32,
    /// Yaw do corpo em graus (0 = sul, como no jogo) — o `yBodyRot` real da
    /// entidade, que orienta o modelo inteiro no viewer. `default` mantém um
    /// addon antigo (sem os campos de pose) funcionando: o modelo fica virado
    /// pro sul e sem cabeça articulada até o addon novo mandar.
    #[serde(default)]
    pub yaw: f32,
    /// Pitch da cabeça em graus (positivo = olhando pra baixo) — o `xRot` do
    /// jogo, aplicado só na cabeça do modelo.
    #[serde(default)]
    pub pitch: f32,
    /// Yaw da cabeça **relativo** ao corpo em graus (`getYRot() - yBodyRot`,
    /// normalizado) — é exatamente o que o jogo passa pro `head.yRot`.
    #[serde(default)]
    pub head_yaw: f32,
    /// `isBaby()` — o viewer troca pro modelo/textura de filhote (vaca,
    /// porco, ovelha, galinha e zumbi têm modelos de bebê próprios no jogo).
    #[serde(default)]
    pub is_baby: bool,
    /// Cor de sobreposição em RGB (a lã da ovelha, resolvida pelo próprio
    /// `DyeColor` do jogo). `None` = sem sobreposição: mob sem camada ou
    /// ovelha tosquiada — o viewer não inventa uma cor nesse caso.
    #[serde(default)]
    pub tint: Option<u32>,
}

/// Snapshot do raio varrido. O raio vem do addon (campo `radius` da mensagem),
/// não é um chute do app — a UI mostra o valor real da varredura.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobSnapshot {
    pub radius: f32,
    pub mobs: Vec<NearbyMob>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O JSON aqui é o mesmo que o addon Java monta (`sendNearbyMobs`) — se um
    /// lado renomear um campo/categoria, este teste quebra antes do socket.
    #[test]
    fn snapshot_json_matches_addon_protocol() {
        let json = r#"{
            "radius": 32.0,
            "mobs": [
                {"id": 7, "kind": "zombie", "name": "Zumbi", "category": "hostile",
                 "x": 1.5, "y": 64.0, "z": -3.25, "health": 20.0, "max_health": 20.0,
                 "distance": 6.2, "height": 1.95,
                 "yaw": 90.0, "pitch": 12.5, "head_yaw": -8.0, "is_baby": false},
                {"id": 9, "kind": "cow", "name": "Vaca", "category": "passive",
                 "x": -4.0, "y": 63.0, "z": 8.0, "health": 10.0, "max_health": 10.0,
                 "distance": 12.8, "height": 1.4,
                 "yaw": 180.0, "pitch": 0.0, "head_yaw": 15.0, "is_baby": true},
                {"id": 11, "kind": "sheep", "name": "Ovelha", "category": "passive",
                 "x": 0.0, "y": 64.0, "z": 0.0, "health": 8.0, "max_health": 8.0,
                 "distance": 2.0, "height": 1.3,
                 "yaw": 0.0, "pitch": 0.0, "head_yaw": 0.0, "is_baby": false, "tint": 16383998}
            ]
        }"#;
        let snapshot: MobSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snapshot.radius, 32.0);
        assert_eq!(snapshot.mobs.len(), 3);
        assert_eq!(snapshot.mobs[0].category, MobCategory::Hostile);
        assert_eq!(snapshot.mobs[1].category, MobCategory::Passive);
        assert_eq!(snapshot.mobs[0].kind, "zombie");
        assert_eq!(snapshot.mobs[1].name, "Vaca");
        assert_eq!(snapshot.mobs[0].yaw, 90.0);
        assert_eq!(snapshot.mobs[0].head_yaw, -8.0);
        assert!(snapshot.mobs[1].is_baby);
        assert_eq!(snapshot.mobs[2].tint, Some(16_383_998));
        assert_eq!(snapshot.mobs[0].tint, None);
    }

    /// Addon antigo (sem pose/nascimento/tint) continua parseando — os campos
    /// novos têm `default` justamente pra isso; o viewer desenha o mob virado
    /// pro sul e sem sobreposição em vez de recusar o snapshot inteiro.
    #[test]
    fn snapshot_without_pose_fields_still_parses() {
        let json = r#"{"id": 7, "kind": "zombie", "name": "Zumbi", "category": "hostile",
            "x": 1.5, "y": 64.0, "z": -3.25, "health": 20.0, "max_health": 20.0,
            "distance": 6.2, "height": 1.95}"#;
        let mob: NearbyMob = serde_json::from_str(json).unwrap();
        assert_eq!(mob.yaw, 0.0);
        assert!(!mob.is_baby);
        assert_eq!(mob.tint, None);
    }

    /// Uma categoria desconhecida (addon mais novo que o app) precisa falhar
    /// alto na desserialização em vez de virar `Other` em silêncio.
    #[test]
    fn unknown_category_is_rejected() {
        let json = r#"{"id": 1, "kind": "x", "name": "X", "category": "boss",
            "x": 0.0, "y": 0.0, "z": 0.0, "health": 1.0, "max_health": 1.0,
            "distance": 1.0, "height": 1.0}"#;
        assert!(serde_json::from_str::<NearbyMob>(json).is_err());
    }
}
