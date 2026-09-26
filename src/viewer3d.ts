import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MinecraftPlayerModel, type PlayerSkinInput } from "./player_model";

/**
 * Renderer 3D real do viewer — ver `docs/SPEC.md`, "Visualização 3D própria".
 * O spec descreve isso como wgpu nativo do lado Rust; aqui é WebGL (Three.js)
 * dentro do mesmo webview do app, por decisão explícita do usuário: entrega
 * o mesmo resultado (cena 3D, câmera orbitável, geometria real) sem a
 * complexidade de embutir uma superfície wgpu numa janela separada
 * sincronizada com o Tauri, que eu não teria como validar visualmente.
 *
 * O jogador é um modelo de verdade do Minecraft (`player_model.ts`), com a
 * skin real do jogador mandada pelo addon — não um marcador genérico. Ver
 * `docs/CHANGELOG.md`, "Renderizador do jogador".
 *
 * Escopo honesto: o addon manda o chunk inteiro em voxels (paleta + índices
 * 16×16×16, ver `world_cache.rs`), então cada bloco vira só as faces expostas
 * (face culling de verdade, inclusive entre chunks vizinhos já carregados) —
 * não o pipeline completo de blockstate→model→face (`docs/SPEC.md`, "Blocos
 * 3D"): blocos não-cúbicos (escada, cerca, tocha...) ainda aparecem como
 * cubo cheio, e propriedades de blockstate além do nível de fluido não
 * trafegam.
 *
 * Água e lava são tratadas à parte, como no jogo: a superfície fica na altura
 * do nível (`(8 − nível) / 9`, fonte/caindo = 8/9), faces entre o mesmo
 * fluido somem (nada de grade de cubos d'água), o fluido é translúcido e a
 * textura animada (`water_still`/`water_flow`, frames extraídos do jar em
 * `texture_atlas.rs`) gira conforme o sentido da correnteza calculado dos
 * vizinhos.
 */

const BLOCK_TEXTURE_PX = 16; // resolução dos tiles do atlas (frames 32×32 são reduzidos lá)
// Céu e ciclo de dia/noite: o addon manda a hora real do mundo 1x/s
// (`world_time`, ticks 0..23999 — 0 = nascer do sol, 6000 = meio-dia, 12000 =
// pôr do sol, 18000 = meia-noite), o viewer interpola a 20 ticks/s (como o
// jogo) e move sol, lua, luz ambiente e o gradiente do céu. Sem hora
// conhecida (jogo fechado, app recém-aberto), fica no meio-dia fixo — não
// inventa um ciclo. O horizonte é também a cor do fog e do canvas: é nele que
// o terreno distante se dissolve.
const SKY_DAY = { zenith: 0x2f6ba8, mid: 0x6f9cc9, horizon: 0xc2d6e8 };
const SKY_NIGHT = { zenith: 0x050a18, mid: 0x0a1226, horizon: 0x141d30 };
/** Tom quente do horizonte no nascer/pôr do sol (pico quando o sol cruza o
 * horizonte) — é o laranja que o céu do jogo ganha nesses momentos. */
const SKY_TWILIGHT = 0xe8955a;
/** Paletas de luz do ciclo: `LOW` = sol rasante, `HIGH` = meio-dia. */
const SUN_COLOR_LOW = 0xff9e63;
const SUN_COLOR_HIGH = 0xfff4e0;
const MOON_COLOR = 0x9db4e8;
const AMBIENT_DAY = 0.55; // era a luz fixa antiga
const AMBIENT_NIGHT = 0.13;
const MOON_INTENSITY = 0.1;
// 1 dia do jogo = 24000 ticks = 20 min reais; a hora local anda 20 ticks por
// segundo entre as mensagens do addon.
const TICKS_PER_SECOND = 20;
const TICKS_PER_DAY = 24000;
const DEFAULT_DAY_TIME = 6000; // meio-dia fixo quando não há hora real
/** Céu/fog não precisam ser recoloridos a cada frame — o ciclo é lento. */
const SKY_REPAINT_MS = 500;
const SUN_DISTANCE = 300;
/** Raio do domo de céu: dentro do `far` da câmera (5000) e maior que o
 * `maxDistance` do OrbitControls (2000), pra nunca cortar terreno. */
const SKY_RADIUS = 3000;

// Nuvens vanilla — porte do `CloudRenderer` do client: o padrão vem de
// `textures/environment/clouds.png` (256×256 texels = uma célula por texel,
// corte em alpha < 10), cada célula é uma caixa de 12×12×4 blocos com topo em
// 192.33 (altura padrão do overworld), cor branca com alpha 0.8, sombreamento
// por face e deriva de 0.6 bloco/s no X (+3.96 fixo no Z, como no jogo); o
// padrão se repete a cada 3072 blocos. A cor acompanha o ciclo dia/noite
// (`daylightFactor`); a altura ainda é sempre a do overworld, porque o addon
// não manda a dimensão (ver "Known gaps").
const CLOUD_CELL_SIZE = 12;
const CLOUD_THICKNESS = 4;
const CLOUD_HEIGHT = 192.33;
const CLOUD_ALPHA = 0.8;
const CLOUD_ALPHA_CUTOFF = 10;
const CLOUD_DRIFT_PER_SECOND = 0.6;
const CLOUD_Z_OFFSET = 3.96;
const CLOUD_TEXTURE_PX = 256;
const CLOUD_SHADE_TOP = 1;
const CLOUD_SHADE_BOTTOM = 0.7;
const CLOUD_SHADE_NORTH_SOUTH = 0.8;
const CLOUD_SHADE_EAST_WEST = 0.9;
/** Período do padrão de nuvens em blocos (256 células × 12 blocos). */
const CLOUD_PERIOD_BLOCKS = CLOUD_CELL_SIZE * CLOUD_TEXTURE_PX;
// Multiplicador noturno do jogo (`Timelines.NIGHT_CLOUD_COLOR_MULTIPLIER`):
// as nuvens escurecem pra um azul quase preto quando não há sol.
const CLOUD_NIGHT_COLOR = new THREE.Color(0.1, 0.1, 0.15);
const CLOUD_DAY_COLOR = new THREE.Color(0xffffff);

// Cores pré-alocadas do ciclo: `updateDayNight` roda por frame e não pode
// alocar `THREE.Color` a cada chamada.
const SKY_DAY_ZENITH = new THREE.Color(SKY_DAY.zenith);
const SKY_DAY_MID = new THREE.Color(SKY_DAY.mid);
const SKY_DAY_HORIZON = new THREE.Color(SKY_DAY.horizon);
const SKY_NIGHT_ZENITH = new THREE.Color(SKY_NIGHT.zenith);
const SKY_NIGHT_MID = new THREE.Color(SKY_NIGHT.mid);
const SKY_NIGHT_HORIZON = new THREE.Color(SKY_NIGHT.horizon);
const SKY_TWILIGHT_COLOR = new THREE.Color(SKY_TWILIGHT);
const SUN_COLOR_LOW_C = new THREE.Color(SUN_COLOR_LOW);
const SUN_COLOR_HIGH_C = new THREE.Color(SUN_COLOR_HIGH);
const AMBIENT_DAY_COLOR = new THREE.Color(0xffffff);
const AMBIENT_NIGHT_COLOR = new THREE.Color(MOON_COLOR);

/** Interpolação suave (Hermite) entre dois limiares — usada pra transformar
 * a elevação do sol num fator de luz do dia contínuo. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
const COLOR_TEAL = 0x5eead4; // token `--teal` do SPEC ("estado atual/progresso")
// token `--amber` do SPEC ("ação planejada"): camada de edição do editor e
// alvo clicado da fila.
const COLOR_AMBER = 0xf2b155;
const MAX_EDIT_VOLUME = 50_000; // teto de blocos por operação de região (um clique só)

// Clique vs. arrastar: o botão esquerdo orbita (OrbitControls) e também edita
// (editor) ou escolhe o alvo da fila — só conta como clique se o ponteiro quase
// não andou (um clique lento, mas parado, continua valendo).
const CLICK_MAX_MOVE_PX = 6;
const CLICK_MAX_MS = 800;

// Movimento por teclado ("voo" pela cena): o OrbitControls sozinho só responde
// ao mouse, então qualquer deslocamento exigia arrastar/orbitar — e o alvo da
// órbita fica preso a um ponto, sem como atravessar o terreno. Ver
// docs/CHANGELOG.md, "Movimentação da câmera do viewer 3D".
const MOVE_BASE_SPEED = 24; // blocos/s na distância de referência
const MOVE_REF_DISTANCE = 40; // distância câmera→alvo em que a velocidade base vale
const MOVE_MAX_SPEED = 500; // teto: 20× a base, senão num zoom afastado o voo vira um piscar
const MOVE_TURBO = 4; // multiplicador do Shift
const MOVE_PRECISE = 0.25; // multiplicador do Alt
const MOVE_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "KeyQ",
  "KeyE",
  "Space",
]);

// Fog: os valores-base são os do enquadramento inicial. Eles passam a
// acompanhar a distância câmera→alvo (ver `updateFog`) porque com o zoom
// livre um `far` fixo de 260 engolia o mundo inteiro no fundo assim que o
// usuário se afastava.
const FOG_NEAR_BASE = 60;
const FOG_FAR_BASE = 260;
/** Início do fog como fração do fim — a aba Config expõe só a distância do
 * horizonte (`fog_far`), e o início acompanha nessa proporção. */
const FOG_NEAR_RATIO = FOG_NEAR_BASE / FOG_FAR_BASE;

// Perseguição do jogador: a pose real chega 4x/s (ver `addon_socket.rs`), e
// estes valores são o que evita o modelo "piscar" de posição em posição — o
// alvo é interpolado a cada frame (constante de tempo ~83ms com 12), e um
// salto grande (reconexão, `/tp`) encaixa direto em vez de deslizar pelo mapa.
// O addon manda `bot_pose` a cada 250 ms (mesma cadência do `POSE_INTERVAL_MS`
// no `main.ts`); o follow do boneco cobre a distância da pose no intervalo real
// entre elas, em velocidade constante — chegando exato no alvo, sem a
// aproximação exponencial que nunca fechava a conta e deixava o boneco
// deslizando depois que o bot parava. O teto evita que um ajuste grande (mas
// abaixo do teleporte) vire um borrão.
const BOT_FOLLOW_INTERVAL_FALLBACK = 0.25; // s — primeira pose, sem histórico
const BOT_FOLLOW_MAX_SPEED = 40; // blocos/s
const BOT_TELEPORT_DISTANCE = 8; // blocos
const BOT_CAMERA_HEIGHT = 1; // altura do alvo da órbita (peito do jogador)
const PLAYER_HEAD_HEIGHT = 2.25; // rótulo de coordenadas acima da cabeça

// Marcadores de mob (`nearby_mobs`): a posição chega 4x/s e é interpolada a
// cada frame, como a pose do bot — sem isso os rótulos piscariam de posição
// em posição. Um salto grande é teleporte (enderman) ou id reciclado: encaixa
// direto em vez de deslizar pelo mapa.
const MOB_FOLLOW_RATE = 10; // 1/s
const MOB_TELEPORT_DISTANCE = 16; // blocos
const MOB_LABEL_GAP = 0.4; // acima da hitbox do mob (que já tem altura própria)

// Cores reais de bioma chegam no payload v3, por coluna (`ChunkTints`): grama,
// folhagem e água com a mesma cor que o `BiomeColors` do jogo resolve pra
// renderização (colormap + modificador de bioma já aplicados). Os valores
// abaixo são só o fallback de payload antigo/sem tint — um tom temperado
// médio, nunca a cor de um bioma específico. Ver docs/SPEC.md "Blocos 3D".
const GRASS_TINT = 0x79c05a;
const FOLIAGE_TINT = 0x59ae30;
const WATER_TINT = 0x3f76e4;

/** Blocos cuja cor o jogo resolve pelo `BlockColors` (26.3): `grass` e
 * `foliage` vêm do tint de bioma da coluna; sem tint no payload, caem no
 * fallback acima. Espécies cuja textura já vem colorida no arquivo (cerejeira,
 * azaleia, carvalho-pálido) ficam de fora de propósito — tint nelas só
 * escureceria uma cor que já está certa. O topo do `grass_block` é tingido; o
 * lado leva tint só na camada de overlay (ver `GRASS_SIDE_OVERLAY`). */
const BLOCK_TINT_KIND: Record<string, "grass" | "foliage"> = {
  grass_block: "grass",
  lily_pad: "grass", // o jogo usa a cor de grama no lírio
  sugar_cane: "grass",
  oak_leaves: "foliage",
  jungle_leaves: "foliage",
  acacia_leaves: "foliage",
  dark_oak_leaves: "foliage",
  mangrove_leaves: "foliage",
  vine: "foliage",
};

/** Cores fixas do jogo pra blocos que não dependem de bioma — mesmos valores
 * de `BlockColors.createDefault()` no 26.3 (em `0xRRGGBB`). */
const BLOCK_TINTS: Record<string, number> = {
  spruce_leaves: 0x619961,
  birch_leaves: 0x80a755,
};

/** Segunda camada do lado do `grass_block` no modelo vanilla: a base
 * (`grass_block_side`) é terra com uma franja clara, e por cima vem
 * `grass_block_side_overlay` — cinza no arquivo, tingida com a cor de grama do
 * bioma. Sem ela os lados da grama não acompanhavam o bioma (só o topo). O
 * jogo desenha as duas coincidentes; aqui a de cima sai um fio ao longo da
 * normal pra não brigar no z-buffer. */
const GRASS_SIDE_OVERLAY = "grass_block_side_overlay";
const GRASS_SIDE_OVERLAY_OFFSET = 0.002;

/** Blocos cujo nome não bate com o nome da textura no jar: água/lava/fogo
 * são animados (`water_still`, `fire_0`) e o atlas guarda todos os frames,
 * com o nome puro apontando pro frame 0 — ver `texture_atlas.rs`. */
const TEXTURE_ALIASES: Record<string, string> = {
  water: "water_still",
  lava: "lava_still",
  fire: "fire_0",
  soul_fire: "soul_fire_0",
};

/** Face do cubo pra resolução de textura — os 4 lados compartilham uma só,
 * como no modelo do jogo (topo e fundo têm texturas próprias quando existem). */
type BlockFace = "top" | "side" | "bottom";

/** Blocos cujo modelo vanilla usa `dirt` embaixo — sem isso o fundo cairia no
 * fallback cinza, porque não existe textura base "grass_block"/"mycelium"/
 * "podzol" (só as variantes `_top`/`_side`). */
const BOTTOM_TEX_OVERRIDE: Record<string, string> = {
  grass_block: "dirt",
  mycelium: "dirt",
  podzol: "dirt",
};

/** Nome do tile branco sintético que o `texture_atlas.rs` adiciona pro
 * fallback tingível — bloco sem textura resolvida usa ele + cor sólida por
 * vértice, em vez de aparecer com a textura de outro bloco (ex: `dirt`). */
const WHITE_TILE = "__white";

/** Cor de bloco sem textura/atlas — cinza neutro, nunca a textura de outro. */
const COLOR_UNKNOWN_BLOCK = 0x3a3f47;

/** UV usada no modo degradado (sem atlas nenhum): a geometria é montada sem
 * `map`, então o valor não importa — só precisa existir. */
const NO_ATLAS_RECT: UvRect = { u0: 0, v0: 0, u1: 1, v1: 1 };

// Versão/flags do payload binário de `chunk_voxels` — espelham `world_cache.rs`.
// v4 = seções (paleta + índices + luz) + tints de bioma por coluna; v3 (sem
// luz) e v2 (sem nada disso) ainda são aceitos na leitura pros `world.cache`
// gravados antes, caindo no dia cheio e nos tints fixos.
const VOXEL_FORMAT_VERSION = 4;
const VOXEL_FORMAT_VERSION_TINTS = 3;
const VOXEL_FORMAT_VERSION_LEGACY = 2;
const VOXEL_FLAG_RENDER = 1;
const VOXEL_FLAG_OCCLUDES = 2;
const VOXEL_FLAG_FLUID = 4;

