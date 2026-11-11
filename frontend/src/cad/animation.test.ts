import { describe, expect, it } from 'vitest';
import { executeBatch } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import { poseAt } from './animation';
import type { ModelDefinition } from './commandTypes';

const run = (m: ModelDefinition, cmds: unknown[]) => {
  const r = executeBatch(m, cmds);
  if (!r.ok) throw new Error(r.error);
  return r.model;
};

describe('애니메이션 (형식 v43)', () => {
  it('키 사이 직선 보간, 첫 키 앞·마지막 키 뒤는 그 키', () => {
    const track = {
      id: 'b',
      keys: [
        { frame: 10, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
        { frame: 30, position: [40, 0, 20] as [number, number, number], rotation: [0, 0, 90] as [number, number, number] },
      ],
    };
    expect(poseAt(track, 0)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
    expect(poseAt(track, 20)).toEqual({ position: [20, 0, 10], rotation: [0, 0, 45] });
    expect(poseAt(track, 25.5)).toEqual({ position: [31, 0, 15.5], rotation: [0, 0, 69.75] });
    expect(poseAt(track, 99)).toEqual({ position: [40, 0, 20], rotation: [0, 0, 90] });
  });
  it('명령: 키 넣기(지금 위치·지정 위치·같은 프레임 바꾸기), 지우기(마지막 키면 트랙도), 설정·모두 지우기 — 설계 위치 그대로', () => {
    const m0 = createDefaultModel();
    const m1 = run(m0, [
      { type: 'insert_keyframe', target: 'box_1', frame: 24, position: [50, 0, 0], rotation: [0, 0, 0] },
      { type: 'insert_keyframe', target: 'box_1', frame: 0 },
      { type: 'insert_keyframe', target: 'box_1', frame: 24, position: [60, 0, 0], rotation: [0, 0, 0] },
    ]);
    expect(m1.animation).toEqual({ fps: 24, end: 120, tracks: [{ id: 'box_1', keys: [{ frame: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { frame: 24, position: [60, 0, 0], rotation: [0, 0, 0] }] }] });
    expect(m1.objects).toEqual(m0.objects);
    const m2 = run(m1, [{ type: 'delete_keyframe', target: 'box_1', frame: 24 }, { type: 'delete_keyframe', target: 'box_1', frame: 0 }]);
    expect(m2.animation!.tracks).toEqual([]);
    expect(executeBatch(m1, [{ type: 'delete_keyframe', target: 'box_1', frame: 5 }]).ok).toBe(false);
    expect(run(m1, [{ type: 'set_animation', fps: 30, end: 60 }]).animation).toMatchObject({ fps: 30, end: 60 });
    expect(run(m1, [{ type: 'set_animation', clear: true }]).animation!.tracks).toEqual([]);
  });
  it('보간 방식 (형식 v44): 부드럽게 = smoothstep, 계단 = 다음 키까지 그대로, 같은 프레임 다시 넣으면 방식 유지', () => {
    const v = (x: number): [number, number, number] => [x, 0, 0];
    const z: [number, number, number] = [0, 0, 0];
    const ease = { id: 'b', keys: [{ frame: 0, position: v(0), rotation: z, interp: 'ease' as const }, { frame: 10, position: v(100), rotation: z }] };
    expect(poseAt(ease, 5).position[0]).toBeCloseTo(50);
    expect(poseAt(ease, 2.5).position[0]).toBeCloseTo(15.625);
    const step = { id: 'b', keys: [{ frame: 0, position: v(0), rotation: z, interp: 'constant' as const }, { frame: 10, position: v(100), rotation: z }] };
    expect(poseAt(step, 9.9).position[0]).toBe(0);
    expect(poseAt(step, 10).position[0]).toBe(100);
    const m = run(createDefaultModel(), [
      { type: 'insert_keyframe', target: 'box_1', frame: 0, interp: 'ease' },
      { type: 'insert_keyframe', target: 'box_1', frame: 0, position: [5, 0, 0] },
      { type: 'insert_keyframe', target: 'box_1', frame: 10, interp: 'linear' },
    ]);
    expect(m.animation!.tracks[0]!.keys).toEqual([
      { frame: 0, position: [5, 0, 0], rotation: [0, 0, 0], interp: 'ease' },
      { frame: 10, position: [0, 0, 0], rotation: [0, 0, 0] },
    ]);
  });
});
