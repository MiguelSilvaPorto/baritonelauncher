import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Viewer3D, CHUNKS_PER_REFRESH, NEARBY_CHUNK_LIMIT, type BotPos, type BotPose, type ChunkPos, type UvRect } from "./viewer3d";
interface TextureAtlas {
  image_data_url: string;
  textures: Record<string, UvRect>;
}

/* ---------- Tipos (espelham as structs em src-tauri/src) ---------- */

interface ConnectionStatus {
  connected: boolean;
  endpoint?: string;
}

interface WorldSummary {
  chunks_explored: number;
  chunks_total_estimate: number;
  bot_pos?: BotPos;
}

/** Skin real do jogador (comando `player_skin`, ver `player_skin.rs`). */
interface PlayerSkin {
  name: string;
  model: string;
  image_data_url: string;
}
type InstructionStatus = "Queued" | "Active" | "Paused" | "Done" | "Failed" | "Canceled";
type InstructionKind =
  | "Explore"
  | "Mine"
  | "Build"
  | "FetchFromChest"
  | "Craft"
  | "Smelt"
  | "TravelTo";

/** Alvo horizontal (x, z) — ver `InstructionTarget` em src-tauri/src/instructions.rs. */
interface InstructionTarget {
  x: number;
  z: number;
}

interface Instruction {
  id: string;
  kind: InstructionKind;
  label: string;
  status: InstructionStatus;
  progress: number;
  target: InstructionTarget | null;
}

interface ItemTotal {
  item_id: number;
  total: number;
  chest_count: number;
}

interface ArmorPiece {
  item_id: number;
  durability_pct: number;
}

interface Vitals {
  health: number;
  max_health: number;
  hunger: number;
  saturation: number;
  armor_points: number;
  armor_pieces: (ArmorPiece | null)[];
  active_effects: { name: string; duration_ticks: number; amplifier: number }[];
}

/* ---------- Helpers ---------- */

const $ = <T extends Element = Element>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends Element = Element>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];

/* ---------- Navegação (rail) ---------- */

function setMode(mode: string) {
  $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${mode}`));
  $$(".rail-btn").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.mode === mode));
  // A view-viewer fica display:none nos outros modos — o WebGLRenderer não
  // vê isso, então o tamanho do canvas fica desatualizado até isso rodar.
  if (mode === "viewer") viewer3d?.resize();
}

function bootstrapRail() {
  $$<HTMLButtonElement>(".rail-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode ?? "viewer"));
  });
  setMode("viewer");
}

/* ---------- Titlebar customizada ---------- */

function bootstrapTitlebar() {
  const win = getCurrentWindow();
  $("#win-min").addEventListener("click", () => win.minimize());
  $("#win-max").addEventListener("click", () => win.toggleMaximize());
  $("#win-close").addEventListener("click", () => win.close());
}

/* ---------- Fila de instruções ---------- */

const STATUS_LABEL: Record<InstructionStatus, string> = {
  Queued: "na fila",
  Active: "ativo",
  Paused: "pausado",
  Done: "concluído",
  Failed: "falhou",
  Canceled: "cancelado",
};

function queueCard(instruction: Instruction): string {
  const statusClass = `status-${instruction.status.toLowerCase()}`;
  const cancellable = instruction.status === "Queued" || instruction.status === "Active";
  // `Explore` é contínuo e não tem progresso mensurável (o addon não manda
  // `progress`) — barra só onde existe progresso real, nada de fingir 0%.
  const showBar = !(instruction.kind === "Explore" && instruction.status === "Active");
  return `
    <div class="queue-card ${statusClass}">
      <div class="row1">
        <span class="label">${instruction.label}</span>
        <span class="kind mono">${STATUS_LABEL[instruction.status]}</span>
      </div>
      ${showBar ? `<div class="bar"><span style="width:${Math.round(instruction.progress * 100)}%"></span></div>` : ""}
      ${cancellable ? `<button type="button" class="queue-cancel" data-queue-cancel="${instruction.id}">cancelar</button>` : ""}
    </div>
  `;
}

function renderQueueInto(listId: string, countId: string | null, items: Instruction[]) {
  const list = $(`#${listId}`);
  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="headline">Fila vazia</span>
        <span class="detail">Enfileire uma instrução acima: "Ir para" manda o bot viajar até as coordenadas x/z e "Explorar" cobre a área a partir de onde ele está — o addon executa com o pathing do Baritone e devolve status/progresso. Resolução automática de dependências (baú/craft) ainda não está ligada.</span>
      </div>
    `;
  } else {
    list.innerHTML = items.map(queueCard).join("");
  }
  if (countId) $(`#${countId}`).textContent = String(items.length);
}

