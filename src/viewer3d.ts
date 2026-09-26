import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Renderer 3D real do viewer — ver `docs/SPEC.md`, "Visualização 3D própria".
 * O spec descreve isso como wgpu nativo do lado Rust; aqui é WebGL (Three.js)
 * dentro do mesmo webview do app, por decisão explícita do usuário: entrega
 * o mesmo resultado (cena 3D, câmera orbitável, geometria real) sem a
 * complexidade de embutir uma superfície wgpu numa janela separada
 * sincronizada com o Tauri, que eu não teria como validar visualmente.
 *
 * Escopo honesto: ainda não há dado de bloco nenhum vindo do addon
 * (`chunk_loaded` só marca presença — ver `addon_socket.rs`), então cada
 * chunk explorado aparece como uma placa plana na posição/tamanho reais
 * (16×16 blocos), não como terreno/blocos de verdade. Isso é literal, não
 * inventado: representa exatamente o dado que existe (chunk visto), não
 * finge saber o que tem dentro dele.
 */

const CHUNK_SIZE = 16;
const COLOR_BG = 0x0a0c0f;
const COLOR_CHUNK = 0x14181d;
const COLOR_CHUNK_EDGE = 0x262c34;
const COLOR_TEAL = 0x5eead4;

// O addon ainda não manda qual bloco tem em cada chunk (só presença — ver
// addon_socket.rs, "chunk_loaded"), então não dá pra texturizar com o bloco
// real de cada um. Em vez de deixar sem textura nenhuma, usa um
// representante fixo só pra provar que o atlas extraído do jar local
// funciona ponta a ponta — vira textura real por chunk assim que o addon
// mandar o bloco de superfície de verdade.
//
// Não usa "grass_block_top": essa textura vem cinza no jar por design —
// RGB médio (147,147,147), R=G=B — porque o verde real é aplicado em
// runtime pelo jogo via "biome tint" (multiplicação de cor por bioma,
// textures/colormap/grass.png, ver docs/SPEC.md "Blocos 3D"), não
// implementado ainda. "dirt" já vem com cor real no arquivo (134,96,67),
// sem depender de tint nenhum.
const PLACEHOLDER_TEXTURE = "dirt";

export interface ChunkPos {
  x: number;
  z: number;
}

export interface BotPos {
  x: number;
  y: number;
  z: number;
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

  private chunkMeshes = new Map<string, THREE.Group>();
  private botMarker: THREE.Group;
  private botLight: THREE.PointLight;
  private lastBotWorldPos: THREE.Vector3 | null = null;

  private labelEl: HTMLDivElement;

  private atlasTexture: THREE.Texture | null = null;
  private atlasUvByName: Record<string, UvRect> | null = null;
  private atlasLoading = false;

  constructor(container: HTMLElement, labelEl: HTMLDivElement) {
    this.container = container;
    this.labelEl = labelEl;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(COLOR_BG, 60, 260);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    this.camera.position.set(40, 45, 40);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setClearColor(COLOR_BG, 1);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = Math.PI * 0.49; // não deixa virar de cabeça pra baixo

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(80, 120, 40);
    this.scene.add(sun);

    this.botMarker = this.buildBotMarker();
    this.botMarker.visible = false;
    this.scene.add(this.botMarker);

    this.botLight = new THREE.PointLight(COLOR_TEAL, 3, 20);
    this.botMarker.add(this.botLight);

    this.resize();
    this.animate();
  }

