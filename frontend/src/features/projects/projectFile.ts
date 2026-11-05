/**
 * 프로젝트 파일 형식 (.ai3d, JSON).
 *
 * 설계 원본(ModelDefinition)만 저장한다. RenderMesh 는 저장하지 않는다 (언제든 재계산 가능).
 * 형식 버전이 바뀌면 PROJECT_FORMAT_VERSION 을 올리고 migrate() 에 변환을 추가한다.
 */
import { z } from 'zod';
import { MODEL_SCHEMA_VERSION, ModelDefinitionSchema, type ModelDefinition } from '../../cad/commandTypes';
import { validateGraph } from '../../cad/modelGraph';

export const PROJECT_FORMAT = 'ai3d-project';
/**
 * 형식 버전
 * - 1: 객체(기본 도형·불리언·모서리 처리)
 * - 2: + 스케치(model.sketches)와 돌출 객체. model.schemaVersion 2
 * - 3: + 면 위 스케치(plane.type 'face'), 반대 방향 돌출(음수 거리). model.schemaVersion 3. v2 내용은 그대로 유효
 * - 4: + 스케치 다각형(polygon)과 기하 구속(sketch.constraints). model.schemaVersion 4
 * - 5: + 회전 객체(kind 'revolve'). model.schemaVersion 5. v4 내용은 그대로 유효
 * - 6: + 억제·숨김·외관색, 쉘, 패턴·대칭(kind 'pattern'), 구멍 도구(kind 'hole'). model.schemaVersion 6. v5 내용은 그대로 유효
 * - 7: + 스케치 구성선(line)·슬롯(slot)·각도 구속, 각도 기준 평면(angled), 크기 조정(pattern type 'scale'). v6 내용은 그대로 유효
 * - 8: + 헬릭스(helix)·로프트(loft)·가져온 메시(mesh). v7 내용은 그대로 유효
 * - 9: + 모서리 필렛·모따기(fillet)·구배(draft)·가져온 STEP(step). v8 내용은 그대로 유효
 * - 10: + 경로(path)·꼭짓점 처리(corners)·스윕(sweep)·얇은 돌출(extrude.thin). v9 내용은 그대로 유효
 * - 11: + 조립 메이트(model.mates). v10 내용은 그대로 유효
 * - 12: + 고른 모서리(fillet.edges.at)·고른 면 평면(plane 'frame')·고른 메이트 참조. v11 내용은 그대로 유효
 * - 13: + 호 모서리(polygon·path arcs)·대칭 구속(symmetric). v12 내용은 그대로 유효
 * - 14: + 도면 설정(model.drawing). v13 내용은 그대로 유효
 * - 15: + 영역 단면(sketch region: 요소 합치기·빼기). v14 내용은 그대로 유효
 * - 16: + 스플라인(polygon·path spline). v15 내용은 그대로 유효
 * 읽기는 1~16 모두, 쓰기는 항상 최신(16). 열기는 파일을 바꾸지 않는다 — 저장할 때 새 형식으로 쓴다.
 */
export const PROJECT_FORMAT_VERSION = 16;
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
  const parsed = ProjectFileSchema.safeParse(migrate(raw as Record<string, unknown>, head.data.formatVersion));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `파일 내용이 올바르지 않습니다 (${issue?.path.join('.')}: ${issue?.message})` };
  }
  const graphErrors = validateGraph(parsed.data.model);
  if (graphErrors.length > 0) return { ok: false, error: `파일 내용이 올바르지 않습니다: ${graphErrors[0]}` };
  return { ok: true, project: parsed.data };
}

/**
 * 이전 형식을 현재 형식으로 (입력은 바꾸지 않고 새 객체를 돌려준다).
 * 알 수 없는 구조는 그대로 두어 이후 스키마 검증이 정확한 오류를 내게 한다.
 */
