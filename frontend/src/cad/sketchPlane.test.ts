import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, CylinderGeometry, Mesh } from 'three';
import type { SketchPlane } from './commandTypes';
import type { Profile } from './sketch';
import { extrudePreviewMatrix, planeMatrix, planeSizeToLocal } from './sketchPlane';

const box = (mesh: Mesh) => {
  mesh.updateMatrixWorld(true);
  const b = new Box3().setFromObject(mesh);
  return [...b.min.toArray(), ...b.max.toArray()].map((v) => Math.round(v * 1e6) / 1e6 + 0);
};

describe('스케치 평면 (서버 test_sketch_extrude.py 와 같은 기대값)', () => {
  it('평면 원점 = 법선 × offset, 기저는 회전(뒤집힘 없음)', () => {
    for (const [type, origin] of [['XY', [0, 0, 3]], ['XZ', [0, -3, 0]], ['YZ', [3, 0, 0]]] as const) {
      const m = planeMatrix({ type, offset: 3 });
      expect(m.elements.slice(12, 15).map((v) => v + 0)).toEqual(origin);
      expect(m.determinant()).toBeCloseTo(1, 12);
    }
  });

  it.each([
    ['XZ 사각형', { type: 'rectangle', center: [5, 10], width: 30, height: 20, z: 3, plane: { type: 'XZ', offset: 3 } }, 4, [-10, -7, 0, 20, -3, 20]],
    ['YZ 원', { type: 'circle', center: [2, 8], diameter: 10, z: -2, plane: { type: 'YZ', offset: -2 } }, 6, [-2, -3, 3, 4, 7, 13]],
    ['XY 원', { type: 'circle', center: [18, 0], diameter: 6, z: -1, plane: { type: 'XY', offset: -1 } }, 6, [15, -3, -1, 21, 3, 5]],
  ] as const)('미리보기 배치: %s', (_, profile, distance, expected) => {
    const p = profile as unknown as Profile;
    const geom = p.type === 'rectangle' ? new BoxGeometry(p.width, p.height, distance) : new CylinderGeometry(p.diameter / 2, p.diameter / 2, distance, 64);
    const mesh = new Mesh(geom);
    mesh.applyMatrix4(extrudePreviewMatrix(p, distance));
    const b = box(mesh);
    b.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 1)); // 원통 다각형 근사 허용
  });

  it('평면 크기 → 로컬 X·Y·Z', () => {
    const plane = (type: SketchPlane['type']): SketchPlane => ({ type, offset: 0 });
    expect(planeSizeToLocal(plane('XY'), [30, 20, 4])).toEqual([30, 20, 4]);
    expect(planeSizeToLocal(plane('XZ'), [30, 20, 4])).toEqual([30, 4, 20]);
    expect(planeSizeToLocal(plane('YZ'), [30, 20, 4])).toEqual([4, 30, 20]);
  });
});
