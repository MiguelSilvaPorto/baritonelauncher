import * as THREE from "three";

/**
 * Modelos de entidade (mobs) do viewer — o porte das classes de modelo reais
 * do cliente (ver `net/minecraft/client/model/...` nas fontes do jar local):
 * mesmas caixas, mesmas UVs, mesmos pivôs e as mesmas contas de
 * `setupAnim` (caminhada, cabeça, asas). Nada aqui é inventado: a geometria
 * vem do jogo e as texturas do jar do usuário (ver `texture_atlas.rs`,
 * `build_or_load_entity_textures`); sem modelo pra um tipo de mob, o viewer
 * mantém só o rótulo (ver "Known gaps" em `AGENTS.md`).
 *
 * Convenções, iguais às do `player_model.ts` (que já é um porte do
 * `ModelPart.Cube`): espaço do modelo com y pra baixo e 16 px = 1 bloco, pés
 * em y=24; a geometria vira (x, -y, -z) e a rotação de cada parte é
 * (x, -y, -z) na mesma ordem de composição do jogo (`ZYX`, como o
 * `mulPose` Z→Y→X do `PartPose`). O grupo raiz é posicionado nos pés e gira
 * `-yaw` (mesmo yaw do jogo que o `player_model` consome).
 */

const PX = 1 / 16;
const GROUND_PX = 24; // pés no espaço do modelo (como no player_model)
const TICKS_PER_SECOND = 20;

// ---------------------------------------------------------------------------
// Especificação de geometria (tradução direta de CubeListBuilder/PartPose)
// ---------------------------------------------------------------------------

interface MobBox {
  /** `texOffs(x, y)` do jogo, no espaço de UV da textura do modelo. */
  texOffs: [number, number];
  /** Canto mínimo da caixa, em pixels do espaço do modelo (relativo ao pivô). */
  min: [number, number, number];
  size: [number, number, number];
  /** `CubeDeformation` (inflate) em pixels — camadas de sobreposição. */
  grow?: number;
  /** `mirror()` do `CubeListBuilder`: espelha as UVs da caixa. */
  mirror?: boolean;
}

interface MobPart {
  name: string;
  /** Pivô da parte em pixels (absoluto na raiz; relativo ao pai nos filhos). */
  pivot: [number, number, number];
  /** `PartPose.offsetAndRotation`: rotação base em radianos (eixos do modelo). */
  rot?: [number, number, number];
  boxes?: MobBox[];
  children?: MobPart[];
}

/** Estado que os animadores recebem por frame (nomes espelham o render state). */
export interface MobAnimState {
  /** `walkAnimationPos` — mesma integração a 20 Hz do `WalkAnimationState`. */
  walkPosition: number;
  /** `walkAnimationSpeed` (0..1). */
  walkSpeed: number;
  /** Yaw da cabeça relativo ao corpo, em graus (`state.yRot` do jogo). */
  headYaw: number;
  /** Pitch da cabeça em graus (`state.xRot`). */
  pitch: number;
}

/** Um modelo de mob completo: tamanho de UV + partes + animador do jogo. */
export interface MobModelDef {
  /** `LayerDefinition.create(mesh, w, h)` — o espaço de UV, não o do PNG. */
  texSize: [number, number];
  parts: MobPart[];
  animate(parts: Map<string, THREE.Group>, state: MobAnimState): void;
}

// ---------------------------------------------------------------------------
// Geometria: porte do `ModelPart.Cube` (mesmas faces/UVs do player_model)
// ---------------------------------------------------------------------------

/** Constrói as faces de uma caixa com as UVs do jogo. `mirror` inverte a
 *  ordem das UVs de cada face (o `Polygon` do jogo troca as pontas); faces
 *  sem área (caixa achatada, ex: asas do pintinho) são puladas. */