/** Luz: cada byte do payload carrega dois níveis 0–15 — nibble baixo = luz de
 * bloco (tocha, lava, glowstone...), nibble alto = luz de céu, já propagados
 * pelo motor de luz do próprio jogo (`LightLayer.BLOCK`/`SKY`). O viewer
 * reamostra por canto de face (smooth lighting, como o jogo) e assa o
 * resultado na cor do vértice — o terreno usa material sem luz dinâmica. */
/** Fator do céu usado ao assar a luz do terreno: o material do terreno não
 * tem luz dinâmica, então a luz de céu é multiplicada na hora da malha. Ele
 * acompanha o ciclo dia/noite (`updateDayNight`) — de noite só tocha/lava
 * seguem iluminando; o piso é o "luar" do jogo. */
const SKY_LIGHT_NIGHT_FLOOR = 0.12;

/** Curva de brilho do jogo (`LightTexture`): nível 15 = 1.0, queda suave
 * até 0 (caverna sem tocha fica escura). */
function lightCurve(level: number): number {
  const f = level / 15;
  return f / (4 - 3 * f);
}

/** Shading por direção da face, como no jogo: topo 1.0, norte/sul 0.8,
 * leste/oeste 0.6, fundo 0.5. */
function faceShade(face: FaceDef): number {
  if (face.dir[1] > 0) return 1;
  if (face.dir[1] < 0) return 0.5;
  return face.dir[2] !== 0 ? 0.8 : 0.6;
}


/** Duração de cada frame das texturas animadas de fluido, em ms. O jogo lê
 * isso do `.mcmeta` de cada textura; aqui é fixo (aproximação honesta, ver
 * "Known gaps" no README). */
const FLUID_FRAME_MS = 120;

/** Quantos chunks o viewer pede por tick de polling (ver `main.ts`). As
 * malhas entram numa fila e são montadas com orçamento por frame
 * (`drainMeshQueue`), então pedir mais não trava o render — só acelera o
 * preenchimento ao redor do bot. */
export const CHUNKS_PER_REFRESH = 16;

/** Teto de chunks que o backend devolve por consulta (`world_chunks_near`),
 * já ordenados por distância do bot. O viewer filtra os que já tem e pede
 * só o que falta; consultas continuam baratas mesmo com o cache inteiro
 * persistido (que cresce sem limite). */
export const NEARBY_CHUNK_LIMIT = 1024;

/** Orçamento de CPU por frame pra montar malhas de chunk, em ms — padrão do
 * app; a aba Config pode mudar (`applySettings`). Um backfill pode enfileirar
 * centenas de chunks; montar todos de uma vez derruba o fps, então a fila é
 * drenada em pedaços por frame. */
const MESH_BUDGET_MS = 8;

export interface BotPos {
  x: number;
  y: number;
  z: number;
}

/** Pose real do jogador (comando `bot_pose`): posição dos pés + olhar. */
export interface BotPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Categoria do mob, classificada pelo addon a partir do tipo real do jogo —
 *  ver `MobCategory` em `src-tauri/src/mobs.rs`. */
export type MobCategory = "hostile" | "neutral" | "passive" | "other";

/** Um mob vivo ao redor do bot (comando `nearby_mobs`, espelha `NearbyMob` em
 *  `src-tauri/src/mobs.rs`). Posição em blocos (double), `distance` já é a
 *  distância real até o jogador medida pelo addon na varredura. */
export interface NearbyMob {
  id: number;
  kind: string;
  name: string;
  category: MobCategory;
  x: number;
  y: number;
  z: number;
  health: number;
  max_health: number;
  height: number;
  distance: number;
}

export interface ChunkPos {
  x: number;
  z: number;
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface BlockPos {
  x: number;
  y: number;
  z: number;
}

/** Ferramenta ativa do editor de schematic. `null` = viewer puro (clique não
 * edita nada). */
export type EditMode = "select" | "place" | "break";

/** Preferências do viewer vindas da aba Config (comando `settings_get`, ver
 * `src-tauri/src/settings.rs`). O backend já prende os valores na faixa
 * válida — o viewer só aplica o que chegou. */
export interface ViewerSettings {
  /** Distância (blocos) em que o fog fecha o horizonte. */
  fogFar: number;
  /** Orçamento por frame (ms) pra montar malhas de chunk. */
  meshBudgetMs: number;
  /** Teto do device pixel ratio do canvas. */
  maxPixelRatio: number;
  /** Teto de FPS — 0 = sem limite (vsync). */
  fpsCap: number;
}

/** Uma edição da camada de pintura: `block = null` = quebrar (vira ar). O
 * frontend manda isso inteiro em `schematic_apply` e o diff real acontece no
 * Rust (`schematic.rs`) contra o `WorldCache`. */
export interface BlockEdit {
  x: number;
  y: number;
  z: number;
  block: string | null;
}

/** Resultado do picking: bloco atingido + face clicada (normal, pra saber
 * onde um bloco colocado encosta). */
export interface PickedBlock {
  pos: BlockPos;
  normal: readonly [number, number, number];
}

interface PaletteEntry {
  block: string;
  flags: number;
  /** Nível do fluido (blockstate vanilla): 0 = fonte, 1..7 = fluindo,
   * >= 8 = caindo. Fora de fluidos é sempre 0. */
  level: number;
}

interface DecodedSection {
  y: number;
  palette: PaletteEntry[];
  indices: Uint16Array;
  /** 4096 bytes, índice `x + z*16 + y*256`: nibble baixo = luz de bloco,
   * nibble alto = luz de céu (0–15 cada) — ver `world_cache.rs`. */
  light: Uint8Array;
}

/** Tints de bioma por coluna (payload v3): cor `0xRRGGBB` por coluna
 * (`lx + lz*16`, a mesma ordem dos índices das seções), já resolvida pelo
 * addon com o `BiomeColors` do client. `null` = payload v2 ou sem dados — o
 * viewer cai nas cores fixas (`GRASS_TINT` e companhia). */
interface ChunkTints {
  grass: Uint32Array;
  foliage: Uint32Array;
  water: Uint32Array;
}

/** Uma coluna do chunk tem `x + z*16` — os tint maps seguem essa ordem. */
const TINT_COLUMNS = 256;

interface DecodedChunk {
  x: number;
  z: number;
  /** Seção Y (mundo / 16) → seção; ausente = ar. */
  sections: Map<number, DecodedSection>;
  /** Tints de bioma por coluna; `null` = chunk sem essa informação. */
  tints: ChunkTints | null;
  /** Maior seção Y que veio no payload — acima dela o ar é céu cheio (ver
   * `lightAt`). */
  maxSectionY: number;
}

/** Estado de um marcador de mob: o rótulo HTML, o último snapshot recebido e
 *  as posições desenhada (interpolada) e alvo — ver
 *  `setNearbyMobs`/`updateMobs`. */
interface MobMarker {
  el: HTMLDivElement;
  nameEl: HTMLSpanElement;
  metaEl: HTMLSpanElement;
  mob: NearbyMob;
  target: THREE.Vector3;
  position: THREE.Vector3;
}

/** Uma face do cubo, na ordem dos vértices em sentido anti-horário visto de
 * fora (winding do Three.js), com os eixos de textura da face: `uDir` é pra
 * onde o U cresce e `vDir` pra onde o V cresce (textura "desce", v=1 embaixo). */
interface FaceDef {
  kind: BlockFace;
  dir: readonly [number, number, number];
  corners: readonly (readonly [number, number, number])[];
  uv: readonly (readonly [number, number])[];
  uDir: readonly [number, number, number];
  vDir: readonly [number, number, number];
}

const FACES: readonly FaceDef[] = [
  {
    kind: "side",
    dir: [1, 0, 0],
    corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
    uv: [[1, 1], [0, 1], [0, 0], [1, 0]],
    uDir: [0, 0, 1],
    vDir: [0, -1, 0],
  },
  {
    kind: "side",
    dir: [-1, 0, 0],
    corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    uv: [[1, 1], [0, 1], [0, 0], [1, 0]],
    uDir: [0, 0, -1],
    vDir: [0, -1, 0],
  },
  {
    kind: "top",
    dir: [0, 1, 0],
    corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    uv: [[0, 0], [0, 1], [1, 1], [1, 0]],
    uDir: [1, 0, 0],
    vDir: [0, 0, 1],
  },
  {
    kind: "bottom",
    dir: [0, -1, 0],
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    uv: [[0, 0], [1, 0], [1, 1], [0, 1]],
    uDir: [1, 0, 0],
    vDir: [0, 0, 1],
  },
  {
    kind: "side",
    dir: [0, 0, 1],
    corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    uv: [[1, 1], [0, 1], [0, 0], [1, 0]],
    uDir: [-1, 0, 0],
    vDir: [0, -1, 0],
  },
  {
    kind: "side",
    dir: [0, 0, -1],
    corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    uv: [[1, 1], [0, 1], [0, 0], [1, 0]],
    uDir: [1, 0, 0],
    vDir: [0, -1, 0],
  },
];

const HORIZONTAL_NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** UVs de cada face em flat (u0,v0,u1,v1,…) — evita alocar arrays por face
 * no laço de meshing. */
const FACE_UV_FLAT: readonly (readonly number[])[] = FACES.map((face) => face.uv.flat());

/** As 4 rotações de 90° de cada face, pré-computadas: `[faceIndex][rotation]`
 * é o UV flat correspondente, usado pra alinhar a textura do fluido com a
 * correnteza sem fazer `map`/`[u, v]` por face. */
const FLUID_ROTATED_UV: number[][][] = FACE_UV_FLAT.map((flat) => {
  const rotations: number[][] = [flat.slice()];
  for (let r = 1; r < 4; r++) {
    const previous = rotations[r - 1];
    const next: number[] = new Array(8);
    for (let i = 0; i < 4; i++) {
      next[i * 2] = 1 - previous[i * 2 + 1];
      next[i * 2 + 1] = previous[i * 2];
    }
    rotations.push(next);
  }
  return rotations;
});

const AIR: PaletteEntry = { block: "air", flags: 0, level: 0 };
const DOWN = new THREE.Vector3(0, -1, 0);
const ZERO = new THREE.Vector3(0, 0, 0);

/** Altura da superfície do fluido dentro do bloco — a mesma conta do
 * `PaletteEntry::fluid_height` no Rust e do `WaterFluid#getHeight` do jogo. */
function fluidHeight(level: number): number {
  const clamped = Math.min(Math.max(level, 0), 8);
  const surface = clamped === 0 || clamped === 8 ? 8 : 8 - clamped;
  return surface / 9;
}

/** Buffers de um bucket de geometria enquanto o chunk é montado. */
interface MeshBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

/** UVs já no espaço do atlas (flat) + se veio de textura real, cacheados por
 * (bloco, face do cubo) — o laço de meshing roda uma vez por face exposta e
 * refazer string + rect a cada iteração era o grosso do custo num chunk denso.
 * A cor não entra aqui: desde os tints por coluna ela varia dentro do chunk
 * (ver `faceTint`). */
interface FaceRender {
  uv: number[];
  /** Veio de textura real do atlas (`faceRect`) — bloco sem textura sai cinza
   * neutro em vez de fingir que é outro bloco. */
  known: boolean;
}

/** Rect resolvido de uma face + se veio de textura real do atlas (`known`)
 * ou do fallback (tile branco / bloco sem textura) — ver `faceRect`. */
interface ResolvedFace {
  rect: UvRect;
  known: boolean;
}

/** Um decoder UTF-8 só pro módulo — o payload tem uma entrada de paleta por
 * bloco distinto, não faz sentido alocar um `TextDecoder` por entrada. */
const UTF8_DECODER = new TextDecoder();
function byteReader(bytes: Uint8Array) {
  let pos = 0;
  const take = (n: number) => {
    if (pos + n > bytes.length) throw new Error(`payload truncado no byte ${pos}`);
    const slice = bytes.subarray(pos, pos + n);
    pos += n;
    return slice;
  };
  return {
    u8: () => take(1)[0],
    i8: () => (take(1)[0] << 24) >> 24,
    u16: () => {
      const b = take(2);
      return b[0] | (b[1] << 8);
    },
    utf8: (n: number) => UTF8_DECODER.decode(take(n)),
    done: () => pos,
  };
}

/** Decodifica o payload de `chunk_voxels` (formato 4, ver `world_cache.rs` —
 * v3, sem luz, e v2, sem luz nem tints, ainda são aceitos pro cache antigo). */
function decodeVoxels(x: number, z: number, bytes: Uint8Array): DecodedChunk {
  const reader = byteReader(bytes);
  const version = reader.u8();
  if (
    version !== VOXEL_FORMAT_VERSION &&
    version !== VOXEL_FORMAT_VERSION_TINTS &&
    version !== VOXEL_FORMAT_VERSION_LEGACY
  ) {
    throw new Error(`versão de payload desconhecida: ${version}`);
  }
  const sectionCount = reader.u8();
  const sections = new Map<number, DecodedSection>();
  for (let i = 0; i < sectionCount; i++) {
    const y = reader.i8();
    const paletteLen = reader.u16();
    if (paletteLen === 0) throw new Error("paleta vazia");
    const palette: PaletteEntry[] = [];
    for (let p = 0; p < paletteLen; p++) {
      const nameLen = reader.u16();
      const block = reader.utf8(nameLen);
      const flags = reader.u8();
      const level = reader.u8();
      palette.push({ block, flags, level });
    }
    const indices = new Uint16Array(4096);
    for (let idx = 0; idx < 4096; idx++) indices[idx] = reader.u16();
    const light = new Uint8Array(4096);
    if (version >= VOXEL_FORMAT_VERSION) {
      for (let idx = 0; idx < 4096; idx++) light[idx] = reader.u8();
    } else {
      // Payload antigo (v2/v3) não tem luz: dia cheio, como o viewer
      // desenhava antes de existir luz de verdade.
      light.fill(0xf0);
    }
    sections.set(y, { y, palette, indices, light });
  }

  let tints: ChunkTints | null = null;
  if (version >= VOXEL_FORMAT_VERSION_TINTS) {
    const hasTints = reader.u8();
    if (hasTints === 1) {
      const readColumns = () => {
        const columns = new Uint32Array(TINT_COLUMNS);
        for (let column = 0; column < TINT_COLUMNS; column++) {
          const r = reader.u8();
          const g = reader.u8();
          const b = reader.u8();
          columns[column] = (r << 16) | (g << 8) | b;
        }
        return columns;
      };
      tints = { grass: readColumns(), foliage: readColumns(), water: readColumns() };
    } else if (hasTints !== 0) {
      throw new Error(`flag de tints inválida: ${hasTints}`);
    }
  }

  const sectionYs = Array.from(sections.keys());
  return {
    x,
    z,
    sections,
    tints,
    maxSectionY: sectionYs.length > 0 ? Math.max(...sectionYs) : 0,
  };
}

export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private fog: THREE.Fog;

  // Preferências da aba Config (ver `applySettings`). Os valores iniciais são
  // os padrões do backend (`src-tauri/src/settings.rs`); `main.ts` substitui
  // assim que o `settings_get` responde.
  private fogFar = FOG_FAR_BASE;
  private meshBudgetMs = MESH_BUDGET_MS;
  private maxPixelRatio = 2;
  private fpsCap = 0;
  private lastRenderMs = 0;

  /** Chunks decodificados (voxels crus), chave = `chunkKey`. */
  private chunks = new Map<number, DecodedChunk>();
  /** Malhas de um chunk, uma por bucket de material — ver `buildChunkMesh`. */
  private chunkMeshes = new Map<number, THREE.Mesh[]>();
  /** Fila de chunks esperando malha (chave numérica) + dedupe; drenada por
   * frame com orçamento em `drainMeshQueue`. */
  private meshQueue: number[] = [];
  private queuedChunks = new Set<number>();
  private botMarker: THREE.Group;
  /** Modelo do jogador dentro de `botMarker` — ver `player_model.ts`. */
  private playerModel = new MinecraftPlayerModel();
  /** Alvo da interpolação da pose; `null` = sem jogador. */
  private targetBotPos: THREE.Vector3 | null = null;
  /** Velocidade do follow do boneco (blocos/s), calculada na última pose pra
   * cobrir a distância no intervalo real entre poses — ver `setBotPose`. */
  private followSpeed = 0;
  /** Timestamp (ms) da última pose recebida; 0 = sem histórico ainda. */
  private lastPoseAtMs = 0;
  private botYaw = 0;
  private botPitch = 0;

