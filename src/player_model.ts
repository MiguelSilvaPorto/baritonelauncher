import * as THREE from "three";

/**
 * Modelo do jogador do Minecraft pro viewer 3D — ver `docs/SPEC.md` e
 * `viewer3d.ts`. Substitui o marcador genérico (a bola teal) por um
 * personagem de verdade: as mesmas caixas do `HumanoidModel`/`PlayerModel` do
 * jogo (cabeça, tronco, braços e pernas), com a textura 64×64 da skin real do
 * jogador — que o addon manda pelo socket (ver `src-tauri/src/player_skin.rs`,
 * mensagem `player_skin`) — incluindo as camadas de sobreposição (chapéu,
 * jaqueta, mangas, calças).
 *
 * A geometria é um porte fiel do `ModelPart.Cube` do jogo (mesmas faces,
 * mesmas UVs, mesma ordem de vértices), só trocando o espaço de coordenadas
 * do modelo (y pra baixo, frente em -Z) pelo do Three.js (y pra cima, frente
 * em +Z) — a mesma rotação de 180° em X que o `LivingEntityRenderer` aplica.
 * A animação de caminhada segue as contas do `WalkAnimationState` +
 * `HumanoidModel.setupAnim` a 20 Hz.
 */

const TEXTURE_PX = 64; // skin moderna 64×64 (o jogo converte as 64×32 antes de entregar)
const PX = 1 / 16; // pixel do modelo → bloco (16 px = 1 bloco, como no jogo)
const GROUND_PX = 24; // altura dos pés no espaço do modelo (quadril em y=12, ombro em y=0)
const TICKS_PER_SECOND = 20;

/** Cinza neutro pro modelo enquanto a skin não chegou — "sem textura", não
 *  uma skin inventada (o addon manda a real assim que conecta). */
const COLOR_PLACEHOLDER = 0x3a3f47;

export type PlayerModelVariant = "wide" | "slim";

/** O que o viewer recebe do Rust (comando `player_skin`). */
export interface PlayerSkinInput {
  /** `"slim"` (Alex, braço de 3px) ou `"wide"` (Steve, 4px). */
  model: string;
  /** PNG em data URL. */
  imageDataUrl: string;
}

type PartName = "head" | "body" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg";

interface BoxSpec {
  /** `texOffs` do modelo vanilla: canto (x, y) em pixels na textura 64×64. */
  texOffs: [number, number];
  /** Canto mínimo da caixa, em pixels do espaço do modelo (y pra baixo). */
  min: [number, number, number];
  /** Tamanho da caixa em pixels (ex: cabeça = 8×8×8). */
  size: [number, number, number];
  /** Inflate em pixels — 0.25/0.5 nas camadas de sobreposição. */
  grow?: number;
  /** Camada de sobreposição (chapéu, jaqueta, mangas, calças): material
   *  transparente, por cima da camada base. */
  overlay?: boolean;
}

interface PartSpec {
  name: PartName;
  /** Ponto de rotação da parte, em pixels (ex: ombro do braço em -5,2,0). */
  pivot: [number, number, number];
  boxes: BoxSpec[];
}

const HEAD_AND_BODY: PartSpec[] = [
  {
    name: "head",
    pivot: [0, 0, 0],
    boxes: [
      { texOffs: [0, 0], min: [-4, -8, -4], size: [8, 8, 8] },
      { texOffs: [32, 0], min: [-4, -8, -4], size: [8, 8, 8], grow: 0.5, overlay: true },
    ],
  },
  {
    name: "body",
    pivot: [0, 0, 0],
    boxes: [
      { texOffs: [16, 16], min: [-4, 0, -2], size: [8, 12, 4] },
      { texOffs: [16, 32], min: [-4, 0, -2], size: [8, 12, 4], grow: 0.25, overlay: true },
    ],
  },
];