function buildBoxGeometry(box: MobBox, [texW, texH]: [number, number]): THREE.BufferGeometry {
  const [ox, oy] = box.texOffs;
  const [w, h, d] = box.size;
  const grow = box.grow ?? 0;

  const minX = box.min[0] - grow;
  const minY = box.min[1] - grow;
  const minZ = box.min[2] - grow;
  const maxX = box.min[0] + w + grow;
  const maxY = box.min[1] + h + grow;
  const maxZ = box.min[2] + d + grow;

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
  // fora); `uvSpan` é a área da face em pixels, usada só pra pular face
  // degenerada.
  const faces: { verts: number[][]; uvs: [number, number][]; uvSpan: [number, number] }[] = [
    { verts: [l1, l0, t0, t1], uvs: [[u1, v0], [u0, v0], [u0, v1], [u1, v1]], uvSpan: [d, w] }, // baixo do modelo
    { verts: [t2, t3, l3, l2], uvs: [[u22, v1], [u2, v1], [u2, v0], [u22, v0]], uvSpan: [w, d] }, // topo
    { verts: [t0, l0, l3, t3], uvs: [[u1, v1], [u0, v1], [u0, v2], [u1, v2]], uvSpan: [d, h] }, // -X
    { verts: [t1, t0, t3, t2], uvs: [[u2, v1], [u1, v1], [u1, v2], [u2, v2]], uvSpan: [w, h] }, // frente
    { verts: [l1, t1, t2, l2], uvs: [[u3, v1], [u2, v1], [u2, v2], [u3, v2]], uvSpan: [d, h] }, // +X
    { verts: [l0, l1, l2, l3], uvs: [[u4, v1], [u3, v1], [u3, v2], [u4, v2]], uvSpan: [w, h] }, // costas
  ];

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    if (face.uvSpan[0] === 0 || face.uvSpan[1] === 0) continue;
    const faceUvs = box.mirror ? [...face.uvs].reverse() : face.uvs;
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(face.verts[i][0] * PX, -face.verts[i][1] * PX, -face.verts[i][2] * PX);
      uvs.push(faceUvs[i][0] / texW, 1 - faceUvs[i][1] / texH);
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

interface CompiledPart {
  spec: MobPart;
  geometries: THREE.BufferGeometry[];
  children: CompiledPart[];
}

const compiledModels = new WeakMap<MobModelDef, CompiledPart[]>();

function compileModel(def: MobModelDef): CompiledPart[] {
  const cached = compiledModels.get(def);
  if (cached) return cached;
  const compile = (spec: MobPart): CompiledPart => ({
    spec,
    geometries: (spec.boxes ?? []).map((box) => buildBoxGeometry(box, def.texSize)),
    children: (spec.children ?? []).map(compile),
  });
  const compiled = def.parts.map(compile);
  compiledModels.set(def, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Animadores (transliteração dos `setupAnim` das classes do jogo)
// ---------------------------------------------------------------------------

const PI = Math.PI;

/** Aplica rotações *no espaço do modelo do jogo* numa parte (o -y/-z é a
 *  conversão pro Three, como no player_model). */
function pose(
  parts: Map<string, THREE.Group>,
  name: string,
  x: number,
  y: number,
  z: number
): void {
  const part = parts.get(name);
  if (part) part.rotation.set(x, -y, -z);
}

/** Igual a `pose`, mas somando à rotação base da parte (pernas da aranha, que
 *  já nascem rotacionadas no `PartPose`). */
function poseDelta(
  parts: Map<string, THREE.Group>,
  name: string,
  x: number,
  y: number,
  z: number
): void {
  const part = parts.get(name);
  if (!part) return;
  const base = part.userData.baseRot as [number, number, number];
  part.rotation.set(base[0] + x, -(base[1] + y), -(base[2] + z));
}

function poseHead(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  pose(parts, "head", (state.pitch * PI) / 180, (state.headYaw * PI) / 180, 0);
}

/** `HumanoidModel.setupAnim`: braços e pernas no ciclo de caminhada. */
function animateHumanoidWalk(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  poseHead(parts, state);
  const phase = state.walkPosition * 0.6662;
  pose(parts, "right_arm", Math.cos(phase + PI) * state.walkSpeed, 0, 0);
  pose(parts, "left_arm", Math.cos(phase) * state.walkSpeed, 0, 0);
  pose(parts, "right_leg", Math.cos(phase) * 1.4 * state.walkSpeed, 0, 0);
  pose(parts, "left_leg", Math.cos(phase + PI) * 1.4 * state.walkSpeed, 0, 0);
}

/** `ZombieModel` + `AnimationUtils.animateZombieArms` parado: braços pra
 *  frente (sem o swing de ataque, que não é reportado pelo addon). */
function animateZombie(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  poseHead(parts, state);
  const phase = state.walkPosition * 0.6662;
  pose(parts, "right_leg", Math.cos(phase) * 1.4 * state.walkSpeed, 0, 0);
  pose(parts, "left_leg", Math.cos(phase + PI) * 1.4 * state.walkSpeed, 0, 0);
  const drop = -PI / 2.25;
  pose(parts, "right_arm", drop, -0.1, 0);
  pose(parts, "left_arm", drop, 0.1, 0);
}

/** `QuadrupedModel.setupAnim`: cabeça + quatro pernas alternadas. */
function animateQuadruped(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  poseHead(parts, state);
  const phase = state.walkPosition * 0.6662;
  const swing = 1.4 * state.walkSpeed;
  pose(parts, "right_hind_leg", Math.cos(phase) * swing, 0, 0);
  pose(parts, "left_hind_leg", Math.cos(phase + PI) * swing, 0, 0);
  pose(parts, "right_front_leg", Math.cos(phase + PI) * swing, 0, 0);
  pose(parts, "left_front_leg", Math.cos(phase) * swing, 0, 0);
}

/** `CreeperModel.setupAnim` (as pernas trocam em diagonal). */
function animateCreeper(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  poseHead(parts, state);
  const phase = state.walkPosition * 0.6662;
  const swing = 1.4 * state.walkSpeed;
  pose(parts, "left_hind_leg", Math.cos(phase) * swing, 0, 0);
  pose(parts, "right_hind_leg", Math.cos(phase + PI) * swing, 0, 0);
  pose(parts, "left_front_leg", Math.cos(phase + PI) * swing, 0, 0);
  pose(parts, "right_front_leg", Math.cos(phase) * swing, 0, 0);
}

/** `SpiderModel.setupAnim`: oito pernas com swing (yRot) e passo (zRot). */
function animateSpider(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  poseHead(parts, state);
  const pos = state.walkPosition * 0.6662;
  const speed = state.walkSpeed;
  const swing = (offset: number) => -(Math.cos(pos * 2 + offset) * 0.4) * speed;
  const step = (offset: number) => Math.abs(Math.sin(pos + offset) * 0.4) * speed;
  const hind = { s: swing(0), t: step(0) };
  const middleHind = { s: swing(PI), t: step(PI) };
  const middleFront = { s: swing(PI / 2), t: step(PI / 2) };
  const front = { s: swing((PI * 3) / 2), t: step((PI * 3) / 2) };
  poseDelta(parts, "right_hind_leg", 0, hind.s, hind.t);
  poseDelta(parts, "left_hind_leg", 0, -hind.s, -hind.t);
  poseDelta(parts, "right_middle_hind_leg", 0, middleHind.s, middleHind.t);
  poseDelta(parts, "left_middle_hind_leg", 0, -middleHind.s, -middleHind.t);
  poseDelta(parts, "right_middle_front_leg", 0, middleFront.s, middleFront.t);
  poseDelta(parts, "left_middle_front_leg", 0, -middleFront.s, -middleFront.t);
  poseDelta(parts, "right_front_leg", 0, front.s, front.t);
  poseDelta(parts, "left_front_leg", 0, -front.s, -front.t);
}

/** `ChickenModel.setupAnim`: pernas + cabeça. As asas batem com `flap`, que o
 *  app não recebe — ficam em repouso (zRot 0), como no jogo sem bateção. */
function animateChicken(parts: Map<string, THREE.Group>, state: MobAnimState): void {
  poseHead(parts, state);
  const phase = state.walkPosition * 0.6662;
  pose(parts, "right_leg", Math.cos(phase) * 1.4 * state.walkSpeed, 0, 0);
  pose(parts, "left_leg", Math.cos(phase + PI) * 1.4 * state.walkSpeed, 0, 0);
  pose(parts, "right_wing", 0, 0, 0);
  pose(parts, "left_wing", 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Modelos (um por classe do jogo; nomes de parte = nomes do `PartDefinition`)
// ---------------------------------------------------------------------------

/** `HumanoidModel.createMesh` (zumbi/afogado/husk adultos), 64×64. */
const HUMAN_HAT: MobPart = {
  name: "hat",
  pivot: [0, 0, 0],
  boxes: [{ texOffs: [32, 0], min: [-4, -8, -4], size: [8, 8, 8], grow: 0.5 }],
};

const HUMANOID: MobModelDef = {
  texSize: [64, 64],
  animate: animateZombie,
  parts: [
    {
      name: "head",
      pivot: [0, 0, 0],
      boxes: [{ texOffs: [0, 0], min: [-4, -8, -4], size: [8, 8, 8] }],
      children: [HUMAN_HAT],
    },
    { name: "body", pivot: [0, 0, 0], boxes: [{ texOffs: [16, 16], min: [-4, 0, -2], size: [8, 12, 4] }] },
    { name: "right_arm", pivot: [-5, 2, 0], boxes: [{ texOffs: [40, 16], min: [-3, -2, -2], size: [4, 12, 4] }] },
    {
      name: "left_arm",
      pivot: [5, 2, 0],
      boxes: [{ texOffs: [40, 16], min: [-1, -2, -2], size: [4, 12, 4], mirror: true }],
    },
    { name: "right_leg", pivot: [-1.9, 12, 0], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4] }] },
    {
      name: "left_leg",
      pivot: [1.9, 12, 0],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4], mirror: true }],
    },
  ],
};

