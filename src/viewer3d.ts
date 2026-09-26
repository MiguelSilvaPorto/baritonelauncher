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
 * Escopo honesto: o addon manda o bloco de *superfície* de cada coluna
 * (primeiro bloco sólido de cima pra baixo — ver `addon_socket.rs`,
 * `chunk_surface`), não o mundo inteiro em voxel. Cada coluna vira um único
 * bloquinho na altura real, com a textura real resolvida do jar local. Não
 * tem o que tem embaixo (cavernas, minérios) nem o pipeline completo de
 * blockstate→model→face (`docs/SPEC.md`, "Blocos 3D") — a textura usada é
 * uma resolução heurística por face (`{bloco}_top` em cima, `{bloco}_side`
 * nos 4 lados, `{bloco}_bottom` embaixo), não o modelo real. Texturas que o
 * jogo colore em runtime (folha, videira, água...) levam um tint fixo
 * aproximado — ver `BLOCK_TINTS`/`TEXTURE_ALIASES`.
 */

const BLOCK_TEXTURE_PX = 16; // resolução nativa das texturas de bloco do Minecraft
const COLOR_BG = 0x0a0c0f;
const COLOR_TEAL = 0x5eead4;
const COLOR_UNKNOWN_BLOCK = 0x3a3f47; // bloco sem textura resolvida no atlas

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
  water: WATER_TINT,
};

/** Blocos cujo nome não bate com o nome da textura no jar: água/lava/fogo
 * são animados (`water_still`, `fire_0`) e o atlas usa o primeiro frame como
 * estático — ver `texture_atlas.rs`. Sem isso, esses blocos nem textura
 * tinham (caíam no cinza de fallback). */
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

/** Capacidade inicial de um lote instanciado (dobra quando enche — ver
 * `growBatch`). Começa pequena porque a maioria dos tipos de bloco tem poucas
 * colunas; os tipos comuns crescem sozinhos até o tamanho real. */
const BATCH_INITIAL_CAPACITY = 256;

/** Um lote de blocos do mesmo tipo: uma geometria, um material por face e N
 * matrizes de instância, tudo num `InstancedMesh` só. A versão anterior
 * criava um `Mesh` por coluna — com o material por face, isso dava 6 draw
 * calls por bloco e milhares por frame, afundando o render pra 2–5 fps
 * (relatado pelo usuário). Aqui o custo por frame vira ~6 draw calls por
 * tipo de bloco usado no mundo, independente de quantos blocos existem. */
interface BlockBatch {
  block: string;
  mesh: THREE.InstancedMesh;
  capacity: number;
}

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

export interface ColumnBlock {
  x: number;
  y: number;
  z: number;
  block: string;
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private fog: THREE.Fog;

  /** Lotes instanciados por tipo de bloco — ver `setColumns`/`BlockBatch`. */
  private batches = new Map<string, BlockBatch>();
  /** Chaves (x,z) já renderizadas — o polling manda a lista completa toda
   * vez, então é este dedupe que evita re-adicionar o mundo a cada segundo. */
  private columnKeys = new Set<number>();
  /** Matriz reutilizada ao escrever/copiar posições de instância. */
  private readonly scratchMatrix = new THREE.Matrix4();
  // 1×1×1 de verdade, não 0.98: com um cubo menor que 1 sobra um vão de 2%
  // entre blocos vizinhos, e como só existe a camada de superfície (nada
  // embaixo), esse vão deixava ver o fundo escuro da cena — a grade preta
  // entre blocos que o usuário reportou. No jogo blocos encostam; a textura
  // de cada cubo é que dá o limite visual, sem precisar de vão.
  private blockGeometry = new THREE.BoxGeometry(1, 1, 1); // compartilhada por todo bloco
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
  private atlasUvByName: Record<string, UvRect> | null = null;
  /** Uma textura recortada (16×16px) por nome exato de textura do atlas (ex:
   * "grass_block_top", "grass_block_side") — evita recriar canvas/textura pro
   * mesmo tile a cada coluna nova. `null` = atlas carregado mas sem essa
   * textura. Enquanto o atlas não carregou nada é cacheado — ver
   * `getTileTexture`. */
  private tileTextureCache = new Map<string, THREE.Texture | null>();
  /** Materiais prontos por nome de bloco, na ordem dos 6 grupos do
   * `BoxGeometry` (+X, −X, +Y, −Y, +Z, −Z) — ver `resolveMaterials`. */
  private materialCache = new Map<string, THREE.Material[]>();

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
   * `x * 30M + z` é única — e, diferente do `${x},${z}` de antes, não aloca
   * uma string por coluna a cada tick do polling. */
  private columnKey(x: number, z: number): number {
    return x * 30_000_000 + z;
  }

