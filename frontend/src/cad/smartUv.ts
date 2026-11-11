/**
 * 스마트 UV 펼치기 (형식 v46, 블렌더 Smart UV Project): 박스 투영 대신 면 묶음(차트)마다 펼쳐 이미지 한 장(0~1)에 겹치지 않게 배치.
 *
 * 1. 삼각형 법선·넓이. 넓은 삼각형부터 씨앗으로, 모서리를 공유하고 법선이 씨앗 법선과 angleLimit 이내인 이웃을 넓혀 차트를 만든다.
 * 2. 차트를 씨앗 법선에 수직인 평면에 투영 (mm 그대로 → 모든 차트가 같은 축척, 텍스처가 늘어나지 않음).
 * 3. 차트 상자를 높이 순으로 선반(shelf) 배치 → 가장 큰 변으로 나눠 0~1. 차트 사이 여백 margin.
 * 화면(three.js)과 GLB 내보내기(브라우저 exporters.ts · 서버 exporter.py smart_uv)가 같은 계산을 쓴다 — 정렬·반올림까지 같게.
 * glTF 는 이미지 위쪽이 v = 0 이라 v 는 1 − v 로 넣는다 (boxUv 와 같은 관례).
 */

export const SMART_UV_ANGLE = 66;
export const SMART_UV_MARGIN = 0.01;

/** 위치 키 (같은 꼭짓점 찾기): 1e-4 mm 격자 */
const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;

/** 법선에 수직인 두 축 (법선의 가장 작은 성분 축과 외적 — 결정적) */
function basis(n: [number, number, number]): [[number, number, number], [number, number, number]] {
  const a = Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2]) ? [1, 0, 0] : Math.abs(n[1]) <= Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1];
  const u = [n[1] * a[2]! - n[2] * a[1]!, n[2] * a[0]! - n[0] * a[2]!, n[0] * a[1]! - n[1] * a[0]!];
  const lu = Math.hypot(u[0]!, u[1]!, u[2]!);
  const uu: [number, number, number] = [u[0]! / lu, u[1]! / lu, u[2]! / lu];
  const v: [number, number, number] = [n[1] * uu[2] - n[2] * uu[1], n[2] * uu[0] - n[0] * uu[2], n[0] * uu[1] - n[1] * uu[0]];
  return [uu, v];
}

export interface SmartUvResult {
  /** 꼭짓점(삼각형 모서리)마다 [u, v] — 0~1, glTF 관례 (v 위쪽 0) */
  uv: Float32Array;
  /** 차트 수 */
  charts: number;
  /** 0~1 정사각형에서 차트들이 차지하는 비율 */
  fill: number;
}