/** `BabyZombieModel.createBodyLayer`, 64×64. */
const BABY_ZOMBIE: MobModelDef = {
  texSize: [64, 64],
  animate: animateZombie,
  parts: [
    {
      name: "head",
      pivot: [0, 15.25, 0],
      boxes: [
        { texOffs: [3, 3], min: [-3, -6.25, -3], size: [6, 6, 6] },
        { texOffs: [35, 3], min: [-3, -6.15, -3], size: [6, 6, 6], grow: 0.25 },
      ],
    },
    { name: "body", pivot: [0, 17.5, 0], boxes: [{ texOffs: [16, 16], min: [-2, -2.5, -1], size: [4, 5, 2] }] },
    { name: "right_arm", pivot: [-3, 15.5, 0], boxes: [{ texOffs: [36, 16], min: [-1, -0.5, -1], size: [2, 5, 2] }] },
    { name: "left_arm", pivot: [3, 15.5, 0], boxes: [{ texOffs: [28, 16], min: [-1, -0.5, -1], size: [2, 5, 2] }] },
    { name: "right_leg", pivot: [-1, 20, 0], boxes: [{ texOffs: [8, 16], min: [-1, 0, -1], size: [2, 4, 2] }] },
    { name: "left_leg", pivot: [1, 20, 0], boxes: [{ texOffs: [0, 16], min: [-1, 0, -1], size: [2, 4, 2] }] },
  ],
};

