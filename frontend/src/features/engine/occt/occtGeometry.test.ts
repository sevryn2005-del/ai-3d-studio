/**
 * 브라우저 정밀 엔진(OCCT): 모든 공유 픽스처를 manifold·서버와 같은 기준(해석적 부피·닫힌 메시)으로 검사한다.
 */
import cases from '../../../../../shared/schemas/examples/feature-cases.json';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelDefinitionSchema } from '../../../cad/commandTypes';
import { topLevelObjects, byId } from '../../../cad/modelGraph';
import { isSuppressed } from '../../../cad/features';
import { toBinaryStl } from '../browser/exporters';
import { occtLocalProps, occtStep, occtTopology, occtWorldMesh, readStep, volumeOf, boundsOf, type OC } from './occtGeometry';
import { executeCommand } from '../../../cad/commandExecutor';
import { emptyModel } from '../../../cad/commandTypes';
import { toBase64 } from '../../../cad/meshData';
import { loadTestOcct } from './testOcct';
import { stlCheck } from '../browser/stlCheck';

let oc: OC;
beforeAll(async () => {
  oc = await loadTestOcct();
}, 60_000);

describe('정밀 엔진(OCCT): 공유 픽스처', () => {
  it.each(Object.entries(cases))('%s', (_name, c) => {
    const model = ModelDefinitionSchema.parse(c.model);
    const index = byId(model);
    const roots = topLevelObjects(model).filter((o) => !isSuppressed(o, index));
    expect(roots.length).toBe(c.roots);
    const meshes = roots.map((o) => ({ name: o.name, ...occtWorldMesh(oc, model, o) }));
    const r = stlCheck(toBinaryStl(meshes));
    expect(r.bad).toBe(0);
    expect(Math.abs(r.volume - c.volume) / c.volume).toBeLessThan(3e-3);
    if ('bbox' in c && c.bbox) {
      const [lo, hi] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (const m of meshes)
        for (let i = 0; i < m.positions.length; i += 3)
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
            hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
          }
      [...lo, ...hi].forEach((v, i) => expect(v).toBeCloseTo([...c.bbox![0]!, ...c.bbox![1]!][i]!, 2));
    }
  }, 60_000);
});

function build(commands: unknown[]) {
  let model = emptyModel();
  for (const c of commands) {
    const r = executeCommand(model, c as never);
    if (!r.ok) throw new Error(r.error);
    model = r.model;
  }
  return model;
}

describe('정밀 엔진(OCCT): 모서리 규칙·구배·STEP', () => {
  it('원통 이음선은 고르지 않는다 (vertical 규칙은 원통에서 고를 모서리가 없음)', () => {
    const model = build([{ type: 'create_cylinder', id: 'c', radius: 5, height: 10 }, { type: 'edge_feature', id: 'f', target: 'c', feature: 'fillet', size: 1, edges: 'vertical' }]);
    expect(() => occtLocalProps(oc, model, model.objects.find((o) => o.id === 'f')!)).toThrow('규칙에 맞는 모서리가 없습니다');
  });

  it('너무 큰 필렛은 사용자 메시지로 실패한다', () => {
    const model = build([{ type: 'create_box', id: 'b', width: 10, depth: 10, height: 10 }, { type: 'edge_feature', id: 'f', target: 'b', feature: 'fillet', size: 6, edges: 'all' }]);
    expect(() => occtLocalProps(oc, model, model.objects.find((o) => o.id === 'f')!)).toThrow('크기를 줄여 보세요');
  });

  it('음수 구배는 위로 갈수록 넓어진다 (바닥 = 중립면)', () => {
    const model = build([{ type: 'create_box', id: 'b', width: 20, depth: 20, height: 10 }, { type: 'draft', id: 'd', target: 'b', angle: -5 }]);
    const p = occtLocalProps(oc, model, model.objects.find((o) => o.id === 'd')!);
    const top = 20 + 2 * 10 * Math.tan((5 * Math.PI) / 180);
    expect(p.bounds[3]).toBeCloseTo(top / 2, 4);
    expect(p.volume).toBeCloseTo((10 / 3) * (400 + top * top + Math.sqrt(400 * top * top)), 2);
  });

  it('STEP 내보내기 → 다시 읽기: 월드 좌표의 부피가 같다', () => {
    const model = build([
      { type: 'create_box', id: 'b', width: 20, depth: 20, height: 20, position: [30, 0, 0] },
      { type: 'edge_feature', id: 'f', target: 'b', feature: 'fillet', size: 2, edges: 'all' },
      { type: 'create_sphere', id: 's', radius: 5 },
    ]);
    const bytes = occtStep(oc, model);
    expect(new TextDecoder().decode(bytes.slice(0, 13))).toBe('ISO-10303-21;');
    const back = readStep(oc, toBase64(bytes), '다시 읽기');
    expect(volumeOf(oc, back)).toBeCloseTo(7804.696 + (4 / 3) * Math.PI * 125, 0);
    // 원점 규칙: 바닥면 중심으로 옮겨진다
    const b = boundsOf(oc, back);
    expect(b[2]).toBeCloseTo(0, 6);
    expect((b[0]! + b[3]!) / 2).toBeCloseTo(0, 6);
  });

  it('깨진 STEP 은 사용자 메시지로 실패한다', () => {
    expect(() => readStep(oc, btoa('not a step file'), '깨진 파일')).toThrow('STEP 파일을 읽을 수 없습니다');
  });
});