function renderQueue(items: Instruction[]) {
  renderQueueInto("queue-list", "queue-count", items);
  renderQueueInto("queue-list-full", "queue-count-full", items);
}

/** Mesma instrução "Ir para"/"Explorar" nos dois painéis de fila (viewer e
 *  view cheia) — `lastBotPos` vem do polling e é a origem do "Explorar". */
function bootstrapQueueComposers() {
  $$<HTMLElement>(".queue-composer").forEach((composer) => {
    const xInput = composer.querySelector<HTMLInputElement>('input[name="x"]');
    const zInput = composer.querySelector<HTMLInputElement>('input[name="z"]');

    composer.querySelector('[data-queue-action="travel"]')?.addEventListener("click", () => {
      const x = Number(xInput?.value);
      const z = Number(zInput?.value);
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        (Number.isFinite(x) ? zInput : xInput)?.focus();
        return;
      }
      invoke<Instruction[]>("queue_push", { kind: "TravelTo", target: { x: Math.round(x), z: Math.round(z) } })
        .then(renderQueue)
        .catch((err) => console.error("[fila] ir para falhou:", err));
    });

    composer.querySelector('[data-queue-action="explore"]')?.addEventListener("click", () => {
      const target = lastBotPos ? { x: lastBotPos.x, z: lastBotPos.z } : null;
      invoke<Instruction[]>("queue_push", { kind: "Explore", target })
        .then(renderQueue)
        .catch((err) => console.error("[fila] explorar falhou:", err));
    });
  });
}

function bootstrapQueueActions() {
  // Delegação: os cards são innerHTML recriado a cada refresh, então o
  // listener fica no container, não no botão.
  $$<HTMLElement>(".queue-list").forEach((list) => {
    list.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-queue-cancel]");
      if (!btn) return;
      invoke<Instruction[]>("queue_cancel", { id: btn.dataset.queueCancel })
        .then(renderQueue)
        .catch((err) => console.error("[fila] cancelar falhou:", err));
    });
  });
}

/* ---------- Armazém ---------- */

function renderStorage(totals: ItemTotal[]) {
  const body = $("#storage-body");
  const footer = $("#storage-footer");

  if (totals.length === 0) {
    body.innerHTML = `
      <div class="empty-state" style="height: 100%;">
        <span class="headline">Nenhum baú indexado</span>
        <span class="detail">Baús aparecem aqui assim que o addon Java reporta posição e conteúdo pelo socket local — ver <code>docs/SPEC.md</code>, seção "Índice de armazenamento".</span>
      </div>
    `;
    footer.innerHTML = `<div class="footer-row"><span class="label">totais</span><span class="value mono">—</span></div>`;
    return;
  }

  body.innerHTML = `
    <table class="item-table">
      <thead><tr><th>item</th><th>baús</th><th>quantidade</th></tr></thead>
      <tbody>
        ${totals
          .map(
            (t) => `<tr><td class="mono">#${t.item_id}</td><td class="num mono">${t.chest_count}</td><td class="num mono">${t.total}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  footer.innerHTML = totals
    .slice(0, 6)
    .map((t) => `<div class="footer-row"><span class="label">#${t.item_id}</span><span class="value mono">${t.total}</span></div>`)
    .join("");
}

/* ---------- Viewer: status de conexão + resumo do mundo ---------- */