/** pos = 인덱스 없는 삼각형 꼭짓점 (9개씩, mm) */
export function smartUv(pos: ArrayLike<number>, angleLimit = SMART_UV_ANGLE, margin = SMART_UV_MARGIN): SmartUvResult {
  const n = Math.floor(pos.length / 9);
  const uv = new Float32Array(n * 6);
  if (!n) return { uv, charts: 0, fill: 0 };
  const normals: [number, number, number][] = [];
  const areas: number[] = [];
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const e1 = [pos[i + 3]! - pos[i]!, pos[i + 4]! - pos[i + 1]!, pos[i + 5]! - pos[i + 2]!];
    const e2 = [pos[i + 6]! - pos[i]!, pos[i + 7]! - pos[i + 1]!, pos[i + 8]! - pos[i + 2]!];
    const c = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(c[0]!, c[1]!, c[2]!);
    areas.push(l / 2);
    normals.push(l > 1e-12 ? [c[0]! / l, c[1]! / l, c[2]! / l] : [0, 0, 1]);
  }
  // 모서리 → 삼각형 (위치 키 두 개, 순서 무관)
  const vkey = (t: number, k: number) => key(pos[t * 9 + k * 3]!, pos[t * 9 + k * 3 + 1]!, pos[t * 9 + k * 3 + 2]!);
  const edgeTris = new Map<string, number[]>();
  const edgesOf: string[][] = [];
  for (let t = 0; t < n; t++) {
    const ks = [vkey(t, 0), vkey(t, 1), vkey(t, 2)];
    const es: string[] = [];
    for (let k = 0; k < 3; k++) {
      const a = ks[k]!;
      const b = ks[(k + 1) % 3]!;
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      es.push(e);
      const list = edgeTris.get(e);
      if (list) list.push(t);
      else edgeTris.set(e, [t]);
    }
    edgesOf.push(es);
  }
  // 차트 넓히기: 넓은 삼각형부터 (같으면 번호 순)
  // 정렬 키는 1e-6 으로 반올림 (언어마다 hypot 마지막 자리가 달라도 같은 순서)
  const r6 = (v: number) => Math.round(v * 1e6);
  const order = [...Array(n).keys()].sort((a, b) => r6(areas[b]!) - r6(areas[a]!) || a - b);
  const chartOf = new Int32Array(n).fill(-1);
  const cosLimit = Math.cos((angleLimit * Math.PI) / 180);
  const charts: { normal: [number, number, number]; tris: number[] }[] = [];
  for (const seed of order) {
    if (chartOf[seed] !== -1) continue;
    const cn = normals[seed]!;
    const id = charts.length;
    const tris = [seed];
    chartOf[seed] = id;
    for (let q = 0; q < tris.length; q++) {
      const t = tris[q]!;
      for (const e of edgesOf[t]!) {
        for (const o of edgeTris.get(e)!) {
          if (chartOf[o] !== -1) continue;
          const m = normals[o]!;
          if (m[0] * cn[0] + m[1] * cn[1] + m[2] * cn[2] < cosLimit) continue;
          chartOf[o] = id;
          tris.push(o);
        }
      }
    }
    charts.push({ normal: cn, tris });
  }
  // 투영 → 차트 상자
  const local = new Float64Array(n * 6);
  const boxes = charts.map((c, id) => {
    const [bu, bv] = basis(c.normal);
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const t of c.tris) {
      for (let k = 0; k < 3; k++) {
        const x = pos[t * 9 + k * 3]!;
        const y = pos[t * 9 + k * 3 + 1]!;
        const z = pos[t * 9 + k * 3 + 2]!;
        const u = x * bu[0] + y * bu[1] + z * bu[2];
        const v = x * bv[0] + y * bv[1] + z * bv[2];
        local[t * 6 + k * 2] = u;
        local[t * 6 + k * 2 + 1] = v;
        minU = Math.min(minU, u);
        minV = Math.min(minV, v);
        maxU = Math.max(maxU, u);
        maxV = Math.max(maxV, v);
      }
    }
    return { id, minU, minV, w: maxU - minU, h: maxV - minV, x: 0, y: 0 };
  });
  // 선반 배치: 높이 큰 순 (같으면 번호 순). 폭 한계 = 넓이 합의 제곱근 (정사각형에 가깝게), 여백은 mm 로 환산
  const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
  const longest = Math.max(...boxes.map((b) => Math.max(b.w, b.h)));
  const gap = Math.max(longest, Math.sqrt(total)) * margin;
  const limit = Math.max(longest + gap, Math.sqrt(total) * 1.15);
  const sorted = [...boxes].sort((a, b) => r6(b.h) - r6(a.h) || a.id - b.id);
  let x = gap;
  let y = gap;
  let row = 0;
  let width = 0;
  for (const b of sorted) {
    if (x + b.w + gap > limit && x > gap) {
      x = gap;
      y += row + gap;
      row = 0;
    }
    b.x = x;
    b.y = y;
    x += b.w + gap;
    row = Math.max(row, b.h);
    width = Math.max(width, x);
  }
  const size = Math.max(width, y + row + gap);
  for (let id = 0; id < charts.length; id++) {
    const b = boxes[id]!;
    for (const t of charts[id]!.tris)
      for (let k = 0; k < 3; k++) {
        uv[t * 6 + k * 2] = (local[t * 6 + k * 2]! - b.minU + b.x) / size;
        uv[t * 6 + k * 2 + 1] = 1 - (local[t * 6 + k * 2 + 1]! - b.minV + b.y) / size;
      }
  }
  return { uv, charts: charts.length, fill: total / (size * size) };
}
