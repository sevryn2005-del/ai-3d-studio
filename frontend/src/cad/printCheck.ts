/**
 * 출력 전 형상 검사 (순수 함수). 3D 프린터로 보내기 전에 흔한 실패 원인을 찾는다.
 *
 * 입력: 설계 원본 + 최상위 객체별 월드 바운딩 박스 (mm). 박스는 CAD 엔진 메시에서 구하므로
 * 회전·불리언 결과까지 정확하다 (features/print/worldBoxes.ts).
 *
 * 검사 항목
 * - error   바닥 아래: 출력 베드(z=0) 아래로 내려간 부분 → 출력 불가
 * - warning 떠 있음: 바닥에 닿지 않고 다른 객체와도 닿지 않음 → 허공에서 출력 시작
 * - warning 크기 초과: 프린터 출력 범위보다 큼
 * - warning 얇음: 노즐 두 줄(0.8mm)보다 얇은 치수 (구멍을 뚫는 도구는 제외)
 */
import type { CadCommand, CadObject, ModelDefinition, ObjectId, Vec3 } from './commandTypes';
import { childIds, topLevelObjects } from './modelGraph';
import { formatMm } from './units';

export interface WorldBox {
  min: Vec3;
  max: Vec3;
}

export interface PrintIssue {
  key: string;
  severity: 'error' | 'warning';
  objectId: ObjectId;
  message: string;
  fix?: { label: string; command: CadCommand };
}

/** 흔한 FDM 프린터 크기 (mm). 설정 기능 전까지의 기본값 */
export const DEFAULT_BED: Vec3 = [220, 220, 250];
/** 0.4mm 노즐 두 줄 */
export const MIN_FEATURE_MM = 0.8;
const EPS = 0.01;

const PARAM_LABEL: Record<string, string> = {
  width: '너비', depth: '깊이', height: '높이', radius: '지름', radiusBottom: '아래 지름', radiusTop: '위 지름',
};

function round2(v: number): number {
  return Math.round(v * 100) / 100 + 0;
}

function overlaps(a: WorldBox, b: WorldBox): boolean {
  return [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! + EPS && b.min[i]! <= a.max[i]! + EPS);
}

/** 객체를 바닥(z=0)에 붙이는 명령: 아래로 내려간 만큼 올리거나, 뜬 만큼 내린다 */
export function dropToBedCommand(obj: CadObject, box: WorldBox): CadCommand | null {
  const dz = round2(-box.min[2]);
  if (Math.abs(dz) < EPS) return null;
  return { type: 'translate', target: obj.id, offset: [0, 0, dz] };
}

export function checkPrintability(
  model: ModelDefinition,
  boxes: Map<ObjectId, WorldBox>,
  bed: Vec3 = DEFAULT_BED,
): PrintIssue[] {
  const issues: PrintIssue[] = [];
  const roots = topLevelObjects(model);
  const byId = new Map(model.objects.map((o) => [o.id, o]));

  for (const obj of roots) {
    const box = boxes.get(obj.id);
    if (!box) continue;
    const drop = dropToBedCommand(obj, box);

    if (box.min[2] < -EPS) {
      issues.push({
        key: `below:${obj.id}`, severity: 'error', objectId: obj.id,
        message: `'${obj.name}'이(가) 바닥 아래로 ${formatMm(round2(-box.min[2]))}mm 내려가 있습니다`,
        fix: drop ? { label: '바닥에 놓기', command: drop } : undefined,
      });
    } else if (box.min[2] > EPS) {
      const supported = roots.some((o) => o.id !== obj.id && boxes.has(o.id) && overlaps(box, boxes.get(o.id)!));
      if (!supported) {
        issues.push({
          key: `floating:${obj.id}`, severity: 'warning', objectId: obj.id,
          message: `'${obj.name}'이(가) 바닥에서 ${formatMm(round2(box.min[2]))}mm 떠 있습니다`,
          fix: drop ? { label: '바닥에 놓기', command: drop } : undefined,
        });
      }
    }

    const size = [0, 1, 2].map((i) => box.max[i]! - box.min[i]!);
    if (size.some((s, i) => s > bed[i]! + EPS)) {
      issues.push({
        key: `size:${obj.id}`, severity: 'warning', objectId: obj.id,
        message: `'${obj.name}'(${size.map((s) => formatMm(round2(s))).join('×')}mm)이 출력 범위 ${bed.join('×')}mm 보다 큽니다`,
      });
    }

    // 얇은 치수: 객체와 그 하위 도형 (빼기의 도구는 홈·구멍이므로 제외)
    const visit = (o: CadObject, isCutTool: boolean) => {
      if (o.kind === 'boolean') {
        childIds(o).forEach((id, i) => {
          const child = byId.get(id);
          if (child) visit(child, o.boolean.operation === 'cut' && i > 0);
        });
        return;
      }
      if (isCutTool) return;
      for (const [k, v] of Object.entries(o.params as Record<string, number>)) {
        const dim = k.startsWith('radius') ? v * 2 : v;
        // 원뿔 꼭짓점(반지름 0)은 의도된 형상
        if (dim > 0 && dim < MIN_FEATURE_MM) {
          issues.push({
            key: `thin:${o.id}:${k}`, severity: 'warning', objectId: o.id,
            message: `'${o.name}'의 ${PARAM_LABEL[k] ?? k} ${formatMm(dim)}mm 는 ${MIN_FEATURE_MM}mm 보다 얇아 출력되지 않을 수 있습니다`,
          });
        }
      }
    };
    visit(obj, false);
  }
  return issues;
}
