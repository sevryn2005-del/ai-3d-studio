import { describe, expect, it } from 'vitest';
import { primitiveMesh } from './polymesh';
import { applyDab, falloff, grabStroke, paintMask, sculptContext, strokeEdit } from './sculpt';
import { executeCommand } from './commandExecutor';
import { emptyModel } from './commandTypes';

const grid = () => primitiveMesh('grid', { size: 20, subdivisions: 10 }); // 평면 z = 0, 점 121개

describe('스컬프트 브러시', () => {
  it('감쇠: 가운데 1, 반지름에서 0', () => {
    expect(falloff(0, 5)).toBe(1);
    expect(falloff(5, 5)).toBe(0);
    expect(falloff(2.5, 5)).toBeCloseTo(0.5625);
  });

  it('그리기: 반지름 안 점만 법선 쪽으로, 가운데가 가장 많이 / Ctrl = 반대', () => {
    const m = grid();
    const ctx = sculptContext(m);
    const out = applyDab(m, ctx, { brush: 'draw', center: [0, 0, 0], normal: [0, 0, 1], radius: 5, strength: 1 });
    const zAt = (x: number, y: number) => out.verts[m.verts.findIndex((v) => v[0] === x && v[1] === y)]![2];
    expect(zAt(0, 0)).toBeCloseTo(0.4); // 5 × 0.08
    expect(zAt(2, 0)).toBeGreaterThan(0);
    expect(zAt(2, 0)).toBeLessThan(zAt(0, 0));
    expect(zAt(6, 0)).toBe(0);
    const inv = applyDab(m, ctx, { brush: 'draw', center: [0, 0, 0], normal: [0, 0, 1], radius: 5, strength: 1, invert: true });
    expect(inv.verts.some((v) => v[2] < 0)).toBe(true);
  });

  it('매끈하게: 튀어나온 점이 이웃 쪽으로 / 평평하게: 높이 차가 줄어든다', () => {
    const m = grid();
    const peak = m.verts.findIndex((v) => v[0] === 0 && v[1] === 0);
    const bumped = { verts: m.verts.map((v, i) => (i === peak ? ([0, 0, 3] as [number, number, number]) : v)), faces: m.faces };
    const ctx = sculptContext(bumped);
    const sm = applyDab(bumped, ctx, { brush: 'smooth', center: [0, 0, 3], normal: [0, 0, 1], radius: 4, strength: 1 });
    expect(sm.verts[peak]![2]).toBeLessThan(3);
    const fl = applyDab(bumped, ctx, { brush: 'flatten', center: [0, 0, 3], normal: [0, 0, 1], radius: 4, strength: 1 });
    expect(fl.verts[peak]![2]).toBeLessThan(3);
  });

  it('점토(C): 평균 평면을 띄워 그 아래 점만 올림 — 튀어나온 점은 그대로 / 주름(Shift+C): 파면서 가운데로 모음', () => {
    const m = grid();
    const peak = m.verts.findIndex((v) => v[0] === 2 && v[1] === 0);
    const bumped = { verts: m.verts.map((v, i) => (i === peak ? ([2, 0, 2] as [number, number, number]) : v)), faces: m.faces };
    const ctx = sculptContext(bumped);
    const clay = applyDab(bumped, ctx, { brush: 'clay', center: [0, 0, 0], normal: [0, 0, 1], radius: 5, strength: 1 });
    const at = (mm: { verts: number[][] }, x: number, y: number) => mm.verts[m.verts.findIndex((v) => v[0] === x && v[1] === y)]!;
    expect(at(clay, 0, 0)[2]).toBeGreaterThan(0);
    expect(at(clay, 0, 0)[2]).toBeLessThan(0.6); // 띄운 평면(≈ 평균 + 0.4)을 넘지 않는다
    expect(clay.verts[peak]![2]).toBe(2); // 평면 위 점은 그대로
    expect(at(clay, 6, 0)[2]).toBe(0); // 반지름 밖

    const flat = grid();
    const cctx = sculptContext(flat);
    const cr = applyDab(flat, cctx, { brush: 'crease', center: [0, 0, 0], normal: [0, 0, 1], radius: 5, strength: 1 });
    expect(at(cr, 0, 0)[2]).toBeLessThan(0); // 골
    expect(at(cr, 2, 0)[0]).toBeLessThan(2); // 가운데로 모임
    expect(at(cr, -2, 0)[0]).toBeGreaterThan(-2);
    const ridge = applyDab(flat, cctx, { brush: 'crease', center: [0, 0, 0], normal: [0, 0, 1], radius: 5, strength: 1, invert: true });
    expect(at(ridge, 0, 0)[2]).toBeGreaterThan(0); // Ctrl = 능선
  });

  it('X 대칭·잡아끌기·획 → set_verts 명령 (실행 취소 1번 단위)', () => {
    const m = grid();
    const ctx = sculptContext(m);
    const sym = applyDab(m, ctx, { brush: 'draw', center: [6, 0, 0], normal: [0, 0, 1], radius: 3, strength: 1, symmetryX: true });
    const at = (x: number) => sym.verts[m.verts.findIndex((v) => v[0] === x && v[1] === 0)]![2];
    expect(at(-6)).toBeCloseTo(at(6));
    const g = grabStroke(m, [0, 0, 0], 4, [0, 0, 2], 1);
    expect(g.verts[m.verts.findIndex((v) => v[0] === 0 && v[1] === 0)]![2]).toBeCloseTo(2);
    const edit = strokeEdit(m, g)!;
    expect(edit.verts.length).toBeGreaterThan(1);
    expect(edit.verts.length).toBeLessThan(m.verts.length);

    const added = executeCommand(emptyModel(), { type: 'add_mesh', id: 'g', primitive: 'grid', params: { size: 20, subdivisions: 10 } });
    if (!added.ok) throw new Error(added.error);
    const r = executeCommand(added.model, { type: 'mesh_edit', target: 'g', edit: { op: 'set_verts', ...edit } });
    expect(r.ok).toBe(true);
    if (r.ok && r.model.objects[0]!.kind === 'polymesh') expect(Math.max(...r.model.objects[0]!.polymesh.verts.map((v) => v[2]))).toBeCloseTo(2);
    expect(executeCommand(added.model, { type: 'mesh_edit', target: 'g', edit: { op: 'set_verts', verts: [0, 1], positions: [[0, 0, 0]] } }).ok).toBe(false);
  });
});

describe('스컬프트 마스크', () => {
  it('마스크 칠한 곳은 그리기 브러시에 움직이지 않는다, Ctrl 로 지우기', () => {
    const m = grid();
    const ctx = sculptContext(m);
    const c = m.verts.findIndex((v) => v[0] === 0 && v[1] === 0);
    const mask = paintMask(m, null, [0, 0, 0], 3, 1);
    expect(mask[c]).toBe(1);
    const out = applyDab(m, ctx, { brush: 'draw', center: [0, 0, 0], normal: [0, 0, 1], radius: 5, strength: 1, mask });
    expect(out.verts[c]![2]).toBe(0); // 가운데는 마스크 = 그대로
    const edge = m.verts.findIndex((v) => v[0] === 4 && v[1] === 0); // 마스크 밖, 브러시 안
    expect(out.verts[edge]![2]).toBeGreaterThan(0);
    const erased = paintMask(m, mask, [0, 0, 0], 3, 1, true);
    expect(erased[c]).toBe(0);
    expect(grabStroke(m, [0, 0, 0], 4, [0, 0, 2], 1, false, mask).verts[c]![2]).toBe(0);
  });
});
