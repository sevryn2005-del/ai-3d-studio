/**
 * 프로젝트 파일 형식 (.ai3d, JSON).
 *
 * 설계 원본(ModelDefinition)만 저장한다. RenderMesh 는 저장하지 않는다 (언제든 재계산 가능).
 * 형식 버전이 바뀌면 PROJECT_FORMAT_VERSION 을 올리고 migrate() 에 변환을 추가한다.
 */
import { z } from 'zod';
import { ModelDefinitionSchema, type ModelDefinition } from '../../cad/commandTypes';
import { validateGraph } from '../../cad/modelGraph';

export const PROJECT_FORMAT = 'ai3d-project';
export const PROJECT_FORMAT_VERSION = 1;
export const PROJECT_EXTENSION = '.ai3d';
export const APP_VERSION = '0.1.0';

export const ProjectFileSchema = z.strictObject({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  app: z.strictObject({ name: z.string(), version: z.string() }),
  name: z.string().min(1).max(200),
  savedAt: z.iso.datetime(),
  model: ModelDefinitionSchema,
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export function serializeProject(name: string, model: ModelDefinition, now = new Date()): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    app: { name: 'AI 3D Studio', version: APP_VERSION },
    name,
    savedAt: now.toISOString(),
    model,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export type ParseResult = { ok: true; project: ProjectFile } | { ok: false; error: string };

export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 형식이 아닙니다' };
  }
  const head = z.object({ format: z.string(), formatVersion: z.number() }).safeParse(raw);
  if (!head.success || head.data.format !== PROJECT_FORMAT) {
    return { ok: false, error: 'AI 3D Studio 프로젝트 파일이 아닙니다' };
  }
  if (head.data.formatVersion > PROJECT_FORMAT_VERSION) {
    return { ok: false, error: '더 새로운 버전의 앱에서 저장된 파일입니다. 앱을 업데이트하세요' };
  }
  const parsed = ProjectFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `파일 내용이 올바르지 않습니다 (${issue?.path.join('.')}: ${issue?.message})` };
  }
  const graphErrors = validateGraph(parsed.data.model);
  if (graphErrors.length > 0) return { ok: false, error: `파일 내용이 올바르지 않습니다: ${graphErrors[0]}` };
  return { ok: true, project: parsed.data };
}

/** 파일 이름에서 프로젝트 이름 추출: "받침대.ai3d" → "받침대" */
export function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.ai3d(\.json)?$/i, '') || '제목 없음';
}
