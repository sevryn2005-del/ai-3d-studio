import { create } from 'zustand';
import type { BufferGeometry } from 'three';
import type { Health } from '../../api/backend';
import type { EngineEvaluation } from '../engine/types';

export type Connection = 'checking' | 'online' | 'offline';

export type Evaluation =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'done'; result: EngineEvaluation }
  | { status: 'failed'; error: string };

/** 캐시에 보관할 최대 형상 수. 실행 취소 시 재사용을 위해 현재 모델에 없는 형상도 일부 유지한다. */
export const GEOMETRY_CACHE_LIMIT = 200;

interface BackendState {
  connection: Connection;
  health: Health | null;
  evaluation: Evaluation;
  /** 형상 키 → 서버가 계산한 메시 (삽입 순서 = 오래된 순) */
  geometries: Record<string, BufferGeometry>;

  setOnline: (health: Health) => void;
  setOffline: () => void;
  setEvaluation: (e: Evaluation) => void;
  addGeometries: (entries: [string, BufferGeometry][], inUse: Set<string>) => void;
}

export const useBackendStore = create<BackendState>((set) => ({
  connection: 'checking',
  health: null,
  evaluation: { status: 'idle' },
  geometries: {},

  setOnline: (health) => set({ connection: 'online', health }),
  setOffline: () => set({ connection: 'offline', health: null, evaluation: { status: 'idle' } }),
  setEvaluation: (evaluation) => set({ evaluation }),
  addGeometries: (entries, inUse) =>
    set((s) => {
      const next = { ...s.geometries };
      for (const [key, g] of entries) {
        if (next[key]) {
          g.dispose(); // 이미 있는 형상: 기존 객체를 유지해 불필요한 재렌더 방지
          continue;
        }
        next[key] = g;
      }
      // 한도를 넘으면 현재 사용하지 않는 오래된 형상부터 해제
      const keys = Object.keys(next);
      for (let i = 0; keys.length - i > GEOMETRY_CACHE_LIMIT && i < keys.length; i++) {
        const k = keys[i]!;
        if (inUse.has(k)) continue;
        next[k]!.dispose();
        delete next[k];
      }
      return { geometries: next };
    }),
}));
