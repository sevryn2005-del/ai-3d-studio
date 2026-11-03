import { useMemo } from 'react';
import { checkPrintability, type PrintIssue, type WorldBox } from '../../cad/printCheck';
import type { ObjectId } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useBackendStore } from '../backend/backendStore';
import { worldBoxes } from './worldBoxes';

export interface PrintCheck {
  issues: PrintIssue[];
  boxes: Map<ObjectId, WorldBox>;
  /** false: 일부 객체가 아직 엔진 메시 없이 근사로 검사됨 */
  exact: boolean;
}

/** 설계나 엔진 메시가 바뀔 때마다 다시 검사한다 (로컬 계산, 비용 없음) */
export function usePrintCheck(): PrintCheck {
  const model = useSceneStore(selectModel);
  const geometries = useBackendStore((s) => s.geometries);
  return useMemo(() => {
    const { boxes, exact } = worldBoxes(model, geometries);
    return { issues: checkPrintability(model, boxes), boxes, exact };
  }, [model, geometries]);
}

/** 컴포넌트 밖(내보내기 등)에서 현재 상태로 검사 */
export function currentPrintCheck(): PrintCheck {
  const model = useSceneStore.getState().history.present.model;
  const { boxes, exact } = worldBoxes(model, useBackendStore.getState().geometries);
  return { issues: checkPrintability(model, boxes), boxes, exact };
}
