/**
 * 자동 임시 저장 (브라우저 저장소). 새로 고침·비정상 종료 후 작업을 복원한다.
 * 프로젝트 파일과 같은 형식/검증을 사용한다. 저장소를 쓸 수 없는 환경에서도 앱은 정상 동작한다.
 */
import type { ModelDefinition } from '../../cad/commandTypes';
import { parseProject, serializeProject, type ProjectFile } from './projectFile';

export const DRAFT_KEY = 'ai3d.draft.v1';
export const DRAFT_DEBOUNCE_MS = 1000;

interface DraftEnvelope {
  project: string; // serializeProject 결과
  clean: boolean; // 파일에 저장된 상태와 같은가
}

export function writeDraft(name: string, model: ModelDefinition, clean: boolean): void {
  try {
    const env: DraftEnvelope = { project: serializeProject(name, model), clean };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(env));
  } catch {
    // 저장 공간 부족·사생활 보호 모드 등: 임시 저장만 건너뛴다
  }
}

export function readDraft(): { project: ProjectFile; clean: boolean } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as DraftEnvelope;
    const r = parseProject(env.project);
    return r.ok ? { project: r.project, clean: !!env.clean } : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 무시 */
  }
}