  /** Rótulos dos mobs vivos ao redor (comando `nearby_mobs`), chave = id de
   *  rede da entidade — ver `setNearbyMobs`. */
  private readonly mobMarkers = new Map<number, MobMarker>();
  /** Camada dos rótulos de mob — mesmo padrão do `bot-label` (HTML projetado
   *  por cima do canvas), um elemento por mob. */
  private readonly mobLayer: HTMLDivElement;
  /** Scratch da projeção dos rótulos (`updateMobLabels`) — evita alocar um
   *  `Vector3` por mob por frame. */
  private readonly mobScratch = new THREE.Vector3();

  private labelEl: HTMLDivElement;

  /** Alvo escolhido clicando no terreno (âmbar) + popup de ações — ver
   * `pickTargetAt`/`setTarget`. `null` = nenhum alvo. */
  private targetMarker: THREE.Group;
  private targetEl: HTMLDivElement;
  private targetBlock: { x: number; y: number; z: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private pointerDownAt: { x: number; y: number; time: number } | null = null;

  /** Instruções da fila com alvo, desenhadas no mundo (uma caixa de arame por
   * instrução): âmbar = `Queued`, teal = `Active` — ver `setInstructionTargets`. */
  private readonly instructionMarkers = new Map<string, THREE.Mesh>();
  private readonly ghostGeometry = new THREE.BoxGeometry(1.04, 1.04, 1.04);
  private readonly ghostQueuedMaterial = new THREE.MeshBasicMaterial({
    color: COLOR_AMBER,
    wireframe: true,
    transparent: true,
    opacity: 0.45,
    fog: false,
  });
  private readonly ghostActiveMaterial = new THREE.MeshBasicMaterial({
    color: COLOR_TEAL,
    wireframe: true,
    transparent: true,
    opacity: 0.75,
    fog: false,
  });

  // Estado do voo por teclado — ver `handleKeyDown`/`applyMovement`.
  private keysDown = new Set<string>();
  private turboKey = false;
  private preciseKey = false;
  private readonly moveForward = new THREE.Vector3();
  private readonly moveRight = new THREE.Vector3();
  private readonly moveDelta = new THREE.Vector3();
  private lastFrameMs = performance.now();

  private atlasLoading = false;
  private atlasImage: HTMLImageElement | null = null;
  private atlasTexture: THREE.Texture | null = null;
  private atlasUvByName: Record<string, UvRect> | null = null;

  // ---- Editor de schematic (ver `docs/SPEC.md`, "Como isso vira o editor
  // estilo WorldEdit") ----
  /** Camada de edição, separada do `chunks` (mundo real): chave = x,y,z.
   * `block = null` = quebrar. Nunca muta o terreno verdadeiro — o diff e a
   * instrução são gerados no Rust (`schematic.rs`). */
  private edits = new Map<string, BlockEdit>();
  private editMode: EditMode | null = null;
  private placeBlock: string | null = null;
  private selectionA: BlockPos | null = null;
  private selectionB: BlockPos | null = null;
  private hovered: PickedBlock | null = null;
  /** Cubo de arame do bloco sob o cursor / destino da colocação. */
  private hoverHelper: THREE.LineSegments;
  /** Cubo de arame da região selecionada (âmbar = planejado). */
  private selectionHelper: THREE.LineSegments;
  private ghostGroup = new THREE.Group();
  /** Ghosts instanciados por (bloco, quebrar|colocar). */
  private ghostMeshes = new Map<string, THREE.InstancedMesh>();
  private iconCache = new Map<string, string>();
  private readonly scratchMatrix = new THREE.Matrix4();
  /** Chamado quando a camada de edição ou a seleção muda — a UI usa pra
   * atualizar contadores/botões. */
  onEditChange: (() => void) | null = null;
  /** Chamado quando o atlas termina de carregar — é quando a paleta (ícones
   * reais) pode ser montada. */
  onAtlasReady: (() => void) | null = null;
  /** Avisos honestos pra UI (ex: seleção grande demais). */
  onNotice: ((message: string) => void) | null = null;

  /** Atlas tentado e falhou (jar ausente, extração quebrada): o mundo é
   * desenhado em modo degradado (cor sólida, sem textura) e `main.ts` para de
   * tentar — ver `needsAtlas`/`setAtlasUnavailable`. */
  private atlasUnavailable = false;
  /** Cache de `faceRect` por `bloco|face` — o rect não muda enquanto o atlas
   * não troca, e isso é consultado por toda face da malha. */
  private faceRectCache = new Map<string, ResolvedFace>();
  /** Uma textura recortada (16×16px) por nome exato de textura do atlas (ex:
   * "grass_block_top", "water_still_f3") — evita recriar canvas/textura pro
   * mesmo tile. `null` = atlas carregado mas sem essa textura. Enquanto o
   * atlas não carregou nada é cacheado — ver `getTileTexture`. */
  private tileTextureCache = new Map<string, THREE.Texture | null>();
  /** UV+tint por (bloco, face do cubo) — ver `FaceRender`. Invalidado quando
   * o atlas (re)carrega, em `buildMaterials`. */
  private faceRenderCache = new Map<string, FaceRender | null>();
  /** Material do terreno opaco: um só pra tudo, com UV apontando pro tile
   * certo do atlas por face e cor por vértice (tint). */
  private opaqueMaterial: THREE.MeshBasicMaterial | null = null;
  /** Material por bucket de fluido (`water_still`, `water_flow`,
   * `lava_still`, `lava_flow`). */
  private bucketMaterials = new Map<string, THREE.MeshBasicMaterial>();
  /** Materiais com textura animada + seus frames, pra trocar o `map`. */
  private animatedMaterials: { material: THREE.MeshBasicMaterial; frames: THREE.Texture[] }[] = [];
  private animationFrame = 0;
  private lastAnimationMs = 0;
  private readonly scratchColor = new THREE.Color();
  /** Cache `0xRRGGBB` → componentes lineares — ver `linearColor`. */
  private readonly linearColorCache = new Map<number, [number, number, number]>();
  /** Domo de céu com gradiente, sempre centrado na câmera — ver `updateSky`. */
  private sky: THREE.Mesh;
  /** Layer de nuvens (3×3 tiles do padrão) — `null` até o PNG do jar chegar. */
  private cloudGroup: THREE.Group | null = null;
  /** Material compartilhado pelos 9 tiles — a cor é retintada por dia/noite
   * em `updateClouds` (`daylightFactor`). */
  private cloudMaterial: THREE.MeshBasicMaterial | null = null;
  /** Base do relógio da deriva das nuvens (o jogo mede em ticks; aqui é o
   * tempo real desde a primeira textura de nuvens carregada). */
  private cloudStartMs = 0;
  /** Fator 0..1 de luz do dia, calculado em `updateDayNight` — as nuvens usam
   * pra escurecer à noite como no jogo. */
  private daylightFactor = 1;
  /** Canvas/textura do gradiente do domo — `paintSky` redesenha os dois. */
  private skyCanvas: HTMLCanvasElement | null = null;
  private skyTexture: THREE.CanvasTexture | null = null;
  /** Hora do mundo (ticks 0..23999) e se o addon está reportando agora. Sem
   * jogo, a hora congela na última real; sem nenhuma, vale `DEFAULT_DAY_TIME`. */
  private worldTime: number | null = null;
  private worldTimeLive = false;
  private lastSkyPaintMs = -Infinity;
  /** Luzes do ciclo dia/noite — ver `updateDayNight`. */
  private ambientLight: THREE.AmbientLight;
  private sunLight: THREE.DirectionalLight;
  private moonLight: THREE.DirectionalLight;
  private readonly dayNightA = new THREE.Color();
  private readonly dayNightB = new THREE.Color();
  private readonly dayNightC = new THREE.Color();
  /** Fator de luz de céu já assado na malha atual — acompanha o dia/noite
   * (ver `updateDayNight`). */
  private bakedSkyFactor = 1;

  constructor(container: HTMLElement, labelEl: HTMLDivElement, targetEl: HTMLDivElement) {
    this.container = container;
    this.labelEl = labelEl;
    this.targetEl = targetEl;

    // Camada dos rótulos de mob: filha do mesmo overlay do `bot-label` — o
    // canvas (e o container) troca entre viewer/editor, o overlay não.
    this.mobLayer = document.createElement("div");
    this.mobLayer.className = "mob-layer";
    (labelEl.parentElement ?? container).appendChild(this.mobLayer);

    this.scene = new THREE.Scene();
    this.fog = new THREE.Fog(SKY_DAY.horizon, FOG_NEAR_BASE, FOG_FAR_BASE);
    this.scene.fog = this.fog;

    // `far` acompanha o `maxDistance` do OrbitControls: com o zoom livre
    // (2000 blocos) um far de 1000 cortaria o terreno ao se afastar.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.camera.position.set(40, 45, 40);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    // O domo cobre a tela; isto é o fundo de segurança (o que aparece antes do
    // primeiro frame), por isso a cor do horizonte.
    this.renderer.setClearColor(SKY_DAY.horizon, 1);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Inércia curta: soltando o mouse, a órbita para em ~0,4 s em vez de
    // continuar girando por segundos.
    this.controls.dampingFactor = 0.22;
    // Rotação por arrasto um pouco menos sensível — um arrasto curto não
    // joga a câmera pro outro lado do bot.
    this.controls.rotateSpeed = 0.8;
    // Zoom livre na prática: antes travava em 8–400 blocos (não dava pra
    // chegar perto de um bloco pra inspecionar nem ver o relevo de longe).
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 2000;
    this.controls.zoomToCursor = true; // a roda aproxima no ponto do cursor, não no centro do alvo
    this.controls.maxPolarAngle = Math.PI * 0.49; // não deixa virar de cabeça pra baixo
    // Botão do meio também vira `pan` (arrastar = mover): com `zoomToCursor`
    // a roda já dá conta do dolly, e pan é o gesto que mais falta.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    // Teclado é escutado na window (não no canvas, que pode não ter foco);
    // `handleKeyDown` ignora quando a view do viewer não está ativa/visível.
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.clearKeys);

    // Clique parado no terreno escolhe o destino; arrastar continua orbitando
    // (o OrbitControls escuta os mesmos eventos, então nada de preventDefault
    // aqui — a distinção é só o movimento/tempo). O mesmo clique vira edição
    // quando há uma ferramenta do editor ativa — ver `handlePointerUp`.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.hoverHelper.visible = false;
    });

    // Luzes do ciclo dia/noite — posição/intensidade/cor reais em
    // `updateDayNight` (o construtor só deixa a cena num dia neutro).
    this.ambientLight = new THREE.AmbientLight(0xffffff, AMBIENT_DAY);
    this.scene.add(this.ambientLight);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.sunLight.position.set(80, 120, 40);
    this.scene.add(this.sunLight);
    this.moonLight = new THREE.DirectionalLight(MOON_COLOR, 0);
    this.scene.add(this.moonLight);

    this.sky = this.buildSky();
    this.scene.add(this.sky);

    this.botMarker = this.buildBotMarker();
    this.botMarker.visible = false;
    this.scene.add(this.botMarker);

    // Editor: helpers de arame (hover/seleção) e o grupo dos ghosts — ver
    // `rebuildGhosts`.
    this.scene.add(this.ghostGroup);
    this.hoverHelper = this.buildWireBox(COLOR_TEAL);
    this.selectionHelper = this.buildWireBox(COLOR_AMBER);

    // Alvo clicado da fila (instruções) — caixa âmbar sobre o bloco escolhido.
    this.targetMarker = this.buildTargetMarker();
    this.scene.add(this.targetMarker);

    this.resize();
    this.animate();
  }

  /** Cubo de arame 1×1×1 (escalado depois) do hover e da região selecionada.
   * `depthTest: false` = sempre visível, mesmo atrás do terreno — é um cursor,
   * não um objeto da cena. */
  private buildWireBox(color: number): THREE.LineSegments {
    const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
    const box = new THREE.LineSegments(geometry, material);
    box.renderOrder = 3; // por cima do terreno
    box.visible = false;
    this.scene.add(box);
    return box;
  }

  /** Caixa de arame âmbar sobre o bloco clicado — planejado, ainda não
   * enviado (a cor segue a identidade: âmbar = ação/planejado). O preenchimento
   * translúcido existe só pra dar volume; `fog: false` pra nunca sumir no
   * horizonte, igual o marcador do bot. */
  private buildTargetMarker(): THREE.Group {
    const group = new THREE.Group();
    const geometry = new THREE.BoxGeometry(1.02, 1.02, 1.02);
    const fill = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: COLOR_AMBER, transparent: true, opacity: 0.14, depthWrite: false, fog: false })
    );
    const wire = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: COLOR_AMBER, wireframe: true, transparent: true, opacity: 0.9, fog: false })
    );
    group.add(fill, wire);
    group.visible = false;
    return group;
  }

  /** Grupo do jogador: o modelo do Minecraft + um anel teal raso no chão. O
   * modelo é a posição real; o anel mantém o "você está aqui" legível de
   * longe (mesmo papel do marcador antigo, sem a bola). */
  private buildBotMarker(): THREE.Group {
    const group = new THREE.Group();
    group.add(this.playerModel.group);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 32),
      new THREE.MeshBasicMaterial({
        color: COLOR_TEAL,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        fog: false, // o marcador é "você está aqui", nunca some no fog
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
    return group;
  }

  /** Domo de céu com gradiente vertical (zênite → horizonte) numa textura de
   * canvas — mais simples que um shader próprio e sem conversão manual de
   * color space. `BackSide` = visto por dentro; `fog: false` = a neblina não
   * engole o céu; `depthWrite: false` = nunca esconde o terreno, seja qual for
   * a distância da câmera. */
  private buildSky(): THREE.Mesh {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 256;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
      new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
        toneMapped: false,
      })
    );
    sky.frustumCulled = false; // está sempre na câmera — nunca cullar
    this.skyCanvas = canvas;
    this.skyTexture = texture;
    // Estado inicial (dia claro); `updateDayNight` repinta conforme a hora.
    this.paintSky(SKY_DAY_ZENITH, SKY_DAY_MID, SKY_DAY_HORIZON);
    return sky;
  }

  /** Monta o layer de nuvens a partir do PNG do jar (ver `texture_atlas.rs`):
   * uma geometria com as caixas de todas as células do padrão, replicada em
   * 3×3 tiles que compartilham a malha (o padrão é periódico — ver
   * `updateClouds`), o que cobre a vista mesmo com o zoom afastado. */
  private buildClouds(dataUrl: string | null) {
    if (!dataUrl) return;
    new THREE.TextureLoader().load(
      dataUrl,
      (texture) => {
        const image = texture.image as HTMLImageElement | undefined;
        if (!image) return;
        const geometry = this.buildCloudGeometry(image);
        if (!geometry) return;

        const material = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: CLOUD_ALPHA,
          depthWrite: false,
        });
        this.cloudMaterial = material;
        const group = new THREE.Group();
        for (let ix = -1; ix <= 1; ix++) {
          for (let iz = -1; iz <= 1; iz++) {
            const tile = new THREE.Mesh(geometry, material);
            tile.position.set(ix * CLOUD_PERIOD_BLOCKS, 0, iz * CLOUD_PERIOD_BLOCKS);
            group.add(tile);
          }
        }
        if (this.cloudGroup) {
          this.scene.remove(this.cloudGroup);
          for (const child of this.cloudGroup.children) {
            if (child instanceof THREE.Mesh) child.geometry.dispose();
          }
        }
        this.cloudGroup = group;
        this.scene.add(group);
        this.updateClouds(performance.now());
      },
      undefined,
      (err) => console.error("[viewer3d] falha ao carregar textura de nuvens:", err)
    );
  }

  /** Caixas do padrão de nuvens a partir dos pixels do PNG: cada texel com
   * alpha ≥ `CLOUD_ALPHA_CUTOFF` é uma célula; topo e base sempre, os lados só
   * quando o vizinho (com wrap, como no `CloudRenderer`) é vazio. */
  private buildCloudGeometry(image: HTMLImageElement): THREE.BufferGeometry | null {
    const width = image.width;
    const height = image.height;
    if (width !== CLOUD_TEXTURE_PX || height !== CLOUD_TEXTURE_PX) {
      console.warn(`[viewer3d] textura de nuvens inesperada: ${width}×${height}`);
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;

    const solid = new Uint8Array(width * height);
    for (let i = 0; i < solid.length; i++) {
      solid[i] = pixels[i * 4 + 3] >= CLOUD_ALPHA_CUTOFF ? 1 : 0;
    }
    const wrapX = (v: number) => ((v % width) + width) % width;
    const wrapZ = (v: number) => ((v % height) + height) % height;
    const at = (x: number, z: number) => solid[wrapZ(z) * width + wrapX(x)];

    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const size = CLOUD_CELL_SIZE;
    const top = CLOUD_THICKNESS;
    const addQuad = (corners: readonly (readonly [number, number, number])[], shade: number) => {
      const base = positions.length / 3;
      for (const [x, y, z] of corners) {
        positions.push(x, y, z);
        colors.push(shade, shade, shade);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        if (!solid[z * width + x]) continue;
        const bx = x * size;
        const bz = z * size;
        addQuad(
          [
            [bx, top, bz],
            [bx, top, bz + size],
            [bx + size, top, bz + size],
            [bx + size, top, bz],
          ],
          CLOUD_SHADE_TOP
        );
        addQuad(
          [
            [bx, 0, bz],
            [bx + size, 0, bz],
            [bx + size, 0, bz + size],
            [bx, 0, bz + size],
          ],
          CLOUD_SHADE_BOTTOM
        );
        if (!at(x, z - 1)) {
          addQuad(
            [
              [bx, 0, bz],
              [bx, top, bz],
              [bx + size, top, bz],
              [bx + size, 0, bz],
            ],
            CLOUD_SHADE_NORTH_SOUTH
          );
        }
        if (!at(x, z + 1)) {
          addQuad(
            [
              [bx, 0, bz + size],
              [bx + size, 0, bz + size],
              [bx + size, top, bz + size],
              [bx, top, bz + size],
            ],
            CLOUD_SHADE_NORTH_SOUTH
          );
        }
        if (!at(x - 1, z)) {
          addQuad(
            [
              [bx, 0, bz],
              [bx, 0, bz + size],
              [bx, top, bz + size],
              [bx, top, bz],
            ],
            CLOUD_SHADE_EAST_WEST
          );
        }
        if (!at(x + 1, z)) {
          addQuad(
            [
              [bx + size, 0, bz + size],
              [bx + size, 0, bz],
              [bx + size, top, bz],
              [bx + size, top, bz + size],
            ],
            CLOUD_SHADE_EAST_WEST
          );
        }
      }
    }
    if (indices.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Ancora o layer de nuvens no mundo: a célula `i` da textura fica em
   * `i * 12 − drift` no X e `i * 12 − 3.96` no Z (mesma conta do
   * `CloudRenderer`: `cloudX = camera.x + drift`, `cloudZ = camera.z + 3.96`,
   * com o padrão andando pra −X a 0.6 bloco/s) — e o grupo vai pro múltiplo do
   * período mais perto da câmera, o que não muda o visual (o padrão repete a
   * cada 3072 blocos) e mantém os 3×3 tiles cobrindo a vista. */
  private updateClouds(now: number) {
    const group = this.cloudGroup;
    if (!group) return;
    if (this.cloudStartMs === 0) this.cloudStartMs = now;
    // Cor do jogo: branco de dia, azul quase preto à noite (multiplicador
    // noturno do `Timelines`), interpolado pelo mesmo fator de luz do céu.
    this.cloudMaterial?.color.copy(CLOUD_NIGHT_COLOR).lerp(CLOUD_DAY_COLOR, this.daylightFactor);
    const drift = (((now - this.cloudStartMs) / 1000) * CLOUD_DRIFT_PER_SECOND) % CLOUD_PERIOD_BLOCKS;
    const anchorX = -drift;
    const anchorZ = -CLOUD_Z_OFFSET;
    const nearest = (anchor: number, camera: number) =>
      anchor + Math.round((camera - anchor) / CLOUD_PERIOD_BLOCKS) * CLOUD_PERIOD_BLOCKS;
    group.position.set(
      nearest(anchorX, this.camera.position.x),
      CLOUD_HEIGHT,
      nearest(anchorZ, this.camera.position.z)
    );
  }

  /** Redesenha o gradiente do domo (2×256) e reenvia pra GPU. Só é chamado a
   * cada `SKY_REPAINT_MS` — o ciclo é lento e o domo não precisa de 60fps. */
  private paintSky(zenith: THREE.Color, mid: THREE.Color, horizon: THREE.Color) {
    const canvas = this.skyCanvas;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !this.skyTexture) return;
    // FlipY padrão do CanvasTexture: o topo da imagem cai no topo da esfera.
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, `#${zenith.getHexString()}`);
    gradient.addColorStop(0.55, `#${mid.getHexString()}`);
    gradient.addColorStop(1, `#${horizon.getHexString()}`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.skyTexture.needsUpdate = true;
  }

  /** Chave numérica (x,z): o mundo do Minecraft cabe em |x|,|z| < 30M, então
   * `x * 30M + z` é única e não aloca string por chunk no polling. */
  private chunkKey(x: number, z: number): number {
    return x * 30_000_000 + z;
  }

  hasAtlas(): boolean {
    return this.atlasImage !== null;
  }

  get isLoadingAtlas(): boolean {
    return this.atlasLoading;
  }

  /** O `main.ts` só deve tentar `get_texture_atlas` quando isto for `true`:
   * uma tentativa por vez, e nenhuma depois que o atlas já resolveu ou já
   * falhou (falha vira modo degradado, não retry infinito). */
  needsAtlas(): boolean {
    return !this.atlasUnavailable && this.atlasImage === null && !this.atlasLoading;
  }

  /** Sem atlas (jar ausente, extração quebrada): para de tentar e passa a
   * desenhar o mundo com cor sólida por face — degradado, mas visível. */
  setAtlasUnavailable() {
    if (this.atlasImage || this.atlasUnavailable) return;
    this.atlasUnavailable = true;
    this.buildMaterials();
    this.rebuildAllMeshes();
  }

  /** `true` se o chunk já foi recebido (mesmo antes do atlas carregar — os
   * dados ficam guardados e a malha é montada quando o atlas chega). */
  hasChunk(x: number, z: number): boolean {
    return this.chunks.has(this.chunkKey(x, z));
  }

  /** Chunk do ponto que a câmera orbita — âncora de prioridade quando não há
   * bot conectado (mundo em cache sendo navegado com o jogo fechado). */
  getFocusChunk(): ChunkPos {
    return {
      x: Math.floor(this.controls.target.x) >> 4,
      z: Math.floor(this.controls.target.z) >> 4,
    };
  }

  /** Recebe o atlas já extraído/empacotado pelo lado Rust (data URL + mapa
   * de UV) e guarda a imagem crua + o mapa de UV. Chamado uma vez, quando o
   * comando `get_texture_atlas` resolve — ver `main.ts`.
   *
   * Isso é assíncrono, mas o backfill de reconexão pode mandar dezenas de
   * chunks antes do atlas terminar de carregar; os voxels ficam guardados e
   * só viram malha aqui, com as texturas prontas. */
  setAtlas(dataUrl: string, textures: Record<string, UvRect>, cloudDataUrl: string | null = null) {
    this.atlasLoading = true;
    // As nuvens vêm do mesmo jar mas são outro PNG — monta em paralelo; sem
    // ele (jar ausente) simplesmente não há nuvens, nada de inventar padrão.
    this.buildClouds(cloudDataUrl);
    new THREE.TextureLoader().load(
      dataUrl,
      (texture) => {
        // `flipY = false`: os rects de UV do Rust usam a origem no topo da
        // imagem (igual ao canvas), e é assim que o mapa é montado aqui.
        texture.flipY = false;
        texture.magFilter = THREE.NearestFilter;
        // Mipmaps com folga no atlas (ver `texture_atlas.rs`): sem mipmap,
        // cada bloco distante amostra um texel diferente do vizinho e o
        // terreno ganha uma grade/"separação" visível de longe; com ele, as
        // faces convergem pro mesmo tom médio. `NearestMipmapLinear` mantém o
        // pixel nítido de perto e só mistura entre níveis na minificação.
        texture.minFilter = THREE.NearestMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;

        this.atlasImage = texture.image;
        this.atlasTexture = texture;
        this.atlasUvByName = textures;
        this.atlasUnavailable = false;
        this.atlasLoading = false;
        this.buildMaterials();
        this.rebuildAllMeshes();
        // Edições feitas antes do atlas (ícone/ghost dependem dele) aparecem
        // agora — e o `onEditChange` avisa a UI pra montar a paleta.
        this.rebuildGhosts();
        this.onEditChange?.();
        this.onAtlasReady?.();
      },
      undefined,
      (err) => {
        console.error("[viewer3d] falha ao carregar atlas de texturas:", err);
        this.atlasLoading = false;
        // O data URL veio do Rust mas não decodificou — trata como atlas
        // indisponível em vez de tentar pra sempre.
        this.setAtlasUnavailable();
      }
    );
  }

  /** Recorta um único tile (16×16px) do atlas pro nome de textura exato
   * (ex: "grass_block_top", "water_flow_f7") e devolve uma textura própria. */
  private buildTileTexture(rect: UvRect): THREE.Texture {
    const sourceImage = this.atlasImage!;
    const canvas = document.createElement("canvas");
    canvas.width = BLOCK_TEXTURE_PX;
    canvas.height = BLOCK_TEXTURE_PX;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceImage,
      rect.u0 * sourceImage.width,
      rect.v0 * sourceImage.height,
      (rect.u1 - rect.u0) * sourceImage.width,
      (rect.v1 - rect.v0) * sourceImage.height,
      0,
      0,
      BLOCK_TEXTURE_PX,
      BLOCK_TEXTURE_PX
    );

    const texture = new THREE.CanvasTexture(canvas);
    // Mesma convenção do atlas (ver `setAtlas`): V=0 é o topo da imagem, que
    // é como a tabela de UVs das faces foi montada.
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    // Tile avulso (frames de fluido): pode ter mipmap sem risco de folga —
    // não há tile vizinho pra vazar.
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private getTileTexture(textureName: string): THREE.Texture | null {
    if (this.tileTextureCache.has(textureName)) {
      return this.tileTextureCache.get(textureName)!;
    }
    if (!this.atlasUvByName) return null; // atlas ainda não carregou — não cacheia, tenta de novo depois

    const rect = this.atlasUvByName[textureName];
    const texture = rect ? this.buildTileTexture(rect) : null;
    this.tileTextureCache.set(textureName, texture);
    return texture;
  }

  /** Rect do atlas pra uma face do bloco, como no jogo: topo usa
   * `"{bloco}_top"` (ex: grass_block_top, oak_log_top), os 4 lados usam
   * `"{bloco}_side"` e o fundo `"{bloco}_bottom"` — com fallback pro nome
   * puro quando a variante não existe (stone, dirt, sand...). Blocos com
   * modelo próprio (escada, laje, muro, porta...) não têm textura com o nome
   * do bloco: a lista de candidatos tira o sufixo e tenta o material "base"
   * deles (oak_stairs → oak_planks). Heurística, não o pipeline
   * blockstate→model→face do spec ("Blocos 3D").
   *
   * Devolve também se a textura é real (`known`) ou fallback — quem chama usa
   * isso pra pintar o bloco desconhecido de cinza em vez de fingir que é
   * outro bloco. */
  private faceRect(blockName: string, face: BlockFace): ResolvedFace | null {
    const atlas = this.atlasUvByName;
    if (!atlas) {
      // Sem atlas nenhum: no modo degradado a geometria ainda é montada (sem
      // `map`), então qualquer UV serve; antes do atlas resolver, `null`
      // adia a malha (ver `addChunkVoxels`/`setAtlas`).
      return this.atlasUnavailable ? { rect: NO_ATLAS_RECT, known: false } : null;
    }

    const key = `${blockName}|${face}`;
    const cached = this.faceRectCache.get(key);
    if (cached) return cached;

    const base = face === "bottom" ? BOTTOM_TEX_OVERRIDE[blockName] ?? blockName : blockName;
    const candidates: string[] = [];
    const add = (name: string) => {
      if (name && !candidates.includes(name)) candidates.push(name);
    };
    if (face === "top") add(`${base}_top`);
    if (face === "side") add(`${base}_side`);
    if (face === "bottom") add(`${base}_bottom`);
    add(base);

    const stripped = base.replace(
      /(_stairs|_slab|_wall|_fence_gate|_fence|_door|_trapdoor|_button|_pressure_plate|_pane|_bars|_carpet|_bed|_candle|_sign|_hanging_sign|_chain)$/,
      ""
    );
    if (stripped !== base) {
      add(`${stripped}_planks`);
      add(stripped);
      add(`${stripped}_block`);
    }

    for (const name of candidates) {
      const rect = atlas[name] ?? atlas[TEXTURE_ALIASES[name]];
      if (rect) {
        const resolved = { rect, known: true };
        this.faceRectCache.set(key, resolved);
        return resolved;
      }
    }

    // Nenhuma textura com o nome do bloco (mod, nome sem variante): tile
    // branco + cinza por vértice. Se o atlas for antigo e não tiver o tile
    // branco, ainda cai em `dirt` como último recurso.
    const fallback = atlas[WHITE_TILE] ?? atlas["dirt"] ?? Object.values(atlas)[0] ?? null;
    if (!fallback) return null;
    const resolved = { rect: fallback, known: false };
    this.faceRectCache.set(key, resolved);
    return resolved;
  }

  /** Cor (`0xRRGGBB`) de uma face do bloco como o jogo resolve: texturas
   * cinzas (grama, folhagem) levam o tint de bioma da coluna quando o chunk
   * trouxe os tints (payload v3) — senão o fallback fixo aproximado. O resto
   * sai branco (a textura já é colorida). */
  private faceTint(blockName: string, face: BlockFace, column: number, tints: ChunkTints | null): number {
    const kind = BLOCK_TINT_KIND[blockName];
    if (kind === "grass") {
      // No grass_block o lado é terra + overlay (camada própria, tingida em
      // `buildChunkMesh`); aqui só o topo leva tint.
      if (blockName === "grass_block" && face !== "top") return 0xffffff;
      return this.grassTintAt(column, tints);
    }
    if (kind === "foliage") return this.foliageTintAt(column, tints);
    return BLOCK_TINTS[blockName] ?? 0xffffff;
  }

  private grassTintAt(column: number, tints: ChunkTints | null): number {
    return tints ? tints.grass[column] : GRASS_TINT;
  }

  private foliageTintAt(column: number, tints: ChunkTints | null): number {
    return tints ? tints.foliage[column] : FOLIAGE_TINT;
  }

  private waterTintAt(column: number, tints: ChunkTints | null): number {
    return tints ? tints.water[column] : WATER_TINT;
  }

  private buildMaterials() {
    this.animatedMaterials = [];
    this.bucketMaterials.clear();
    this.faceRenderCache.clear();
    this.faceRectCache.clear();
    // Material do terreno é **sem luz dinâmica** (`MeshBasicMaterial`): a luz
    // vem assada na cor do vértice, reamostrada da luz real do jogo (tocha,
    // céu, lava...) em `pushQuadFlat` — é o que faz o bloco emissor iluminar
    // os vizinhos e a caverna ficar escura. `alphaTest` recorta as texturas
    // com transparência (folhas, plantas, tochas); no modo degradado
    // (`map: null`) o alpha do vértice é 1 e nada muda.
    this.opaqueMaterial = new THREE.MeshBasicMaterial({
      map: this.atlasTexture,
      vertexColors: true,
      alphaTest: 0.5,
    });
    this.bucketMaterials.set("opaque", this.opaqueMaterial);
    this.bucketMaterials.set("water_still", this.buildFluidMaterial("water", "still"));
    this.bucketMaterials.set("water_flow", this.buildFluidMaterial("water", "flow"));
    this.bucketMaterials.set("lava_still", this.buildFluidMaterial("lava", "still"));
    this.bucketMaterials.set("lava_flow", this.buildFluidMaterial("lava", "flow"));
  }

  private buildFluidMaterial(kind: "water" | "lava", phase: "still" | "flow"): THREE.MeshBasicMaterial {
    const frames = this.loadFrames(`${kind}_${phase}`);
    const water = kind === "water";
    const material = new THREE.MeshBasicMaterial({
      map: frames[0] ?? null,
      // O tint da água é por coluna (bioma, ver `meshFluidFace`) e chega por
      // vértice junto da luz; lava não tem tint (branco).
      color: 0xffffff,
      vertexColors: true,
      // Água é translúcida e não escreve no z-buffer (como no jogo); lava é
      // opaca. A luz da lava vem do próprio dado do jogo (bloco 15 propagado
      // nas posições vizinhas), então ela não precisa de emissive.
      transparent: water,
      opacity: water ? 0.72 : 1,
      depthWrite: !water,
      side: THREE.DoubleSide,
    });
    if (frames.length > 1) this.animatedMaterials.push({ material, frames });
    return material;
  }

  /** Frames `"{stem}_f0"`, `"_f1"`… extraídos pelo `texture_atlas.rs`; o
   * nome puro (frame 0) é o fallback de atlas antigo/sem frames. */
  private loadFrames(stem: string): THREE.Texture[] {
    const atlas = this.atlasUvByName;
    if (!atlas) return [];
    const frames: THREE.Texture[] = [];
    for (let i = 0; i < 512; i++) {
      if (!atlas[`${stem}_f${i}`]) break;
      const texture = this.getTileTexture(`${stem}_f${i}`);
      if (!texture) break;
      frames.push(texture);
    }
    if (frames.length === 0) {
      const single = this.getTileTexture(stem);
      if (single) frames.push(single);
    }
    return frames;
  }

  /** Recebe um chunk em voxels (payload binário de `chunk_voxels`, ver
   * `world_cache.rs`) e enfileira a malha dele pra montagem orçada por frame
   * (`drainMeshQueue`) — um backfill enfileira centenas de chunks de uma vez
   * e montar tudo aqui travava o render.
   *
   * Vizinhos já montados só entram na fila se a borda que dá pra eles tem
   * algo desenhável (oclusão/fluido na divisa mudam a malha do vizinho); a
   * checagem é muito mais barata que remontar 4 chunks por chunk que chega. */
  addChunkVoxels(x: number, z: number, bytes: Uint8Array) {
    if (bytes.length === 0) return; // ainda não pronto no Rust — tenta de novo depois
    let chunk: DecodedChunk;
    try {
      chunk = decodeVoxels(x, z, bytes);
    } catch (err) {
      console.error(`[viewer3d] chunk (${x}, ${z}) com payload inválido:`, err);
      return;
    }
    this.chunks.set(this.chunkKey(x, z), chunk);
    this.enqueueMesh(this.chunkKey(x, z));
    for (const [dx, dz] of HORIZONTAL_NEIGHBORS) {
      if (!this.chunkBorderHasContent(chunk, dx, dz)) continue;
      const neighborKey = this.chunkKey(x + dx, z + dz);
      if (this.chunkMeshes.has(neighborKey)) this.enqueueMesh(neighborKey);
    }
  }

  private enqueueMesh(key: number) {
    if (this.queuedChunks.has(key)) return;
    this.queuedChunks.add(key);
    this.meshQueue.push(key);
  }

  /** `true` se a camada de borda do chunk (a que encosta no vizinho em
   * `(dx, dz)` — cada um em −1/0/1) tem algum bloco desenhável. Borda só de
   * ar não muda a malha nem o fluxo do vizinho, então remontá-lo seria
   * trabalho jogado fora. */
  private chunkBorderHasContent(chunk: DecodedChunk, dx: number, dz: number): boolean {
    for (const section of chunk.sections.values()) {
      for (let a = 0; a < 16; a++) {
        const lx = dx < 0 ? 0 : dx > 0 ? 15 : a;
        const lz = dz < 0 ? 0 : dz > 0 ? 15 : a;
        for (let ly = 0; ly < 16; ly++) {
          const entry = section.palette[section.indices[(ly << 8) | (lz << 4) | lx]];
          if (entry && (entry.flags & VOXEL_FLAG_RENDER) !== 0) return true;
        }
      }
    }
    return false;
  }

  /** Bloco em coordenada de mundo. `null` = desconhecido (chunk ainda não
   * chegou); seção ausente num chunk carregado = ar, como no jogo. */
  private entryAt(x: number, y: number, z: number): PaletteEntry | null {
    const chunk = this.chunks.get(this.chunkKey(x >> 4, z >> 4));
    if (!chunk) return null;
    const section = chunk.sections.get(y >> 4);
    if (!section) return AIR;
    const index = section.indices[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
    return section.palette[index] ?? AIR;
  }

  /** Direção da correnteza de um fluido, calculada dos níveis dos vizinhos
   * horizontais — a mesma ideia do `FlowingFluid#getFlow` do jogo: soma dos
   * vetores apontando pra onde o nível é mais baixo. Sem gradiente, cai
   * (se o bloco de baixo não for o mesmo fluido) ou fica parado. */
  private fluidFlowVector(x: number, y: number, z: number, entry: PaletteEntry): THREE.Vector3 {
    if (entry.level >= 8) return DOWN; // caindo: sempre pra baixo
    const own = fluidHeight(entry.level);
    let fx = 0;
    let fz = 0;
    for (const [dx, dz] of HORIZONTAL_NEIGHBORS) {
      const neighbor = this.entryAt(x + dx, y, z + dz);
      if (neighbor === null) continue; // vizinho desconhecido: neutro, não puxa a água
      let neighborHeight = 0;
      if ((neighbor.flags & VOXEL_FLAG_FLUID) !== 0 && neighbor.block === entry.block) {
        neighborHeight = fluidHeight(neighbor.level);
      }
      fx += dx * (neighborHeight - own);
      fz += dz * (neighborHeight - own);
    }
    if (Math.abs(fx) < 1e-4 && Math.abs(fz) < 1e-4) {
      const below = this.entryAt(x, y - 1, z);
      const belowSameFluid =
        below !== null && (below.flags & VOXEL_FLAG_FLUID) !== 0 && below.block === entry.block;
      return below === null || !belowSameFluid ? DOWN : ZERO;
    }
    return new THREE.Vector3(fx, 0, fz);
  }

  /** Qual das 4 rotações de 90° da textura alinha o "desce" da imagem (V+)
   * com o fluxo projetado na face — [0]=V, [1]=U, [2]=−V, [3]=−U. Roda uma
   * vez por face de fluido visível, então evita alocar arrays de direção. */
  private flowRotation(faceIndex: number, flow: THREE.Vector3): number {
    const face = FACES[faceIndex];
    const vDot = flow.x * face.vDir[0] + flow.y * face.vDir[1] + flow.z * face.vDir[2];
    const uDot = flow.x * face.uDir[0] + flow.y * face.uDir[1] + flow.z * face.uDir[2];
    const candidates = [vDot, uDot, -vDot, -uDot];
    let best = 0;
    for (let i = 1; i < 4; i++) {
      if (candidates[i] > candidates[best]) best = i;
    }
    return best;
  }

  private buffersFor(buckets: Map<string, MeshBuffers>, bucket: string): MeshBuffers {
    let buffers = buckets.get(bucket);
    if (!buffers) {
      buffers = { positions: [], normals: [], uvs: [], colors: [], indices: [] };
      buckets.set(bucket, buffers);
    }
    return buffers;
  }

  /** Adiciona um quad (2 triângulos) de uma face com UVs já flat (8 números),
   * sem alocar nada por face. `low`/`high` recortam a altura local (0..1) —
   * usado pra superfície rebaixada de fluido. `offset` desloca o quad ao
   * longo da normal da face (camada de overlay) e `light` traz o brilho 0–1
   * já suavizado por canto (ver `faceCornerBrightness`). */
  /** Byte de luz de uma posição (nibble baixo = bloco, alto = céu); 0 se o
   * chunk/seção não está no cache. Acima do topo do mundo é céu cheio. */
  private lightAt(x: number, y: number, z: number): number {
    if (y > 319) return 0xf0;
    if (y < -64) return 0;
    const chunk = this.chunks.get(this.chunkKey(x >> 4, z >> 4));
    if (!chunk) return 0;
    const sectionY = y >> 4;
    const section = chunk.sections.get(sectionY);
    if (!section) {
      // Seção de ar não vem no payload (só as que têm bloco): acima da maior
      // seção do chunk é ar aberto (céu cheio); abaixo/entre, escuridão.
      return sectionY > chunk.maxSectionY ? 0xf0 : 0;
    }
    return section.light[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] ?? 0;
  }

  /** Brilho 0–1 de um canto de face, no estilo do jogo: média das 4 posições
   * de ar em volta do canto (a da frente da face + as duas arestas + a quina),
   * nos dois canais, e `max(céu, bloco)` no fim. É isso que dá o degradê
   * suave em volta de uma tocha em vez de blocos com brilho chapado. */
  private cornerBrightness(
    lightAt: (x: number, y: number, z: number) => number,
    face: FaceDef,
    corner: readonly [number, number, number],
    x: number,
    y: number,
    z: number
  ): number {
    const axes: number[] = [];
    for (let axis = 0; axis < 3; axis++) if (face.dir[axis] === 0) axes.push(axis);
    const signs = axes.map((axis) => (corner[axis] === 1 ? 1 : -1));
    const offset = (axis: number, sign: number) => {
      const out = [0, 0, 0];
      out[axis] = sign;
      return out;
    };
    const o1 = offset(axes[0], signs[0]);
    const o2 = offset(axes[1], signs[1]);
    const bx = x + face.dir[0];
    const by = y + face.dir[1];
    const bz = z + face.dir[2];
    const samples = [
      [bx, by, bz],
      [bx + o1[0], by + o1[1], bz + o1[2]],
      [bx + o2[0], by + o2[1], bz + o2[2]],
      [bx + o1[0] + o2[0], by + o1[1] + o2[1], bz + o1[2] + o2[2]],
    ];

    let block = 0;
    let sky = 0;
    for (const [sx, sy, sz] of samples) {
      const value = lightAt(sx, sy, sz);
      block += value & 15;
      sky += value >> 4;
    }
    return lightCurve(Math.max(block >> 2, (sky >> 2) * this.bakedSkyFactor));
  }

  /** Brilho dos 4 cantos de uma face (0–1), já sem o shading direcional —
   * `pushQuadFlat` aplica `faceShade` por cima. */
  private faceCornerBrightness(
    lightAt: (x: number, y: number, z: number) => number,
    faceIndex: number,
    x: number,
    y: number,
    z: number
  ): number[] {
    const face = FACES[faceIndex];
    return face.corners.map((corner) => this.cornerBrightness(lightAt, face, corner, x, y, z));
  }

  private pushQuadFlat(
    buffers: MeshBuffers,
    faceIndex: number,
    x: number,
    y: number,
    z: number,
    low: number,
    high: number,
    uv: readonly number[],
    r: number,
    g: number,
    b: number,
    light: readonly number[],
    offset = 0
  ) {
    const face = FACES[faceIndex];
    const shade = faceShade(face);
    const offsetX = face.dir[0] * offset;
    const offsetY = face.dir[1] * offset;
    const offsetZ = face.dir[2] * offset;
    const base = buffers.positions.length / 3;
    for (let i = 0; i < 4; i++) {
      const corner = face.corners[i];
      buffers.positions.push(
        x + corner[0] + offsetX,
        y + (corner[1] === 1 ? high : low) + offsetY,
        z + corner[2] + offsetZ
      );
      buffers.normals.push(face.dir[0], face.dir[1], face.dir[2]);
      buffers.uvs.push(uv[i * 2], uv[i * 2 + 1]);
      // A luz do jogo já vem pronta (tocha, céu, lava...): aqui ela só é
      // multiplicada no tint do vértice junto do shading da direção da face.
      const brightness = light[i] * shade;
      buffers.colors.push(r * brightness, g * brightness, b * brightness);
    }
    buffers.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Componentes lineares de uma cor `0xRRGGBB`: o `THREE.Color` converte
   * sRGB→linear no `setHex`, e o meshing não pode pagar essa conversão por
   * face — o cache guarda o conjunto de cores em uso (com os tints de bioma
   * são algumas centenas). */
  private linearColor(hex: number): readonly [number, number, number] {
    let linear = this.linearColorCache.get(hex);
    if (!linear) {
      this.scratchColor.setHex(hex);
      const components: [number, number, number] = [
        this.scratchColor.r,
        this.scratchColor.g,
        this.scratchColor.b,
      ];
      this.linearColorCache.set(hex, components);
      linear = components;
    }
    return linear;
  }

  /** UVs (flat, já no espaço do atlas) de uma face do bloco, com cache por
   * (bloco, face). `null` = face sem textura resolvida, pulada sem quebrar o
   * chunk. `requireKnown` = só aceita textura real do atlas (usado pela
   * camada de overlay do grass_block: sem a textura, melhor não desenhar nada
   * do que um retângulo de fallback). */
  private cachedFaceRender(blockName: string, faceIndex: number, requireKnown: boolean): FaceRender | null {
    const key = `${blockName}|${faceIndex}`;
    if (this.faceRenderCache.has(key)) return this.faceRenderCache.get(key)!;

    const face = FACES[faceIndex];
    const resolved = this.faceRect(blockName, face.kind);
    let render: FaceRender | null = null;
    if (resolved && (!requireKnown || resolved.known)) {
      const rect = resolved.rect;
      const uv = new Array<number>(8);
      for (let i = 0; i < 4; i++) {
        const [u, v] = face.uv[i];
        uv[i * 2] = rect.u0 + u * (rect.u1 - rect.u0);
        uv[i * 2 + 1] = rect.v0 + v * (rect.v1 - rect.v0);
      }
      render = { uv, known: resolved.known };
    }
    this.faceRenderCache.set(key, render);
    return render;
  }

  private faceRender(blockName: string, faceIndex: number): FaceRender | null {
    return this.cachedFaceRender(blockName, faceIndex, false);
  }

  private grassOverlayRender(faceIndex: number): FaceRender | null {
    return this.cachedFaceRender(GRASS_SIDE_OVERLAY, faceIndex, true);
  }

  /** Uma face visível de fluido: mesma culling dos sólidos, mas face entre o
   * mesmo fluido só aparece quando o vizinho é mais raso (degrau d'água), e
   * a altura sai do nível em vez de 0..1. `color` = tint do bioma (água) ou
   * branco (lava). */
  private meshFluidFace(
    buffers: MeshBuffers,
    faceIndex: number,
    x: number,
    y: number,
    z: number,
    entry: PaletteEntry,
    neighbor: PaletteEntry | null,
    flow: THREE.Vector3 | null,
    color: number,
    lightAt: (x: number, y: number, z: number) => number
  ) {
    const ownHeight = fluidHeight(entry.level);
    let low = 0;
    let high = ownHeight;
    const sameFluid =
      neighbor !== null && (neighbor.flags & VOXEL_FLAG_FLUID) !== 0 && neighbor.block === entry.block;
    if (sameFluid) {
      const neighborHeight = fluidHeight(neighbor!.level);
      if (neighborHeight >= ownHeight - 1e-4) return; // mesmo nível: face interna some
      low = neighborHeight;
    } else if (neighbor !== null && (neighbor.flags & VOXEL_FLAG_RENDER) !== 0) {
      if ((neighbor.flags & VOXEL_FLAG_OCCLUDES) !== 0) return;
    }

    const rotation = flow ? this.flowRotation(faceIndex, flow) : 0;
    const [r, g, b] = this.linearColor(color);
    this.pushQuadFlat(
      buffers,
      faceIndex,
      x,
      y,
      z,
      low,
      high,
      FLUID_ROTATED_UV[faceIndex][rotation],
      r,
      g,
      b,
      this.faceCornerBrightness(lightAt, faceIndex, x, y, z)
    );
  }

  /** Monta as malhas de um chunk (um mesh por bucket usado) e substitui as
   * antigas. Sem atlas carregado não faz nada até o atlas resolver (ou até o
   * modo degradado ligar) — `setAtlas`/`setAtlasUnavailable` remontam tudo.
   *
   * Roda dentro da fila orçada (`drainMeshQueue`), nunca direto no refresh:
   * é o trabalho pesado do viewer (varre 4096 blocos por seção) e montar
   * vários chunks no mesmo tick derrubava o fps. */
  private buildChunkMesh(chunk: DecodedChunk) {
    const key = this.chunkKey(chunk.x, chunk.z);
    this.disposeChunkMeshes(key);
    if (!this.atlasUvByName && !this.atlasUnavailable) return;

    const buckets = new Map<string, MeshBuffers>();
    const buffered = (bucket: string) => this.buffersFor(buckets, bucket);

    for (const section of chunk.sections.values()) {
      // Acesso local ao chunk/seção corrente: num chunk denso quase todas as
      // consultas de vizinho caem aqui (sem dois `Map.get` por face); só a
      // divisa de chunk cai no caminho global (`entryAt`).
      const sectionY = section.y;
      const sectionPalette = section.palette;
      const sectionIndices = section.indices;
      const blockAt = (x: number, y: number, z: number): PaletteEntry | null => {
        if ((x >> 4) === chunk.x && (z >> 4) === chunk.z) {
          if ((y >> 4) === sectionY) {
            return sectionPalette[sectionIndices[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]] ?? AIR;
          }
          const other = chunk.sections.get(y >> 4);
          if (!other) return AIR;
          return other.palette[other.indices[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]] ?? AIR;
        }
        return this.entryAt(x, y, z);
      };
      // Luz local: quase toda amostra do smooth lighting cai na seção
      // corrente, então evita o `Map.get` global na maioria dos casos.
      const lightAt = (x: number, y: number, z: number): number => {
        if ((x >> 4) === chunk.x && (z >> 4) === chunk.z) {
          const source = (y >> 4) === sectionY ? section : chunk.sections.get(y >> 4);
          if (source) return source.light[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
        }
        return this.lightAt(x, y, z);
      };

      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const entry = sectionPalette[sectionIndices[(ly << 8) | (lz << 4) | lx]];
            if (!entry || (entry.flags & VOXEL_FLAG_RENDER) === 0) continue;

            const x = chunk.x * 16 + lx;
            const y = sectionY * 16 + ly;
            const z = chunk.z * 16 + lz;
            // Coluna do chunk (ordem dos tints, `x + z*16`): de onde sai a cor
            // de bioma da grama/folhagem/água.
            const column = (lz << 4) | lx;
            const isFluid = (entry.flags & VOXEL_FLAG_FLUID) !== 0;
            const fluidBucket = isFluid ? `${entry.block}_${entry.level === 0 ? "still" : "flow"}` : "opaque";
            // Direção da correnteza só é calculada se alguma face de fluido
            // realmente precisar — evita varrer 4 vizinhos de água enterrada.
            let flow: THREE.Vector3 | null = null;
            let flowNeeded = isFluid && entry.level !== 0;

            for (let f = 0; f < 6; f++) {
              const face = FACES[f];
              const neighbor = blockAt(x + face.dir[0], y + face.dir[1], z + face.dir[2]);
              if (isFluid) {
                if (flowNeeded) {
                  flow = this.fluidFlowVector(x, y, z, entry);
                  flowNeeded = false;
                }
                const fluidColor = entry.block === "water" ? this.waterTintAt(column, chunk.tints) : 0xffffff;
                this.meshFluidFace(buffered(fluidBucket), f, x, y, z, entry, neighbor, flow, fluidColor, lightAt);
                continue;
              }
              // Sólido: face some se o vizinho é oclusor; oclusão entre
              // chunks ainda não carregados não conta — o vizinho é `null` e
              // a face fica desenhada até o chunk chegar (aí este chunk é
              // remontado).
              if (neighbor !== null && (neighbor.flags & VOXEL_FLAG_RENDER) !== 0) {
                if ((neighbor.flags & VOXEL_FLAG_OCCLUDES) !== 0) continue;
              }
              const render = this.faceRender(entry.block, f);
              if (!render) continue;
              // Sem textura real (bloco de mod, atlas degradado): cinza neutro
              // em vez da textura de outro bloco.
              const color = render.known
                ? this.faceTint(entry.block, face.kind, column, chunk.tints)
                : COLOR_UNKNOWN_BLOCK;
              const [r, g, b] = this.linearColor(color);
              const faceLight = this.faceCornerBrightness(lightAt, f, x, y, z);
              this.pushQuadFlat(buffered("opaque"), f, x, y, z, 0, 1, render.uv, r, g, b, faceLight);
              // Segunda camada do lado do grass_block no modelo vanilla:
              // cinza no arquivo, tingida com a cor de grama do bioma.
              if (entry.block === "grass_block" && face.kind === "side") {
                const overlay = this.grassOverlayRender(f);
                if (overlay) {
                  const [overlayR, overlayG, overlayB] = this.linearColor(
                    this.grassTintAt(column, chunk.tints)
                  );
                  this.pushQuadFlat(
                    buffered("opaque"),
                    f,
                    x,
                    y,
                    z,
                    0,
                    1,
                    overlay.uv,
                    overlayR,
                    overlayG,
                    overlayB,
                    faceLight,
                    GRASS_SIDE_OVERLAY_OFFSET
                  );
                }
              }
            }
          }
        }
      }
    }

    const meshes: THREE.Mesh[] = [];
    for (const [bucket, buffers] of buckets) {
      if (buffers.indices.length === 0) continue;
      const material = this.bucketMaterials.get(bucket);
      if (!material) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(buffers.normals, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uvs, 2));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(buffers.colors, 3));
      geometry.setIndex(buffers.indices);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = true;
      // Malha estática: nunca se move depois de criada, então não precisa
      // recalcular a matriz por frame (são centenas de meshes no mundo).
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.chunkMeshes.set(key, meshes);
  }

  /** Monta no máximo `meshBudgetMs` de malhas por frame. Um backfill (ou o
   * mundo persistido abrindo) enfileira centenas de chunks de uma vez;
   * montar tudo num tick só derrubava o fps, então a fila anda em pedaços —
   * o resto aparece nos frames seguintes, começando pelos mais próximos do
   * bot (a fila é alimentada na ordem que o backend manda, já por
   * distância). */
  private drainMeshQueue() {
    if (this.meshQueue.length === 0) return;
    const start = performance.now();
    do {
      const key = this.meshQueue.shift()!;
      this.queuedChunks.delete(key);
      const chunk = this.chunks.get(key);
      if (chunk && this.atlasUvByName) this.buildChunkMesh(chunk);
    } while (this.meshQueue.length > 0 && performance.now() - start < this.meshBudgetMs);
  }

  private disposeChunkMeshes(key: number) {
    const meshes = this.chunkMeshes.get(key);
    if (!meshes) return;
    for (const mesh of meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.delete(key);
  }

  /** Chamado quando o atlas termina de carregar (as UVs/materiais dependem
   * dele) — enfileira todos os chunks já recebidos pra remontagem orçada, em
   * vez de montar centenas de uma vez travando o primeiro frame. */
  private rebuildAllMeshes() {
    for (const key of this.chunks.keys()) this.enqueueMesh(key);
  }

  /** Recebe a pose real do jogador (comando `bot_pose`) e usa como alvo: o
   * modelo anda até ela a cada frame (a pose chega 4x/s e sem isso ele
   * piscaria de posição em posição), e a câmera segue pelo mesmo delta —
   * preservando o ângulo/distância que o usuário escolheu orbitando.
   * Teleporte (reconexão, `/tp`) encaixa direto, sem atravessar o mapa. */
  setBotPose(pose: BotPose | null) {
    if (!pose) {
      this.targetBotPos = null;
      this.followSpeed = 0;
      this.lastPoseAtMs = 0;
      this.botMarker.visible = false;
      this.labelEl.style.display = "none";
      this.playerModel.resetWalk();
      return;
    }

    this.botYaw = pose.yaw;
    this.botPitch = pose.pitch;
    const target = new THREE.Vector3(pose.x, pose.y, pose.z);

    if (!this.targetBotPos) {
      // Primeira posição conhecida: enquadra direto, não tem de onde vir o delta.
      this.botMarker.position.copy(target);
      this.controls.target.set(pose.x, pose.y + BOT_CAMERA_HEIGHT, pose.z);
      this.camera.position.set(pose.x + 40, pose.y + 45, pose.z + 40);
      this.playerModel.resetWalk();
    } else if (target.distanceTo(this.botMarker.position) > BOT_TELEPORT_DISTANCE) {
      const delta = target.clone().sub(this.botMarker.position);
      this.botMarker.position.copy(target);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.playerModel.resetWalk();
    }

    // Velocidade constante pra cobrir a distância no intervalo real entre
    // poses: o boneco anda no ritmo do bot e chega exato antes da próxima.
    // Sem isso (regime exponencial antigo) o follow nunca fechava a conta e
    // continuava deslizando por cima do alvo depois que o bot parava.
    const now = performance.now();
    const interval =
      this.lastPoseAtMs > 0
        ? Math.max((now - this.lastPoseAtMs) / 1000, 0.05)
        : BOT_FOLLOW_INTERVAL_FALLBACK;
    this.lastPoseAtMs = now;
    this.followSpeed = Math.min(target.distanceTo(this.botMarker.position) / interval, BOT_FOLLOW_MAX_SPEED);

    this.targetBotPos = target;
    this.botMarker.visible = true;
    this.labelEl.textContent = `${pose.x}, ${pose.y}, ${pose.z}`;
  }

  /** Skin real do jogador (comando `player_skin`) — o modelo só reaplica
   * quando ela muda de verdade, então dá pra chamar a cada polling. */
  setPlayerSkin(skin: PlayerSkinInput | null) {
    this.playerModel.setSkin(skin);
  }

  /** Recebe o snapshot dos mobs vivos ao redor (comando `nearby_mobs`) e
   * mantém um rótulo por mob — nome, categoria (hostil em vermelho), distância
   * e vida. A lista é o estado atual, não um delta: mob que saiu do raio tem o
   * rótulo removido aqui. É o que "identifica" o mob: o viewer ainda não
   * desenha os modelos reais de entidade (ver "Known gaps"), então o marcador
   * é a informação honesta que temos — nome, tipo e vida vêm do jogo. */
  setNearbyMobs(mobs: NearbyMob[]) {
    const seen = new Set<number>();
    for (const mob of mobs) {
      seen.add(mob.id);
      let marker = this.mobMarkers.get(mob.id);
      if (!marker) {
        const el = document.createElement("div");
        const nameEl = document.createElement("span");
        nameEl.className = "mob-name";
        const metaEl = document.createElement("span");
        metaEl.className = "mob-meta mono";
        el.append(nameEl, metaEl);
        this.mobLayer.appendChild(el);
        const position = new THREE.Vector3(mob.x, mob.y, mob.z);
        marker = { el, nameEl, metaEl, mob, target: position.clone(), position };
        this.mobMarkers.set(mob.id, marker);
      }
      marker.mob = mob;
      marker.target.set(mob.x, mob.y, mob.z);
      // A classe carrega a categoria (hostil = perigo no CSS); reaplicar
      // inteira mantém a cor certa mesmo se o mob mudar de categoria.
      marker.el.className = `mob-label mob-${mob.category}`;
      // Nome do jogo (pode ter nome customizado de name tag): textContent,
      // nunca innerHTML.
      marker.nameEl.textContent = mob.name;
      marker.metaEl.textContent = `${mob.distance.toFixed(0)} m · ${Math.round(mob.health)}/${Math.round(
        mob.max_health
      )}`;
    }
    for (const [id, marker] of this.mobMarkers) {
      if (seen.has(id)) continue;
      marker.el.remove();
      this.mobMarkers.delete(id);
    }
  }

  /** Interpola a posição desenhada dos mobs até o alvo do último snapshot —
   * mesma ideia do `updateBotMarker`, numa cadência mais lenta (mob anda
   * menos que o bot correndo) e com encaixe direto em salto grande. */
  private updateMobs(dt: number) {
    if (this.mobMarkers.size === 0) return;
    const step = 1 - Math.exp(-MOB_FOLLOW_RATE * dt);
    for (const marker of this.mobMarkers.values()) {
      if (marker.position.distanceTo(marker.target) > MOB_TELEPORT_DISTANCE) {
        marker.position.copy(marker.target);
        continue;
      }
      marker.position.lerp(marker.target, step);
    }
  }

  /** Projeta cada rótulo de mob na tela, acima da hitbox dele (galinha e
   * enderman não têm a mesma altura) — mesmo padrão do rótulo do bot, um por
   * mob. Atrás da câmera, some. */
  private updateMobLabels() {
    if (this.mobMarkers.size === 0) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    for (const marker of this.mobMarkers.values()) {
      const vector = this.mobScratch
        .copy(marker.position)
        .setY(marker.position.y + marker.mob.height + MOB_LABEL_GAP)
        .project(this.camera);
      if (vector.z > 1) {
        marker.el.style.display = "none";
        continue;
      }
      marker.el.style.display = "flex";
      marker.el.style.left = `${(vector.x * 0.5 + 0.5) * width}px`;
      marker.el.style.top = `${(-vector.y * 0.5 + 0.5) * height}px`;
    }
  }

  /** Move o modelo (em velocidade constante até o alvo) e a câmera pelo mesmo
   * passo. Quando o resto cabe no passo do frame, `step` já é o resto exato —
   * o boneco chega e para junto com o bot, sem sobra pra deslizar depois. */
  private updateBotMarker(dt: number) {
    if (!this.targetBotPos) return;

    const step = this.targetBotPos.clone().sub(this.botMarker.position);
    const distance = step.length();
    const maxStep = this.followSpeed * dt;
    if (distance > maxStep) step.multiplyScalar(maxStep / distance);
    this.botMarker.position.add(step);
    this.camera.position.add(step);
    this.controls.target.add(step);

    this.playerModel.update(dt, this.botMarker.position, this.botYaw, this.botPitch);
  }

  /** Reenquadra o bot (tecla F): desloca câmera e alvo pelo mesmo delta, ou
   * seja, mantém o ângulo/distância que o usuário escolheu e só recentra a
   * órbita no jogador — útil quando ele andou pra longe da câmera. */
  private focusBot() {
    if (!this.botMarker.visible) return;
    const target = this.botMarker.position.clone().setY(this.botMarker.position.y + BOT_CAMERA_HEIGHT);
    const delta = target.clone().sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.copy(target);
  }

  /** A view do viewer fica `display:none` nos outros modos do rail; nesse
   * caso o container tem 0px e as teclas devem continuar sendo do app (não
   * voar uma câmera invisível). */
  private isViewerVisible(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private handlePointerUp = (event: PointerEvent) => {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > CLICK_MAX_MOVE_PX || performance.now() - down.time > CLICK_MAX_MS) return;
    // Com uma ferramenta do editor ativa o clique é edição; o alvo da fila
    // fica de fora (nada de mirar instrução sem querer enquanto se pinta).
    if (this.editMode) {
      const hit = this.pickBlock(event.clientX, event.clientY);
      if (hit) this.applyToolAt(hit);
      return;
    }
    this.pickTargetAt(event.clientX, event.clientY);
  };

  /** Raycast do clique contra as malhas dos chunks. A geometria é composta de
   * quads em coordenadas de mundo, então recuar meio bloco contra a normal
   * (`-0.5 × normal`) cai dentro do bloco clicado — serve tanto pra face de
   * topo quanto pra lateral (e a face rebaixada de fluido, que fica abaixo de
   * y+1). Clicar no céu limpa o alvo. */
  private pickTargetAt(clientX: number, clientY: number) {
    if (!this.isViewerVisible()) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    const meshes: THREE.Object3D[] = [];
    for (const list of this.chunkMeshes.values()) meshes.push(...list);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || !hit.face) {
      this.setTarget(null);
      return;
    }
    const inside = hit.point.clone().addScaledVector(hit.face.normal, -0.5);
    this.setTarget({ x: Math.floor(inside.x), y: Math.floor(inside.y), z: Math.floor(inside.z) });
  }

  /** Define (ou limpa, com `null`) o alvo do clique — movimento do marcador,
   * popup de ações e coordenadas. Público porque o `main.ts` limpa o alvo
   * depois de enfileirar a instrução. */
  setTarget(pos: { x: number; y: number; z: number } | null) {
    this.targetBlock = pos;
    if (!pos) {
      this.targetMarker.visible = false;
      this.targetEl.style.display = "none";
      return;
    }
    this.targetMarker.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
    this.targetMarker.visible = true;
    this.targetEl.style.display = "flex";
    const coords = this.targetEl.querySelector<HTMLElement>(".target-coords");
    if (coords) coords.textContent = `${pos.x}, ${pos.y}, ${pos.z}`;
  }

  getTarget(): { x: number; y: number; z: number } | null {
    return this.targetBlock;
  }

  /** Reflete a fila real no mundo: cada instrução com alvo (`Queued`/`Active`)
   * vira uma caixa de arame na superfície do bloco apontado — âmbar enquanto
   * espera, teal enquanto o bot executa (mesma semântica de cor do app). Alvo
   * fora do que já foi carregado no cache não desenha nada: melhor nada do que
   * chutar uma altura. */
  setInstructionTargets(items: { id: string; active: boolean; x: number; z: number }[]) {
    const seen = new Set<string>();
    for (const item of items) {
      const y = this.surfaceYAt(item.x, item.z);
      if (y === null) continue;
      seen.add(item.id);
      let mesh = this.instructionMarkers.get(item.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.ghostGeometry, this.ghostQueuedMaterial);
        this.scene.add(mesh);
        this.instructionMarkers.set(item.id, mesh);
      }
      mesh.material = item.active ? this.ghostActiveMaterial : this.ghostQueuedMaterial;
      mesh.position.set(item.x + 0.5, y + 0.5, item.z + 0.5);
    }
    for (const [id, mesh] of this.instructionMarkers) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      this.instructionMarkers.delete(id);
    }
  }

  /** Primeiro bloco desenhável descendo a coluna — mesma varredura que o
   * addon fazia por coluna, agora em cima do cache de voxels já recebido. */
  private surfaceYAt(x: number, z: number): number | null {
    for (let y = 319; y >= -64; y--) {
      const entry = this.entryAt(x, y, z);
      if (entry && (entry.flags & VOXEL_FLAG_RENDER) !== 0) return y;
    }
    return null;
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    // Nunca roubar teclas de quem está digitando num campo de texto (não
    // existe campo no viewer hoje, mas o app tem modal/prompt planejados).
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    // Ctrl/Cmd+F etc. continuam sendo atalhos da janela, não da câmera.
    if (event.ctrlKey || event.metaKey || !this.isViewerVisible()) return;

    if (event.code === "Escape") {
      this.setTarget(null);
      return;
    }

    this.turboKey = event.shiftKey;
    this.preciseKey = event.altKey;

    if (event.code === "KeyF") {
      event.preventDefault();
      this.focusBot();
      return;
    }
    if (!MOVE_KEYS.has(event.code)) return;
    event.preventDefault(); // Espaço/setas não devem rolar a página
    this.keysDown.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    // Sempre limpa, mesmo com a view escondida — senão uma tecla solta
    // enquanto outro modo está ativo ficaria "presa" pra sempre.
    this.turboKey = event.shiftKey;
    this.preciseKey = event.altKey;
    this.keysDown.delete(event.code);
  };

  /** Perder o foco da janela com uma tecla pressionada dispara `keyup` em
   * lugar nenhum; sem isso a câmera voaria sozinha até voltar o foco. */
  private clearKeys = () => {
    this.keysDown.clear();
    this.turboKey = false;
    this.preciseKey = false;
  };

  /** Voar pela cena com WASD/setas (relativo à direção horizontal da câmera),
   * Q/E (ou Espaço) pra descer/subir, Shift pra acelerar e Alt pra precisão.
   * Move câmera e alvo juntos: a órbita continua válida (mesmo ângulo e
   * distância) e a perseguição do bot em `setBotPos` segue valendo.
   *
   * A velocidade escala com a distância câmera→alvo — com o zoom livre, uma
   * velocidade fixa fica lenta demais com a câmera afastada e rápida demais
   * de perto. */
  private applyMovement(dt: number) {
    if (this.keysDown.size === 0 || dt <= 0) return;

    const distance = this.camera.position.distanceTo(this.controls.target);
    let speed = MOVE_BASE_SPEED * Math.max(1, distance / MOVE_REF_DISTANCE);
    if (this.turboKey) speed *= MOVE_TURBO;
    else if (this.preciseKey) speed *= MOVE_PRECISE;
    speed = Math.min(speed, MOVE_MAX_SPEED);

    this.camera.getWorldDirection(this.moveForward);
    this.moveForward.y = 0;
    if (this.moveForward.lengthSq() < 0.01) {
      // Câmera quase na vertical (olhando reto pra baixo/cima): a projeção
      // "para frente" degenera e fica instável. Usa o "para cima da tela" —
      // o +Y local da câmera, que deitado no chão aponta pra longe de quem
      // olha. O código antigo usava o -Y (o "para baixo" da tela), e era
      // exatamente isso que invertia o W/S quando se olhava pra baixo. O
      // fallback final só cobre a câmera cravada na vertical, caso em que o
      // +Y também degenera.
      this.moveForward.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.moveForward.y = 0;
      if (this.moveForward.lengthSq() < 1e-6) this.moveForward.set(0, 0, -1);
    }
    this.moveForward.normalize();
    // right = (-fz, 0, fx) — o eixo +X da câmera projetado no chão.
    this.moveRight.set(-this.moveForward.z, 0, this.moveForward.x);

    const move = this.moveDelta.set(0, 0, 0);
    if (this.keysDown.has("KeyW") || this.keysDown.has("ArrowUp")) move.add(this.moveForward);
    if (this.keysDown.has("KeyS") || this.keysDown.has("ArrowDown")) move.sub(this.moveForward);
    if (this.keysDown.has("KeyD") || this.keysDown.has("ArrowRight")) move.add(this.moveRight);
    if (this.keysDown.has("KeyA") || this.keysDown.has("ArrowLeft")) move.sub(this.moveRight);
    if (this.keysDown.has("KeyE") || this.keysDown.has("Space")) move.y += 1;
    if (this.keysDown.has("KeyQ")) move.y -= 1;

    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed * dt);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  /** O domo é centrado na câmera (não no alvo): o horizonte do gradiente fica
   * sempre na linha do olhar, e o domo nunca "fica pra trás" quando a câmera
   * se afasta do bot. */
  /** Hora real do mundo (ticks 0..23999) reportada pelo addon — ver
   * `main.ts`/`addon_socket.rs`. `null` (sem jogo) **não** zera a hora local:
   * a cena congela na última hora real, em vez de inventar um ciclo; sem
   * nenhuma mensagem ainda, vale o meio-dia fixo (`DEFAULT_DAY_TIME`). */
  setWorldTime(dayTime: number | null) {
    if (dayTime === null) {
      this.worldTimeLive = false;
      return;
    }
    this.worldTime = ((dayTime % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
    this.worldTimeLive = true;
  }

  /** Move sol, lua, luz ambiente e o gradiente do céu conforme a hora do
   * mundo. Com `worldTimeLive`, roda a cada frame (a hora local avança em
   * `animate`); sem jogo, aplica a hora congelada uma vez e para. */
  private updateDayNight(now: number) {
    if (!this.worldTimeLive && this.lastSkyPaintMs !== -Infinity) return;

    const time = this.worldTime ?? DEFAULT_DAY_TIME;
    const phase = (time / TICKS_PER_DAY) * Math.PI * 2;
    const elevation = Math.sin(phase); // -1 = meia-noite, +1 = meio-dia
    const daylight = smoothstep(-0.12, 0.28, elevation);
    this.daylightFactor = daylight; // as nuvens escurecem junto (updateClouds)

    // A luz de céu assada acompanha o dia — sem isso o terreno ficaria claro
    // de noite. O piso é o luar do jogo; a remontagem é orçada
    // (`rebuildAllMeshes` só enfileira) e acontece em saltos grandes, não a
    // cada frame.
    const skyFactor = Math.max(SKY_LIGHT_NIGHT_FLOOR, daylight);
    if (Math.abs(skyFactor - this.bakedSkyFactor) >= 0.2) {
      this.bakedSkyFactor = skyFactor;
      this.rebuildAllMeshes();
    }

    // Sol nasce no leste (+X) e se põe no oeste, como no jogo.
    this.sunLight.position.set(
      Math.cos(phase) * SUN_DISTANCE,
      elevation * SUN_DISTANCE,
      SUN_DISTANCE * 0.25
    );
    this.sunLight.intensity = 0.5 * daylight;
    this.sunLight.color.copy(SUN_COLOR_LOW_C).lerp(SUN_COLOR_HIGH_C, daylight);

    // Lua fica do lado oposto e só rende à noite.
    this.moonLight.position.set(
      -Math.cos(phase) * SUN_DISTANCE,
      -elevation * SUN_DISTANCE,
      -SUN_DISTANCE * 0.25
    );
    this.moonLight.intensity = MOON_INTENSITY * (1 - daylight);

    this.ambientLight.intensity = AMBIENT_NIGHT + (AMBIENT_DAY - AMBIENT_NIGHT) * daylight;
    this.ambientLight.color.copy(AMBIENT_NIGHT_COLOR).lerp(AMBIENT_DAY_COLOR, daylight);

    if (now - this.lastSkyPaintMs < SKY_REPAINT_MS) return;
    this.lastSkyPaintMs = now;
    // Nascer/pôr do sol deixa o horizonte quente — pico quando o sol raspa o
    // horizonte (elevação perto de zero).
    const twilight = Math.max(0, 1 - Math.abs(elevation) / 0.3);
    const zenith = this.dayNightA.copy(SKY_NIGHT_ZENITH).lerp(SKY_DAY_ZENITH, daylight);
    const mid = this.dayNightB.copy(SKY_NIGHT_MID).lerp(SKY_DAY_MID, daylight);
    const horizon = this.dayNightC
      .copy(SKY_NIGHT_HORIZON)
      .lerp(SKY_DAY_HORIZON, daylight)
      .lerp(SKY_TWILIGHT_COLOR, twilight * 0.65);
    this.paintSky(zenith, mid, horizon);
    this.fog.color.copy(horizon);
    this.renderer.setClearColor(horizon, 1);
  }

  private updateSky() {
    this.sky.position.copy(this.camera.position);
  }

  /** O fog acompanha a distância câmera→alvo: mantém o gradiente de
   * profundidade no enquadramento normal, mas não deixa o terreno distante
   * "sumir" no fundo quando o usuário afasta o zoom (visão de mundo). O piso
   * das duas pontas é a preferência da aba Config (`fogFar`). */
  private updateFog() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.fog.near = Math.max(this.fogFar * FOG_NEAR_RATIO, distance * 0.85);
    this.fog.far = Math.max(this.fogFar, distance * 3);
  }

  /** Troca o frame das texturas animadas de fluido (água/lava). */
  private updateAnimation(now: number) {
    if (this.animatedMaterials.length === 0) return;
    if (now - this.lastAnimationMs < FLUID_FRAME_MS) return;
    this.lastAnimationMs = now;
    this.animationFrame++;
    for (const { material, frames } of this.animatedMaterials) {
      const frame = frames[this.animationFrame % frames.length];
      // Trocar entre mapas não-nulos não recompila shader — só atualiza a
      // textura usada.
      if (material.map !== frame) material.map = frame;
    }
  }

  // ---- Editor de schematic (ver `docs/SPEC.md`, "Como isso vira o editor
  // estilo WorldEdit") ----------------------------------------------------

  private editKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** Ferramenta ativa — `null` deixa o clique só orbitando (viewer puro). */
  setEditMode(mode: EditMode | null) {
    this.editMode = mode;
    if (!mode) {
      this.hovered = null;
      this.hoverHelper.visible = false;
    }
    this.onEditChange?.();
  }

  getEditMode(): EditMode | null {
    return this.editMode;
  }

  setPlaceBlock(block: string | null) {
    this.placeBlock = block;
    this.onEditChange?.();
  }

  getPlaceBlock(): string | null {
    return this.placeBlock;
  }

  /** Blocos que a paleta oferece: derivados dos nomes de textura do atlas
   * (`_top`/`_side`/`_bottom`/frames viram o nome base). Aproximação honesta
   * enquanto não existe o registro de blocos do `minecraft-data`: a paleta
   * lista o que temos textura real pra desenhar. */
  getEditableBlocks(): string[] {
    const atlas = this.atlasUvByName;
    if (!atlas) return [];
    const blocks = new Set<string>();
    for (const name of Object.keys(atlas)) {
      if (/_f\d+$/.test(name)) continue;
      if (/^destroy_stage|^debug/.test(name)) continue; // não são blocos colocáveis
      // Tira sufixos em cadeia: `grass_block_side_overlay` -> `grass_block`.
      let base = name;
      for (;;) {
        const next = base.replace(/_(top|side|bottom|overlay|still|flow)$/, "");
        if (next === base) break;
        base = next;
      }
      blocks.add(base);
    }
    // Fluidos ficam fora da paleta: o editor quebra/coloca bloco sólido, e
    // fluido tem nível/regras próprias (ver "Known gaps").
    for (const skip of ["air", "water", "lava", "fire", "soul_fire"]) blocks.delete(skip);
    return Array.from(blocks).sort();
  }

  /** Ícone 32×32 (data URL) do tile de topo do bloco — a paleta é visual, com
   * a textura real, não uma lista de texto (como o spec pede). */
  blockIconDataUrl(block: string): string | null {
    const cached = this.iconCache.get(block);
    if (cached) return cached;
    const face = this.faceRect(block, "top");
    // `known: false` = caiu no tile sintético (textura faltando no atlas) — a
    // paleta mostra o nome sem ícone em vez de fingir uma textura.
    if (!face || !face.known || !this.atlasImage) return null;
    const rect = face.rect;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.atlasImage,
      rect.u0 * this.atlasImage.width,
      rect.v0 * this.atlasImage.height,
      (rect.u1 - rect.u0) * this.atlasImage.width,
      (rect.v1 - rect.v0) * this.atlasImage.height,
      0,
      0,
      32,
      32
    );
    const url = canvas.toDataURL();
    this.iconCache.set(block, url);
    return url;
  }

  getEditStats(): { total: number; breaks: number; builds: number } {
    let breaks = 0;
    for (const edit of this.edits.values()) {
      if (edit.block === null) breaks++;
    }
    return { total: this.edits.size, breaks, builds: this.edits.size - breaks };
  }

  getEdits(): BlockEdit[] {
    return Array.from(this.edits.values());
  }

  clearEdits() {
    if (this.edits.size === 0) return;
    this.edits.clear();
    this.rebuildGhosts();
    this.onEditChange?.();
  }

  clearSelection() {
    if (!this.selectionA && !this.selectionB) return;
    this.selectionA = null;
    this.selectionB = null;
    this.refreshSelectionHelper();
    this.onEditChange?.();
  }

  /** Região selecionada normalizada (min/max) — `null` se ainda não fechou. */
  getSelection(): { min: BlockPos; max: BlockPos } | null {
    if (!this.selectionA || !this.selectionB) return null;
    const a = this.selectionA;
    const b = this.selectionB;
    return {
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
      max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
    };
  }

  /** Move o canvas (e o contexto WebGL) pra outro host — o editor usa o mesmo
   * renderer do viewer, como o spec descreve ("mesmo motor de render"), sem
   * abrir um segundo contexto WebGL. O `container` acompanha: é dele que saem
   * as dimensões de `resize()` e o teste de "view visível" do teclado. */
  mountTo(host: HTMLElement) {
    if (this.renderer.domElement.parentElement === host) return;
    host.appendChild(this.renderer.domElement);
    this.container = host;
    this.resize();
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.editMode) return;
    this.hovered = this.pickBlock(event.clientX, event.clientY);
    this.refreshHoverHelper();
  };

  private refreshHoverHelper() {
    const hit = this.hovered;
    if (!hit || !this.editMode) {
      this.hoverHelper.visible = false;
      return;
    }
    // Em "colocar" o cursor mostra onde o bloco vai encostar (face clicada);
    // nas outras ferramentas, o próprio bloco atingido.
    const target =
      this.editMode === "place"
        ? {
            x: hit.pos.x + hit.normal[0],
            y: hit.pos.y + hit.normal[1],
            z: hit.pos.z + hit.normal[2],
          }
        : hit.pos;
    this.hoverHelper.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    this.hoverHelper.visible = true;
  }

  /** Bloco sob o cursor via DDA em voxels (Amanatides & Woo) sobre os chunks
   * decodificados — as malhas são fundidas por chunk, então não dá pra mapear
   * um `Raycaster` de volta pra um bloco. `null` = nada desenhável no caminho
   * (ou chunk desconhecido, onde não dá pra saber o que tem). */
  pickBlock(clientX: number, clientY: number): PickedBlock | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const origin = this.camera.position;
    const direction = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera).sub(origin);
    if (direction.lengthSq() === 0) return null;
    direction.normalize();

    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);
    const stepX = Math.sign(direction.x);
    const stepY = Math.sign(direction.y);
    const stepZ = Math.sign(direction.z);
    const deltaX = stepX !== 0 ? Math.abs(1 / direction.x) : Infinity;
    const deltaY = stepY !== 0 ? Math.abs(1 / direction.y) : Infinity;
    const deltaZ = stepZ !== 0 ? Math.abs(1 / direction.z) : Infinity;
    let maxX = stepX > 0 ? (x + 1 - origin.x) * deltaX : stepX < 0 ? (origin.x - x) * deltaX : Infinity;
    let maxY = stepY > 0 ? (y + 1 - origin.y) * deltaY : stepY < 0 ? (origin.y - y) * deltaY : Infinity;
    let maxZ = stepZ > 0 ? (z + 1 - origin.z) * deltaZ : stepZ < 0 ? (origin.z - z) * deltaZ : Infinity;

    let normal: [number, number, number] = [0, 0, 0];
    // 512 passos cobre o alcance prático da câmera (mesmo com o zoom livre);
    // depois disso o raio já se perdeu no vazio.
    for (let step = 0; step < 512; step++) {
      const entry = this.entryAt(x, y, z);
      if (entry === null) return null; // chunk desconhecido
      if ((entry.flags & VOXEL_FLAG_RENDER) !== 0) {
        return { pos: { x, y, z }, normal };
      }
      if (maxX < maxY && maxX < maxZ) {
        x += stepX;
        maxX += deltaX;
        normal = [-stepX, 0, 0];
      } else if (maxY < maxZ) {
        y += stepY;
        maxY += deltaY;
        normal = [0, -stepY, 0];
      } else {
        z += stepZ;
        maxZ += deltaZ;
        normal = [0, 0, -stepZ];
      }
    }
    return null;
  }

  private applyToolAt(hit: PickedBlock) {
    if (!this.editMode) return;

    if (this.editMode === "select") {
      // Dois cliques, como o WorldEdit: o primeiro marca o canto A, o segundo
      // fecha a região (um terceiro começa outra).
      if (!this.selectionA || this.selectionB) {
        this.selectionA = hit.pos;
        this.selectionB = null;
      } else {
        this.selectionB = hit.pos;
      }
      this.refreshSelectionHelper();
      this.onEditChange?.();
      return;
    }

    const breaking = this.editMode === "break";
    const block = breaking ? null : this.placeBlock;
    if (!breaking && !block) {
      this.onNotice?.("Escolha um bloco na paleta antes de colocar.");
      return;
    }

    const region = this.getSelection();
    if (region) {
      this.applyToRegion(region, block);
    } else {
      if (breaking) {
        // Água/lava não se "quebra" (nem no jogo) — o editor trabalha com
        // bloco sólido, ver "Known gaps".
        const entry = this.entryAt(hit.pos.x, hit.pos.y, hit.pos.z);
        if (!entry || (entry.flags & VOXEL_FLAG_FLUID) !== 0) return;
      }
      const pos = breaking
        ? hit.pos
        : {
            x: hit.pos.x + hit.normal[0],
            y: hit.pos.y + hit.normal[1],
            z: hit.pos.z + hit.normal[2],
          };
      this.setEdit(pos.x, pos.y, pos.z, block);
    }
    this.rebuildGhosts();
    this.onEditChange?.();
  }

  /** Pinta a região inteira com uma edição — o `//set` do WorldEdit: quebrar
   * tudo que existe ou colocar/substituir pelo bloco escolhido. Volume grande
   * demais é recusado com aviso em vez de travar a UI. */
  private applyToRegion(region: { min: BlockPos; max: BlockPos }, block: string | null) {
    const volume =
      (region.max.x - region.min.x + 1) *
      (region.max.y - region.min.y + 1) *
      (region.max.z - region.min.z + 1);
    if (volume > MAX_EDIT_VOLUME) {
      this.onNotice?.(`Seleção grande demais (${volume} blocos; o teto é ${MAX_EDIT_VOLUME}).`);
      return;
    }
    for (let y = region.min.y; y <= region.max.y; y++) {
      for (let z = region.min.z; z <= region.max.z; z++) {
        for (let x = region.min.x; x <= region.max.x; x++) {
          if (block === null) {
            // Quebrar só o que existe e é sólido; ar e fluido ficam de fora (o
            // editor trabalha com bloco sólido — ver "Known gaps").
            const entry = this.entryAt(x, y, z);
            if (entry === null) continue;
            if ((entry.flags & VOXEL_FLAG_RENDER) === 0) continue;
            if ((entry.flags & VOXEL_FLAG_FLUID) !== 0) continue;
          }
          this.setEdit(x, y, z, block);
        }
      }
    }
  }

  private setEdit(x: number, y: number, z: number, block: string | null) {
    if (this.entryAt(x, y, z) === null) return; // chunk desconhecido: não pinta
    this.edits.set(this.editKey(x, y, z), { x, y, z, block });
  }

  /** Reconstrói a camada ghost (âmbar translúcido), separada do mundo real —
   * é o que dá pra distinguir "o que existe" de "o que foi desenhado" sem
   * construir nada. Cada (bloco, quebrar|colocar) vira um `InstancedMesh`. */
  private rebuildGhosts() {
    for (const mesh of this.ghostMeshes.values()) {
      this.ghostGroup.remove(mesh);
      mesh.geometry.dispose(); // geometria própria (UVs do tile), não a compartilhada
      (mesh.material as THREE.Material).dispose();
    }
    this.ghostMeshes.clear();
    if (!this.atlasTexture) return;

    const groups = new Map<string, { block: string; breaking: boolean; positions: BlockPos[] }>();
    for (const edit of this.edits.values()) {
      const breaking = edit.block === null;
      const block = breaking ? (this.entryAt(edit.x, edit.y, edit.z)?.block ?? null) : edit.block;
      if (!block) continue;
      const key = `${breaking ? "break" : "build"}|${block}`;
      let group = groups.get(key);
      if (!group) {
        group = { block, breaking, positions: [] };
        groups.set(key, group);
      }
      group.positions.push({ x: edit.x, y: edit.y, z: edit.z });
    }

    for (const [key, group] of groups) {
      const geometry = this.buildGhostGeometry(group.block);
      if (!geometry) continue;
      const mesh = new THREE.InstancedMesh(geometry, this.ghostMaterial(group.breaking), group.positions.length);
      mesh.count = group.positions.length;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      group.positions.forEach((pos, index) => {
        this.scratchMatrix.makeTranslation(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
        mesh.setMatrixAt(index, this.scratchMatrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.ghostGroup.add(mesh);
      this.ghostMeshes.set(key, mesh);
    }
  }

  /** Cubo com UVs apontando pro tile do bloco no atlas (topo em todas as
   * faces — o ghost é aproximação, não o modelo real). */
  private buildGhostGeometry(block: string): THREE.BufferGeometry | null {
    const face = this.faceRect(block, "top");
    if (!face) return null;
    const rect = face.rect;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = 1 - uv.getY(i); // atlas usa v=0 no topo (flipY=false)
      uv.setXY(i, rect.u0 + u * (rect.u1 - rect.u0), rect.v0 + v * (rect.v1 - rect.v0));
    }
    uv.needsUpdate = true;
    return geometry;
  }

  private ghostMaterial(breaking: boolean): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      map: this.atlasTexture,
      color: COLOR_AMBER,
      transparent: true,
      // Quebrar é a marca mais fraca (o bloco ainda existe, só vai sair);
      // colocar é o que vai aparecer de verdade.
      opacity: breaking ? 0.32 : 0.55,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      emissive: COLOR_AMBER,
      emissiveIntensity: breaking ? 0.25 : 0.1,
    });
  }

  private refreshSelectionHelper() {
    const region = this.getSelection();
    if (!region) {
      this.selectionHelper.visible = false;
      return;
    }
    const sizeX = region.max.x - region.min.x + 1;
    const sizeY = region.max.y - region.min.y + 1;
    const sizeZ = region.max.z - region.min.z + 1;
    this.selectionHelper.scale.set(sizeX, sizeY, sizeZ);
    this.selectionHelper.position.set(
      region.min.x + sizeX / 2,
      region.min.y + sizeY / 2,
      region.min.z + sizeZ / 2
    );
    this.selectionHelper.visible = true;
  }

  /** Sem chunks nem bot ainda — estado honesto, não mostra uma cena vazia
   * como se fosse "carregada". Chamado quando o addon desconecta. */
  clear() {
    for (const key of Array.from(this.chunkMeshes.keys())) this.disposeChunkMeshes(key);
    this.chunks.clear();
    this.meshQueue = [];
    this.queuedChunks.clear();
    this.botMarker.visible = false;
    this.labelEl.style.display = "none";
    // Mobs são do mundo daquela conexão — sem addon online o snapshot deixa
    // de existir no Rust e os rótulos não podem ficar congelados no mapa.
    for (const marker of this.mobMarkers.values()) marker.el.remove();
    this.mobMarkers.clear();
    this.clearEdits();
    this.clearSelection();
    this.targetBotPos = null;
    this.followSpeed = 0;
    this.lastPoseAtMs = 0;
    this.playerModel.resetWalk();
    this.setTarget(null);
    for (const [id, mesh] of this.instructionMarkers) {
      this.scene.remove(mesh);
      this.instructionMarkers.delete(id);
    }
    // Uma nova conexão tenta o atlas de novo (ex: a versão do jogo foi
    // instalada nesse meio tempo) — a falha anterior não é definitiva.
    this.atlasUnavailable = false;
  }

  /** Aplica as preferências da aba Config (`settings_get`): fog, orçamento de
   * malha por frame, teto de pixel ratio e teto de FPS. Os valores já chegam
   * presos na faixa pelo backend (`settings.rs`) — aqui é só aplicar no
   * renderer. */
  applySettings(settings: ViewerSettings) {
    this.fogFar = settings.fogFar;
    this.meshBudgetMs = settings.meshBudgetMs;
    this.maxPixelRatio = settings.maxPixelRatio;
    this.fpsCap = settings.fpsCap;
    this.updateFog();
    this.resize(); // o teto de pixel ratio mudou
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    // Se o container ainda não tem layout pronto (0px — ex: chamado antes
    // do primeiro paint, ou enquanto a view está `display:none`), não faz
    // nada. Um resize de verdade acontece depois (troca de modo, resize da
    // janela) — melhor que forçar aspect ratio 1:1/degenerado nesse meio
    // tempo.
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // `false` = não escreve width/height inline no style do canvas. Isso é
    // do CSS (`.viewer-3d canvas { width: 100%; height: 100% }`) — se o
    // Three.js escrevesse um pixel inline aqui e essa chamada acontecesse
    // com um tamanho errado/desatualizado, o canvas ficava visualmente
    // pequeno/distorcido pra sempre, mesmo depois do container ter o
    // tamanho certo — foi exatamente o bug relatado ("visualização
    // erradíssima", rótulo de coordenada em lugar diferente do marcador).
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio));
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    const now = performance.now();
    // Teto de FPS da aba Config: um viewer parado não precisa queimar GPU a
    // 144 fps. `- 1` de tolerância pra um rAF que oscila décimos de ms não
    // pular dois frames seguidos (60 caindo pra 30 por jitter do timer).
    if (this.fpsCap > 0 && now - this.lastRenderMs < 1000 / this.fpsCap - 1) return;
    this.lastRenderMs = now;
    // Delta-time com teto de 100ms: se a janela ficar em segundo plano (o
    // rAF pausa) e voltar, o primeiro frame não pode dar um salto gigante.
    const dt = Math.min((now - this.lastFrameMs) / 1000, 0.1);
    this.lastFrameMs = now;

    this.applyMovement(dt);
    this.updateBotMarker(dt);
    this.updateMobs(dt);
    this.controls.update();
    // A hora local anda 20 ticks/s enquanto o addon reporta a hora real — é
    // isso que deixa o ciclo contínuo em vez de pular 1x/s no polling.
    if (this.worldTimeLive && this.worldTime !== null) {
      this.worldTime = (this.worldTime + dt * TICKS_PER_SECOND) % TICKS_PER_DAY;
    }
    this.updateDayNight(now);
    this.updateSky();
    this.updateClouds(now);
    this.updateFog();
    this.updateAnimation(now);
    this.drainMeshQueue();
    this.renderer.render(this.scene, this.camera);
    this.updateLabelPosition();
    this.updateTargetPosition();
    this.updateMobLabels();
  };

  /** Mantém o popup do alvo grudado no bloco clicado (mesma projeção do
   * rótulo do bot); some quando o ponto fica atrás da câmera. */
  private updateTargetPosition() {
    if (!this.targetBlock) return;
    const vector = this.targetMarker.position.clone().project(this.camera);
    if (vector.z > 1) {
      this.targetEl.style.display = "none";
      return;
    }
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.targetEl.style.display = "flex";
    this.targetEl.style.left = `${(vector.x * 0.5 + 0.5) * width}px`;
    this.targetEl.style.top = `${(-vector.y * 0.5 + 0.5) * height}px`;
  }

  private updateLabelPosition() {
    if (!this.botMarker.visible) return;
    // Projeta acima da cabeça do jogador (o marcador está nos pés).
    const vector = this.botMarker.position
      .clone()
      .setY(this.botMarker.position.y + PLAYER_HEAD_HEIGHT)
      .project(this.camera);
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const x = (vector.x * 0.5 + 0.5) * width;
    const y = (-vector.y * 0.5 + 0.5) * height;

    if (vector.z > 1) {
      // atrás da câmera
      this.labelEl.style.display = "none";
      return;
    }
    this.labelEl.style.display = "block";
    this.labelEl.style.left = `${x + 16}px`;
    this.labelEl.style.top = `${y - 6}px`;
  }
}