const LEGS: PartSpec[] = [
  {
    name: "rightLeg",
    pivot: [-1.9, 12, 0],
    boxes: [
      { texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4] },
      { texOffs: [0, 32], min: [-2, 0, -2], size: [4, 12, 4], grow: 0.25, overlay: true },
    ],
  },
  {
    name: "leftLeg",
    pivot: [1.9, 12, 0],
    boxes: [
      { texOffs: [16, 48], min: [-2, 0, -2], size: [4, 12, 4] },
      { texOffs: [0, 48], min: [-2, 0, -2], size: [4, 12, 4], grow: 0.25, overlay: true },
    ],
  },
];

/** Braços por variante — no slim o braço tem 3px de largura e o jogo usa
 *  retângulos de textura próprios pra cada lado (ver `PlayerModel.createMesh`
 *  em 26.3, que substitui o braço espelhado do `HumanoidModel`). */
const ARMS: Record<PlayerModelVariant, PartSpec[]> = {
  wide: [
    {
      name: "rightArm",
      pivot: [-5, 2, 0],
      boxes: [
        { texOffs: [40, 16], min: [-3, -2, -2], size: [4, 12, 4] },
        { texOffs: [40, 32], min: [-3, -2, -2], size: [4, 12, 4], grow: 0.25, overlay: true },
      ],
    },
    {
      name: "leftArm",
      pivot: [5, 2, 0],
      boxes: [
        { texOffs: [32, 48], min: [-1, -2, -2], size: [4, 12, 4] },
        { texOffs: [48, 48], min: [-1, -2, -2], size: [4, 12, 4], grow: 0.25, overlay: true },
      ],
    },
  ],
  slim: [
    {
      name: "rightArm",
      pivot: [-5, 2, 0],
      boxes: [
        { texOffs: [40, 16], min: [-2, -2, -2], size: [3, 12, 4] },
        { texOffs: [40, 32], min: [-2, -2, -2], size: [3, 12, 4], grow: 0.25, overlay: true },
      ],
    },
    {
      name: "leftArm",
      pivot: [5, 2, 0],
      boxes: [
        { texOffs: [32, 48], min: [-1, -2, -2], size: [3, 12, 4] },
        { texOffs: [48, 48], min: [-1, -2, -2], size: [3, 12, 4], grow: 0.25, overlay: true },
      ],
    },
  ],
};

function partsFor(variant: PlayerModelVariant): PartSpec[] {
  return [...HEAD_AND_BODY, ...ARMS[variant], ...LEGS];
}

/**
 * Geometria de uma caixa do modelo, na ordem de faces do `ModelPart.Cube`:
 * verticais em coordenadas de pixel do modelo (y pra baixo, frente em -Z),
 * convertidas pro Three.js e com a UV invertida no eixo V (a textura do jogo
 * tem origem no topo-esquerda; a do Three.js, embaixo-esquerda).
 */
