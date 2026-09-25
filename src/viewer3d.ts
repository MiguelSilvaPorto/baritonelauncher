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

export interface ChunkPos {
  x: number;
  z: number;
}

export interface BotPos {
  x: number;
  y: number;
  z: number;
}

export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;

  private chunkMeshes = new Map<string, THREE.Object3D>();
  private botMarker: THREE.Group;
  private botLight: THREE.PointLight;
  private hasFramedInitialView = false;

  private labelEl: HTMLDivElement;

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
      new THREE.MeshStandardMaterial({ color: COLOR_TEAL, emissive: COLOR_TEAL, emissiveIntensity: 0.9 })
    );
    group.add(sphere);
    return group;
  }

  private chunkKey(pos: ChunkPos): string {
    return `${pos.x},${pos.z}`;
  }

  /** Chunks só são adicionados, nunca removidos — ver doc-comment do módulo
   * e de `addon_socket.rs`: é o "já explorado" cumulativo. */
  setChunks(chunks: ChunkPos[]) {
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

      group.position.set(pos.x * CHUNK_SIZE + CHUNK_SIZE / 2, 0, pos.z * CHUNK_SIZE + CHUNK_SIZE / 2);
      this.scene.add(group);
      this.chunkMeshes.set(key, group);
    }
  }

  setBotPos(pos: BotPos | null) {
    if (!pos) {
      this.botMarker.visible = false;
      this.labelEl.style.display = "none";
      return;
    }
    this.botMarker.visible = true;
    this.botMarker.position.set(pos.x, pos.y + 1, pos.z);
    this.labelEl.textContent = `${pos.x}, ${pos.y}, ${pos.z}`;

    if (!this.hasFramedInitialView) {
      this.hasFramedInitialView = true;
      this.controls.target.set(pos.x, pos.y, pos.z);
      this.camera.position.set(pos.x + 40, pos.y + 45, pos.z + 40);
    }
  }

  /** Sem chunks nem bot ainda — estado honesto, não mostra uma cena vazia
   * como se fosse "carregada". Chamado quando o addon desconecta. */
  clear() {
    for (const mesh of this.chunkMeshes.values()) this.scene.remove(mesh);
    this.chunkMeshes.clear();
    this.botMarker.visible = false;
    this.labelEl.style.display = "none";
    this.hasFramedInitialView = false;
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