/** `SkeletonModel.createBodyLayer` (braços/pernas finos), 64×32. */
const SKELETON: MobModelDef = {
  texSize: [64, 32],
  animate: animateHumanoidWalk,
  parts: [
    {
      name: "head",
      pivot: [0, 0, 0],
      boxes: [{ texOffs: [0, 0], min: [-4, -8, -4], size: [8, 8, 8] }],
      children: [HUMAN_HAT],
    },
    { name: "body", pivot: [0, 0, 0], boxes: [{ texOffs: [16, 16], min: [-4, 0, -2], size: [8, 12, 4] }] },
    { name: "right_arm", pivot: [-5, 2, 0], boxes: [{ texOffs: [40, 16], min: [-1, -2, -1], size: [2, 12, 2] }] },
    {
      name: "left_arm",
      pivot: [5, 2, 0],
      boxes: [{ texOffs: [40, 16], min: [-1, -2, -1], size: [2, 12, 2], mirror: true }],
    },
    { name: "right_leg", pivot: [-2, 12, 0], boxes: [{ texOffs: [0, 16], min: [-1, 0, -1], size: [2, 12, 2] }] },
    {
      name: "left_leg",
      pivot: [2, 12, 0],
      boxes: [{ texOffs: [0, 16], min: [-1, 0, -1], size: [2, 12, 2], mirror: true }],
    },
  ],
};

/** `CreeperModel.createBodyLayer`, 64×32. */
const CREEPER: MobModelDef = {
  texSize: [64, 32],
  animate: animateCreeper,
  parts: [
    { name: "head", pivot: [0, 6, 0], boxes: [{ texOffs: [0, 0], min: [-4, -8, -4], size: [8, 8, 8] }] },
    { name: "body", pivot: [0, 6, 0], boxes: [{ texOffs: [16, 16], min: [-4, 0, -2], size: [8, 12, 4] }] },
    { name: "right_hind_leg", pivot: [-2, 18, 4], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4] }] },
    { name: "left_hind_leg", pivot: [2, 18, 4], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4] }] },
    { name: "right_front_leg", pivot: [-2, 18, -4], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4] }] },
    { name: "left_front_leg", pivot: [2, 18, -4], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4] }] },
  ],
};

/** `SpiderModel.createSpiderBodyLayer`, 64×32 (aranha e aranha da caverna —
 *  essa última com `MeshTransformer.scaling(0.7)` = `scale` no viewer). */
const SPIDER_LEG_Z = (angle: number): [number, number, number] => [0, angle, -angle];
const SPIDER: MobModelDef = {
  texSize: [64, 32],
  animate: animateSpider,
  parts: [
    { name: "head", pivot: [0, 15, -3], boxes: [{ texOffs: [32, 4], min: [-4, -4, -8], size: [8, 8, 8] }] },
    { name: "body0", pivot: [0, 15, 0], boxes: [{ texOffs: [0, 0], min: [-3, -3, -3], size: [6, 6, 6] }] },
    { name: "body1", pivot: [0, 15, 9], boxes: [{ texOffs: [0, 12], min: [-5, -4, -6], size: [10, 8, 12] }] },
    {
      name: "right_hind_leg",
      pivot: [-4, 15, 2],
      rot: SPIDER_LEG_Z(PI / 4),
      boxes: [{ texOffs: [18, 0], min: [-15, -1, -1], size: [16, 2, 2] }],
    },
    {
      name: "left_hind_leg",
      pivot: [4, 15, 2],
      rot: SPIDER_LEG_Z(-PI / 4),
      boxes: [{ texOffs: [18, 0], min: [-1, -1, -1], size: [16, 2, 2], mirror: true }],
    },
    {
      name: "right_middle_hind_leg",
      pivot: [-4, 15, 1],
      rot: [0, PI / 8, -0.58119464],
      boxes: [{ texOffs: [18, 0], min: [-15, -1, -1], size: [16, 2, 2] }],
    },
    {
      name: "left_middle_hind_leg",
      pivot: [4, 15, 1],
      rot: [0, -PI / 8, 0.58119464],
      boxes: [{ texOffs: [18, 0], min: [-1, -1, -1], size: [16, 2, 2], mirror: true }],
    },
    {
      name: "right_middle_front_leg",
      pivot: [-4, 15, 0],
      rot: [0, -PI / 8, -0.58119464],
      boxes: [{ texOffs: [18, 0], min: [-15, -1, -1], size: [16, 2, 2] }],
    },
    {
      name: "left_middle_front_leg",
      pivot: [4, 15, 0],
      rot: [0, PI / 8, 0.58119464],
      boxes: [{ texOffs: [18, 0], min: [-1, -1, -1], size: [16, 2, 2], mirror: true }],
    },
    {
      name: "right_front_leg",
      pivot: [-4, 15, -1],
      rot: [0, -PI / 4, -PI / 4],
      boxes: [{ texOffs: [18, 0], min: [-15, -1, -1], size: [16, 2, 2] }],
    },
    {
      name: "left_front_leg",
      pivot: [4, 15, -1],
      rot: [0, PI / 4, PI / 4],
      boxes: [{ texOffs: [18, 0], min: [-1, -1, -1], size: [16, 2, 2], mirror: true }],
    },
  ],
};

