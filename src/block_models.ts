/**
 * Modelos de bloco reais (tocha, cogumelo, vitória-régia, escada, cerca...) —
 * decoder do payload binário assado pelo `block_models.rs` a partir do client
 * jar local, e o matching das variantes do blockstate.
 *
 * O viewer desenhava **todo** bloco como cubo cheio; aqui chegam as faces
 * reais de quem não é cubo, já no espaço do bloco (1/16) e na ordem de cantos
 * do `FACES` do `viewer3d.ts`. Ver `block_models.rs` pro layout e pro porte
 * fiel do `FaceBakery`/`CuboidRotation`/`BlockMath` do jogo.
 */

/** Versão do payload — precisa bater com `block_models::MODELS_PAYLOAD_VERSION`. */
export const MODELS_PAYLOAD_VERSION = 1;

export interface BlockModelPart {
  /** Índices em `conditions` (OR) — vazio = sempre aplica. */
  when: number[];
  /** Índice em `geos`. */
  geo: number;
}

export interface BlockModelDef {
  /** `true` = multipart (todas as partes que casam); `false` = variants
   *  (só a primeira que casa, na ordem do JSON). */
  multipart: boolean;
  parts: BlockModelPart[];
}

export interface QuadArrays {
  /** 4 vértices × 3 eixos por quad, em 1/16 de bloco (já rotacionados). */
  p: Int16Array;
  /** 4 UVs × 2 por quad, em 1/16 de pixel de textura. */
  uv: Uint16Array;
  /** Nome da textura (índice em `textures`). */
  tex: Uint16Array;
  /** Face do cubo que culla (índice do `FACES`) ou −1. */
  cull: Int8Array;
  /** `tintindex` do modelo (−1 = sem tint). */
  tint: Int8Array;
}

export interface DecodedBlockModels {
  textures: string[];
  conditions: string[];
  /** Intervalo em `quads` de cada geometria. */
  geos: { start: number; count: number }[];
  quads: QuadArrays;
  blocks: Map<string, BlockModelDef>;
}

const UTF8 = new TextDecoder();

/** Decodifica o payload binário (little-endian) — mesma estrutura escrita em
 * `block_models::encode_payload`. Qualquer payload truncado/versão errada
 * lança, e quem chamou mantém o viewer no modo antigo (cubo). */
export function decodeBlockModels(bytes: Uint8Array): DecodedBlockModels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const need = (n: number) => {
    if (offset + n > bytes.length) throw new Error("payload de modelos truncado");
  };
  const u8 = () => {
    need(1);
    return view.getUint8(offset++);
  };
  const i8 = () => {
    need(1);
    return view.getInt8(offset++);
  };
  const u16 = () => {
    need(2);
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const i16 = () => {
    need(2);
    const value = view.getInt16(offset, true);
    offset += 2;
    return value;
  };
  const u32 = () => {
    need(4);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const utf8 = () => {
    const length = u16();
    need(length);
    const value = UTF8.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const stringTable = () => {
    const count = u16();
    const values: string[] = new Array(count);
    for (let i = 0; i < count; i++) values[i] = utf8();
    return values;
  };

  const version = u8();
  if (version !== MODELS_PAYLOAD_VERSION) {
    throw new Error(`versão de modelos desconhecida: ${version}`);
  }

  const textures = stringTable();
  const conditions = stringTable();

  const geoCount = u16();
  const counts = new Uint16Array(geoCount);
  let totalQuads = 0;
  for (let i = 0; i < geoCount; i++) {
    counts[i] = u16();
    totalQuads += counts[i];
  }
  const geos: { start: number; count: number }[] = new Array(geoCount);
  {
    let start = 0;
    for (let i = 0; i < geoCount; i++) {
      geos[i] = { start, count: counts[i] };
      start += counts[i];
    }
  }

  const quads: QuadArrays = {
    p: new Int16Array(totalQuads * 12),
    uv: new Uint16Array(totalQuads * 8),
    tex: new Uint16Array(totalQuads),
    cull: new Int8Array(totalQuads),
    tint: new Int8Array(totalQuads),
  };
  for (let q = 0; q < totalQuads; q++) {
    for (let i = 0; i < 12; i++) quads.p[q * 12 + i] = i16();
    for (let i = 0; i < 8; i++) quads.uv[q * 8 + i] = u16();
    quads.tex[q] = u16();
    quads.cull[q] = i8();
    quads.tint[q] = i8();
  }

  const blockCount = u32();
  const blocks = new Map<string, BlockModelDef>();
  for (let b = 0; b < blockCount; b++) {
    const name = utf8();
    const multipart = u8() === 1;
    const partCount = u16();
    const parts: BlockModelPart[] = new Array(partCount);
    for (let p = 0; p < partCount; p++) {
      const whenCount = u8();
      const when: number[] = new Array(whenCount);
      for (let w = 0; w < whenCount; w++) when[w] = u16();
      parts[p] = { when, geo: u16() };
    }
    blocks.set(name, { multipart, parts });
  }

  return { textures, conditions, geos, quads, blocks };
}

/** `"facing=east,half=bottom"` → `Map { facing → east, half → bottom }`. */
export function parseProps(props: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!props) return map;
  for (const pair of props.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return map;
}

/** Uma condição do blockstate (`"facing=east|west,half=!top"`) contra as
 * props reais — AND entre chaves, OR (`|`) entre valores, `!` nega. */
function matchesCondition(condition: string, props: Map<string, string>): boolean {
  for (const pair of condition.split(",")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const actual = props.get(key);
    if (actual === undefined) return false;
    const terms = pair.slice(eq + 1).split("|");
    let matched = false;
    for (const term of terms) {
      const negated = term.startsWith("!");
      const expected = negated ? term.slice(1) : term;
      if ((actual === expected) !== negated) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/** Índices das geometrias a desenhar pra um bloco + props, na semântica do
 * jogo: `variants` escolhe a primeira variante que casa; `multipart` aplica
 * todas as partes que casam. `null` = sem modelo (o viewer usa o cubo). */
export function resolveModelGeometries(
  models: DecodedBlockModels,
  block: string,
  props: Map<string, string>
): number[] | null {
  const def = models.blocks.get(block);
  if (!def) return null;

  const matches = (part: BlockModelPart) =>
    part.when.length === 0 ||
    part.when.some((index) => matchesCondition(models.conditions[index], props));

  if (!def.multipart) {
    const part = def.parts.find(matches);
    return part ? [part.geo] : null;
  }
  const geos = def.parts.filter(matches).map((part) => part.geo);
  return geos.length > 0 ? geos : null;
}
