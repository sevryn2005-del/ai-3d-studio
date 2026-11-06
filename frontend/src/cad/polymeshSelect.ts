/**
 * 편집 모드 선택·베벨 (블렌더 Alt+클릭 루프 선택, Ctrl+L 연결 선택, Ctrl+± 넓히기·좁히기, Ctrl+B 베벨) — 순수 함수.
 */
import { compact, edges, type PolyMesh, type V3 } from './polymesh';

const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};
const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/** 점 이웃 (선으로 이어진 점) */
export function vertexNeighbors(m: PolyMesh): number[][] {
  const s = m.verts.map(() => new Set<number>());
  for (const [a, b] of edges(m)) {
    s[a]!.add(b);
    s[b]!.add(a);
  }
  return s.map((x) => [...x]);
}

/**
 * 점 v 둘레 면 고리: 면마다 (면 번호, 앞 점, 뒤 점). 면 i 의 "나가는 선" (v → next) 을 면 i+1 이 "들어오는 선"으로 공유한다.
 * 열린 가장자리라 고리가 닫히지 않으면 null
 */
export function faceRing(m: PolyMesh, v: number): { f: number; prev: number; next: number }[] | null {
  const corners = new Map<number, { f: number; prev: number; next: number }>(); // 들어오는 선의 앞 점 → 모서리
  m.faces.forEach((face, f) => {
    const k = face.indexOf(v);
    if (k < 0) return;
    corners.set(face[(k - 1 + face.length) % face.length]!, { f, prev: face[(k - 1 + face.length) % face.length]!, next: face[(k + 1) % face.length]! });
  });
  if (!corners.size) return null;
  const first = corners.values().next().value!;
  const ring = [first];
  let cur = first;
  for (let guard = 0; guard < corners.size; guard++) {
    const nxt = corners.get(cur.next);
    if (!nxt) return null;
    if (nxt === first) return ring.length === corners.size ? ring : null;
    ring.push(nxt);
    cur = nxt;
  }
  return null;
}

/** 루프 선택 (Alt+클릭): 선 (a, b) 에서 점마다 "맞은편 선"(점 4개 짜리 사각형 고리)으로 양쪽 끝까지 */
export function edgeLoop(m: PolyMesh, a: number, b: number): number[] {
  const walk = (from: number, to: number): { path: number[]; closed: boolean } => {
    const path: number[] = [];
    const seen = new Set([from, to]);
    let [p, c] = [from, to];
    for (let guard = 0; guard < m.verts.length; guard++) {
      const ring = faceRing(m, c);
      if (!ring || ring.length !== 4 || ring.some((r) => m.faces[r.f]!.length !== 4)) break;
      const i = ring.findIndex((r) => r.next === p);
      if (i < 0) break;
      const n = ring[(i + 2) % 4]!.next;
      if (n === from) return { path, closed: true }; // 한 바퀴 돌아옴
      if (seen.has(n)) break;
      seen.add(n);
      path.push(n);
      [p, c] = [c, n];
    }
    return { path, closed: false };
  };
  const forward = walk(a, b);
  if (forward.closed) return [a, b, ...forward.path];
  const backward = walk(b, a).path;
  return [...backward.reverse(), a, b, ...forward.path];
}

/** 연결 선택 (Ctrl+L): 고른 점과 선으로 이어진 모든 점 */
export function selectLinked(m: PolyMesh, sel: number[]): number[] {
  const nb = vertexNeighbors(m);
  const seen = new Set(sel);
  const stack = [...sel];
  while (stack.length) for (const n of nb[stack.pop()!]!) if (!seen.has(n)) (seen.add(n), stack.push(n));
  return [...seen];
}

/** 선택 넓히기 (Ctrl+숫자패드 +) / 좁히기 (Ctrl+숫자패드 −) */
export function growSelection(m: PolyMesh, sel: number[], shrink = false): number[] {
  const nb = vertexNeighbors(m);
  const s = new Set(sel);
  if (shrink) return sel.filter((v) => nb[v]!.every((n) => s.has(n)));
  const out = new Set(sel);
  for (const v of sel) for (const n of nb[v]!) out.add(n);
  return [...out];
}

/**
 * 베벨 (Ctrl+B, 1단계 = 모따기): 고른 선(양 끝 점이 모두 고른 선)을 width 만큼 깎아 새 면으로.
 * 점 v 둘레를 베벨 선으로 나눈 "부채"마다 새 점: 부채 면이 1개면 두 선 방향 합, 2개 이상이면 첫·끝 사이 선 위 (그 사이 면은 v 유지).
 * 세 개 이상의 부채가 만나는 점(예: 큐브 모서리 전부)은 구멍을 다각형 면으로 메운다.
 * 닫힌(모든 선에 면 2개) 부분만 된다. 돌려주는 sel = 새로 생긴 베벨 면의 점
 */
