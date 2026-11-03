import { useEffect } from 'react';
import { getHealth } from '../../api/backend';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useBackendStore } from './backendStore';
import { buildGeometry, geometryKey } from './renderMesh';
import type { ModelDefinition } from '../../cad/commandTypes';
import { byId, sketchIndex } from '../../cad/modelGraph';
import type { CadEngine, EngineEvaluation } from '../engine/types';
import { getActiveEngine, useActiveEngineId } from '../engine/engines';
import { appConfig } from '../../api/config';

export const HEALTH_INTERVAL_MS = 10_000;
export const EVALUATE_DEBOUNCE_MS = 400;

/**
 * 백엔드 연결 상태를 주기적으로 확인하고, 설계 원본이 바뀔 때마다 활성 CAD 엔진(서버 또는 브라우저)으로 계산한다.
 * - 편집이 연속될 때는 마지막 변경 후 EVALUATE_DEBOUNCE_MS 뒤 한 번만 요청
 * - 새 요청이 시작되면 이전 요청은 취소 (늦게 도착한 오래된 응답이 최신 결과를 덮지 않도록)
 * - 서버가 꺼져 있어도 편집기는 정상 동작한다 (검증 결과만 표시되지 않음)
 */
export function useBackendSync() {
  const engineId = useActiveEngineId();
  const model = useSceneStore(selectModel);

  // 연결 상태 확인 (브라우저 전용 모드 = 백엔드 없는 정적 웹: 서버에 요청하지 않는다)
  useEffect(() => {
    const { setOnline, setOffline } = useBackendStore.getState();
    if (appConfig().cadEngine === 'browser') {
      setOffline();
      return;
    }
    let alive = true;
    const check = async () => {
      try {
        const h = await getHealth();
        if (alive) setOnline(h);
      } catch {
        if (alive) setOffline();
      }
    };
    void check();
    const timer = setInterval(check, HEALTH_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // 형상 계산 (활성 엔진이 정해지지 않았으면 대기: 예) 시작 직후 서버 연결 확인 중)
  useEffect(() => {
    if (!engineId) return;
    const engine = getActiveEngine(engineId);
    const { setEvaluation } = useBackendStore.getState();
    const controller = new AbortController();
    setEvaluation({ status: 'pending' });
    const timer = setTimeout(() => void runEvaluation(engine, model, controller.signal), EVALUATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [model, engineId]);
}

/**
 * 한 번의 형상 계산. 설계 원본(모델·이력)은 절대 바꾸지 않는다 — 결과는 형상 키 캐시와 표시 상태에만 들어간다.
 * - 계산 중 모델이 바뀌면(signal 취소) 늦게 온 결과·오류는 버린다 → 오래된 결과가 최신 화면을 덮지 않음
 * - 결과 메시는 "보낸 모델"의 형상 키로 저장 → 다른 형상에 잘못 붙지 않음
 */
export async function runEvaluation(
  engine: Pick<CadEngine, 'evaluate'>,
  model: ModelDefinition,
  signal: AbortSignal,
): Promise<'done' | 'failed' | 'discarded'> {
  const { setEvaluation } = useBackendStore.getState();
  try {
    const result = await engine.evaluate(model, signal);
    if (signal.aborted) return 'discarded';
    storeMeshes(model, result);
    setEvaluation({ status: 'done', result });
    return 'done';
  } catch (e) {
    if (signal.aborted) return 'discarded';
    setEvaluation({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    return 'failed';
  }
}

/** 응답 메시를 "요청에 보낸 모델" 기준의 형상 키로 캐시에 넣는다. */
function storeMeshes(sent: ModelDefinition, result: EngineEvaluation) {
  const sentIndex = byId(sent);
  const sentSketches = sketchIndex(sent);
  const keyById = new Map(sent.objects.map((o) => [o.id, geometryKey(o, sentIndex, sentSketches)]));
  const entries = result.meshes.flatMap((m) => {
    const key = keyById.get(m.objectId);
    if (!key) return [];
    const g = buildGeometry(m);
    g.userData.engine = result.engine; // 화면·테스트에서 어느 엔진이 계산했는지 확인
    return [[key, g] as [string, ReturnType<typeof buildGeometry>]];
  });
  const current = useSceneStore.getState().history.present.model;
  const index = byId(current);
  useBackendStore.getState().addGeometries(entries, new Set(current.objects.map((o) => geometryKey(o, index, sketchIndex(current)))));
}