export function migrate(raw: Record<string, unknown>, fromVersion: number): unknown {
  let file = raw;
  if (fromVersion < 2) {
    const model = file.model as Record<string, unknown> | undefined;
    const migrated =
      model && typeof model === 'object' && model.schemaVersion === 1
        ? { ...model, schemaVersion: 2, sketches: model.sketches ?? [] }
        : model;
    file = { ...file, formatVersion: 2, model: migrated };
  }
  if ((file.formatVersion as number) < 3) {
    // v2 → v3: 새 평면 종류·음수 거리만 추가되었으므로 내용은 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 2 ? { ...model, schemaVersion: 3 } : model;
    file = { ...file, formatVersion: 3, model: migrated };
  }
  if ((file.formatVersion as number) < 4) {
    // v3 → v4: 스케치마다 빈 구속 목록. 나머지는 그대로
    const model = file.model as Record<string, unknown> | undefined;
    const migrated =
      model && typeof model === 'object' && model.schemaVersion === 3
        ? {
            ...model,
            schemaVersion: 4,
            sketches: Array.isArray(model.sketches)
              ? model.sketches.map((sk: unknown) => (sk && typeof sk === 'object' ? { ...sk, constraints: (sk as { constraints?: unknown }).constraints ?? [] } : sk))
              : model.sketches,
          }
        : model;
    file = { ...file, formatVersion: 4, model: migrated };
  }
  if ((file.formatVersion as number) < 5) {
    // v4 → v5: 새 객체 종류(회전)만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 4 ? { ...model, schemaVersion: 5 } : model;
    file = { ...file, formatVersion: 5, model: migrated };
  }
  if ((file.formatVersion as number) < 6) {
    // v5 → v6: 선택 필드와 새 객체 종류만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 5 ? { ...model, schemaVersion: 6 } : model;
    file = { ...file, formatVersion: 6, model: migrated };
  }
  if ((file.formatVersion as number) < 7) {
    // v6 → v7: 새 요소·평면·패턴 종류만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 6 ? { ...model, schemaVersion: 7 } : model;
    file = { ...file, formatVersion: 7, model: migrated };
  }
  if ((file.formatVersion as number) < 8) {
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 7 ? { ...model, schemaVersion: 8 } : model;
    file = { ...file, formatVersion: 8, model: migrated };
  }
  if ((file.formatVersion as number) < 9) {
    // v8 → v9: 새 객체 종류만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 8 ? { ...model, schemaVersion: 9 } : model;
    file = { ...file, formatVersion: 9, model: migrated };
  }
  if ((file.formatVersion as number) < 10) {
    // v9 → v10: 새 요소·객체 종류만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 9 ? { ...model, schemaVersion: 10 } : model;
    file = { ...file, formatVersion: 10, model: migrated };
  }
  if ((file.formatVersion as number) < 11) {
    // v10 → v11: 메이트(선택 항목)만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 10 ? { ...model, schemaVersion: 11 } : model;
    file = { ...file, formatVersion: 11, model: migrated };
  }
  if ((file.formatVersion as number) < 12) {
    // v11 → v12: 선택 항목만 늘어남 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 11 ? { ...model, schemaVersion: 12 } : model;
    file = { ...file, formatVersion: 12, model: migrated };
  }
  if ((file.formatVersion as number) < 13) {
    // v12 → v13: 선택 항목(arcs)·구속 종류만 늘어남 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 12 ? { ...model, schemaVersion: 13 } : model;
    file = { ...file, formatVersion: 13, model: migrated };
  }
  if ((file.formatVersion as number) < 14) {
    // v13 → v14: 도면 설정(선택 항목)만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 13 ? { ...model, schemaVersion: 14 } : model;
    file = { ...file, formatVersion: 14, model: migrated };
  }
  if ((file.formatVersion as number) < 15) {
    // v14 → v15: 스케치 요소 종류(region)만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 14 ? { ...model, schemaVersion: 15 } : model;
    file = { ...file, formatVersion: 15, model: migrated };
  }
  if ((file.formatVersion as number) < 16) {
    // v15 → v16: 선택 항목(spline)만 추가 → 내용 그대로, 버전만 올린다
    const model = file.model as Record<string, unknown> | undefined;
    const migrated = model && typeof model === 'object' && model.schemaVersion === 15 ? { ...model, schemaVersion: MODEL_SCHEMA_VERSION } : model;
    file = { ...file, formatVersion: 16, model: migrated };
  }
  return file;
}

/** 파일 이름에서 프로젝트 이름 추출: "받침대.ai3d" → "받침대" */
export function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.ai3d(\.json)?$/i, '') || '제목 없음';
}
