//! Modelos de bloco reais — o viewer desenhava **todo** bloco como cubo cheio
//! (ver docs/SPEC.md, "Blocos 3D"), o que deformava tochas, cogumelos,
//! vitórias-régias, flores, escadas, cercas etc. Este módulo lê os
//! `blockstates/*.json` + `models/block/*.json` do **client jar que o usuário
//! já tem instalado** (mesma regra do `texture_atlas.rs`: nada é baixado nem
//! empacotado da Mojang) e assa a geometria de cada variante num formato
//! compacto pro frontend.
//!
//! O porte é fiel ao jogo (26.3): mesmas faces/vértices do `FaceInfo`, mesma
//! ordem de UVs do `CuboidFace`, rotação de elemento do `CuboidRotation`
//! (eixo+ângulo com `rescale`), rotação de variante (x/y/z) e `uvlock` do
//! `BlockMath`, UV padrão do `FaceBakery.defaultFaceUV`. O que o viewer recebe
//! já está no espaço do bloco (1/16) e **já rotacionado**, na ordem de cantos
//! da tabela `FACES` do `viewer3d.ts` — o frontend só posiciona no bloco.
//!
//! Blocos cujo modelo é um cubo cheio sem rotação **ficam de fora** do
//! payload: o caminho antigo (cubo com textura por face) continua valendo pra
//! eles, o que mantém o tamanho do payload e o risco de regressão baixos.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use crate::texture_atlas::{cache_dir, find_local_client_jar};

/// Sobe isto quando o formato do payload mudar: o cache em disco é
/// reaproveitado sem checar conteúdo.
const MODELS_CACHE_VERSION: u32 = 1;

/// Direção de face na convenção vanilla (`Direction`), usada pelos JSONs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FaceDir {
    Down,
    Up,
    North,
    South,
    West,
    East,
}

/// Ordem do `Direction.values()` do jogo — importa pro `getApproximateNearest`
/// (empate fica com a primeira).
const VANILLA_DIRECTIONS: [FaceDir; 6] = [
    FaceDir::Down,
    FaceDir::Up,
    FaceDir::North,
    FaceDir::South,
    FaceDir::West,
    FaceDir::East,
];

impl FaceDir {
    fn normal(self) -> [f32; 3] {
        match self {
            FaceDir::Down => [0.0, -1.0, 0.0],
            FaceDir::Up => [0.0, 1.0, 0.0],
            FaceDir::North => [0.0, 0.0, -1.0],
            FaceDir::South => [0.0, 0.0, 1.0],
            FaceDir::West => [-1.0, 0.0, 0.0],
            FaceDir::East => [1.0, 0.0, 0.0],
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "down" => Some(FaceDir::Down),
            "up" => Some(FaceDir::Up),
            "north" => Some(FaceDir::North),
            "south" => Some(FaceDir::South),
            "west" => Some(FaceDir::West),
            "east" => Some(FaceDir::East),
            _ => None,
        }
    }

    /// Índice na tabela `FACES` do `viewer3d.ts`: [+x, −x, +y, −y, +z, −z].
    fn frontend_index(self) -> usize {
        match self {
            FaceDir::East => 0,
            FaceDir::West => 1,
            FaceDir::Up => 2,
            FaceDir::Down => 3,
            FaceDir::South => 4,
            FaceDir::North => 5,
        }
    }
}

/// Quais das faces do `FaceInfo` já viram `FACES[frontend_index]` no viewer —
/// medido comparando os cantos das duas tabelas (todas as faces batem com
/// deslocamento 1, menos o topo, que bate direto).
fn corner_shift(dir: FaceDir) -> usize {
    if dir == FaceDir::Up {
        0
    } else {
        1
    }
}

/// Um quad pronto: 4 vértices (12 floats, em 1/16 de bloco) e 4 UVs (8 floats,
/// em pixels de textura 0..16), na ordem dos cantos do `FACES` do viewer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quad {
    /// [x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3] em 1/16 de bloco.
    pub p: Vec<f32>,
    /// [u0,v0, u1,v1, u2,v2, u3,v3] em 0..16.
    pub uv: Vec<f32>,
    pub tex: String,
    /// Direção que esse quad culla (índice em `FACES`) — ausente = nunca culla.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cull: Option<usize>,
    /// `-1` sem tint; `>= 0` o viewer aplica o tint do bloco.
    pub tint: i8,
}