/** `CowModel.createBaseCowModel` (vaca/mooshroom adultas), 64×64. */
const COW: MobModelDef = {
  texSize: [64, 64],
  animate: animateQuadruped,
  parts: [
    {
      name: "head",
      pivot: [0, 4, -8],
      boxes: [
        { texOffs: [0, 0], min: [-4, -4, -6], size: [8, 8, 6] },
        { texOffs: [1, 33], min: [-3, 1, -7], size: [6, 3, 1] },
        { texOffs: [22, 0], min: [-5, -5, -5], size: [1, 3, 1] },
        { texOffs: [22, 0], min: [4, -5, -5], size: [1, 3, 1] },
      ],
    },
    {
      name: "body",
      pivot: [0, 5, 2],
      rot: [PI / 2, 0, 0],
      boxes: [
        { texOffs: [18, 4], min: [-6, -10, -7], size: [12, 18, 10] },
        { texOffs: [52, 0], min: [-2, 2, -8], size: [4, 6, 1] },
      ],
    },
    { name: "right_hind_leg", pivot: [-4, 12, 7], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4] }] },
    {
      name: "left_hind_leg",
      pivot: [4, 12, 7],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4], mirror: true }],
    },
    { name: "right_front_leg", pivot: [-4, 12, -5], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4] }] },
    {
      name: "left_front_leg",
      pivot: [4, 12, -5],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4], mirror: true }],
    },
  ],
};

/** `BabyCowModel.createBodyLayer`, 64×64. */
const BABY_COW: MobModelDef = {
  texSize: [64, 64],
  animate: animateQuadruped,
  parts: [
    {
      name: "head",
      pivot: [0, 13.569, -5.1667],
      boxes: [
        { texOffs: [0, 18], min: [-3, -4.569, -4.8333], size: [6, 6, 5] },
        { texOffs: [8, 29], min: [3, -5.569, -3.8333], size: [1, 2, 1] },
        { texOffs: [4, 29], min: [-4, -5.569, -3.8333], size: [1, 2, 1], mirror: true },
        { texOffs: [12, 29], min: [-2, -1.569, -5.8333], size: [4, 3, 1] },
      ],
    },
    { name: "body", pivot: [3, 19, -5], boxes: [{ texOffs: [0, 0], min: [-7, -7, -1], size: [8, 6, 12] }] },
    {
      name: "right_front_leg",
      pivot: [-2.5, 18, -3.5],
      boxes: [{ texOffs: [22, 18], min: [-1.5, 0, -1.5], size: [3, 6, 3] }],
    },
    {
      name: "left_front_leg",
      pivot: [2.5, 18, -3.5],
      boxes: [{ texOffs: [34, 18], min: [-1.5, 0, -1.5], size: [3, 6, 3] }],
    },
    {
      name: "right_hind_leg",
      pivot: [-2.5, 18, 3.5],
      boxes: [{ texOffs: [22, 27], min: [-1.5, 0, -1.5], size: [3, 6, 3] }],
    },
    {
      name: "left_hind_leg",
      pivot: [2.5, 18, 3.5],
      boxes: [{ texOffs: [34, 27], min: [-1.5, 0, -1.5], size: [3, 6, 3] }],
    },
  ],
};

/** `PigModel.createBasePigModel` (porco adulto), 64×64. */
const PIG: MobModelDef = {
  texSize: [64, 64],
  animate: animateQuadruped,
  parts: [
    {
      name: "head",
      pivot: [0, 12, -6],
      boxes: [
        { texOffs: [0, 0], min: [-4, -4, -8], size: [8, 8, 8] },
        { texOffs: [16, 16], min: [-2, 0, -9], size: [4, 3, 1] },
      ],
    },
    { name: "body", pivot: [0, 11, 2], rot: [PI / 2, 0, 0], boxes: [{ texOffs: [28, 8], min: [-5, -10, -7], size: [10, 16, 8] }] },
    { name: "right_hind_leg", pivot: [-3, 18, 7], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4] }] },
    {
      name: "left_hind_leg",
      pivot: [3, 18, 7],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4], mirror: true }],
    },
    { name: "right_front_leg", pivot: [-3, 18, -5], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4] }] },
    {
      name: "left_front_leg",
      pivot: [3, 18, -5],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4], mirror: true }],
    },
  ],
};

/** `BabyPigModel.createBodyLayer`, 32×32. */
const BABY_PIG: MobModelDef = {
  texSize: [32, 32],
  animate: animateQuadruped,
  parts: [
    { name: "body", pivot: [0, 19, 0.5], boxes: [{ texOffs: [0, 0], min: [-3.5, -3, -4.5], size: [7, 6, 9] }] },
    {
      name: "head",
      pivot: [0, 19, -2],
      boxes: [
        { texOffs: [0, 15], min: [-3.5, -5, -5], size: [7, 6, 6], grow: 0.025 },
        { texOffs: [6, 27], min: [-1.5, -1.975, -6], size: [3, 2, 1], grow: 0.015 },
      ],
    },
    { name: "left_front_leg", pivot: [2.5, 22, -3], boxes: [{ texOffs: [0, 0], min: [-1, 0, -1], size: [2, 2, 2] }] },
    { name: "right_front_leg", pivot: [-2.5, 22, -3], boxes: [{ texOffs: [23, 0], min: [-1, 0, -1], size: [2, 2, 2] }] },
    { name: "left_hind_leg", pivot: [2.5, 22, 4], boxes: [{ texOffs: [0, 4], min: [-1, 0, -1], size: [2, 2, 2] }] },
    { name: "right_hind_leg", pivot: [-2.5, 22, 4], boxes: [{ texOffs: [23, 4], min: [-1, 0, -1], size: [2, 2, 2] }] },
  ],
};