  hasAtlas(): boolean {
    return this.atlasImage !== null;
  }

  get isLoadingAtlas(): boolean {
    return this.atlasLoading;
  }

  /** Recebe o atlas já extraído/empacotado pelo lado Rust (data URL + mapa
   * de UV) e guarda a imagem crua + o mapa de UV. Chamado uma vez, quando o
   * comando `get_texture_atlas` resolve — ver `main.ts`.
   *
   * Isso é assíncrono, mas o backfill de reconexão pode mandar dezenas de
   * `chunk_surface` (centenas de colunas) antes do atlas terminar de
   * carregar — mesmo problema que já apareceu com a placa por chunk (ver
   * `docs/CHANGELOG.md`). `resolveMaterials`/`getTileTexture` não cacheiam
   * nada enquanto o atlas não carregou, então nenhuma coluna fica presa
   * num material errado — só precisa retrofitar as que já foram criadas. */
  setAtlas(dataUrl: string, textures: Record<string, UvRect>) {
    this.atlasLoading = true;
    new THREE.TextureLoader().load(
      dataUrl,
      (atlasImageTexture) => {
        this.atlasImage = atlasImageTexture.image;
        this.atlasUvByName = textures;
        this.atlasLoading = false;

        for (const batch of this.batches.values()) {
          batch.mesh.material = this.resolveMaterials(batch.block);
        }
      },
      undefined,
      (err) => {
        console.error("[viewer3d] falha ao carregar atlas de texturas:", err);
        this.atlasLoading = false;
      }
    );
  }