/// Uma parte do modelo: condições de match + a geometria. `when` vazio =
/// sempre aplica.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPart {
    /// OR de condições; cada condição é um AND `"k=v,k2=v2"` (valores aceitam
    /// `a|b` e `!valor`, como no `KeyValueCondition` do jogo).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub when: Vec<String>,
    /// Índice em `BlockModels::geometries`.
    pub geo: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockModelDef {
    /// `true` = multipart (aplica todas as partes que casam); `false` =
    /// variants (aplica só a primeira que casa, na ordem do JSON).
    pub multipart: bool,
    pub parts: Vec<ModelPart>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct BlockModels {
    /// Geometrias deduplicadas (modelo + rotação).
    pub geometries: Vec<Vec<Quad>>,
    /// Nome do bloco (path do registry, ex: `"torch"`) → partes.
    pub blocks: HashMap<String, BlockModelDef>,
}

impl BlockModels {
    pub fn quad_count(&self) -> usize {
        self.geometries.iter().map(|g| g.len()).sum()
    }
}

/// Versão do payload binário (ver `encode_payload` e o decoder em
/// `viewer3d.ts`). Mudar o layout sem subir isto corrompe a decodificação em
/// vez de dar erro claro.
pub const MODELS_PAYLOAD_VERSION: u8 = 1;

/// Serializa os modelos num payload binário compacto (little-endian):
///
/// ```text
/// u8  versão
/// u16 nº de texturas    | por textura: u16 len, bytes UTF-8
/// u16 nº de condições   | por condição: u16 len, bytes UTF-8
/// u16 nº de geometrias  | por geometria: u16 nº de quads (os quads vêm em
///                       |   sequência, na mesma ordem das geometrias)
/// por quad: 12×i16 posições (1/16 de bloco)
///           8×u16 UVs (1/16 de pixel de textura)
///           u16 índice da textura, i8 cull (−1 = nenhum), i8 tint (−1 = nenhum)
/// u32 nº de blocos
/// por bloco: u16 len do nome, bytes UTF-8, u8 multipart,
///            u16 nº de partes
///            por parte: u8 nº de condições (OR), u16[] índices de condição,
///                       u16 índice da geometria
/// ```
///
/// JSON dava ~11 MB (números e nomes de textura repetidos por face); este
/// formato fica na casa dos MBs e é decodificado direto pra `TypedArray` no
/// frontend.
pub fn encode_payload(models: &BlockModels) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 1024 * 1024);

    // Tabela de texturas (interna os nomes repetidos em cada quad).
    let mut textures: Vec<&str> = Vec::new();
    let mut texture_index: HashMap<&str, u16> = HashMap::new();
    for geometry in &models.geometries {
        for quad in geometry {
            if !texture_index.contains_key(quad.tex.as_str()) {
                texture_index.insert(quad.tex.as_str(), textures.len() as u16);
                textures.push(quad.tex.as_str());
            }
        }
    }

    // Tabela de condições (`when`), também internada.
    let mut conditions: Vec<&str> = Vec::new();
    let mut condition_index: HashMap<&str, u16> = HashMap::new();
    for def in models.blocks.values() {
        for part in &def.parts {
            for when in &part.when {
                if !condition_index.contains_key(when.as_str()) {
                    condition_index.insert(when.as_str(), conditions.len() as u16);
                    conditions.push(when.as_str());
                }
            }
        }
    }

    out.push(MODELS_PAYLOAD_VERSION);
    write_string_table(&mut out, &textures);
    write_string_table(&mut out, &conditions);

    let u16_max = u16::MAX as usize;
    out.extend_from_slice(&(models.geometries.len().min(u16_max) as u16).to_le_bytes());
    for geometry in models.geometries.iter().take(u16_max) {
        out.extend_from_slice(&(geometry.len().min(u16_max) as u16).to_le_bytes());
    }
    for geometry in models.geometries.iter().take(u16_max) {
        for quad in geometry.iter().take(u16_max) {
            for value in &quad.p {
                out.extend_from_slice(&((value * 16.0).round() as i16).to_le_bytes());
            }
            for value in &quad.uv {
                out.extend_from_slice(&((value * 16.0).round().clamp(0.0, u16_max as f32) as u16).to_le_bytes());
            }
            let tex = texture_index
                .get(quad.tex.as_str())
                .copied()
                .unwrap_or(0);
            out.extend_from_slice(&tex.to_le_bytes());
            out.push(quad.cull.map(|c| c as i8).unwrap_or(-1) as u8);
            out.push(quad.tint as u8);
        }
    }

    let mut blocks: Vec<(&String, &BlockModelDef)> = models.blocks.iter().collect();
    blocks.sort_by(|a, b| a.0.cmp(b.0)); // saída determinística
    out.extend_from_slice(&(blocks.len().min(u32::MAX as usize) as u32).to_le_bytes());
    for (name, def) in blocks {
        let bytes = name.as_bytes();
        out.extend_from_slice(&(bytes.len().min(u16_max) as u16).to_le_bytes());
        out.extend_from_slice(bytes);
        out.push(def.multipart as u8);
        let parts = def.parts.iter().take(u16_max).count();
        out.extend_from_slice(&(parts as u16).to_le_bytes());
        for part in def.parts.iter().take(u16_max) {
            let whens = part.when.iter().take(u8::MAX as usize).collect::<Vec<_>>();
            out.push(whens.len() as u8);
            for when in whens {
                let index = condition_index.get(when.as_str()).copied().unwrap_or(0);
                out.extend_from_slice(&index.to_le_bytes());
            }
            out.extend_from_slice(&(part.geo.min(u16_max) as u16).to_le_bytes());
        }
    }

    out
}