export function bevelEdges(m: PolyMesh, edgeList: [number, number][], width: number): { mesh: PolyMesh; sel: number[] } | string {
  if (!edgeList.length) return '베벨: 선을 고르세요 (2 = 선 선택 모드)';
  const bev = new Set(edgeList.map(([a, b]) => ekey(a, b)));
  const faceCount = new Map<string, number>();
  for (const f of m.faces) f.forEach((a, i) => faceCount.set(ekey(a, f[(i + 1) % f.length]!), (faceCount.get(ekey(a, f[(i + 1) % f.length]!)) ?? 0) + 1));
  for (const k of bev) if (faceCount.get(k) !== 2) return '베벨: 면 두 개 사이의 선만 깎을 수 있습니다 (열린 가장자리 제외)';

  const verts: V3[] = [...m.verts];
  const newVert = (p: V3) => {
    verts.push([r6(p[0]), r6(p[1]), r6(p[2])]);
    return verts.length - 1;
  };
  const corner = new Map<string, number[]>(); // "면:점" → 그 모서리를 대신할 점들
  const extraFaces: number[][] = [];
  const touched = new Set(edgeList.flat());
  for (const v of touched) {
    const ring = faceRing(m, v);
    if (!ring) return '베벨: 열린 가장자리의 점은 아직 베벨할 수 없습니다';
    const P = m.verts[v]!;
    const isBev = ring.map((r) => bev.has(ekey(v, r.next))); // 면 i 의 나가는 선 = 면 i 와 i+1 사이
    const start = isBev.findIndex(Boolean);
    if (start < 0) continue;
    // 베벨 선 다음부터 부채로 나눈다
    const fans: (typeof ring)[] = [];
    let cur: typeof ring = [];
    for (let s = 1; s <= ring.length; s++) {
      const i = (start + s) % ring.length;
      cur.push(ring[i]!);
      if (isBev[i]) {
        fans.push(cur);
        cur = [];
      }
    }
    const chains: number[][] = [];
    for (const fan of fans) {
      const k = fan.length;
      const g1 = fan[0]!;
      const gk = fan[k - 1]!;
      let chain: number[];
      if (k === 1) {
        const id = newVert(add(P, mul(add(unit(sub(m.verts[g1.prev]!, P)), unit(sub(m.verts[g1.next]!, P))), width)));
        corner.set(`${g1.f}:${v}`, [id]);
        chain = [id];
      } else {
        const A = newVert(add(P, mul(unit(sub(m.verts[g1.next]!, P)), width)));
        const B = k === 2 ? A : newVert(add(P, mul(unit(sub(m.verts[gk.prev]!, P)), width)));
        corner.set(`${g1.f}:${v}`, [A]);
        corner.set(`${gk.f}:${v}`, [B]);
        if (k === 2) chain = [A];
        else if (k === 3) {
          corner.set(`${fan[1]!.f}:${v}`, [A, B]);
          chain = [A, B];
        } else {
          corner.set(`${fan[1]!.f}:${v}`, [A, v]);
          corner.set(`${fan[k - 2]!.f}:${v}`, [v, B]);
          chain = [A, v, B];
        }
      }
      chains.push(chain);
    }
    // 부채 셋 이상 = 가운데 구멍: 반대 방향으로 메운다
    const seq = chains.flat().filter((x, i, arr) => x !== arr[(i - 1 + arr.length) % arr.length]);
    if (seq.length >= 3) extraFaces.push([...seq].reverse());
  }
  const at = (f: number, x: number) => corner.get(`${f}:${x}`) ?? [x];
  const faces = m.faces.map((face, f) => face.flatMap((x) => at(f, x)));
  const sel = new Set<number>();
  for (const [u, v] of edgeList) {
    const fL = m.faces.findIndex((face) => face.some((x, i) => x === v && face[(i + 1) % face.length] === u));
    const fR = m.faces.findIndex((face) => face.some((x, i) => x === u && face[(i + 1) % face.length] === v));
    const quad = [at(fL, u)[0]!, at(fL, v).at(-1)!, at(fR, v)[0]!, at(fR, u).at(-1)!];
    quad.forEach((q) => sel.add(q));
    faces.push(quad);
  }
  faces.push(...extraFaces);
  const out = compact({ verts, faces });
  // compact 로 번호가 바뀌므로 새 베벨 면 점은 좌표로 다시 찾는다
  const selPos = new Set([...sel].map((i) => verts[i]!.join(',')));
  return { mesh: out, sel: out.verts.flatMap((p, i) => (selPos.has(p.join(',')) ? [i] : [])) };
}