function renderViewer(status: ConnectionStatus, world: WorldSummary) {
  const empty = $("#viewer-empty");
  const endpoint = $("#viewer-endpoint");
  const hasWorld = world.chunks_explored > 0;

  // Sem conexão e sem nada em cache não há o que renderizar — estado honesto,
  // e a cena é limpa (ex: primeira execução, ou cache apagado).
  if (!status.connected && !hasWorld) {
    empty.classList.remove("hidden");
    endpoint.textContent = "socket: aguardando o addon Java";
    viewer3d?.clear();
    return;
  }

  empty.classList.add("hidden");
  endpoint.textContent = status.connected
    ? `socket: ${status.endpoint ?? "conectado"}`
    : "jogo não conectado — mostrando o mundo em cache";

  let chip = $<HTMLElement>("#progress-chip");
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "progress-chip";
    chip.className = "progress-chip";
    $("#viewer-canvas").appendChild(chip);
  }
  // Sem uma noção real de "total do mundo" (isso exigiria saber o quanto
  // falta explorar, que não temos), a barra de progresso só faz sentido
  // quando chunks_total_estimate vem preenchido. Sem isso, mostrar "0%"
  // seria inventar um dado — então só a contagem crua.
  if (!status.connected) {
    chip.innerHTML = `<span class="pct mono">${world.chunks_explored} chunks em cache</span>`;
  } else if (world.chunks_total_estimate > 0) {
    const pct = Math.round((world.chunks_explored / world.chunks_total_estimate) * 100);
    chip.innerHTML = `
      <div class="bar"><span style="width:${pct}%"></span></div>
      <span class="pct mono">${pct}% · ${world.chunks_explored} / ${world.chunks_total_estimate} chunks</span>
    `;
  } else {
    chip.innerHTML = `<span class="pct mono">${world.chunks_explored} chunks vistos</span>`;
  }
}

/* ---------- HUD de vitais ---------- */

function armorClass(pct: number): string {
  if (pct > 50) return "ok";
  if (pct >= 20) return "warn";
  return "crit";
}

function renderHud(vitals: Vitals | null) {
  let hud = $<HTMLElement>("#hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "hud";
    hud.className = "hud";
    $("#viewer-canvas").appendChild(hud);
  }

  if (!vitals) {
    hud.innerHTML = `
      <div class="hud-stat"><span class="stat-label">vida</span><span class="stat-value mono">—</span></div>
      <div class="hud-stat"><span class="stat-label">fome</span><span class="stat-value mono">—</span></div>
      <div class="hud-stat"><span class="stat-label">armadura</span><span class="stat-value mono">—</span></div>
    `;
    return;
  }

  const healthPct = Math.round((vitals.health / vitals.max_health) * 100);
  const hungerPct = Math.round((vitals.hunger / 20) * 100);
  const armorPips = vitals.armor_pieces
    .map((piece) => `<span class="armor-pip ${piece ? armorClass(piece.durability_pct * 100) : ""}"></span>`)
    .join("");

  hud.innerHTML = `
    <div class="hud-stat">
      <span class="stat-label">vida</span>
      <div class="stat-row">
        <div class="stat-track health"><span style="width:${healthPct}%"></span></div>
        <span class="stat-value mono">${vitals.health.toFixed(0)}/${vitals.max_health.toFixed(0)}</span>
      </div>
    </div>
    <div class="hud-stat">
      <span class="stat-label">fome</span>
      <div class="stat-row">
        <div class="stat-track hunger"><span style="width:${hungerPct}%"></span></div>
        <span class="stat-value mono">${vitals.hunger}/20</span>
      </div>
    </div>
    <div class="hud-stat">
      <span class="stat-label">armadura</span>
      <div class="armor-pips">${armorPips}</div>
    </div>
  `;
}

/* ---------- Bootstrap ---------- */

let viewer3d: Viewer3D | null = null;
/** Última posição do bot (do polling) — origem do "Explorar" no composer. */
let lastBotPos: BotPos | null = null;
/** Chunks já pedidos e ainda não resolvidos — evita pedir de novo no próximo
 * refresh antes da resposta do anterior chegar. */
const pendingChunks = new Set<string>();

function requestChunk(pos: ChunkPos) {
  const key = `${pos.x},${pos.z}`;
  if (!viewer3d || viewer3d.hasChunk(pos.x, pos.z) || pendingChunks.has(key)) return;
  pendingChunks.add(key);
  invoke<ArrayBuffer | number[]>("chunk_voxels", { x: pos.x, z: pos.z })
    .then((raw) => {
      // `tauri::ipc::Response` chega como ArrayBuffer; o fallback cobre uma
      // resposta JSON antiga em vez de estourar.
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
      viewer3d?.addChunkVoxels(pos.x, pos.z, bytes);
    })
    .catch((err) => console.error(`[chunk_voxels] (${pos.x}, ${pos.z})`, err))
    .finally(() => pendingChunks.delete(key));
}

