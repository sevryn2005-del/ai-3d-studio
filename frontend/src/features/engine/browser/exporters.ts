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

export interface NamedMesh {
  name: string;
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
  meshes.forEach((m, i) => {
    parts.push(`<object id="${i + 1}" type="model" name="${xmlAttr(m.name)}"><mesh><vertices>\n`);
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

export function toGlb(meshes: NamedMesh[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const gltfMeshes: object[] = [];
  const nodes: object[] = [];

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
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, pos[i + k]!);
        max[k] = Math.max(max[k]!, pos[i + k]!);
      }
    }
    creased.dispose();
    accessors.push({ bufferView: addView(pos), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: addView(nrm), componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
    gltfMeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: aPos, NORMAL: aPos + 1 }, material: 0 }] });
    nodes.push({ name: m.name, mesh: gltfMeshes.length - 1 });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'AI 3D Studio' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials: [{ name: 'default', pbrMetallicRoughness: { baseColorFactor: [0.64, 0.68, 0.73, 1], metallicFactor: 0.05, roughnessFactor: 0.55 } }],
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