fn write_string_table(out: &mut Vec<u8>, values: &[&str]) {
    out.extend_from_slice(&(values.len().min(u16::MAX as usize) as u16).to_le_bytes());
    for value in values {
        let bytes = value.as_bytes();
        out.extend_from_slice(&(bytes.len().min(u16::MAX as usize) as u16).to_le_bytes());
        out.extend_from_slice(bytes);
    }
}

// ---------------------------------------------------------------------------
// Álgebra linear mínima (matrizes 3×3, rotações right-handed como o JOML)
// ---------------------------------------------------------------------------

type Mat3 = [[f32; 3]; 3];

const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

fn mat_mul_vec(m: &Mat3, v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn is_identity(m: &Mat3) -> bool {
    (0..3).all(|i| (0..3).all(|j| (m[i][j] - IDENTITY[i][j]).abs() < 1e-6))
}

fn rot_x(deg: f32) -> Mat3 {
    let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

fn rot_y(deg: f32) -> Mat3 {
    let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}

fn rot_z(deg: f32) -> Mat3 {
    let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// Rotação de eixo arbitrário (JOML `Matrix4f.rotation(angle, axis)`).
fn rot_axis(axis: [f32; 3], deg: f32) -> Mat3 {
    let len = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if len == 0.0 {
        return IDENTITY;
    }
    let (x, y, z) = (axis[0] / len, axis[1] / len, axis[2] / len);
    let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
    let t = 1.0 - c;
    [
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn approx_nearest(v: [f32; 3]) -> FaceDir {
    let mut best = FaceDir::North;
    let mut best_dot = f32::MIN;
    for dir in VANILLA_DIRECTIONS {
        let d = dot(v, dir.normal());
        if d > best_dot {
            best_dot = d;
            best = dir;
        }
    }
    best
}

fn invert(m: &Mat3) -> Mat3 {
    // Matriz de rotação (ortonormal): a inversa é a transposta.
    [
        [m[0][0], m[1][0], m[2][0]],
        [m[0][1], m[1][1], m[2][1]],
        [m[0][2], m[1][2], m[2][2]],
    ]
}

/// Matriz da rotação de variante (x/y/z do blockstate), como em
/// `Quadrant.fromXYZAngles`: `Rz(−z) · Ry(−y) · Rx(−x)` — os ângulos do JSON
/// são o negativo do ângulo matemático (conferido contra as matrizes do
/// `OctahedralGroup` do 26.3).
fn variant_matrix(x: i32, y: i32, z: i32) -> Mat3 {
    let rz = rot_z(-(z as f32));
    let ry = rot_y(-(y as f32));
    let rx = rot_x(-(x as f32));
    mat_mul(&rz, &mat_mul(&ry, &rx))
}

/// `BlockMath.VANILLA_UV_TRANSFORM_LOCAL_TO_GLOBAL` — a rotação que leva o
/// plano de UV local da face pro plano global.
fn vanilla_uv_local_to_global(dir: FaceDir) -> Mat3 {
    match dir {
        FaceDir::South => IDENTITY,
        FaceDir::East => rot_y(90.0),
        FaceDir::West => rot_y(-90.0),
        FaceDir::North => rot_y(180.0),
        FaceDir::Up => rot_x(-90.0),
        FaceDir::Down => rot_x(90.0),
    }
}

/// `BlockMath.getFaceTransformation` — transformação da face que o `uvlock`
/// usa (invertida no `bakeVertex`).
fn face_transformation(transform: &Mat3, original_side: FaceDir) -> Mat3 {
    if is_identity(transform) {
        return IDENTITY;
    }
    let base = vanilla_uv_local_to_global(original_side);
    let face_action = mat_mul(transform, &base);
    let normal = mat_mul_vec(&face_action, [0.0, 0.0, 1.0]);
    let new_side = approx_nearest(normal);
    mat_mul(&invert(&vanilla_uv_local_to_global(new_side)), &face_action)
}

fn rotate_about(point: [f32; 3], origin: [f32; 3], m: &Mat3) -> [f32; 3] {
    let rel = [
        point[0] - origin[0],
        point[1] - origin[1],
        point[2] - origin[2],
    ];
    let r = mat_mul_vec(m, rel);
    [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]]
}

// ---------------------------------------------------------------------------
// Leitura do jar + resolução de modelos (parent, textures)
// ---------------------------------------------------------------------------

/// `FaceInfo` do jogo: canto de cada índice de vértice, por face, em pixels do
/// modelo (0..16).
fn face_info_vertex(dir: FaceDir, index: usize, from: [f32; 3], to: [f32; 3]) -> [f32; 3] {
    // true = máximo, false = mínimo, na ordem x, y, z.
    let picks: [[bool; 3]; 4] = match dir {
        // DOWN: (minX,minY,maxZ) (minX,minY,minZ) (maxX,minY,minZ) (maxX,minY,maxZ)
        FaceDir::Down => [
            [false, false, true],
            [false, false, false],
            [true, false, false],
            [true, false, true],
        ],
        // UP: (minX,maxY,minZ) (minX,maxY,maxZ) (maxX,maxY,maxZ) (maxX,maxY,minZ)
        FaceDir::Up => [
            [false, true, false],
            [false, true, true],
            [true, true, true],
            [true, true, false],
        ],
        // NORTH: (maxX,maxY,minZ) (maxX,minY,minZ) (minX,minY,minZ) (minX,maxY,minZ)
        FaceDir::North => [
            [true, true, false],
            [true, false, false],
            [false, false, false],
            [false, true, false],
        ],
        // SOUTH: (minX,maxY,maxZ) (minX,minY,maxZ) (maxX,minY,maxZ) (maxX,maxY,maxZ)
        FaceDir::South => [
            [false, true, true],
            [false, false, true],
            [true, false, true],
            [true, true, true],
        ],
        // WEST: (minX,maxY,minZ) (minX,minY,minZ) (minX,minY,maxZ) (minX,maxY,maxZ)
        FaceDir::West => [
            [false, true, false],
            [false, false, false],
            [false, false, true],
            [false, true, true],
        ],
        // EAST: (maxX,maxY,maxZ) (maxX,minY,maxZ) (maxX,minY,minZ) (maxX,maxY,minZ)
        FaceDir::East => [
            [true, true, true],
            [true, false, true],
            [true, false, false],
            [true, true, false],
        ],
    };
    let p = picks[index];
    [
        if p[0] { to[0] } else { from[0] },
        if p[1] { to[1] } else { from[1] },
        if p[2] { to[2] } else { from[2] },
    ]
}

/// `FaceBakery.defaultFaceUV`.
fn default_face_uv(from: [f32; 3], to: [f32; 3], dir: FaceDir) -> [f32; 4] {
    match dir {
        FaceDir::Down => [from[0], 16.0 - to[2], to[0], 16.0 - from[2]],
        FaceDir::Up => [from[0], from[2], to[0], to[2]],
        FaceDir::North => [16.0 - to[0], 16.0 - to[1], 16.0 - from[0], 16.0 - from[1]],
        FaceDir::South => [from[0], 16.0 - to[1], to[0], 16.0 - from[1]],
        FaceDir::West => [from[2], 16.0 - to[1], to[2], 16.0 - from[1]],
        FaceDir::East => [16.0 - to[2], 16.0 - to[1], 16.0 - from[2], 16.0 - from[1]],
    }
}

/// Elemento já resolvido (o `parent` foi fundido e as texturas resolvidas).
#[derive(Debug, Clone)]
struct ResolvedElement {
    from: [f32; 3],
    to: [f32; 3],
    /// Matriz de rotação do elemento já com o `rescale` embutido.
    rotation: Option<(Mat3, [f32; 3])>, // (matriz, origem em unidades de bloco)
    faces: Vec<ResolvedFace>,
}

#[derive(Debug, Clone)]
struct ResolvedFace {
    dir: FaceDir,
    uv: Option<[f32; 4]>,
    tex: String,
    cull: Option<FaceDir>,
    tint: i8,
    /// Quadrante de rotação da UV (`rotation` do JSON: 0/90/180/270).
    uv_rotation: usize,
}

#[derive(Debug, Clone, Default)]
struct ResolvedModel {
    /// Texturas já com o merge de toda a cadeia de `parent` (valores ainda
    /// podem ser referências `#outra` — a resolução final é por face, depois,
    /// quando o mapa já está completo).
    textures: HashMap<String, String>,
    /// Elementos crus (JSON), resolvidos só no fim — antes disso as texturas
    /// do filho ainda não foram mergeadas nas do pai.
    elements: Vec<Value>,
}

/// Resolve um modelo do jar: funde a cadeia de `parent` (o filho sobrescreve
/// `textures` e, se tiver `elements`, substitui os do pai) e resolve os
/// `#variáveis` de textura pro nome de textura final (`oak_planks`).
fn resolve_model(
    archive: &mut zip::ZipArchive<std::fs::File>,
    path: &str,
    cache: &mut HashMap<String, ResolvedModel>,
    stack: &mut HashSet<String>,
) -> Option<ResolvedModel> {
    if let Some(cached) = cache.get(path) {
        return Some(cached.clone());
    }
    if !stack.insert(path.to_string()) {
        return None; // ciclo de parent (não deveria acontecer)
    }

    let json = read_archive_json(archive, &model_entry_name(path))?;
    let mut model = ResolvedModel::default();
    if let Some(parent) = json.get("parent").and_then(|v| v.as_str()) {
        let parent_path = normalize_model_path(parent);
        if let Some(parent_model) = resolve_model(archive, &parent_path, cache, stack) {
            model = parent_model;
        }
    }

    if let Some(textures) = json.get("textures").and_then(|v| v.as_object()) {
        for (key, value) in textures {
            if let Some(value) = value.as_str() {
                model.textures.insert(key.clone(), value.to_string());
            }
        }
    }

    if let Some(elements) = json.get("elements").and_then(|v| v.as_array()) {
        model.elements = elements.clone();
    }

    stack.remove(path);
    cache.insert(path.to_string(), model.clone());
    Some(model)
}

fn resolve_element(element: &Value, textures: &HashMap<String, String>) -> Option<ResolvedElement> {
    let from = json_vec3(element.get("from")?)?;
    let to = json_vec3(element.get("to")?)?;

    let rotation = element.get("rotation").and_then(|r| {
        let origin = json_vec3(r.get("origin")?)?;
        let origin = [origin[0] / 16.0, origin[1] / 16.0, origin[2] / 16.0];
        let transform = if let (Some(axis), Some(angle)) = (
            r.get("axis").and_then(|v| v.as_str()),
            r.get("angle").and_then(|v| v.as_f64()),
        ) {
            let axis = match axis {
                "x" => [1.0, 0.0, 0.0],
                "y" => [0.0, 1.0, 0.0],
                "z" => [0.0, 0.0, 1.0],
                _ => return None,
            };
            rot_axis(axis, angle as f32)
        } else {
            // Forma alternativa `{x}`, `{y}`, `{z}` (Euler ZYX, como o joml).
            let x = r.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let y = r.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let z = r.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            mat_mul(&rot_z(z), &mat_mul(&rot_y(y), &rot_x(x)))
        };
        let transform = if r.get("rescale").and_then(|v| v.as_bool()).unwrap_or(false)
            && !is_identity(&transform)
        {
            // `CuboidRotation.computeRescale`: cada eixo é escalado por
            // 1/max(|componentes| do eixo local rotacionado).
            let mut scale = [1.0f32; 3];
            for (i, unit) in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
                .into_iter()
                .enumerate()
            {
                let rotated = mat_mul_vec(&transform, unit);
                let max = rotated[0]
                    .abs()
                    .max(rotated[1].abs())
                    .max(rotated[2].abs())
                    .max(1e-6);
                scale[i] = 1.0 / max;
            }
            let scale_matrix = [
                [scale[0], 0.0, 0.0],
                [0.0, scale[1], 0.0],
                [0.0, 0.0, scale[2]],
            ];
            mat_mul(&transform, &scale_matrix)
        } else {
            transform
        };
        Some((transform, origin))
    });

    let mut faces = Vec::new();
    if let Some(face_map) = element.get("faces").and_then(|v| v.as_object()) {
        for (name, face) in face_map {
            let Some(dir) = FaceDir::from_name(name) else {
                continue;
            };
            let uv = face.get("uv").and_then(json_vec4);
            let tex_ref = face.get("texture").and_then(|v| v.as_str()).unwrap_or("");
            let tex = resolve_texture(tex_ref, textures);
            let cull = face
                .get("cullface")
                .and_then(|v| v.as_str())
                .and_then(FaceDir::from_name);
            let tint = face.get("tintindex").and_then(|v| v.as_i64()).unwrap_or(-1) as i8;
            let uv_rotation = face.get("rotation").and_then(|v| v.as_i64()).unwrap_or(0);
            let uv_rotation = ((uv_rotation % 360 + 360) % 360 / 90) as usize;
            faces.push(ResolvedFace {
                dir,
                uv,
                tex,
                cull,
                tint,
                uv_rotation,
            });
        }
    }

    Some(ResolvedElement {
        from,
        to,
        rotation,
        faces,
    })
}

fn resolve_texture(value: &str, textures: &HashMap<String, String>) -> String {
    // Um `seen` por chamada: a MESMA variável pode ser usada por várias faces
    // do mesmo elemento (bedrock do bug: `seen` compartilhado fazia a segunda
    // face desistir e devolver `#bottom` literal).
    let mut seen = HashSet::new();
    let mut current = value.to_string();
    loop {
        let Some(reference) = current.strip_prefix('#') else {
            break;
        };
        if !seen.insert(reference.to_string()) {
            break; // ciclo (ex: `particle: "#particle"`)
        }
        match textures.get(reference) {
            Some(next) => current = next.clone(),
            None => return crate::texture_atlas::WHITE_TILE_NAME.to_string(),
        }
    }
    texture_stem(&current)
}

/// `minecraft:block/oak_planks` (ou `block/oak_planks`) → `oak_planks`.
fn texture_stem(value: &str) -> String {
    let path = value.rsplit(':').next().unwrap_or(value);
    let path = path.strip_prefix("block/").unwrap_or(path);
    path.to_string()
}

fn normalize_model_path(value: &str) -> String {
    let path = value.rsplit(':').next().unwrap_or(value);
    path.strip_prefix("models/").unwrap_or(path).to_string()
}

fn model_entry_name(path: &str) -> String {
    format!("assets/minecraft/models/{path}.json")
}

fn json_vec3(value: &Value) -> Option<[f32; 3]> {
    let array = value.as_array()?;
    if array.len() != 3 {
        return None;
    }
    Some([
        array[0].as_f64()? as f32,
        array[1].as_f64()? as f32,
        array[2].as_f64()? as f32,
    ])
}

fn json_vec4(value: &Value) -> Option<[f32; 4]> {
    let array = value.as_array()?;
    if array.len() != 4 {
        return None;
    }
    Some([
        array[0].as_f64()? as f32,
        array[1].as_f64()? as f32,
        array[2].as_f64()? as f32,
        array[3].as_f64()? as f32,
    ])
}

fn read_archive_json(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Value> {
    let mut entry = archive.by_name(name).ok()?;
    let mut raw = String::new();
    entry.read_to_string(&mut raw).ok()?;
    serde_json::from_str(&raw).ok()
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

/// Um bloco é "cubo cheio" quando todos os elementos são a caixa 0..16 inteira
/// sem rotação própria — aí o caminho antigo (cubo texturizado por face) já
/// desenha certo e não precisamos mandar geometria nenhuma.
fn is_plain_cube(elements: &[ResolvedElement]) -> bool {
    !elements.is_empty()
        && elements.iter().all(|e| {
            e.rotation.is_none()
                && e.from == [0.0, 0.0, 0.0]
                && e.to == [16.0, 16.0, 16.0]
        })
}

fn quantize(v: f32) -> f32 {
    (v * 16.0).round() / 16.0
}

struct VariantRef {
    model: String,
    x: i32,
    y: i32,
    z: i32,
    uvlock: bool,
    /// Condições (OR) — vazio = sempre.
    when: Vec<String>,
}

/// Assa a geometria de uma variante; `None` = pular (cubo cheio ou modelo
/// irresolvível).
fn bake_variant(
    archive: &mut zip::ZipArchive<std::fs::File>,
    model_cache: &mut HashMap<String, ResolvedModel>,
    reference: &VariantRef,
) -> Option<Vec<Quad>> {
    let mut stack = HashSet::new();
    let model = resolve_model(archive, &reference.model, model_cache, &mut stack)?;
    // Elementos resolvidos só agora, com o mapa de texturas já completo
    // (filho sobrescrevendo pai) — ver `ResolvedModel`.
    let elements: Vec<ResolvedElement> = model
        .elements
        .iter()
        .filter_map(|element| resolve_element(element, &model.textures))
        .collect();
    if elements.is_empty() {
        return None;
    }

    let variant = variant_matrix(reference.x, reference.y, reference.z);
    if is_plain_cube(&elements) && is_identity(&variant) {
        return None; // caminho do cubo cobre
    }

    let center = [0.5, 0.5, 0.5];
    let mut quads = Vec::new();
    for element in &elements {
        for face in &element.faces {
            let rect = face
                .uv
                .unwrap_or_else(|| default_face_uv(element.from, element.to, face.dir));

            // 1) posições/UVs na ordem do FaceInfo, com rotação de elemento e
            //    de variante já aplicadas.
            let mut positions = [[0.0f32; 3]; 4];
            let mut uvs = [[0.0f32; 2]; 4];
            for i in 0..4 {
                let mut p = face_info_vertex(face.dir, i, element.from, element.to);
                p = [p[0] / 16.0, p[1] / 16.0, p[2] / 16.0];
                if let Some((matrix, origin)) = &element.rotation {
                    p = rotate_about(p, *origin, matrix);
                }
                p = rotate_about(p, center, &variant);
                positions[i] = p;

                let uv_index = (i + face.uv_rotation) % 4;
                let u = if uv_index == 0 || uv_index == 1 {
                    rect[0]
                } else {
                    rect[2]
                };
                let v = if uv_index == 0 || uv_index == 3 {
                    rect[1]
                } else {
                    rect[3]
                };
                uvs[i] = [u, v];
            }

            // 2) `uvlock`: a UV é transformada no espaço centrado da face,
            //    como no `bakeVertex`.
            if reference.uvlock && !is_identity(&variant) {
                let transform = invert(&face_transformation(&variant, face.dir));
                for uv in &mut uvs {
                    let centered = [uv[0] / 16.0 - 0.5, uv[1] / 16.0 - 0.5, 0.0];
                    let moved = mat_mul_vec(&transform, centered);
                    uv[0] = (moved[0] + 0.5) * 16.0;
                    uv[1] = (moved[1] + 0.5) * 16.0;
                }
            }

            // 3) reordena pro `FACES` do viewer e confere o winding (uma
            //    rotação de variante pode inverter o sentido do quad).
            let shift = corner_shift(face.dir);
            let mut p = [0.0f32; 12];
            let mut uv = [0.0f32; 8];
            for j in 0..4 {
                let i = (j + shift) % 4;
                p[j * 3] = quantize(positions[i][0] * 16.0);
                p[j * 3 + 1] = quantize(positions[i][1] * 16.0);
                p[j * 3 + 2] = quantize(positions[i][2] * 16.0);
                uv[j * 2] = (uvs[i][0] * 1000.0).round() / 1000.0;
                uv[j * 2 + 1] = (uvs[i][1] * 1000.0).round() / 1000.0;
            }

            let expected = {
                let mut n = face.dir.normal();
                if let Some((matrix, _)) = &element.rotation {
                    n = mat_mul_vec(matrix, n);
                }
                mat_mul_vec(&variant, n)
            };
            let a = [p[0], p[1], p[2]];
            let b = [p[3], p[4], p[5]];
            let c = [p[6], p[7], p[8]];
            let order_normal = cross(
                [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
                [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
            );
            if dot(order_normal, expected) < 0.0 {
                let reversed_p: Vec<f32> = [3usize, 2, 1, 0]
                    .iter()
                    .flat_map(|&j| [p[j * 3], p[j * 3 + 1], p[j * 3 + 2]])
                    .collect();
                let reversed_uv: Vec<f32> = [3usize, 2, 1, 0]
                    .iter()
                    .flat_map(|&j| [uv[j * 2], uv[j * 2 + 1]])
                    .collect();
                p.copy_from_slice(&reversed_p);
                uv.copy_from_slice(&reversed_uv);
            }

            let cull = face
                .cull
                .map(|_| approx_nearest(expected).frontend_index());

            quads.push(Quad {
                p: p.to_vec(),
                uv: uv.to_vec(),
                tex: face.tex.clone(),
                cull,
                tint: face.tint,
            });
        }
    }

    (!quads.is_empty()).then_some(quads)
}

/// Lê uma variante de `variants`/`multipart` (`apply` pode ser um objeto ou
/// uma lista deles).
fn variant_refs(value: &Value, when: Vec<String>) -> Vec<VariantRef> {
    let entries: Vec<&Value> = match value {
        Value::Array(array) => array.iter().collect(),
        other => vec![other],
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let model = entry
                .get("model")
                .and_then(|v| v.as_str())
                .map(normalize_model_path)?;
            Some(VariantRef {
                model,
                x: entry.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                y: entry.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                z: entry.get("z").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                uvlock: entry
                    .get("uvlock")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                when: when.clone(),
            })
        })
        .collect()
}

/// Converte um `when` (objeto `{k: v}`, string, ou `{"OR": [...]}` /
/// `{"AND": [...]}` aninhado) numa lista de condições (OR) de strings AND.
fn parse_when(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => {
            if let Some(terms) = map.get("OR").and_then(|v| v.as_array()) {
                return terms.iter().flat_map(parse_when).collect();
            }
            if let Some(terms) = map.get("AND").and_then(|v| v.as_array()) {
                // AND de condições distintas: cada uma vira uma condição; o
                // frontend trata a lista como OR, então mantemos o AND como
                // uma condição só (união dos testes).
                let parts: Vec<String> = terms
                    .iter()
                    .flat_map(parse_when)
                    .filter(|s| !s.is_empty())
                    .collect();
                return vec![parts.join(",")];
            }
            let condition: Vec<String> = map
                .iter()
                .filter_map(|(key, value)| {
                    let value = value.as_str()?;
                    Some(format!("{key}={value}"))
                })
                .collect();
            vec![condition.join(",")]
        }
        _ => Vec::new(),
    }
}

/// Assa um bloco (variants ou multipart) e devolve a definição pronta.
fn bake_block(
    archive: &mut zip::ZipArchive<std::fs::File>,
    block: &str,
    json: &Value,
    model_cache: &mut HashMap<String, ResolvedModel>,
    geometries: &mut Vec<Vec<Quad>>,
) -> Option<BlockModelDef> {
    let mut parts = Vec::new();
    let mut geo_index: HashMap<String, usize> = HashMap::new();

    let mut push_ref = |reference: VariantRef,
                        parts: &mut Vec<ModelPart>,
                        geo_index: &mut HashMap<String, usize>,
                        geometries: &mut Vec<Vec<Quad>>| {
        let key = format!(
            "{}|{}|{}|{}|{}",
            reference.model, reference.x, reference.y, reference.z, reference.uvlock
        );
        let geo = match geo_index.get(&key) {
            Some(index) => Some(*index),
            None => bake_variant(archive, model_cache, &reference).map(|quads| {
                let index = geometries.len();
                geometries.push(quads);
                geo_index.insert(key, index);
                index
            }),
        };
        if let Some(geo) = geo {
            parts.push(ModelPart {
                when: reference.when,
                geo,
            });
        }
    };

    let multipart = json.get("multipart").is_some();
    if let Some(variants) = json.get("variants").and_then(|v| v.as_object()) {
        for (key, value) in variants {
            let when = if key.is_empty() {
                Vec::new()
            } else {
                vec![key.clone()]
            };
            for reference in variant_refs(value, when) {
                push_ref(reference, &mut parts, &mut geo_index, geometries);
            }
        }
    }
    if let Some(list) = json.get("multipart").and_then(|v| v.as_array()) {
        for entry in list {
            let when = entry.get("when").map(parse_when).unwrap_or_default();
            if let Some(apply) = entry.get("apply") {
                for reference in variant_refs(apply, when.clone()) {
                    push_ref(reference, &mut parts, &mut geo_index, geometries);
                }
            }
        }
    }

    if parts.is_empty() {
        return None;
    }
    let _ = block;
    Some(BlockModelDef { multipart, parts })
}

/// Gera (ou reaproveita do cache) o payload binário dos modelos de bloco pra
/// versão pedida. Cache em disco guarda o **payload já codificado** (o JSON
/// intermediário tem ~11 MB; o payload fica bem menor).
pub fn build_or_load_payload(mc_version: &str) -> Result<Vec<u8>, String> {
    let cache_path = cache_dir().join(format!("models_v{MODELS_CACHE_VERSION}_{mc_version}.bin"));
    if cache_path.is_file() {
        return std::fs::read(&cache_path).map_err(|e| e.to_string());
    }

    let jar_path = find_local_client_jar(mc_version).ok_or_else(|| {
        format!(
            "Client jar do Minecraft {mc_version} não encontrado em \
             ~/.minecraft/versions/{mc_version}/{mc_version}.jar — instale essa \
             versão pelo launcher oficial primeiro."
        )
    })?;

    let models = build_models(&jar_path)?;
    let payload = encode_payload(&models);
    std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;
    std::fs::write(&cache_path, &payload).map_err(|e| e.to_string())?;
    Ok(payload)
}

/// Assa todos os blocos do jar.
pub fn build_models(jar_path: &Path) -> Result<BlockModels, String> {
    let file = std::fs::File::open(jar_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let blockstate_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            name.starts_with("assets/minecraft/blockstates/")
                .then_some(name)
        })
        .collect();

    let mut models = BlockModels::default();
    let mut model_cache: HashMap<String, ResolvedModel> = HashMap::new();

    for entry_name in blockstate_names {
        let block = entry_name
            .trim_start_matches("assets/minecraft/blockstates/")
            .trim_end_matches(".json")
            .to_string();
        let Some(json) = read_archive_json(&mut archive, &entry_name) else {
            continue;
        };
        if let Some(def) = bake_block(
            &mut archive,
            &block,
            &json,
            &mut model_cache,
            &mut models.geometries,
        ) {
            models.blocks.insert(block, def);
        }
    }

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Integração real contra o jar instalado nesta máquina — pula sozinho
    /// (não falha) se não existir.
    #[test]
    fn bakes_models_from_local_jar_if_present() {
        let Some(jar) = find_local_client_jar("26.3") else {
            eprintln!("skip: sem client jar local pra testar contra");
            return;
        };
        let models = build_models(&jar).expect("modelos deveriam assar");

        // Tocha em pé: cubo pequeno 2×10×2 (6 faces), uma delas com cull.
        let torch = models.blocks.get("torch").expect("tocha deveria ter modelo");
        assert!(!torch.multipart);
        let geo = &models.geometries[torch.parts[0].geo];
        assert_eq!(geo.len(), 6, "tocha deveria ter 6 faces");
        let ys: Vec<f32> = geo.iter().flat_map(|q| q.p.iter().skip(1).step_by(3).copied()).collect();
        assert!(ys.iter().cloned().fold(f32::MIN, f32::max) <= 10.0, "tocha não pode ter 16 de altura");

        // Cogumelo: modelo `cross` (duas placas cruzadas = 4 faces, pois cada
        // placa tem frente e verso).
        let mushroom = models
            .blocks
            .get("red_mushroom")
            .expect("cogumelo deveria ter modelo");
        let geo = &models.geometries[mushroom.parts[0].geo];
        assert_eq!(geo.len(), 4, "cogumelo deveria ser um cross (4 faces)");

        // Vitória-régia: uma placa horizontal = 2 faces.
        let lily = models.blocks.get("lily_pad").expect("vitória-régia");
        let geo = &models.geometries[lily.parts[0].geo];
        assert_eq!(geo.len(), 2, "vitória-régia deveria ter 2 faces");

        // Escada: várias variantes (rotações), geometria não-cúbica.
        let stairs = models.blocks.get("oak_stairs").expect("escada");
        assert!(stairs.parts.len() > 4, "escada deveria ter várias variantes");

        eprintln!(
            "modelos: {} blocos, {} geometrias, {} quads",
            models.blocks.len(),
            models.geometries.len(),
            models.quad_count()
        );
        let payload = encode_payload(&models);
        eprintln!(
            "payload binário: {:.2} MB",
            payload.len() as f64 / 1_048_576.0
        );
        assert_eq!(payload[0], MODELS_PAYLOAD_VERSION);
        // Cabeçalho: versão + tabelas + nº de geometrias.
        assert!(payload.len() > 1000, "payload vazio demais");

        // Deixa o payload em `.cache/` (gitignored) pra ferramentas de
        // inspeção visual durante o desenvolvimento — não é usado em runtime.
        let _ = std::fs::create_dir_all(cache_dir());
        let _ = std::fs::write(cache_dir().join("models_preview_payload.bin"), &payload);
    }
}
