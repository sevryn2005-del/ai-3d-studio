import { useSceneStore } from '../../cad/sceneStore';
import { getActiveEngine } from '../engine/engines';
import type { EngineId, ExportFormat } from '../engine/types';
import { downloadBlob } from './projectStorage';
import { HostSaveDeclined } from './hostDownloads';
import { useProjectStore } from './projectStore';

export const EXPORT_FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: '3mf', label: '3MF', hint: '3D 프린팅 (권장 · 단위 포함)' },
  { format: 'stl', label: 'STL', hint: '3D 프린팅 (범용)' },
  { format: 'step', label: 'STEP', hint: '다른 CAD 프로그램 (정확한 곡면)' },
  { format: 'glb', label: 'GLB', hint: '웹 · 3D 뷰어' },
];

/** 현재 설계를 활성 CAD 엔진(서버 또는 브라우저)으로 변환해 내려받는다. 성공 여부를 반환한다. */
export async function downloadExport(engineId: EngineId, format: ExportFormat): Promise<boolean> {
  const { history, reportError } = useSceneStore.getState();
  try {
    const blob = await getActiveEngine(engineId).exportFile(format, history.present.model);
    await downloadBlob(blob, `${useProjectStore.getState().name}.${format}`);
    return true;
  } catch (e) {
    if (e instanceof HostSaveDeclined) return false;
    reportError(`${format.toUpperCase()} 내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