function buildBoxGeometry(spec: BoxSpec): THREE.BufferGeometry {
  const [ox, oy] = spec.texOffs;
  const [w, h, d] = spec.size;
  const grow = spec.grow ?? 0;

  const minX = spec.min[0] - grow;
  const minY = spec.min[1] - grow;
  const minZ = spec.min[2] - grow;
  const maxX = spec.min[0] + w + grow;
  const maxY = spec.min[1] + h + grow;
  const maxZ = spec.min[2] + d + grow;

  const t0 = [minX, minY, minZ];
  const t1 = [maxX, minY, minZ];
  const t2 = [maxX, maxY, minZ];
  const t3 = [minX, maxY, minZ];
  const l0 = [minX, minY, maxZ];
  const l1 = [maxX, minY, maxZ];
  const l2 = [maxX, maxY, maxZ];
  const l3 = [minX, maxY, maxZ];

  const u0 = ox;
  const u1 = ox + d;
  const u2 = ox + d + w;
  const u22 = ox + d + 2 * w;
  const u3 = ox + w + 2 * d;
  const u4 = ox + 2 * w + 2 * d;
  const v0 = oy;
  const v1 = oy + d;
  const v2 = oy + d + h;

  // Ordem dos vértices/UVs idêntica à do Cube do jogo (anti-horário visto de
  // fora); a rotação de 180° em X preserva a orientação, então a mesma ordem
  // de índices dá as normais pra fora.
  const faces: { verts: number[][]; uvs: [number, number][] }[] = [
    { verts: [l1, l0, t0, t1], uvs: [[u1, v0], [u0, v0], [u0, v1], [u1, v1]] }, // baixo do modelo
    { verts: [t2, t3, l3, l2], uvs: [[u22, v1], [u2, v1], [u2, v0], [u22, v0]] }, // topo
    { verts: [t0, l0, l3, t3], uvs: [[u1, v1], [u0, v1], [u0, v2], [u1, v2]] }, // -X
    { verts: [t1, t0, t3, t2], uvs: [[u2, v1], [u1, v1], [u1, v2], [u2, v2]] }, // frente do modelo
    { verts: [l1, t1, t2, l2], uvs: [[u3, v1], [u2, v1], [u2, v2], [u3, v2]] }, // +X
    { verts: [l0, l1, l2, l3], uvs: [[u4, v1], [u3, v1], [u3, v2], [u4, v2]] }, // costas do modelo
  ];

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(face.verts[i][0] * PX, -face.verts[i][1] * PX, -face.verts[i][2] * PX);
      uvs.push(face.uvs[i][0] / TEXTURE_PX, 1 - face.uvs[i][1] / TEXTURE_PX);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Interpola ângulos em graus pelo caminho mais curto (yaw dá a volta). */
function lerpAngleDeg(current: number, target: number, alpha: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return current + delta * alpha;
}

export class MinecraftPlayerModel {
  /** Nó raiz: posicionar nos pés do jogador e girar o grupo todo pelo yaw. */
  readonly group = new THREE.Group();

  private variant: PlayerModelVariant = "wide";
  private parts = new Map<PartName, THREE.Group>();
  private baseMaterial: THREE.MeshStandardMaterial;
  private overlayMaterial: THREE.MeshStandardMaterial;
  private skinTexture: THREE.Texture | null = null;
  private skinToken = 0;
  private lastSkinUrl: string | null = null;

  // Estado da caminhada — mesmas contas do `WalkAnimationState` do jogo
  // (`LivingEntity.updateWalkAnimation` + `HumanoidModel.setupAnim`), a 20 Hz.
  private lastTickPos = new THREE.Vector3();
  private hasLastTickPos = false;
  private tickAccumulator = 0;
  private walkPosition = 0;
  private walkSpeed = 0;
  private displayedYaw = 0;

  constructor() {
    this.baseMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_PLACEHOLDER,
      roughness: 0.9,
      // fog: false — o jogador é "você está aqui", nunca pode desaparecer no
      // fog de distância (mesma razão do marcador antigo).
      fog: false,
    });
    this.overlayMaterial = new THREE.MeshStandardMaterial({
      color: COLOR_PLACEHOLDER,
      roughness: 0.9,
      fog: false,
      transparent: true,
    });
    this.rebuild();
  }

  /** Aplica a skin real (ou `null` pro placeholder cinza). Trocar entre
   *  `slim`/`wide` reconstrói os braços (largura e UVs mudam); a textura só é
   *  recarregada quando o PNG muda de verdade. */
  setSkin(skin: PlayerSkinInput | null) {
    const token = ++this.skinToken;

    if (!skin) {
      this.lastSkinUrl = null;
      this.applyTexture(null);
      return;
    }

    const variant: PlayerModelVariant = skin.model === "slim" ? "slim" : "wide";
    if (variant !== this.variant) {
      this.variant = variant;
      this.rebuild();
    }

    if (skin.imageDataUrl === this.lastSkinUrl) return;
    this.lastSkinUrl = skin.imageDataUrl;

    new THREE.TextureLoader().load(
      skin.imageDataUrl,
      (texture) => {
        if (token !== this.skinToken) {
          // Uma skin mais nova chegou enquanto esta carregava.
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        // Pixel art: nítido de perto, mipmap de longe (sem serrilhado).
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestMipmapLinearFilter;
        this.applyTexture(texture);
      },
      undefined,
      (err) => console.error("[player_model] falha ao carregar a skin:", err)
    );
  }

  /** Chamado a cada frame com a posição já interpolada pelo viewer. */
  update(dt: number, pos: THREE.Vector3, yawDeg: number, pitchDeg: number) {
    this.tickAccumulator += Math.min(dt, 0.1);
    while (this.tickAccumulator >= 1 / TICKS_PER_SECOND) {
      this.tickAccumulator -= 1 / TICKS_PER_SECOND;
      if (this.hasLastTickPos) {
        const distance = Math.hypot(pos.x - this.lastTickPos.x, pos.z - this.lastTickPos.z);
        // targetSpeed = min(distância/tick * 4, 1) e suavização 0.4 — igual
        // ao `updateWalkAnimation` do jogo.
        const targetSpeed = Math.min(distance * 4, 1);
        this.walkSpeed += (targetSpeed - this.walkSpeed) * 0.4;
        this.walkPosition += this.walkSpeed;
      }
      this.lastTickPos.copy(pos);
      this.hasLastTickPos = true;
    }

    const phase = this.walkPosition * 0.6662;
    const speed = this.walkSpeed;
    const rightArm = this.parts.get("rightArm");
    const leftArm = this.parts.get("leftArm");
    const rightLeg = this.parts.get("rightLeg");
    const leftLeg = this.parts.get("leftLeg");
    const head = this.parts.get("head");
    if (rightArm) rightArm.rotation.x = Math.cos(phase + Math.PI) * speed;
    if (leftArm) leftArm.rotation.x = Math.cos(phase) * speed;
    if (rightLeg) rightLeg.rotation.x = Math.cos(phase) * 1.4 * speed;
    if (leftLeg) leftLeg.rotation.x = Math.cos(phase + Math.PI) * 1.4 * speed;
    // Só o pitch da cabeça: o yaw real do corpo já gira o grupo inteiro.
    if (head) head.rotation.x = THREE.MathUtils.degToRad(pitchDeg);

    // Yaw com suavização pelo caminho mais curto (a pose chega 4x/s).
    this.displayedYaw = lerpAngleDeg(this.displayedYaw, yawDeg, 1 - Math.exp(-12 * dt));
    this.group.rotation.y = THREE.MathUtils.degToRad(-this.displayedYaw);
  }

  /** Zera a caminhada (teleporte/reconexão) — sem isso o modelo chega
   *  "andando" no lugar novo. */
  resetWalk() {
    this.walkPosition = 0;
    this.walkSpeed = 0;
    this.tickAccumulator = 0;
    this.hasLastTickPos = false;
  }

  private applyTexture(texture: THREE.Texture | null) {
    this.skinTexture?.dispose();
    this.skinTexture = texture;
    for (const material of [this.baseMaterial, this.overlayMaterial]) {
      material.map = texture;
      material.color.set(texture ? 0xffffff : COLOR_PLACEHOLDER);
      material.needsUpdate = true; // map null ↔ textura exige recompilar
    }
  }

  private rebuild() {
    for (const part of this.parts.values()) {
      this.group.remove(part);
      part.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    this.parts.clear();

    for (const spec of partsFor(this.variant)) {
      const part = new THREE.Group();
      part.position.set(spec.pivot[0] * PX, GROUND_PX * PX - spec.pivot[1] * PX, -spec.pivot[2] * PX);
      for (const box of spec.boxes) {
        part.add(
          new THREE.Mesh(
            buildBoxGeometry(box),
            box.overlay ? this.overlayMaterial : this.baseMaterial
          )
        );
      }
      this.parts.set(spec.name, part);
      this.group.add(part);
    }
  }
}
