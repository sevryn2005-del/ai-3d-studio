/**
 * 활성 CAD 엔진 선택.
 *
 * 모드 (api/config.ts 의 cadEngine):
 * - 'auto'   : 서버에 연결되면 서버 엔진, 연결할 수 없으면 브라우저 엔진 (기본)
 * - 'server' : 서버 엔진만 (Windows 앱·로컬 모드에서 서버 결과만 쓰고 싶을 때)
 * - 'browser': 브라우저 엔진만 (백엔드 없는 정적 웹 배포)
 */
import { appConfig, type EngineMode } from '../../api/config';
import { useBackendStore, type Connection } from '../backend/backendStore';
import { serverEngine } from './serverEngine';
import type { CadEngine, EngineId } from './types';

export function selectEngineId(mode: EngineMode, connection: Connection): EngineId | null {
  if (mode === 'server') return connection === 'online' ? 'server' : null;
  if (mode === 'browser') return 'browser';
  if (connection === 'online') return 'server';
  if (connection === 'offline') return 'browser';
  return null; // 연결 확인 중: 두 엔진으로 중복 계산하지 않도록 대기
}

let browserEngine: CadEngine | null = null;

export function setBrowserEngine(engine: CadEngine | null) {
  browserEngine = engine;
}

export function getActiveEngine(id: EngineId): CadEngine {
  if (id === 'server') return serverEngine;
  if (!browserEngine) throw new Error('브라우저 CAD 엔진이 준비되지 않았습니다');
  return browserEngine;
}

export function useActiveEngineId(): EngineId | null {
  const connection = useBackendStore((s) => s.connection);
  const id = selectEngineId(appConfig().cadEngine, connection);
  return id === 'browser' && !browserEngine ? null : id;
}