describe('정밀 엔진(OCCT): 화면 선택용 위상', () => {
  it('상자: 평면 6개(바깥 법선) · 직선 모서리 12개, 객체 변환 적용', () => {
    const model = build([{ type: 'create_box', id: 'b', width: 20, depth: 10, height: 5, position: [100, 0, 0] }]);
    const t = occtTopology(oc, model, model.objects[0]!);
    expect(t.faces.map((f) => f.kind)).toEqual(Array(6).fill('plane'));
    const top = t.faces.find((f) => f.dir[2] > 0.99)!;
    expect(top.origin).toEqual([expect.closeTo(100, 6), expect.closeTo(0, 6), expect.closeTo(5, 6)]);
    expect(top.indices.length).toBeGreaterThan(0);
    expect(t.edges).toHaveLength(12);
    expect(t.edges.every((e) => e.kind === 'line')).toBe(true);
    expect(t.edges.map((e) => Math.round(e.length)).sort((a, b) => a - b)).toEqual([5, 5, 5, 5, 10, 10, 10, 10, 20, 20, 20, 20]);
  });

  it('원통: 원통면(축·반지름) · 원 모서리 2개(중심·반지름) + 이음선', () => {
    const model = build([{ type: 'create_cylinder', id: 'c', radius: 4, height: 9 }]);
    const t = occtTopology(oc, model, model.objects[0]!);
    const side = t.faces.find((f) => f.kind === 'cylinder')!;
    expect(side.radius).toBeCloseTo(4, 9);
    expect(Math.abs(side.dir[2])).toBeCloseTo(1, 9);
    const circles = t.edges.filter((e) => e.kind === 'circle');
    expect(circles).toHaveLength(2);
    expect(circles.map((e) => e.center[2]).sort()).toEqual([0, 9]);
    expect(circles[0]!.radius).toBeCloseTo(4, 9);
    // 중간점은 모서리 위의 점 → 필렛 at 점으로 쓰면 그 모서리가 골라진다
    const pick = circles.find((e) => e.center[2] === 9)!.mid;
    const f = build([{ type: 'create_cylinder', id: 'c', radius: 4, height: 9 }, { type: 'edge_feature', id: 'f', target: 'c', feature: 'chamfer', size: 1, edges: { at: [pick] } }]);
    expect(occtLocalProps(oc, f, f.objects.find((o) => o.id === 'f')!).volume).toBeCloseTo(Math.PI * 16 * 9 - 0.5 * 2 * Math.PI * (4 - 1 / 3), 3);
  });
});
