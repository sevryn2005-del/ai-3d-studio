/** 도면 투상 (OCCT): 공유 픽스처 drawing-cases.json — 서버 tests/test_drawing.py 가 같은 값을 검사한다 */
import cases from '../../../../../shared/schemas/examples/drawing-cases.json';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelDefinitionSchema } from '../../../cad/commandTypes';
import type { AuxDirection, StandardViewName } from '../types';
import { dedupeCircles, occtDrawing } from './occtDrawing';
import type { OC } from './occtGeometry';
import { loadTestOcct } from './testOcct';

let oc: OC;
beforeAll(async () => {
  oc = await loadTestOcct();
}, 60_000);

const lineLength = (ls: number[][]) =>
  ls.reduce((s, l) => {
    let t = 0;
    for (let i = 2; i + 1 < l.length; i += 2) t += Math.hypot(l[i]! - l[i - 2]!, l[i + 1]! - l[i - 1]!);
    return s + t;
  }, 0);

describe('도면 투상 (OCCT): 공유 픽스처', () => {
  it.each(Object.entries(cases))('%s', (_name, c) => {
    const model = ModelDefinitionSchema.parse(c.model);
    const names = Object.keys(c.views).filter((n) => !n.startsWith('aux')) as StandardViewName[];
    const section = 'section' in c ? (c.section as { view: 'front' | 'right'; offset: number; rect?: [number, number, number, number] }) : undefined;
    const aux = 'aux' in c ? (c.aux as AuxDirection[]) : [];
    const views = occtDrawing(oc, model, names, section, aux);
    expect(views.map((v) => v.name).sort()).toEqual(Object.keys(c.views).sort());
    for (const v of views) {
      const e = (c.views as Record<string, { visible?: number; hidden?: number; bounds: number[]; circles?: number[]; axes?: number; section?: number }>)[v.name]!;
      if (e.axes !== undefined) expect(lineLength(v.axes)).toBeCloseTo(e.axes, 3);
      if (e.section !== undefined) expect(lineLength(v.section ?? [])).toBeCloseTo(e.section, 1);
      else expect(v.section).toBeUndefined();
      if (e.visible !== undefined) expect(lineLength(v.visible)).toBeCloseTo(e.visible, 1);
      if (e.hidden !== undefined) expect(lineLength(v.hidden)).toBeCloseTo(e.hidden, 1);
      v.bounds.forEach((b, i) => expect(b).toBeCloseTo(e.bounds[i]!, 4));
      if (e.circles) expect(v.circles.filter((x) => x.full && x.visible).map((x) => x.radius)).toEqual(e.circles);
    }
  }, 60_000);

  it('숨긴 객체는 그리지 않고, 그릴 객체가 없으면 오류', () => {
    const model = ModelDefinitionSchema.parse(cases['object-behind-object'].model);
    const hidden = { ...model, objects: model.objects.map((o) => (o.id === 'b' ? { ...o, hidden: true } : o)) };
    expect(lineLength(occtDrawing(oc, hidden, ['front'])[0]!.hidden)).toBeCloseTo(0, 6);
    expect(() => occtDrawing(oc, { ...model, objects: [] }, ['front'])).toThrow('그릴 객체가 없습니다');
  });

  it('단면 위치가 형상 밖이면 오류', () => {
    const model = ModelDefinitionSchema.parse(cases['block-blind-hole'].model);
    expect(() => occtDrawing(oc, model, ['front'], { view: 'front', offset: 50 })).toThrow('단면 위치');
    // 형상 앞쪽 바깥 = 걷어낼 것이 없음 → 보통 정면도와 같은 선 (숨은선은 없음)
    expect(lineLength(occtDrawing(oc, model, ['front'], { view: 'front', offset: -50 })[0]!.visible)).toBeCloseTo(100, 3);
  });

  it('같은 원 조각은 하나로', () => {
    const half = { center: [0, 0] as [number, number], radius: 2, full: false, visible: false };
    expect(dedupeCircles([half, { ...half, visible: true }])).toEqual([{ ...half, full: true, visible: true }]);
  });
});
