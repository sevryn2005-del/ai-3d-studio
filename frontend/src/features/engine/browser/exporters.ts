/**
 * 브라우저 엔진의 파일 작성기 (STL / 3MF / GLB). 서버 backend/app/cad/exporter.py 와 같은 규칙:
 * - STL : 월드, mm, Z-up, 바이너리
 * - 3MF : 월드, mm(파일에 명시), 객체 ID 1부터, 객체별 매니폴드 메시(manifold-3d 출력은 정점이 이미 공유됨)
 * - GLB : glTF 규칙에 따라 Y-up, 미터. CAD (x, y, z) mm → glTF (x, z, −y) m
 * STEP 은 정확한 곡면(B-rep)이 필요하므로 서버 엔진에서만 지원한다.
 */
import { zipSync, strToU8 } from 'fflate';
import { BufferAttribute, BufferGeometry } from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxUv } from '../../../cad/textureMap';

export interface NamedMesh {
  name: string;
  /** 외관 색 #rrggbb (3MF basematerials 로 내보냄, 서버 exporter.to_3mf 와 같은 구조) */
  color?: string;
  /** PBR 재질 (형식 v29, GLB 만) */
  material?: { metallic: number; roughness: number };
  /** 텍스처 (형식 v30, GLB 만): 이미지 + 한 장 크기(mm). toLocal = 월드 → 객체 로컬 4×4 (열 우선, three Matrix4.elements) */
  texture?: { image: string; tile: number };
  toLocal?: number[];
  positions: Float32Array; // 월드 좌표 mm
  indices: Uint32Array;
}

const STL_HEADER = 'AI 3D Studio STL (units: mm, Z-up)';

export function toBinaryStl(meshes: NamedMesh[]): Uint8Array<ArrayBuffer> {
  const count = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  for (let i = 0; i < STL_HEADER.length; i++) view.setUint8(i, STL_HEADER.charCodeAt(i));
  for (let i = STL_HEADER.length; i < 80; i++) view.setUint8(i, 0x20);
  view.setUint32(80, count, true);
  let o = 84;
  for (const { positions: p, indices: t } of meshes) {
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
      for (const idx of [a, b, c]) for (let k = 0; k < 3; k++) { view.setFloat32(o, p[idx + k]!, true); o += 4; }
      o += 2; // attribute byte count
    }
  }
  return new Uint8Array(buf);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const num = (v: number) => String(Number(v.toPrecision(7)));

export function to3mf(meshes: NamedMesh[]): Uint8Array {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="ko-KR" ' +
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      '<metadata name="Application">AI 3D Studio</metadata>\n<resources>\n',
  ];
  // 색이 있으면 basematerials 하나(id = 객체 수 + 1)에 색마다 한 항목 → 객체 pid/pindex (객체 id 는 1..n 그대로)
  const colors = [...new Set(meshes.map((m) => m.color).filter((c): c is string => !!c))];
  const matId = meshes.length + 1;
  if (colors.length) {
    parts.push(`<basematerials id="${matId}">\n`);
    for (const c of colors) parts.push(`<base name="${c}" displaycolor="${c.toUpperCase()}"/>\n`);
    parts.push('</basematerials>\n');
  }
  meshes.forEach((m, i) => {
    const mat = m.color ? ` pid="${matId}" pindex="${colors.indexOf(m.color)}"` : '';
    parts.push(`<object id="${i + 1}" type="model" name="${xmlAttr(m.name)}"${mat}><mesh><vertices>\n`);
    for (let k = 0; k < m.positions.length; k += 3) {
      parts.push(`<vertex x="${num(m.positions[k]!)}" y="${num(m.positions[k + 1]!)}" z="${num(m.positions[k + 2]!)}"/>\n`);
    }
    parts.push('</vertices><triangles>\n');
    for (let k = 0; k < m.indices.length; k += 3) {
      parts.push(`<triangle v1="${m.indices[k]}" v2="${m.indices[k + 1]}" v3="${m.indices[k + 2]}"/>\n`);
    }
    parts.push('</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n');
  meshes.forEach((_, i) => parts.push(`<item objectid="${i + 1}"/>\n`));
  parts.push('</build>\n</model>\n');
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(parts.join('')),
  });
}

/** 화면과 같은 기준(30°)으로 법선을 분리해 곡면은 부드럽게, 모서리는 날카롭게 */
const CREASE_ANGLE = Math.PI / 6;

/** 박스 투영 UV — 화면과 같은 규칙 (cad/textureMap.ts, 서버 exporter.py box_uv) */
export { boxUv };

/** data URL → 바이트 (GLB 이미지) */
function dataUrlBytes(url: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(url)!;
  const bin = atob(m[2]!);
  return { bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)), mime: m[1]! };
}

