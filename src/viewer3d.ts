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
const COLOR_BG = 0x0a0c0f;
const COLOR_TEAL = 0x5eead4;

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

// Perseguição do jogador: a pose real chega 4x/s (ver `addon_socket.rs`), e
// estes valores são o que evita o modelo "piscar" de posição em posição — o
// alvo é interpolado a cada frame (constante de tempo ~83ms com 12), e um
// salto grande (reconexão, `/tp`) encaixa direto em vez de deslizar pelo mapa.
const BOT_FOLLOW_RATE = 12; // 1/s
const BOT_TELEPORT_DISTANCE = 8; // blocos
const BOT_CAMERA_HEIGHT = 1; // altura do alvo da órbita (peito do jogador)
const PLAYER_HEAD_HEIGHT = 2.25; // rótulo de coordenadas acima da cabeça

// Aproximação, não tint real por bioma (isso exigiria saber o bioma da
// coluna e amostrar o colormap/JSON de bioma — não implementado, ver
// docs/SPEC.md "Blocos 3D"). "grass_block_top" vem cinza no jar por design
// (RGB médio 147,147,147, R=G=B); sem isso ficaria tudo cinza de novo.
// Só o topo leva tint: o lado ("grass_block_side") já vem com a franja verde
// impressa na própria textura, sobre a terra.
const GRASS_TINT = 0x79c05a;

// Mesma ideia do GRASS_TINT, pras outras texturas que vêm cinza no jar e que
// o jogo colore em runtime: tom de folhagem/água "floresta/plains", não a cor
// exata do bioma da coluna. Espécies cuja textura já vem colorida no arquivo
// (cerejeira, azaleia, carvalho-pálido) ficam de fora de propósito — tint
// nelas só escureceria uma cor que já está certa.
const FOLIAGE_TINT = 0x59ae30;
const WATER_TINT = 0x3f76e4;
const BLOCK_TINTS: Record<string, number> = {
  oak_leaves: FOLIAGE_TINT,
  jungle_leaves: FOLIAGE_TINT,
  acacia_leaves: FOLIAGE_TINT,
  dark_oak_leaves: FOLIAGE_TINT,
  mangrove_leaves: FOLIAGE_TINT,
  vine: FOLIAGE_TINT,
  lily_pad: GRASS_TINT, // o jogo usa a cor de grama no lírio
  spruce_leaves: 0x619961, // cor fixa no jogo, não vem do bioma
  birch_leaves: 0x80a755,
};

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

// Flags do payload binário de `chunk_voxels` — espelham `world_cache.rs`.
const VOXEL_FORMAT_VERSION = 2;
const VOXEL_FLAG_RENDER = 1;
const VOXEL_FLAG_OCCLUDES = 2;
const VOXEL_FLAG_FLUID = 4;

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

/** Orçamento de CPU por frame pra montar malhas de chunk, em ms. Um backfill
 * pode enfileirar centenas de chunks; montar todos de uma vez derruba o fps,
 * então a fila é drenada em pedaços por frame. */
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
}

interface DecodedChunk {
  x: number;
  z: number;
  /** Seção Y (mundo / 16) → seção; ausente = ar. */
  sections: Map<number, DecodedSection>;
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

/** UVs já no espaço do atlas (flat) + tint linear, cacheados por (bloco,
 * face do cubo) — o laço de meshing roda uma vez por face exposta e refazer
 * string + rect + conversão de cor a cada iteração era o grosso do custo
 * num chunk denso. */
interface FaceRender {
  uv: number[];
  r: number;
  g: number;
  b: number;
}

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
    utf8: (n: number) => new TextDecoder().decode(take(n)),
    done: () => pos,
  };
}

/** Decodifica o payload de `chunk_voxels` (formato 2, ver `world_cache.rs`). */
function decodeVoxels(x: number, z: number, bytes: Uint8Array): DecodedChunk {
  const reader = byteReader(bytes);
  const version = reader.u8();
  if (version !== VOXEL_FORMAT_VERSION) {
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
    sections.set(y, { y, palette, indices });
  }
  return { x, z, sections };
}

