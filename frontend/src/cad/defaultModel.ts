import { emptyModel, type ModelDefinition } from './commandTypes';
import { executeCommand } from './commandExecutor';

/** 새 프로젝트의 시작 모델: 바닥 중앙에 20mm 큐브 하나. */
export function createDefaultModel(): ModelDefinition {
  const r = executeCommand(emptyModel(), {
    type: 'create_box',
    id: 'box_1',
    name: '큐브',
    width: 20,
    depth: 20,
    height: 20,
  });
  if (!r.ok) throw new Error(`기본 모델 생성 실패: ${r.error}`);
  return r.model;
}
