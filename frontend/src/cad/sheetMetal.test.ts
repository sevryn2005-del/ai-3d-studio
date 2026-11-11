import { describe, expect, it } from 'vitest';
import { bendAllowance, flatPattern, flatPatternDxf, polygonArea, sheetBase, sheetError, sheetVolume } from './sheetMetal';
import { executeBatch } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import type { SheetParams } from './commandTypes';

const tray: SheetParams = { width: 60, depth: 40, thickness: 1.5, bendRadius: 2, flangePX: 15, flangeNX: 15, flangePY: 10, flangeNY: 0, kFactor: 0.44 };

describe('판금 (형식 v45)', () => {
  it('바닥 평판·부피: 플랜지 있는 변만 a = r + t 만큼 안쪽', () => {
    expect(sheetBase(tray)).toEqual([-26.5, 26.5, -20, 16.5]);
    expect(sheetVolume(tray)).toBeCloseTo(5494.1714, 3);
  });
  it('K = 0.5 이면 전개 넓이 × 두께 = 부피 (중립면이 두께 가운데)', () => {
    const p = { ...tray, kFactor: 0.5 };
    expect(polygonArea(flatPattern(p).outline) * p.thickness).toBeCloseTo(sheetVolume(p), 6);
  });
  it('전개 크기·굽힘선·DXF', () => {
    const f = flatPattern(tray);
    const ba = bendAllowance(tray);
    expect(ba).toBeCloseTo((Math.PI / 2) * (2 + 0.44 * 1.5), 9);
    expect(f.size[0]).toBeCloseTo(53 + 2 * (ba + 15 - 3.5), 9);
    expect(f.size[1]).toBeCloseTo(36.5 + (ba + 10 - 3.5), 9);
    expect(f.bendLines).toHaveLength(6);
    expect(f.outline).toHaveLength(8); // −Y 플랜지 없음 → 아래 변은 양쪽 플랜지 끝까지 한 직선
    const dxf = flatPatternDxf(f);
    expect(dxf.match(/\nOUTLINE\n/g)).toHaveLength(8);
    expect(dxf.match(/\nBEND\n/g)).toHaveLength(6);
    expect(dxf.trim().endsWith('EOF')).toBe(true);
  });
  it('검사: 플랜지가 굽힘보다 낮으면·평판이 안 남으면 거부, 명령·set_params 로 만들고 바꾼다', () => {
    expect(sheetError({ ...tray, flangePX: 3 })).toMatch(/플랜지 높이/);
    expect(sheetError({ ...tray, width: 6 })).toMatch(/바닥 평판/);
    const r = executeBatch(createDefaultModel(), [
      { type: 'create_sheet_metal', id: 'sm', width: 80, depth: 60, flangePX: 20 },
      { type: 'set_params', target: 'sm', params: { thickness: 2, flangeNY: 12 } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.objects.find((o) => o.id === 'sm')).toMatchObject({ kind: 'sheet', params: { thickness: 2, bendRadius: 1, flangePX: 20, flangeNY: 12, kFactor: 0.44 } });
    expect(executeBatch(r.model, [{ type: 'set_params', target: 'sm', params: { flangePX: 2 } }]).ok).toBe(false);
  });
});
