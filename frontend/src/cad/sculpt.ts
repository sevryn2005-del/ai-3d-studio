/**
 * 스컬프트 브러시 (3D 모델링 모드, 블렌더 스컬프트 모드 흐름) — 순수 함수.
 * 한 획 = 마우스를 누르고 뗄 때까지. 획 동안 여러 번 "찍기(dab)"를 하고, 뗄 때 바뀐 점만 mesh_edit set_verts 명령 하나로 확정한다.
 * 모든 좌표는 객체 로컬(mm). 감쇠 = (1 − (d/R)²)² (가장자리로 갈수록 부드럽게 0).
 */
import { faceNormal, type PolyMesh, type V3 } from './polymesh';

export type Brush = 'draw' | 'inflate' | 'smooth' | 'grab' | 'flatten';
export const BRUSH_LABEL: Record<Brush, string> = {
  draw: '그리기',
  inflate: '부풀리기',
  smooth: '매끈하게',
  grab: '잡아끌기',
  flatten: '평평하게',
};

/** 획을 시작할 때 한 번: 이웃 점, 점 법선 (획 동안 위상은 그대로) */
export interface SculptContext {
  neighbors: number[][];
  normals: V3[];
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 1];
};
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function sculptContext(m: PolyMesh): SculptContext {
  const sets = m.verts.map(() => new Set<number>());
  const normals: V3[] = m.verts.map(() => [0, 0, 0]);
  for (const f of m.faces) {
    const n = faceNormal(m, f);
    f.forEach((v, i) => {
      sets[v]!.add(f[(i + 1) % f.length]!);
      sets[v]!.add(f[(i - 1 + f.length) % f.length]!);
      normals[v] = add(normals[v]!, n);
    });
  }
  return { neighbors: sets.map((s) => [...s]), normals: normals.map(norm) };
}

export const falloff = (d: number, R: number) => (d >= R ? 0 : (1 - (d / R) ** 2) ** 2);

export interface Dab {
  brush: Exclude<Brush, 'grab'>;
  center: V3;
  normal: V3;
  radius: number;
  /** 0~1 */
  strength: number;
  /** Ctrl: 반대로 (그리기·부풀리기는 파고들기) */
  invert?: boolean;
  /** X 대칭: 객체 로컬 x = 0 평면 반대쪽에도 같은 찍기 */
  symmetryX?: boolean;
}

function dabOnce(m: PolyMesh, ctx: SculptContext, d: Dab): V3[] {
  const R = d.radius;
  const hit: { i: number; w: number }[] = [];
  m.verts.forEach((v, i) => {
    const dd = dist(v, d.center);
    if (dd < R) hit.push({ i, w: falloff(dd, R) });
  });
  if (!hit.length) return m.verts;
  const verts = [...m.verts];
  const sign = d.invert ? -1 : 1;
  const amount = R * 0.08 * d.strength;
  if (d.brush === 'draw') {
    const n = norm(d.normal);
    for (const { i, w } of hit) verts[i] = add(m.verts[i]!, mul(n, sign * amount * w));
  } else if (d.brush === 'inflate') {
    for (const { i, w } of hit) verts[i] = add(m.verts[i]!, mul(ctx.normals[i]!, sign * amount * w));
  } else if (d.brush === 'smooth') {
    for (const { i, w } of hit) {
      const nb = ctx.neighbors[i]!;
      if (!nb.length) continue;
      const avg = mul(nb.reduce<V3>((s, j) => add(s, m.verts[j]!), [0, 0, 0]), 1 / nb.length);
      verts[i] = add(m.verts[i]!, mul(sub(avg, m.verts[i]!), Math.min(1, d.strength * w * 0.6)));
    }
  } else {
    // 평평하게: 영향 범위 점들의 (가중) 가운데를 지나고 (가중) 평균 법선에 수직인 평면 쪽으로
    let wsum = 0;
    let c: V3 = [0, 0, 0];
    let n: V3 = [0, 0, 0];
    for (const { i, w } of hit) {
      c = add(c, mul(m.verts[i]!, w));
      n = add(n, mul(ctx.normals[i]!, w));
      wsum += w;
    }
    c = mul(c, 1 / wsum);
    n = norm(n);
    for (const { i, w } of hit) {
      const off = dot(sub(m.verts[i]!, c), n);
      verts[i] = sub(m.verts[i]!, mul(n, off * Math.min(1, d.strength * w * 0.5)));
    }
  }
  return verts;
}

/** 한 번 찍기 (X 대칭이면 반대쪽에도) — 새 메시, 면은 그대로 */
export function applyDab(m: PolyMesh, ctx: SculptContext, d: Dab): PolyMesh {
  let verts = dabOnce(m, ctx, d);
  if (d.symmetryX && Math.abs(d.center[0]) > d.radius * 0.05) {
    verts = dabOnce({ verts, faces: m.faces }, ctx, { ...d, center: [-d.center[0], d.center[1], d.center[2]], normal: [-d.normal[0], d.normal[1], d.normal[2]] });
  }
  return { verts, faces: m.faces };
}

/** 잡아끌기: 획 시작 메시 기준으로, 시작점 둘레 점들을 delta 만큼 (감쇠 곱해) 옮긴다 */
export function grabStroke(start: PolyMesh, center: V3, radius: number, delta: V3, strength: number, symmetryX = false): PolyMesh {
  const verts = [...start.verts];
  const move = (c: V3, dl: V3) =>
    start.verts.forEach((v, i) => {
      const w = falloff(dist(v, c), radius);
      if (w > 0) verts[i] = add(verts[i]!, mul(dl, w * Math.min(1, strength * 1.5)));
    });
  move(center, delta);
  if (symmetryX && Math.abs(center[0]) > radius * 0.05) move([-center[0], center[1], center[2]], [-delta[0], delta[1], delta[2]]);
  return { verts, faces: start.faces };
}

/** 획 전후로 바뀐 점 → set_verts 명령 내용 (좌표는 소수 6자리) */
export function strokeEdit(before: PolyMesh, after: PolyMesh): { verts: number[]; positions: V3[] } | null {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  const verts: number[] = [];
  const positions: V3[] = [];
  after.verts.forEach((p, i) => {
    const q: V3 = [r6(p[0]), r6(p[1]), r6(p[2])];
    const o = before.verts[i]!;
    if (q[0] !== o[0] || q[1] !== o[1] || q[2] !== o[2]) {
      verts.push(i);
      positions.push(q);
    }
  });
  return verts.length ? { verts, positions } : null;
}