async function refreshState() {
  const [status, world, queue, totals, vitals, skin] = await Promise.all([
    invoke<ConnectionStatus>("connection_status"),
    invoke<WorldSummary>("world_summary"),
    invoke<Instruction[]>("queue_snapshot"),
    invoke<ItemTotal[]>("storage_totals"),
    invoke<Vitals | null>("vitals_snapshot"),
    invoke<PlayerSkin | null>("player_skin"),
  ]);

  lastBotPos = world.bot_pos ?? null;
  renderViewer(status, world);

  if (viewer3d) {
    // Atlas: não depende mais do jogo estar aberto — a versão do MC fica no
    // cache em disco (ver `world_store.rs`), então o mundo persistido abre
    // texturizado. Sem versão conhecida (nunca conectou), o comando falha e
    // a tentativa se repete no próximo refresh.
    if (
      !viewer3d.hasAtlas() &&
      !viewer3d.isLoadingAtlas &&
      (status.connected || world.chunks_explored > 0)
    ) {
      invoke<TextureAtlas>("get_texture_atlas")
        .then((atlas) => viewer3d?.setAtlas(atlas.image_data_url, atlas.textures))
        .catch((err) => console.warn("[atlas] ainda indisponível:", err));
    }
    // Sem o jogo aberto o `bot_pos` do Rust volta a ser `None` — esconde o
    // modelo aqui (o polling de `bot_pose` faria o mesmo em 250ms, mas isso
    // mantém a garantia explícita de nunca ficar congelado na última pose).
    if (!world.bot_pos) viewer3d.setBotPose(null);

    // A skin real (ou `null` enquanto o addon não mandou) — o viewer mostra o
    // modelo sem textura em vez de inventar uma skin.
    viewer3d.setPlayerSkin(skin ? { model: skin.model, imageDataUrl: skin.image_data_url } : null);

    // Prioridade: chunks ao redor do bot primeiro. O backend devolve os N
    // mais próximos já ordenados (`world_chunks_near`); antes disso o cache
    // inteiro vinha em ordem arbitrária de `HashMap` e o terreno ao redor do
    // bot podia chegar por último. Com o jogo fechado (mundo em cache sendo
    // navegado) a âncora passa a ser o ponto que a câmera orbita.
    const anchor: ChunkPos = world.bot_pos
      ? { x: world.bot_pos.x >> 4, z: world.bot_pos.z >> 4 }
      : viewer3d.getFocusChunk();
    try {
      const chunks = await invoke<ChunkPos[]>("world_chunks_near", {
        x: anchor.x,
        z: anchor.z,
        limit: NEARBY_CHUNK_LIMIT,
      });
      // Voxels são buscados aos poucos; a montagem em si já é orçada por
      // frame no viewer (`drainMeshQueue`), então pedir vários por refresh
      // não trava — só acelera o preenchimento ao redor do bot.
      let budget = CHUNKS_PER_REFRESH;
      for (const pos of chunks) {
        if (budget <= 0) break;
        if (viewer3d.hasChunk(pos.x, pos.z) || pendingChunks.has(`${pos.x},${pos.z}`)) continue;
        requestChunk(pos);
        budget--;
      }
    } catch (err) {
      console.warn("[chunks] prioridade por distância indisponível:", err);
    }
  }
  renderHud(vitals);
  renderQueue(queue);
  renderStorage(totals);
}

// 1s = mesmo intervalo de envio de vitais do addon (ver addon_socket.rs) — não
// há push do backend pro frontend ainda, então isso é polling, não streaming.
const REFRESH_INTERVAL_MS = 1000;

// 250ms = mesma cadência do envio de `position` do addon (4x/s). A pose anda
// em intervalo próprio porque no polling de 1s o modelo andaria em saltos; o
// payload é minúsculo (5 números), então não pesa.
const POSE_INTERVAL_MS = 250;

async function refreshPose() {
  try {
    viewer3d?.setBotPose(await invoke<BotPose | null>("bot_pose"));
  } catch (err) {
    console.error("[bot_pose]", err);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  bootstrapRail();
  bootstrapTitlebar();
  bootstrapQueueComposers();
  bootstrapQueueActions();

  viewer3d = new Viewer3D($<HTMLElement>("#viewer-3d"), $<HTMLDivElement>("#bot-label"));
  window.addEventListener("resize", () => viewer3d?.resize());

  refreshState();
  setInterval(refreshState, REFRESH_INTERVAL_MS);
  refreshPose();
  setInterval(refreshPose, POSE_INTERVAL_MS);
});