/** `SheepModel.createBodyLayer` (ovelha adulta, sem lã), 64×32. */
const SHEEP: MobModelDef = {
  texSize: [64, 32],
  animate: animateQuadruped,
  parts: [
    { name: "head", pivot: [0, 6, -8], boxes: [{ texOffs: [0, 0], min: [-3, -4, -6], size: [6, 6, 8] }] },
    { name: "body", pivot: [0, 5, 2], rot: [PI / 2, 0, 0], boxes: [{ texOffs: [28, 8], min: [-4, -10, -7], size: [8, 16, 6] }] },
    {
      name: "right_hind_leg",
      pivot: [-3, 12, 7],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4], mirror: true }],
    },
    { name: "left_hind_leg", pivot: [3, 12, 7], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4] }] },
    {
      name: "right_front_leg",
      pivot: [-3, 12, -5],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4], mirror: true }],
    },
    { name: "left_front_leg", pivot: [3, 12, -5], boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 12, 4] }] },
  ],
};

/** `SheepFurModel.createFurLayer` — a camada de lã da ovelha adulta, tingida
 *  pela cor real da lã (`tint`). */
const SHEEP_FUR: MobModelDef = {
  texSize: [64, 32],
  animate: animateQuadruped,
  parts: [
    {
      name: "head",
      pivot: [0, 6, -8],
      boxes: [{ texOffs: [0, 0], min: [-3, -4, -4], size: [6, 6, 6], grow: 0.6 }],
    },
    {
      name: "body",
      pivot: [0, 5, 2],
      rot: [PI / 2, 0, 0],
      boxes: [{ texOffs: [28, 8], min: [-4, -10, -7], size: [8, 16, 6], grow: 1.75 }],
    },
    {
      name: "right_hind_leg",
      pivot: [-3, 12, 7],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4], grow: 0.5 }],
    },
    {
      name: "left_hind_leg",
      pivot: [3, 12, 7],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4], grow: 0.5 }],
    },
    {
      name: "right_front_leg",
      pivot: [-3, 12, -5],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4], grow: 0.5 }],
    },
    {
      name: "left_front_leg",
      pivot: [3, 12, -5],
      boxes: [{ texOffs: [0, 16], min: [-2, 0, -2], size: [4, 6, 4], grow: 0.5 }],
    },
  ],
};

/** `BabySheepModel.createBodyLayer`, 64×32 (a lã do filhote no jogo usa esta
 *  mesma geometria com a textura `sheep_wool_baby`). */
const BABY_SHEEP: MobModelDef = {
  texSize: [64, 32],
  animate: animateQuadruped,
  parts: [
    { name: "body", pivot: [0, 17, 0.5], boxes: [{ texOffs: [0, 10], min: [-3, -2, -4.5], size: [6, 4, 9] }] },
    { name: "head", pivot: [0, 15.5, -2.5], boxes: [{ texOffs: [0, 0], min: [-2.5, -4.5, -3.5], size: [5, 5, 5] }] },
    { name: "right_hind_leg", pivot: [-2, 19, 3], boxes: [{ texOffs: [0, 23], min: [-1, 0, -1], size: [2, 5, 2] }] },
    { name: "left_hind_leg", pivot: [2, 19, 3], boxes: [{ texOffs: [24, 12], min: [-1, 0, -1], size: [2, 5, 2] }] },
    { name: "right_front_leg", pivot: [-2, 19, -2], boxes: [{ texOffs: [8, 23], min: [-1, 0, -1], size: [2, 5, 2] }] },
    { name: "left_front_leg", pivot: [2, 19, -2], boxes: [{ texOffs: [24, 5], min: [-1, 0, -1], size: [2, 5, 2] }] },
  ],
};

/** `AdultChickenModel.createBaseChickenModel`, 64×32. */
const CHICKEN: MobModelDef = {
  texSize: [64, 32],
  animate: animateChicken,
  parts: [
    {
      name: "head",
      pivot: [0, 15, -4],
      boxes: [{ texOffs: [0, 0], min: [-2, -6, -2], size: [4, 6, 3] }],
      children: [
        { name: "beak", pivot: [0, 0, 0], boxes: [{ texOffs: [14, 0], min: [-2, -4, -4], size: [4, 2, 2] }] },
        { name: "red_thing", pivot: [0, 0, 0], boxes: [{ texOffs: [14, 4], min: [-1, -2, -3], size: [2, 2, 2] }] },
      ],
    },
    { name: "body", pivot: [0, 16, 0], rot: [PI / 2, 0, 0], boxes: [{ texOffs: [0, 9], min: [-3, -4, -3], size: [6, 8, 6] }] },
    { name: "right_leg", pivot: [-2, 19, 1], boxes: [{ texOffs: [26, 0], min: [-1, 0, -3], size: [3, 5, 3] }] },
    { name: "left_leg", pivot: [1, 19, 1], boxes: [{ texOffs: [26, 0], min: [-1, 0, -3], size: [3, 5, 3] }] },
    { name: "right_wing", pivot: [-4, 13, 0], boxes: [{ texOffs: [24, 13], min: [0, 0, -3], size: [1, 4, 6] }] },
    { name: "left_wing", pivot: [4, 13, 0], boxes: [{ texOffs: [24, 13], min: [-1, 0, -3], size: [1, 4, 6] }] },
  ],
};

