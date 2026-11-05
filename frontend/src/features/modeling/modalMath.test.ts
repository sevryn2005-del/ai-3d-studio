import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { grabDelta, localMatrix, movedTransform, parseTyped, screenAngle, screenScale, typeKey, worldMatrix } from './modalMath';
import { transformVerts } from '../../cad/polymesh';

describe('모달 조작 계산 (G/R/S)', () => {
  it('숫자 입력: 블렌더처럼 숫자·소수점·마이너스·지우기', () => {
    let t = '';
    for (const k of ['1', '2', '.', '5', '-']) t = typeKey(t, k) ?? t;
    expect(t).toBe('-12.5');
    expect(parseTyped(t)).toBe(-12.5);
    expect(typeKey(t, 'Backspace')).toBe('-12.');
    expect(parseTyped('-')).toBeNull();
    expect(typeKey('1', 'q')).toBeNull();
  });

  it('이동: 축 잠금이면 그 축 성분만, 입력값은 축(기본 X) 방향 거리', () => {
    expect(grabDelta([3, 4, 5], null, null)).toEqual([3, 4, 5]);
    expect(grabDelta([3, 4, 5], 'y', null)).toEqual([0, 4, 0]);
    expect(grabDelta([3, 4, 5], 'z', 10)).toEqual([0, 0, 10]);
    expect(grabDelta([3, 4, 5], null, 7)).toEqual([7, 0, 0]);
  });

  it('회전: 피벗 기준, 월드 Z 90° → (11,0,0) 이 (10,1,0)', () => {
    const m = worldMatrix({ kind: 'rotate', axis: [0, 0, 1], degrees: 90 }, [10, 0, 0]);
    const p = new Vector3(11, 0, 0).applyMatrix4(m);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(1);
  });

  it('크기: 한 축만 늘리기 (피벗 기준)', () => {
    const m = worldMatrix({ kind: 'scale', factor: 2, axis: [1, 0, 0] }, [1, 0, 0]);
    expect(new Vector3(3, 5, 7).applyMatrix4(m).toArray()).toEqual([5, 5, 7]);
  });

  it('편집 모드: 월드 X 이동이 돌아간 객체에서도 월드 X 로 (obj⁻¹·M·obj)', () => {
    const obj = { position: [5, 0, 0] as [number, number, number], rotation: [0, 0, 90] as [number, number, number] };
    const local = localMatrix(worldMatrix({ kind: 'grab', delta: [10, 0, 0] }, [0, 0, 0]), obj);
    const moved = transformVerts({ verts: [[0, 0, 0]], faces: [] }, [0], local).verts[0]!;
    // 객체가 Z 로 90° 돌아가 있으므로 월드 +X = 로컬 −Y
    expect(moved[0]).toBeCloseTo(0);
    expect(moved[1]).toBeCloseTo(-10);
  });

  it('오브젝트 이동·회전 결과 변환', () => {
    const t = movedTransform(worldMatrix({ kind: 'rotate', axis: [0, 0, 1], degrees: 30 }, [0, 0, 0]), { position: [10, 0, 0], rotation: [0, 0, 0] });
    expect(t.rotation[2]).toBeCloseTo(30);
    expect(t.position[1]).toBeCloseTo(5);
  });

  it('화면 각도·크기 비', () => {
    expect(screenAngle([0, 0], [10, 0], [0, -10])).toBeCloseTo(90); // 화면 위쪽(y 감소) = 반시계
    expect(screenScale([0, 0], [10, 0], [0, 25])).toBeCloseTo(2.5);
  });
});