/** 기본 GLB 재질 (색·재질이 없는 객체) — 서버 exporter.py 와 같은 값 */
const GLB_DEFAULT_BASE = [0.64, 0.68, 0.73, 1];
/** sRGB #rrggbb → glTF baseColorFactor (선형, 소수 6자리) — 서버 exporter.py _linear_rgba 와 같은 식 */
export function linearRgba(hex: string): number[] {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return [...c.map((v) => Math.round((v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * 1e6) / 1e6), 1];
}
/** 객체별 glTF 재질 (같은 색·재질은 하나로) — 서버 _glb_material 과 같은 규칙 */
export function glbMaterial(color: string | undefined, m: { metallic: number; roughness: number } | undefined, texture?: number) {
  return {
    name: `${color ?? 'default'} m${m?.metallic ?? 0.05} r${m?.roughness ?? 0.55}${texture !== undefined ? ` t${texture}` : ''}`,
    pbrMetallicRoughness: {
      // 텍스처가 있으면 색은 곱해지는 값 — 색이 없으면 흰색(이미지 그대로)
      baseColorFactor: color ? linearRgba(color) : texture !== undefined ? [1, 1, 1, 1] : GLB_DEFAULT_BASE,
      metallicFactor: m?.metallic ?? 0.05,
      roughnessFactor: m?.roughness ?? 0.55,
      ...(texture !== undefined ? { baseColorTexture: { index: texture } } : {}),
    },
  };
}

export function toGlb(meshes: NamedMesh[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const gltfMeshes: object[] = [];
  const nodes: object[] = [];
  const materials: ReturnType<typeof glbMaterial>[] = [];
  const images: object[] = [];
  const textures: object[] = [];
  const imageIndex = new Map<string, number>(); // 같은 이미지는 하나로
  const addBytes = (bytes: Uint8Array) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const pad = (4 - (bytes.length % 4)) % 4;
    const padded = new Uint8Array(bytes.length + pad);
    padded.set(bytes);
    chunks.push(padded);
    offset += padded.length;
    return bufferViews.length - 1;
  };
  const textureIndex = (m: NamedMesh) => {
    if (!m.texture) return undefined;
    const known = imageIndex.get(m.texture.image);
    if (known !== undefined) return known;
    const { bytes, mime } = dataUrlBytes(m.texture.image);
    images.push({ bufferView: addBytes(bytes), mimeType: mime });
    textures.push({ source: images.length - 1, sampler: 0 });
    imageIndex.set(m.texture.image, textures.length - 1);
    return textures.length - 1;
  };
  const materialIndex = (m: NamedMesh) => {
    const mat = glbMaterial(m.color, m.material, textureIndex(m));
    const k = materials.findIndex((x) => x.name === mat.name);
    if (k >= 0) return k;
    materials.push(mat);
    return materials.length - 1;
  };

  const addView = (data: Float32Array) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
    chunks.push(bytes);
    offset += bytes.length; // Float32 데이터이므로 항상 4바이트 정렬
    return bufferViews.length - 1;
  };

  for (const m of meshes) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.positions, 3));
    g.setIndex(new BufferAttribute(m.indices, 1));
    const creased = toCreasedNormals(g, CREASE_ANGLE); // 인덱스 없는 삼각형 목록
    g.dispose();
    const src = creased.getAttribute('position').array as Float32Array;
    const srcN = creased.getAttribute('normal').array as Float32Array;
    const pos = new Float32Array(src.length);
    const nrm = new Float32Array(srcN.length);
    const uv = new Float32Array((src.length / 3) * 2);
    const L = m.toLocal;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < src.length; i += 3) {
      // (x, y, z) mm Z-up → (x, z, −y) m Y-up
      pos[i] = src[i]! * 0.001;
      pos[i + 1] = src[i + 2]! * 0.001;
      pos[i + 2] = -src[i + 1]! * 0.001;
      nrm[i] = srcN[i]!;
      nrm[i + 1] = srcN[i + 2]!;
      nrm[i + 2] = -srcN[i + 1]!;
      // 텍스처가 있으면 객체 로컬 좌표·법선으로 (객체를 옮겨도 무늬가 따라감), 한 장 = tile mm. 없으면 월드 m
      let uvp = [src[i]!, src[i + 1]!, src[i + 2]!];
      let uvn = [srcN[i]!, srcN[i + 1]!, srcN[i + 2]!];
      if (m.texture && L) {
        uvp = [0, 1, 2].map((r) => L[r]! * src[i]! + L[4 + r]! * src[i + 1]! + L[8 + r]! * src[i + 2]! + L[12 + r]!);
        uvn = [0, 1, 2].map((r) => L[r]! * srcN[i]! + L[4 + r]! * srcN[i + 1]! + L[8 + r]! * srcN[i + 2]!);
      }
      const [u, v] = boxUv(uvp[0]!, uvp[1]!, uvp[2]!, uvn[0]!, uvn[1]!, uvn[2]!, m.texture ? 1 / m.texture.tile : 0.001);
      uv[(i / 3) * 2] = u;
      uv[(i / 3) * 2 + 1] = v;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, pos[i + k]!);
        max[k] = Math.max(max[k]!, pos[i + k]!);
      }
    }
    creased.dispose();
    accessors.push({ bufferView: addView(pos), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: addView(nrm), componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: addView(uv), componentType: 5126, count: uv.length / 2, type: 'VEC2' });
    gltfMeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: aPos, NORMAL: aPos + 1, TEXCOORD_0: aPos + 2 }, material: materialIndex(m) }] });
    nodes.push({ name: m.name, mesh: gltfMeshes.length - 1 });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'AI 3D Studio' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials: materials.length ? materials : [glbMaterial(undefined, undefined)],
    ...(images.length ? { images, textures, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(json.length + jsonPad).fill(0x20);
    padded.set(json);
    json = padded;
  }
  const total = 12 + 8 + json.length + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(json, 20);
  let o = 20 + json.length;
  dv.setUint32(o, offset, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