/** `BabyChickenModel.createBodyLayer`, 16×16 (modelo próprio, sem cabeça). */
const BABY_CHICKEN: MobModelDef = {
  texSize: [16, 16],
  animate: animateChicken,
  parts: [
    {
      name: "body",
      pivot: [0, 20.25, -1.25],
      boxes: [
        { texOffs: [0, 0], min: [-2, -2.25, -0.75], size: [4, 4, 4] },
        { texOffs: [10, 8], min: [-1, -0.25, -1.75], size: [2, 1, 1] },
      ],
    },
    {
      name: "left_leg",
      pivot: [1, 22, 0.5],
      boxes: [
        { texOffs: [2, 2], min: [-0.5, 0, 0], size: [1, 2, 0] },
        { texOffs: [0, 1], min: [-0.5, 2, -1], size: [1, 0, 1] },
      ],
    },
    {
      name: "right_leg",
      pivot: [-1, 22, 0.5],
      boxes: [
        { texOffs: [0, 2], min: [-0.5, 0, 0], size: [1, 2, 0] },
        { texOffs: [0, 0], min: [-0.5, 2, -1], size: [1, 0, 1] },
      ],
    },
    { name: "right_wing", pivot: [2, 20, 0], boxes: [{ texOffs: [6, 8], min: [0, 0, -1], size: [1, 0, 2] }] },
    { name: "left_wing", pivot: [-2, 20, 0], boxes: [{ texOffs: [4, 8], min: [-1, 0, -1], size: [1, 0, 2] }] },
  ],
};

// ---------------------------------------------------------------------------
// Tipo de mob → modelo/textura (as texturas vêm do `get_entity_textures`)
// ---------------------------------------------------------------------------

/** O que o viewer precisa montar pra um mob: modelo + textura (+ a camada de
 *  sobreposição da ovelha, que usa a cor real da lã como tint). */
export interface MobVisualSpec {
  def: MobModelDef;
  texture: string;
  overlay?: { def: MobModelDef; texture: string };
  /** Escala do grupo (aranha da caverna = `MeshTransformer.scaling(0.7)`). */
  scale: number;
}

interface MobKindSpec {
  def: MobModelDef;
  texture: string;
  babyDef?: MobModelDef;
  babyTexture?: string;
  scale?: number;
  /** Camada de sobreposição da ovelha (lã), tingida pelo `tint` real. */
  wool?: { def: MobModelDef; texture: string; babyDef?: MobModelDef; babyTexture?: string };
}

const MOB_KINDS: Record<string, MobKindSpec> = {
  zombie: { def: HUMANOID, texture: "entity/zombie/zombie.png", babyDef: BABY_ZOMBIE, babyTexture: "entity/zombie/zombie_baby.png" },
  husk: { def: HUMANOID, texture: "entity/zombie/husk.png", babyDef: BABY_ZOMBIE, babyTexture: "entity/zombie/husk_baby.png" },
  drowned: { def: HUMANOID, texture: "entity/zombie/drowned.png", babyDef: BABY_ZOMBIE, babyTexture: "entity/zombie/drowned_baby.png" },
  skeleton: { def: SKELETON, texture: "entity/skeleton/skeleton.png" },
  stray: { def: SKELETON, texture: "entity/skeleton/stray.png" },
  wither_skeleton: { def: SKELETON, texture: "entity/skeleton/wither_skeleton.png" },
  bogged: { def: SKELETON, texture: "entity/skeleton/bogged.png" },
  creeper: { def: CREEPER, texture: "entity/creeper/creeper.png" },
  spider: { def: SPIDER, texture: "entity/spider/spider.png" },
  cave_spider: { def: SPIDER, texture: "entity/spider/cave_spider.png", scale: 0.7 },
  cow: {
    def: COW,
    texture: "entity/cow/cow_temperate.png",
    babyDef: BABY_COW,
    babyTexture: "entity/cow/cow_temperate_baby.png",
  },
  mooshroom: {
    def: COW,
    texture: "entity/cow/mooshroom_red.png",
    babyDef: BABY_COW,
    babyTexture: "entity/cow/mooshroom_red_baby.png",
  },
  pig: {
    def: PIG,
    texture: "entity/pig/pig_temperate.png",
    babyDef: BABY_PIG,
    babyTexture: "entity/pig/pig_temperate_baby.png",
  },
  sheep: {
    def: SHEEP,
    texture: "entity/sheep/sheep.png",
    babyDef: BABY_SHEEP,
    babyTexture: "entity/sheep/sheep_baby.png",
    wool: {
      def: SHEEP_FUR,
      texture: "entity/sheep/sheep_wool.png",
      babyDef: BABY_SHEEP,
      babyTexture: "entity/sheep/sheep_wool_baby.png",
    },
  },
  chicken: {
    def: CHICKEN,
    texture: "entity/chicken/chicken_temperate.png",
    babyDef: BABY_CHICKEN,
    babyTexture: "entity/chicken/chicken_temperate_baby.png",
  },
};