  /** Recorta um único tile (16×16px) do atlas pro nome de textura exato
   * (ex: "grass_block_top") e devolve uma textura própria, sem repetição —
   * cada bloco aqui é um cubo de 1×1×1 (um bloco de verdade), não uma placa
   * de 16 blocos, então não precisa de `RepeatWrapping` como a versão
   * anterior (essa foi a causa do borrão: 1 tile esticado sobre 16 blocos). */
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
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /** Nome da textura no atlas pra uma face do bloco, como no jogo: topo usa
   * `"{bloco}_top"` (ex: grass_block_top, oak_log_top) e os 4 lados usam
   * `"{bloco}_side"` (ex: grass_block_side). A maioria dos blocos não tem
   * essas variantes e cai no `"{bloco}"` puro (stone, dirt, sand...). Isso é
   * uma heurística, não o pipeline blockstate→model→face do spec ("Blocos
   * 3D"), mas cobre o caso comum com os nomes reais do jar. */
  private faceTextureName(blockName: string, face: BlockFace): string | null {
    const atlas = this.atlasUvByName;
    if (!atlas) return null; // atlas ainda não carregou
    // Fluido/animado tem nome de textura próprio — ver TEXTURE_ALIASES.
    const alias = TEXTURE_ALIASES[blockName];
    if (alias) return atlas[alias] ? alias : null;
    const base = face === "bottom" ? BOTTOM_TEX_OVERRIDE[blockName] ?? blockName : blockName;
    const candidates =
      face === "top"
        ? [`${base}_top`, base]
        : face === "side"
          ? [`${base}_side`, base]
          : [`${base}_bottom`, base];
    return candidates.find((name) => atlas[name]) ?? null;
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

  private faceMaterial(blockName: string, face: BlockFace): THREE.MeshStandardMaterial {
    const textureName = this.faceTextureName(blockName, face);
    const texture = textureName ? this.getTileTexture(textureName) : null;
    if (!texture) {
      return new THREE.MeshStandardMaterial({ color: COLOR_UNKNOWN_BLOCK, roughness: 0.95 });
    }
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, color: this.tintFor(blockName, face) });
  }

  /** Cor multiplicada da textura — o "tint" do jogo (ver `BLOCK_TINTS` e
   * `GRASS_TINT`). Grama tinge só o topo, porque o lado já vem com a franja
   * verde impressa no jar; folhas/videira/água tingem as 6 faces. */
  private tintFor(blockName: string, face: BlockFace): number {
    if (blockName === "grass_block") return face === "top" ? GRASS_TINT : 0xffffff;
    return BLOCK_TINTS[blockName] ?? 0xffffff;
  }

  /** Um material por face do cubo, na ordem dos 6 grupos do `BoxGeometry`
   * (+X, −X, +Y, −Y, +Z, −Z): topo e fundo com textura própria, os 4 lados
   * compartilhando a mesma — igual ao modelo do jogo. Blocos sem variantes
   * (`_top`/`_side`/`_bottom`) usam a textura única nos 6 lados. */
  private resolveMaterials(blockName: string): THREE.Material[] {
    const cached = this.materialCache.get(blockName);
    if (cached) return cached;

    const top = this.faceMaterial(blockName, "top");
    const side = this.faceMaterial(blockName, "side");
    const bottom = this.faceMaterial(blockName, "bottom");
    const materials = [side, side, top, bottom, side, side];
    // Só cacheia depois que o atlas carregou — antes disso o resultado é só
    // o fallback cinza, e cachear isso deixaria o bloco preso nele pra
    // sempre mesmo depois do atlas ficar pronto.
    if (this.atlasUvByName) this.materialCache.set(blockName, materials);
    return materials;
  }

  /** Colunas só são adicionadas, nunca removidas/atualizadas — mesma
   * semântica cumulativa de `WorldCache` (ver `addon_socket.rs`): é o
   * "já visto", não uma janela ao vivo do que existe agora no jogo. Cada
   * coluna vira um único bloco de 1×1×1 na altura real reportada pelo
   * addon (superfície — não tem o que tem embaixo, ver `chunk_surface`).
   *
   * Renderização: cada coluna só escreve uma matriz de instância no lote do
   * seu tipo de bloco (um draw call por face e por tipo, não por bloco). */
  setColumns(columns: ColumnBlock[]) {
    const touched = new Set<BlockBatch>();
    for (const col of columns) {
      const key = this.columnKey(col.x, col.z);
      if (this.columnKeys.has(key)) continue;
      this.columnKeys.add(key);

      const batch = this.batchFor(col.block);
      if (batch.mesh.count >= batch.capacity) this.growBatch(batch);
      this.scratchMatrix.makeTranslation(col.x + 0.5, col.y + 0.5, col.z + 0.5);
      batch.mesh.setMatrixAt(batch.mesh.count, this.scratchMatrix);
      batch.mesh.count += 1;
      touched.add(batch);
    }
    // `setMatrixAt` só mexe no buffer na CPU — sobe pra GPU uma vez por lote.
    for (const batch of touched) batch.mesh.instanceMatrix.needsUpdate = true;
  }

  private batchFor(block: string): BlockBatch {
    const existing = this.batches.get(block);
    if (existing) return existing;

    const batch: BlockBatch = {
      block,
      mesh: this.buildBatchMesh(block, BATCH_INITIAL_CAPACITY),
      capacity: BATCH_INITIAL_CAPACITY,
    };
    this.scene.add(batch.mesh);
    this.batches.set(block, batch);
    return batch;
  }

  private buildBatchMesh(block: string, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.blockGeometry, this.resolveMaterials(block), capacity);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // lotes crescem/atualizam com o polling
    // Culling por bounding sphere não compensa: uma esfera só cobriria todo
    // o terreno explorado (justamente o que quase sempre está em quadro) e
    // recalcular a cada coluna nova custaria caro. Desligado de propósito.
    mesh.frustumCulled = false;
    return mesh;
  }

  /** `InstancedMesh` não cresce sozinho: dobra a capacidade num lote novo e
   * copia as matrizes já escritas (amortizado O(1) por coluna). */
  private growBatch(batch: BlockBatch) {
    const old = batch.mesh;
    const capacity = batch.capacity * 2;
    const mesh = this.buildBatchMesh(batch.block, capacity);
    for (let i = 0; i < old.count; i++) {
      old.getMatrixAt(i, this.scratchMatrix);
      mesh.setMatrixAt(i, this.scratchMatrix);
    }
    mesh.count = old.count;
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.remove(old);
    old.dispose();
    this.scene.add(mesh);
    batch.mesh = mesh;
    batch.capacity = capacity;
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

  /** Sem chunks nem bot ainda — estado honesto, não mostra uma cena vazia
   * como se fosse "carregada". Chamado quando o addon desconecta. */
  clear() {
    for (const batch of this.batches.values()) {
      this.scene.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches.clear();
    this.columnKeys.clear();
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
