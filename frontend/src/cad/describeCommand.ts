/** 명령을 사람이 읽을 수 있는 한국어 한 줄로 (AI 가 무엇을 바꿨는지 채팅에 표시) */
import type { CadCommand, ModelDefinition } from './commandTypes';
import { OPERATION_INFO } from './objectKinds';
import { formatMm } from './units';

const PARAM_LABEL: Record<string, string> = {
  width: '너비', depth: '깊이', height: '높이', radius: '반지름', radiusBottom: '아래 반지름', radiusTop: '위 반지름',
};

const vec = (v: readonly number[]) => `(${v.map(formatMm).join(', ')})`;

export function describeCommand(cmd: CadCommand, model: ModelDefinition): string {
  const name = (id: string) => model.objects.find((o) => o.id === id)?.name ?? id;
  const sketchName = (id: string) => model.sketches.find((sk) => sk.id === id)?.name ?? id;
  switch (cmd.type) {
    case 'create_box':
      return `박스 추가 ${formatMm(cmd.width)}×${formatMm(cmd.depth)}×${formatMm(cmd.height)}mm`;
    case 'create_cylinder':
      return `원통 추가 지름 ${formatMm(cmd.radius * 2)} × 높이 ${formatMm(cmd.height)}mm`;
    case 'create_sphere':
      return `구 추가 지름 ${formatMm(cmd.radius * 2)}mm`;
    case 'create_cone':
      return `원뿔 추가 지름 ${formatMm(cmd.radiusBottom * 2)}→${formatMm(cmd.radiusTop * 2)} × 높이 ${formatMm(cmd.height)}mm`;
    case 'cut':
    case 'union':
    case 'intersect':
      return `${OPERATION_INFO[cmd.type].label}: ${name(cmd.base)} ${OPERATION_INFO[cmd.type].symbol} ${cmd.tools.map(name).join(', ')}`;
    case 'set_params':
      return `${name(cmd.target)} ${Object.entries(cmd.params).map(([k, v]) => `${PARAM_LABEL[k] ?? k} ${formatMm(v)}mm`).join(', ')}`;
    case 'create_sketch':
      return `스케치 추가${cmd.name ? ` "${cmd.name}"` : ''}${cmd.plane?.offset ? ` (높이 ${formatMm(cmd.plane.offset)}mm)` : ''}`;
    case 'add_rectangle':
      return `${sketchName(cmd.sketch)}에 사각형 ${formatMm(cmd.width)}×${formatMm(cmd.height)}mm`;
    case 'add_circle':
      return `${sketchName(cmd.sketch)}에 원 지름 ${formatMm(cmd.diameter)}mm`;
    case 'set_dimension':
      return `${sketchName(cmd.sketch)} 치수 ${cmd.dimension} → ${formatMm(cmd.value)}mm`;
    case 'extrude':
      return `${sketchName(cmd.sketch)}의 ${cmd.profile} 을(를) ${formatMm(cmd.distance)}mm 돌출`;
    case 'fillet':
    case 'chamfer': {
      const size = cmd.type === 'fillet' ? cmd.radius : cmd.distance;
      if (size === 0) return `${name(cmd.target)} 모서리 처리 제거`;
      const which = cmd.edges === 'vertical' ? '세로 모서리' : '모든 모서리';
      return cmd.type === 'fillet'
        ? `${name(cmd.target)} ${which} 둥글게 R${formatMm(size)}mm`
        : `${name(cmd.target)} ${which} 모따기 ${formatMm(size)}mm`;
    }
    case 'translate':
      return `${name(cmd.target)} 이동 ${vec(cmd.offset)}mm`;
    case 'set_transform':
      return [
        cmd.position && `${name(cmd.target)} 위치 ${vec(cmd.position)}mm`,
        cmd.rotation && `${name(cmd.target)} 회전 ${vec(cmd.rotation)}°`,
      ].filter(Boolean).join(', ') || `${name(cmd.target)} 변환`;
    case 'rename_object':
      return `${name(cmd.target)} → 이름 "${cmd.name}"`;
    case 'duplicate_object':
      return `${name(cmd.target)} 복제`;
    case 'delete_object':
      return `${name(cmd.target)} 삭제`;
  }
}