/** Modelo/textura de um tipo de mob (nome de registro, ex: `cow`). `null` =
 *  o viewer não tem modelo pra esse tipo e mantém só o rótulo. `wool` só
 *  entra quando o addon mandou `tint` (ovelha com lã) — tosquiada não tem
 *  sobreposição. */
export function mobVisualSpec(
  kind: string,
  isBaby: boolean,
  hasWool: boolean
): MobVisualSpec | null {
  const spec = MOB_KINDS[kind];
  if (!spec) return null;
  const useBaby = isBaby && spec.babyDef;
  const visual: MobVisualSpec = {
    def: useBaby ? spec.babyDef! : spec.def,
    texture: useBaby ? spec.babyTexture ?? spec.texture : spec.texture,
    scale: spec.scale ?? 1,
  };
  if (spec.wool && hasWool) {
    const woolDef = (useBaby && spec.wool.babyDef) || spec.wool.def;
    const woolTexture = (useBaby && spec.wool.babyTexture) || spec.wool.texture;
    visual.overlay = { def: woolDef, texture: woolTexture };
  }
  return visual;
}

// ---------------------------------------------------------------------------
// Instância: grupo animado sobre uma textura (geometria compartilhada)
// ---------------------------------------------------------------------------

/** Ciclo de caminhada — mesmas contas do `LivingEntity.updateWalkAnimation`
 *  (distância por tick × 4, suavização 0.4), como no `player_model.ts`. */
class WalkCycle {
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;
  private accumulator = 0;
  position = 0;
  speed = 0;

  update(dt: number, pos: THREE.Vector3): void {
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= 1 / TICKS_PER_SECOND) {
      this.accumulator -= 1 / TICKS_PER_SECOND;
      if (this.hasLast) {
        const distance = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z);
        const target = distance < 0.002 ? 0 : Math.min(distance * 4, 1);
        this.speed += (target - this.speed) * 0.4;
        if (this.speed < 0.005) this.speed = 0;
        this.position += this.speed;
      }
      this.lastPos.copy(pos);
      this.hasLast = true;
    }
  }
}

/** Interpola ângulos em graus pelo caminho mais curto (yaw dá a volta). */
function lerpAngleDeg(current: number, target: number, alpha: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return current + delta * alpha;
}

function instantiate(
  compiled: CompiledPart[],
  material: THREE.Material,
  parts: Map<string, THREE.Group>,
  parent: THREE.Group,
  isRoot: boolean
): void {
  for (const part of compiled) {
    const group = new THREE.Group();
    group.name = part.spec.name;
    // Ordem de composição do `PartPose` (Z→Y→X) — ver comentário do módulo.
    group.rotation.order = "ZYX";
    const [px, py, pz] = part.spec.pivot;
    group.position.set(px * PX, (isRoot ? GROUND_PX - py : -py) * PX, -pz * PX);
    const baseRot = part.spec.rot ?? [0, 0, 0];
    group.userData.baseRot = baseRot;
    group.rotation.set(baseRot[0], -baseRot[1], -baseRot[2]);
    for (const geometry of part.geometries) group.add(new THREE.Mesh(geometry, material));
    parts.set(part.spec.name, group);
    parent.add(group);
    instantiate(part.children, material, parts, group, false);
  }
}

/** Um mob desenhado no viewer: grupo posicionado nos pés, girado pelo yaw do
 *  corpo, com as partes animadas pelo `MobModelDef.animate`. */
export class MobModel {
  readonly group = new THREE.Group();

  private readonly def: MobModelDef;
  private readonly parts = new Map<string, THREE.Group>();
  private readonly overlayDef: MobModelDef | null;
  private readonly overlayParts = new Map<string, THREE.Group>();
  private readonly walk = new WalkCycle();
  private displayedYaw = 0;

  constructor(
    spec: MobVisualSpec,
    baseMaterial: THREE.Material,
    overlayMaterial: THREE.Material | null
  ) {
    this.def = spec.def;
    this.group.scale.setScalar(spec.scale);
    instantiate(compileModel(this.def), baseMaterial, this.parts, this.group, true);

    if (spec.overlay && overlayMaterial) {
      this.overlayDef = spec.overlay.def;
      const overlayGroup = new THREE.Group();
      instantiate(compileModel(this.overlayDef), overlayMaterial, this.overlayParts, overlayGroup, true);
      this.group.add(overlayGroup);
    } else {
      this.overlayDef = null;
    }
  }

  /** Atualiza pose/posição; `pos` já vem interpolada pelo viewer (mesmo vetor
   *  que posiciona o rótulo). */
  update(
    dt: number,
    pos: THREE.Vector3,
    yawDeg: number,
    headYawDeg: number,
    pitchDeg: number
  ): void {
    this.group.position.copy(pos);
    this.displayedYaw = lerpAngleDeg(this.displayedYaw, yawDeg, 1 - Math.exp(-10 * dt));
    this.group.rotation.y = THREE.MathUtils.degToRad(-this.displayedYaw);

    this.walk.update(dt, pos);
    const state: MobAnimState = {
      walkPosition: this.walk.position,
      walkSpeed: this.walk.speed,
      headYaw: headYawDeg,
      pitch: pitchDeg,
    };
    this.def.animate(this.parts, state);
    if (this.overlayDef) this.overlayDef.animate(this.overlayParts, state);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.parts.clear();
    this.overlayParts.clear();
  }
}
