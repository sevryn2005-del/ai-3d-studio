/**
 * 가져온 메시 (형식 v8): STL(이진·텍스트)·OBJ 읽기, base64 저장 형식, 검사.
 * 저장 형식 — positions: Float32 LE xyz, indices: Uint32 LE (삼각형마다 3개), 둘 다 base64.
 * 서버 app/cad/mesh_import.py 가 같은 형식을 읽는다.
 */
import { LIMITS } from './commandTypes';

export interface MeshArrays {
  positions: Float32Array;
  indices: Uint32Array;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 리틀엔디안으로 고정해 저장 (플랫폼과 무관) */
export function encodeMesh(m: MeshArrays): { positions: string; indices: string } {
  const p = new DataView(new ArrayBuffer(m.positions.length * 4));
  m.positions.forEach((v, i) => p.setFloat32(i * 4, v, true));
  const ix = new DataView(new ArrayBuffer(m.indices.length * 4));
  m.indices.forEach((v, i) => ix.setUint32(i * 4, v, true));
  return { positions: toBase64(new Uint8Array(p.buffer)), indices: toBase64(new Uint8Array(ix.buffer)) };
}

export function decodeMesh(d: { positions: string; indices: string }): MeshArrays {
  const pb = fromBase64(d.positions);
  const ib = fromBase64(d.indices);
  const pv = new DataView(pb.buffer, pb.byteOffset, pb.byteLength);
  const iv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
  const positions = new Float32Array(Math.floor(pb.byteLength / 4));
  for (let i = 0; i < positions.length; i++) positions[i] = pv.getFloat32(i * 4, true);
  const indices = new Uint32Array(Math.floor(ib.byteLength / 4));
  for (let i = 0; i < indices.length; i++) indices[i] = iv.getUint32(i * 4, true);
  return { positions, indices };
}

/** 저장된 메시 형식 검사. 문제 없으면 null */
export function meshError(d: { positions: string; indices: string }): string | null {
  let m: MeshArrays;
  try {
    m = decodeMesh(d);
  } catch {
    return '메시 데이터가 base64 형식이 아닙니다';
  }
  if (m.positions.length % 3 !== 0 || m.positions.length === 0) return '메시 정점 데이터 길이가 올바르지 않습니다';
  if (m.indices.length % 3 !== 0 || m.indices.length < 12) return '메시 삼각형이 4개 이상이어야 합니다';
  if (m.indices.length / 3 > LIMITS.maxMeshTriangles) return `메시 삼각형은 최대 ${LIMITS.maxMeshTriangles.toLocaleString()}개까지 가능합니다`;
  const n = m.positions.length / 3;
  if (m.indices.some((i) => i >= n)) return '메시 삼각형이 없는 정점을 가리킵니다';
  if (m.positions.some((v) => !Number.isFinite(v) || Math.abs(v) > LIMITS.maxCoordinate)) return '메시 좌표가 허용 범위를 벗어납니다';
  return null;
}

/** 같은 위치 정점을 합치고(1e-5mm) 넓이 0 삼각형을 뺀다 → 모서리를 공유하는 메시 */
export function weld(positions: ArrayLike<number>): MeshArrays {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  const tri: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const key = `${Math.round(positions[i]! * 1e5)},${Math.round(positions[i + 1]! * 1e5)},${Math.round(positions[i + 2]! * 1e5)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = pos.length / 3;
      map.set(key, k);
      pos.push(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    }
    tri.push(k);
    if (tri.length === 3) {
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) idx.push(...tri);
      tri.length = 0;
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** STL (이진·텍스트) → 삼각형 정점 나열 (mm 가정) */
export function parseStl(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9);
      for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(84 + t * 50 + 12 + k * 4, true);
      return out;
    }
  }
  const text = new TextDecoder().decode(buf);
  if (!/^\s*solid/i.test(text)) throw new Error('STL 파일 형식이 아닙니다');
  const nums = [...text.matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!nums.length || nums.length % 9 !== 0) throw new Error('STL 삼각형을 읽을 수 없습니다');
  return Float32Array.from(nums);
}

/** OBJ (v / f, 다각형 면은 부채꼴로 삼각형 분할, 음수 인덱스 지원) → 삼각형 정점 나열 */
export function parseObj(text: string): Float32Array {
  const verts: number[][] = [];
  const out: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') verts.push([Number(t[1]), Number(t[2]), Number(t[3])]);
    else if (t[0] === 'f') {
      const ids = t.slice(1).map((s) => {
        const i = parseInt(s.split('/')[0]!, 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++)
        for (const i of [ids[0]!, ids[k]!, ids[k + 1]!]) {
          const v = verts[i];
          if (!v) throw new Error('OBJ 면이 없는 정점을 가리킵니다');
          out.push(...v);
        }
    }
  }
  if (!out.length) throw new Error('OBJ 에 면(f)이 없습니다');
  return Float32Array.from(out);
}

/**
 * 가져오기: 읽기 → 정점 합치기 → 원점 규칙(바운딩 박스 바닥면 중심)으로 옮기기 → 저장 형식.
 * scale = 단위 보정 (예: 미터로 저장된 파일 1000, 인치 25.4)
 */
export function prepareImport(soup: Float32Array, scale = 1): { positions: string; indices: string; triangles: number; size: [number, number, number] } {
  const m = weld(soup);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
      hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
    }
  const c = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, lo[2]!];
  for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) m.positions[i + k] = (m.positions[i + k]! - c[k]!) * scale;
  return { ...encodeMesh(m), triangles: m.indices.length / 3, size: [0, 1, 2].map((k) => (hi[k]! - lo[k]!) * scale) as [number, number, number] };
}