  private buildBotMarker(): THREE.Group {
    const group = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 20, 20),
      // fog: false — o marcador é "você está aqui", nunca pode desaparecer
      // no fog de distância como o resto da cena.
      new THREE.MeshStandardMaterial({ color: COLOR_TEAL, emissive: COLOR_TEAL, emissiveIntensity: 0.9, fog: false })
    );
    group.add(sphere);
    return group;
  }

  private chunkKey(pos: ChunkPos): string {
    return `${pos.x},${pos.z}`;
  }

  hasAtlas(): boolean {
    return this.atlasTexture !== null;
  }

  get isLoadingAtlas(): boolean {
    return this.atlasLoading;
  }

  /** Recebe o atlas já extraído/empacotado pelo lado Rust (data URL + mapa
   * de UV) e prepara a textura pro Three.js. Chamado uma vez, quando o
   * comando `get_texture_atlas` resolve — ver `main.ts`.
   *
   * Isso é assíncrono, mas `chunk_loaded` pode chegar aos montes de uma vez
   * (ex: backfill de reconexão — ver `mod-addon/README.md`) antes do atlas
   * terminar de carregar. Sem isso aqui, todo chunk criado nessa janela
   * ficava sem textura pra sempre, porque `setChunks` só texturiza chunk
   * *novo*. Por isso retrofita todo grupo já existente também. */
  setAtlas(dataUrl: string, textures: Record<string, UvRect>) {
    this.atlasLoading = true;
    new THREE.TextureLoader().load(
      dataUrl,
      (texture) => {
        // Pixel art do Minecraft: sem suavização, sem mipmap borrando os tiles.
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        // As UVs são calculadas em espaço de pixel da imagem (v0 = topo),
        // então desliga o flip automático do Three pra não inverter de novo.
        texture.flipY = false;
        this.atlasTexture = texture;
        this.atlasUvByName = textures;
        this.atlasLoading = false;

        for (const group of this.chunkMeshes.values()) this.addTopTexture(group);
      },
      undefined,
      (err) => {
        console.error("[viewer3d] falha ao carregar atlas de texturas:", err);
        this.atlasLoading = false;
      }
    );
  }

  /** Adiciona (ou reaproveita, se já existir) o plano texturizado no topo da
   * placa. Não faz nada se o atlas ainda não carregou. */
  private addTopTexture(group: THREE.Group) {
    if (group.userData.textured || !this.atlasTexture) return;
    const rect = this.atlasUvByName?.[PLACEHOLDER_TEXTURE];
    if (!rect) return;

    const top = new THREE.PlaneGeometry(CHUNK_SIZE - 0.5, CHUNK_SIZE - 0.5);
    top.rotateX(-Math.PI / 2);
    this.remapUv(top, rect);
    const topMesh = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ map: this.atlasTexture, roughness: 0.95 }));
    topMesh.position.y = 0.21; // logo acima da placa, evita z-fighting
    group.add(topMesh);
    group.userData.textured = true;
  }

  private remapUv(geometry: THREE.PlaneGeometry, rect: UvRect) {
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      uv.setXY(i, rect.u0 + u * (rect.u1 - rect.u0), rect.v0 + v * (rect.v1 - rect.v0));
    }
    uv.needsUpdate = true;
  }

  /** Chunks só são adicionados, nunca removidos — ver doc-comment do módulo
   * e de `addon_socket.rs`: é o "já explorado" cumulativo.
   *
   * `chunk_loaded` não manda altura de terreno (só existência do chunk), e o
   * mundo moderno vai de Y=-64 a Y=320+ — não tem "chão" universal em Y=0.
   * Usar Y=0 fixo deixava as placas praticamente fora de quadro sempre que o
   * bot está em qualquer altitude normal de jogo. Em vez de inventar altura
   * de terreno (que não temos), uso a altura real do bot no momento em que
   * cada chunk é visto pela primeira vez — aproximação honesta (assume que o
   * bot está perto do chão local quando o chunk carrega), não terreno de
   * verdade. Isso também é fixado pra sempre no chunk, igual à posição X/Z. */
  setChunks(chunks: ChunkPos[], referenceY: number) {
    for (const pos of chunks) {
      const key = this.chunkKey(pos);
      if (this.chunkMeshes.has(key)) continue;

      const group = new THREE.Group();
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(CHUNK_SIZE - 0.5, 0.4, CHUNK_SIZE - 0.5),
        new THREE.MeshStandardMaterial({ color: COLOR_CHUNK, roughness: 0.9 })
      );
      group.add(plate);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(CHUNK_SIZE, 0.4, CHUNK_SIZE)),
        new THREE.LineBasicMaterial({ color: COLOR_CHUNK_EDGE })
      );
      group.add(edges);

      this.addTopTexture(group);

      group.position.set(pos.x * CHUNK_SIZE + CHUNK_SIZE / 2, referenceY, pos.z * CHUNK_SIZE + CHUNK_SIZE / 2);
      this.scene.add(group);
      this.chunkMeshes.set(key, group);
    }
  }

  /** Câmera "persegue" o bot: a cada posição nova, move a câmera pelo mesmo
   * delta que o bot andou, preservando o ângulo/distância que o usuário
   * escolheu orbitando com o mouse. Sem isso, a câmera fica plantada onde
   * enquadrou da primeira vez e o bot sai de quadro assim que anda — foi
   * exatamente o bug relatado. */
  setBotPos(pos: BotPos | null) {
    if (!pos) {
      this.botMarker.visible = false;
      this.labelEl.style.display = "none";
      return;
    }
    this.botMarker.visible = true;
    const newPos = new THREE.Vector3(pos.x, pos.y + 1, pos.z);

    if (this.lastBotWorldPos) {
      const delta = newPos.clone().sub(this.lastBotWorldPos);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
    } else {
      // Primeira posição conhecida: enquadra direto, não tem de onde vir o delta.
      this.controls.target.set(pos.x, pos.y, pos.z);
      this.camera.position.set(pos.x + 40, pos.y + 45, pos.z + 40);
    }

    this.botMarker.position.copy(newPos);
    this.lastBotWorldPos = newPos;
    this.labelEl.textContent = `${pos.x}, ${pos.y}, ${pos.z}`;
  }

  /** Sem chunks nem bot ainda — estado honesto, não mostra uma cena vazia
   * como se fosse "carregada". Chamado quando o addon desconecta. */
  clear() {
    for (const mesh of this.chunkMeshes.values()) this.scene.remove(mesh);
    this.chunkMeshes.clear();
    this.botMarker.visible = false;
    this.labelEl.style.display = "none";
    this.lastBotWorldPos = null;
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updateLabelPosition();
  };

  private updateLabelPosition() {
    if (!this.botMarker.visible) return;
    const vector = this.botMarker.position.clone().project(this.camera);
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
