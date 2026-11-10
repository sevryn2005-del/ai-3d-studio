/**
 * 애니메이션 (형식 v43): 최상위 객체 위치·회전 키프레임, 키 사이 직선 보간 (첫 키 앞·마지막 키 뒤는 그 키 그대로).
 * 화면 재생만 — 설계 위치·형상·메이트·내보내기는 바뀌지 않는다.
 */
import type { Animation, AnimationTrack, Keyframe, ModelDefinition, Transform, Vec3 } from './commandTypes';

export const DEFAULT_ANIMATION: Animation = { fps: 24, end: 120, tracks: [] };

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 트랙의 frame 자세 (frame 은 소수도 — 재생 중 사이 프레임) */
export function poseAt(track: AnimationTrack, frame: number): Transform {
  const k = track.keys;
  if (frame <= k[0]!.frame) return { position: k[0]!.position, rotation: k[0]!.rotation };
  const last = k[k.length - 1]!;
  if (frame >= last.frame) return { position: last.position, rotation: last.rotation };
  let i = 0;
  while (k[i + 1]!.frame < frame) i++;
  const a = k[i]!;
  const b = k[i + 1]!;
  const t = (frame - a.frame) / (b.frame - a.frame);
  return { position: lerp(a.position, b.position, t), rotation: lerp(a.rotation, b.rotation, t) };
}

export function trackOf(model: ModelDefinition, id: string): AnimationTrack | undefined {
  return model.animation?.tracks.find((t) => t.id === id);
}

/** 키 넣기: 같은 프레임은 바꾸고, 프레임 순서로 */
export function withKey(anim: Animation, id: string, key: Keyframe): Animation {
  const tracks = anim.tracks.some((t) => t.id === id) ? anim.tracks : [...anim.tracks, { id, keys: [] as Keyframe[] }];
  return {
    ...anim,
    tracks: tracks.map((t) => (t.id === id ? { ...t, keys: [...t.keys.filter((k) => k.frame !== key.frame), key].sort((a, b) => a.frame - b.frame) } : t)),
  };
}

/** 키 지우기: 키가 없어진 트랙은 빠진다 */
export function withoutKey(anim: Animation, id: string, frame: number): Animation {
  return {
    ...anim,
    tracks: anim.tracks.map((t) => (t.id === id ? { ...t, keys: t.keys.filter((k) => k.frame !== frame) } : t)).filter((t) => t.keys.length > 0),
  };
}
