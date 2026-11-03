import { afterEach, describe, expect, it } from 'vitest';
import { appConfig } from '../../api/config';
import { selectEngineId } from './engines';

describe('selectEngineId (CLAUDE.md 2장 #4·#5)', () => {
  it.each([
    // auto: 서버가 있으면 서버(CadQuery), 없으면 브라우저, 확인 중에는 대기
    ['auto', 'online', 'server'],
    ['auto', 'offline', 'browser'],
    ['auto', 'checking', null],
    // server: Windows 앱에서 서버 결과만 쓰는 경우
    ['server', 'online', 'server'],
    ['server', 'offline', null],
    // browser: 백엔드 없는 정적 웹
    ['browser', 'online', 'browser'],
    ['browser', 'offline', 'browser'],
  ] as const)('%s + %s → %s', (mode, connection, expected) => {
    expect(selectEngineId(mode, connection)).toBe(expected);
  });
});

describe('appConfig', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('기본값: 같은 출처 /api, auto', () => {
    expect(appConfig()).toEqual({ apiBase: '/api', cadEngine: 'auto' });
  });

  it('런타임 주입(Tauri·클라우드)이 우선하고, 끝의 / 를 정리한다', () => {
    (globalThis as { window?: unknown }).window = {
      __AI3D_CONFIG__: { apiBase: 'http://127.0.0.1:51234/api/', cadEngine: 'server' },
    };
    expect(appConfig()).toEqual({ apiBase: 'http://127.0.0.1:51234/api', cadEngine: 'server' });
  });

  it('알 수 없는 엔진 모드는 auto 로', () => {
    (globalThis as { window?: unknown }).window = { __AI3D_CONFIG__: { cadEngine: 'gpu' } };
    expect(appConfig().cadEngine).toBe('auto');
  });
});
