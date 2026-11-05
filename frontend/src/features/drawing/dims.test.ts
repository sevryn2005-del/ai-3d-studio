import { describe, expect, it } from 'vitest';
import type { DrawingDim } from '../../cad/commandTypes';
import type { DrawingView } from '../engine/types';
import { makeAnchor, resolveDim, snapCircle, snapVertex, viewVertices } from './dims';
import { buildSheet } from './sheet';

const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
const circleLine = (cx: number, cy: number, r: number) =>
  Array.from({ length: 97 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 48), cy + r * Math.sin((i * Math.PI) / 48)]).flat();
const front = (w: number): DrawingView => ({
  name: 'front',
  visible: [rect(-w / 2, 0, w / 2, 10), circleLine(0, 5, 2)],
  hidden: [],
  circles: [{ center: [0, 5], radius: 2, full: true, visible: true }],
  axes: [],
  bounds: [-w / 2, 0, w / 2, 10],
});

describe('도면 사용자 치수: 다시 붙이기', () => {
  it('꼭짓점 = 꺾인 점·양 끝 (곡선 표본 중간은 빼고)', () => {
    const vs = viewVertices(front(40));
    expect(vs).toEqual(expect.arrayContaining([[-20, 0], [20, 0], [20, 10], [-20, 10]]));
    expect(vs.length).toBe(4 + 1); // 원 표본은 시작=끝 점 하나
    expect(snapVertex(front(40), [19.6, 0.3], 1)).toEqual([20, 0]);
    expect(snapVertex(front(40), [10, 5], 1)).toBeNull();
    expect(snapCircle(front(40), [2.1, 5], 0.5)?.radius).toBe(2);
  });

  const v40 = front(40);
  const width: DrawingDim = { id: 'd1', view: 'front', kind: 'horizontal', a: makeAnchor(v40, [-20, 0]), b: makeAnchor(v40, [20, 0]), offset: -8 };

  it('값을 재고, 모델 폭이 40 → 60 으로 바뀌어도 상대 위치로 따라간다', () => {
    expect(width.a.rel).toEqual([0, 0]);
    expect(resolveDim(v40, width)).toMatchObject({ ok: true, value: 40 });
    expect(resolveDim(front(60), width)).toMatchObject({ ok: true, value: 60, a: [-30, 0], b: [30, 0] });
    const height: DrawingDim = { ...width, id: 'd2', kind: 'vertical', b: makeAnchor(v40, [-20, 10]) };
    expect(resolveDim(front(60), height).value).toBe(10);
    const diag: DrawingDim = { ...width, id: 'd3', kind: 'aligned', b: makeAnchor(v40, [20, 10]) };
    expect(resolveDim(v40, diag).value).toBeCloseTo(Math.hypot(40, 10), 9);
  });

  it('붙을 꼭짓점이 없으면 연결 끊김 (저장된 자리·값)', () => {
    const lonely: DrawingDim = { ...width, a: { at: [-20, 0], rel: [0.4, 0.5] }, b: { at: [100, 100], rel: [5, 5] } };
    const r = resolveDim(v40, lonely);
    expect(r.ok).toBe(false);
    expect(r.b).toEqual([100, 100]);
  });

  it('지름: 원 중심에 붙고 지름을 잰다', () => {
    const dia: DrawingDim = { id: 'd4', view: 'front', kind: 'diameter', a: makeAnchor(v40, [0, 5]), offset: 8 };
    expect(resolveDim(v40, dia)).toMatchObject({ ok: true, value: 4 });
    expect(resolveDim({ ...v40, circles: [] }, dia)).toMatchObject({ ok: false, value: 0 });
  });

  it('시트: 사용자 치수 글자, 끊긴 치수는 "?", 배치 정보', () => {
    const opt = { paper: 'A4' as const, scale: 1, title: 't', date: 'd', dimensions: false };
    const s = buildSheet([v40], { ...opt, dims: [width, { id: 'd4', view: 'front', kind: 'diameter', a: makeAnchor(v40, [0, 5]), offset: 8 }] });
    const texts = s.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    expect(texts).toEqual(expect.arrayContaining(['40', 'Ø4']));
    expect(s.dims.map((d) => d.ok)).toEqual([true, true]);
    expect(s.placements.front).toMatchObject({ scale: 1, bounds: [-20, 0, 20, 10] });
    const broken = buildSheet([{ ...v40, visible: [] }], { ...opt, dims: [width] });
    expect(broken.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []))).toContain('40?');
    // 보기가 없으면 그 치수는 건너뛴다
    expect(buildSheet([v40], { ...opt, dims: [{ ...width, view: 'top' }] }).dims).toEqual([]);
  });

  it('평행 치수 글자는 선 방향으로 돌린다 (읽는 방향 −90°~90°)', () => {
    const diag: DrawingDim = { ...width, kind: 'aligned', a: makeAnchor(v40, [20, 0]), b: makeAnchor(v40, [-20, 10]) };
    const s = buildSheet([v40], { paper: 'A4', scale: 1, title: 't', date: 'd', dimensions: false, dims: [diag] });
    const t = s.items.find((i) => i.kind === 'text' && i.layer === 'dim') as { angle?: number };
    expect(t.angle).toBeCloseTo((-Math.atan2(10, 40) * 180) / Math.PI, 2);
  });
});
