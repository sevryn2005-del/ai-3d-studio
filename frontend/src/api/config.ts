/**
 * 플랫폼별 실행 설정. 우선순위: 런타임 주입(window.__AI3D_CONFIG__) > 빌드 변수(VITE_*) > 기본값.
 *
 * - 웹(정적 호스팅, 백엔드 없음): VITE_CAD_ENGINE=browser 로 빌드
 * - 웹(클라우드 CAD 서버):        VITE_API_BASE=https://cad.example.com/api
 * - Windows(Tauri) / 로컬 모드:   기본값 (같은 출처의 /api). Tauri 는 사이드카 주소를 런타임에 주입할 수 있다.
 */
export type EngineMode = 'auto' | 'server' | 'browser';

export interface AppConfig {
  apiBase: string;
  cadEngine: EngineMode;
}

declare global {
  interface Window {
    __AI3D_CONFIG__?: Partial<AppConfig>;
  }
}

const ENGINE_MODES: readonly EngineMode[] = ['auto', 'server', 'browser'];

export function appConfig(): AppConfig {
  const injected = (typeof window !== 'undefined' && window.__AI3D_CONFIG__) || {};
  const env = import.meta.env;
  const mode = injected.cadEngine ?? (env.VITE_CAD_ENGINE as EngineMode | undefined) ?? 'auto';
  return {
    apiBase: (injected.apiBase ?? env.VITE_API_BASE ?? '/api').replace(/\/$/, ''),
    cadEngine: ENGINE_MODES.includes(mode) ? mode : 'auto',
  };
}