export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private fog: THREE.Fog;

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
  private botYaw = 0;
  private botPitch = 0;

  private labelEl: HTMLDivElement;

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
  private opaqueMaterial: THREE.MeshStandardMaterial | null = null;
  /** Material por bucket de fluido (`water_still`, `water_flow`,
   * `lava_still`, `lava_flow`). */
  private bucketMaterials = new Map<string, THREE.MeshStandardMaterial>();
  /** Materiais com textura animada + seus frames, pra trocar o `map`. */
  private animatedMaterials: { material: THREE.MeshStandardMaterial; frames: THREE.Texture[] }[] = [];
  private animationFrame = 0;
  private lastAnimationMs = 0;
  private readonly scratchColor = new THREE.Color();

  constructor(container: HTMLElement, labelEl: HTMLDivElement) {
    this.container = container;
    this.labelEl = labelEl;

    this.scene = new THREE.Scene();
    this.fog = new THREE.Fog(COLOR_BG, FOG_NEAR_BASE, FOG_FAR_BASE);
    this.scene.fog = this.fog;

    // `far` acompanha o `maxDistance` do OrbitControls: com o zoom livre
    // (2000 blocos) um far de 1000 cortaria o terreno ao se afastar.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.camera.position.set(40, 45, 40);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setClearColor(COLOR_BG, 1);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
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

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(80, 120, 40);
    this.scene.add(sun);

    this.botMarker = this.buildBotMarker();
    this.botMarker.visible = false;
    this.scene.add(this.botMarker);

    this.resize();
    this.animate();
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
  setAtlas(dataUrl: string, textures: Record<string, UvRect>) {
    this.atlasLoading = true;
    new THREE.TextureLoader().load(
      dataUrl,
      (texture) => {
        // `flipY = false`: os rects de UV do Rust usam a origem no topo da
        // imagem (igual ao canvas), e é assim que o mapa é montado aqui.
        texture.flipY = false;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;

        this.atlasImage = texture.image;
        this.atlasTexture = texture;
        this.atlasUvByName = textures;
        this.atlasLoading = false;
        this.buildMaterials();
        this.rebuildAllMeshes();
      },
      undefined,
      (err) => {
        console.error("[viewer3d] falha ao carregar atlas de texturas:", err);
        this.atlasLoading = false;
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
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
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
   * puro quando a variante não existe (stone, dirt, sand...). Heurística,
   * não o pipeline blockstate→model→face do spec ("Blocos 3D"). */
  private faceRect(blockName: string, face: BlockFace): UvRect | null {
    const atlas = this.atlasUvByName;
    if (!atlas) return null;
    const base = face === "bottom" ? BOTTOM_TEX_OVERRIDE[blockName] ?? blockName : blockName;
    const candidates =
      face === "top"
        ? [`${base}_top`, base]
        : face === "side"
          ? [`${base}_side`, base]
          : [`${base}_bottom`, base];
    for (const name of candidates) {
      const rect = atlas[name] ?? atlas[TEXTURE_ALIASES[name]];
      if (rect) return rect;
    }
    return atlas["dirt"] ?? Object.values(atlas)[0] ?? null;
  }

  /** Tint por vértice: só o topo da grama e as folhagens que vêm cinza no
   * jar; o resto é branco (textura já colorida). */
  private faceTint(blockName: string, face: BlockFace): number {
    if (blockName === "grass_block") return face === "top" ? GRASS_TINT : 0xffffff;
    return BLOCK_TINTS[blockName] ?? 0xffffff;
  }

  private buildMaterials() {
    if (!this.atlasTexture) return;
    this.animatedMaterials = [];
    this.bucketMaterials.clear();
    this.faceRenderCache.clear();
    this.opaqueMaterial = new THREE.MeshStandardMaterial({
      map: this.atlasTexture,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });
    this.bucketMaterials.set("opaque", this.opaqueMaterial);
    this.bucketMaterials.set("water_still", this.buildFluidMaterial("water", "still"));
    this.bucketMaterials.set("water_flow", this.buildFluidMaterial("water", "flow"));
    this.bucketMaterials.set("lava_still", this.buildFluidMaterial("lava", "still"));
    this.bucketMaterials.set("lava_flow", this.buildFluidMaterial("lava", "flow"));
  }

  private buildFluidMaterial(kind: "water" | "lava", phase: "still" | "flow"): THREE.MeshStandardMaterial {
    const frames = this.loadFrames(`${kind}_${phase}`);
    const water = kind === "water";
    const material = new THREE.MeshStandardMaterial({
      map: frames[0] ?? null,
      color: water ? WATER_TINT : 0xffffff,
      roughness: water ? 0.35 : 0.6,
      metalness: 0,
      // Água é translúcida e não escreve no z-buffer (como no jogo); lava é
      // opaca e emite luz.
      transparent: water,
      opacity: water ? 0.72 : 1,
      depthWrite: !water,
      side: THREE.DoubleSide,
      emissive: water ? 0x000000 : 0x8a3b0c,
      emissiveIntensity: water ? 0 : 0.55,
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
   * usado pra superfície rebaixada de fluido. */
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
    b: number
  ) {
    const face = FACES[faceIndex];
    const base = buffers.positions.length / 3;
    for (let i = 0; i < 4; i++) {
      const corner = face.corners[i];
      buffers.positions.push(x + corner[0], y + (corner[1] === 1 ? high : low), z + corner[2]);
      buffers.normals.push(face.dir[0], face.dir[1], face.dir[2]);
      buffers.uvs.push(uv[i * 2], uv[i * 2 + 1]);
      buffers.colors.push(r, g, b);
    }
    buffers.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** UVs (flat, já no espaço do atlas) + tint linear de uma face do bloco,
   * com cache por (bloco, face). `null` = face sem textura resolvida, pulada
   * sem quebrar o chunk. */
  private faceRender(blockName: string, faceIndex: number): FaceRender | null {
    const key = `${blockName}|${faceIndex}`;
    if (this.faceRenderCache.has(key)) return this.faceRenderCache.get(key)!;

    const face = FACES[faceIndex];
    const rect = this.faceRect(blockName, face.kind);
    let render: FaceRender | null = null;
    if (rect) {
      const uv = new Array<number>(8);
      for (let i = 0; i < 4; i++) {
        const [u, v] = face.uv[i];
        uv[i * 2] = rect.u0 + u * (rect.u1 - rect.u0);
        uv[i * 2 + 1] = rect.v0 + v * (rect.v1 - rect.v0);
      }
      this.scratchColor.setHex(this.faceTint(blockName, face.kind));
      render = { uv, r: this.scratchColor.r, g: this.scratchColor.g, b: this.scratchColor.b };
    }
    this.faceRenderCache.set(key, render);
    return render;
  }

  /** Uma face visível de fluido: mesma culling dos sólidos, mas face entre o
   * mesmo fluido só aparece quando o vizinho é mais raso (degrau d'água), e
   * a altura sai do nível em vez de 0..1. */
  private meshFluidFace(
    buffers: MeshBuffers,
    faceIndex: number,
    x: number,
    y: number,
    z: number,
    entry: PaletteEntry,
    neighbor: PaletteEntry | null,
    flow: THREE.Vector3 | null
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
    this.pushQuadFlat(
      buffers,
      faceIndex,
      x,
      y,
      z,
      low,
      high,
      FLUID_ROTATED_UV[faceIndex][rotation],
      1,
      1,
      1
    );
  }

  /** Monta as malhas de um chunk (um mesh por bucket usado) e substitui as
   * antigas. Sem atlas carregado não faz nada — `setAtlas` remonta tudo.
   *
   * Roda dentro da fila orçada (`drainMeshQueue`), nunca direto no refresh:
   * é o trabalho pesado do viewer (varre 4096 blocos por seção) e montar
   * vários chunks no mesmo tick derrubava o fps. */
  private buildChunkMesh(chunk: DecodedChunk) {
    const key = this.chunkKey(chunk.x, chunk.z);
    this.disposeChunkMeshes(key);
    if (!this.atlasUvByName || !this.atlasTexture) return;

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

      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const entry = sectionPalette[sectionIndices[(ly << 8) | (lz << 4) | lx]];
            if (!entry || (entry.flags & VOXEL_FLAG_RENDER) === 0) continue;

            const x = chunk.x * 16 + lx;
            const y = sectionY * 16 + ly;
            const z = chunk.z * 16 + lz;
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
                this.meshFluidFace(buffered(fluidBucket), f, x, y, z, entry, neighbor, flow);
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
              this.pushQuadFlat(buffered("opaque"), f, x, y, z, 0, 1, render.uv, render.r, render.g, render.b);
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

  /** Monta no máximo `MESH_BUDGET_MS` de malhas por frame. Um backfill (ou o
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
    } while (this.meshQueue.length > 0 && performance.now() - start < MESH_BUDGET_MS);
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

    this.targetBotPos = target;
    this.botMarker.visible = true;
    this.labelEl.textContent = `${pose.x}, ${pose.y}, ${pose.z}`;
  }

  /** Skin real do jogador (comando `player_skin`) — o modelo só reaplica
   * quando ela muda de verdade, então dá pra chamar a cada polling. */
  setPlayerSkin(skin: PlayerSkinInput | null) {
    this.playerModel.setSkin(skin);
  }

  /** Move o modelo (interpolando até o alvo) e a câmera pelo mesmo passo. */
  private updateBotMarker(dt: number) {
    if (!this.targetBotPos) return;

    const step = this.targetBotPos.clone().sub(this.botMarker.position);
    step.multiplyScalar(1 - Math.exp(-BOT_FOLLOW_RATE * dt));
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
    if (this.moveForward.lengthSq() < 1e-6) {
      // Olhando reto pra baixo/cima não existe "frente" no plano horizontal;
      // o eixo local -Y da câmera (o "para cima" da tela) é horizontal nesse
      // caso e serve de frente — sem isso o vetor seria zero e normalizar
      // daria NaN.
      this.moveForward.set(0, -1, 0).applyQuaternion(this.camera.quaternion);
      this.moveForward.y = 0;
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

  /** O fog acompanha a distância câmera→alvo: mantém o gradiente de
   * profundidade no enquadramento normal, mas não deixa o terreno distante
   * "sumir" no fundo quando o usuário afasta o zoom (visão de mundo). */
  private updateFog() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.fog.near = Math.max(FOG_NEAR_BASE, distance * 0.85);
    this.fog.far = Math.max(FOG_FAR_BASE, distance * 3);
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

  /** Sem chunks nem bot ainda — estado honesto, não mostra uma cena vazia
   * como se fosse "carregada". Chamado quando o addon desconecta. */
  clear() {
    for (const key of Array.from(this.chunkMeshes.keys())) this.disposeChunkMeshes(key);
    this.chunks.clear();
    this.meshQueue = [];
    this.queuedChunks.clear();
    this.botMarker.visible = false;
    this.labelEl.style.display = "none";
    this.targetBotPos = null;
    this.playerModel.resetWalk();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    // Delta-time com teto de 100ms: se a janela ficar em segundo plano (o
    // rAF pausa) e voltar, o primeiro frame não pode dar um salto gigante.
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameMs) / 1000, 0.1);
    this.lastFrameMs = now;

    this.applyMovement(dt);
    this.updateBotMarker(dt);
    this.controls.update();
    this.updateFog();
    this.updateAnimation(now);
    this.drainMeshQueue();
    this.renderer.render(this.scene, this.camera);
    this.updateLabelPosition();
  };

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