/**
 * 비례 편집 (블렌더 O): 고른 점은 1, 안 고른 점은 가장 가까운 고른 점까지 거리 d 에 따라 매끈한 감쇠
 * t = 1 − d/R, w = 3t² − 2t³ (블렌더 "Smooth" 감쇠). 반지름 밖은 0 (목록에 없음)
 */
export function proportionalWeights(m: PolyMesh, sel: number[], radius: number): Map<number, number> {
  const w = new Map<number, number>();
  const s = new Set(sel);
  for (const i of sel) w.set(i, 1);
  if (radius <= 0) return w;
  m.verts.forEach((p, i) => {
    if (s.has(i)) return;
    let d = Infinity;
    for (const j of sel) {
      const q = m.verts[j]!;
      d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    if (d >= radius) return;
    const t = 1 - d / radius;
    w.set(i, 3 * t * t - 2 * t * t * t);
  });
  return w;
}

/** 비례 변환: 점마다 p + w·(M·p − p) (M = 4×4 열 우선, 객체 로컬) */
export function proportionalTransform(m: PolyMesh, weights: Map<number, number>, e: number[]): PolyMesh {
  const verts = m.verts.map((p, i): V3 => {
    const w = weights.get(i);
    if (!w) return p;
    const [x, y, z] = p;
    const q: V3 = [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
    return [r6(x + w * (q[0] - x)), r6(y + w * (q[1] - y)), r6(z + w * (q[2] - z))];
  });
  return { verts, faces: m.faces };
}

/**
 * 나이프·이등분 (K): 평면(점 p, 법선 n)으로 면을 자른다. faceIdx 가 비면 모든 면.
 * 평면을 지나는 선마다 새 점(이웃 면에도 같은 점을 넣어 틈이 없다), 자르는 점이 둘인 면은 두 면으로 나눈다.
 * 돌려주는 sel = 자른 자리의 점들
 */
export function bisectFaces(m: PolyMesh, faceIdx: number[], p: V3, n: V3): { mesh: PolyMesh; sel: number[] } {
  const nn = unit(n);
  const d = m.verts.map((v) => (v[0] - p[0]) * nn[0] + (v[1] - p[1]) * nn[1] + (v[2] - p[2]) * nn[2]);
  const eps = 1e-7;
  const chosen = new Set(faceIdx.length ? faceIdx : m.faces.map((_, i) => i));
  const verts: V3[] = [...m.verts];
  const split = new Map<string, number>();
  // 자를 선: 고른 면의 선 중 양 끝이 평면 반대쪽
  for (const fi of chosen) {
    const f = m.faces[fi]!;
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length]!;
      const k = ekey(a, b);
      if (split.has(k) || !(d[a]! * d[b]! < 0 && Math.abs(d[a]!) > eps && Math.abs(d[b]!) > eps)) return;
      const t = d[a]! / (d[a]! - d[b]!);
      const A = m.verts[a]!;
      const B = m.verts[b]!;
      verts.push([r6(A[0] + (B[0] - A[0]) * t), r6(A[1] + (B[1] - A[1]) * t), r6(A[2] + (B[2] - A[2]) * t)]);
      split.set(k, verts.length - 1);
    });
  }
  const sel = new Set<number>([...split.values()]);
  const faces: number[][] = [];
  m.faces.forEach((f, fi) => {
    // 자른 선에 새 점 끼우기 (고르지 않은 이웃 면도 — 틈 방지)
    const loop: number[] = [];
    f.forEach((a, i) => {
      loop.push(a);
      const s = split.get(ekey(a, f[(i + 1) % f.length]!));
      if (s !== undefined) loop.push(s);
    });
    if (!chosen.has(fi)) return void faces.push(loop);
    const cuts = loop.map((v, i) => (v >= m.verts.length || Math.abs(d[v]!) <= eps ? i : -1)).filter((i) => i >= 0);
    for (const i of cuts) sel.add(loop[i]!);
    const [i, j] = cuts;
    if (cuts.length !== 2 || j! - i! === 1 || (i === 0 && j === loop.length - 1)) return void faces.push(loop);
    faces.push(loop.slice(i, j! + 1), [...loop.slice(j!), ...loop.slice(0, i! + 1)]);
  });
  return { mesh: { verts, faces }, sel: [...sel] };
}
