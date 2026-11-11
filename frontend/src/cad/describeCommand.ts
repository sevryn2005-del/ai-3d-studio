/** 명령을 사람이 읽을 수 있는 한국어 한 줄로 (AI 가 무엇을 바꿨는지 채팅에 표시) */
import { REF_LABEL } from './references';
import { CONSTRAINT_LABEL } from './solver';
import type { CadCommand, ModelDefinition } from './commandTypes';
import { OPERATION_INFO } from './objectKinds';
import { MATE_LABEL } from './mates';
import { formatMm } from './units';
import { MODIFIER_LABEL } from './polymeshModifiers';

const PARAM_LABEL: Record<string, string> = {
  width: '너비', depth: '깊이', height: '높이', radius: '반지름', radiusBottom: '아래 반지름', radiusTop: '위 반지름',
  diameter: '지름', cboreDiameter: '카운터보어 지름', cboreDepth: '카운터보어 깊이', csinkDiameter: '카운터싱크 지름',
};

const MESH_LABEL: Record<string, string> = { cube: '큐브', plane: '평면', uv_sphere: 'UV 구', cylinder: '원기둥', cone: '원뿔', torus: '도넛', grid: '격자' };
const MESH_EDIT_LABEL: Record<string, string> = {
  transform: '이동·회전·크기', extrude: '돌출', inset: '인셋', delete: '삭제', loop_cut: '루프 컷', subdivide: '세분', merge: '병합', fill: '면 채우기', set_verts: '스컬프트', bevel: '베벨', bisect: '나이프', remesh: '리메시', replace: '스컬프트 (다이나믹 토폴로지)',
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
    case 'set_entity_center':
      return `${sketchName(cmd.sketch)}의 ${cmd.entity} 중심 → (${formatMm(cmd.center[0])}, ${formatMm(cmd.center[1])})`;
    case 'delete_sketch_entity':
      return `${sketchName(cmd.sketch)}의 ${cmd.entity} 삭제`;
    case 'set_sketch_plane':
      return `${sketchName(cmd.sketch)} 평면 → ${cmd.plane.type}${cmd.plane.offset ? ` (${formatMm(cmd.plane.offset)}mm)` : ''}`;
    case 'add_polygon':
      return `${sketchName(cmd.sketch)}에 다각형 추가 (꼭짓점 ${cmd.points.length}개)`;
    case 'move_point':
      return `${sketchName(cmd.sketch)}의 ${cmd.point} → (${formatMm(cmd.to[0])}, ${formatMm(cmd.to[1])})`;
    case 'add_constraint':
      return `${sketchName(cmd.sketch)}에 ${CONSTRAINT_LABEL[cmd.constraint]} 구속 (${cmd.refs.join(', ')}${cmd.value !== undefined ? ` = ${formatMm(cmd.value)}mm` : ''})`;
    case 'set_constraint':
      return `${sketchName(cmd.sketch)} 구속 ${cmd.constraint} → ${formatMm(cmd.value)}mm`;
    case 'delete_constraint':
      return `${sketchName(cmd.sketch)} 구속 ${cmd.constraint} 삭제`;
    case 'rename_sketch':
      return `스케치 이름 → ${cmd.name}`;
    case 'delete_sketch':
      return `스케치 ${sketchName(cmd.sketch)} 삭제`;
    case 'revolve':
      return `${sketchName(cmd.sketch)}의 ${cmd.profile} 을(를) ${formatMm(cmd.angle ?? 360)}° 회전`;
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
    case 'move_with_mates':
      return `${name(cmd.target)} 메이트 지키며 끌기`;
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
    case 'set_suppressed':
      return `${name(cmd.target)} ${cmd.suppressed ? '억제' : '억제 해제'}`;
    case 'set_appearance':
      return [
        cmd.color && `${name(cmd.target)} 색 → ${cmd.color === 'default' ? '기본' : cmd.color}`,
        cmd.hidden !== undefined && `${name(cmd.target)} ${cmd.hidden ? '숨기기' : '보이기'}`,
      ].filter(Boolean).join(', ');
    case 'shell':
      return cmd.thickness === 0
        ? `${name(cmd.target)} 쉘 제거`
        : `${name(cmd.target)} 쉘 두께 ${formatMm(cmd.thickness)}mm${cmd.open?.length ? ` (열린 면 ${cmd.open.join(', ')})` : ''}`;
    case 'pattern':
    case 'set_pattern': {
      const p = cmd.pattern;
      const what =
        p.type === 'scale' ? `크기 조정 ×(${[p.x, p.y, p.z].map(formatMm).join(', ')})`
        : p.type === 'mirror' ? `대칭 복사 (${p.plane} 평면${p.offset ? ` ${formatMm(p.offset)}mm` : ''})`
        : p.type === 'circular' ? `원형 패턴 ${p.axis.toUpperCase()}축 ${p.count}개 ${formatMm(p.angle)}°`
        : p.type === 'dome' ? `돔 높이 ${formatMm(p.height)}mm`
        : p.type === 'face' ? `면 이동 ${formatMm(p.distance)}mm`
        : p.type === 'split' ? `평면 자르기 (${p.plane} ${formatMm(p.offset)}mm, ${p.keep === 'positive' ? '+' : '−'} 쪽 남김)`
        : p.type === 'sketch' ? `스케치 위치 패턴 (${sketchName(p.sketch)} 원 중심마다)`
        : p.type === 'curve' ? `곡선 패턴 (${sketchName(p.sketch)} ${p.path}) ${p.count}개${p.align ? ', 접선 따라 돌림' : ''}`
        : `선형 패턴 ${p.axis.toUpperCase()} ${p.count}개 × ${formatMm(p.spacing)}mm${p.axis2 ? `, ${p.axis2.toUpperCase()} ${p.count2}개 × ${formatMm(p.spacing2 ?? 0)}mm` : ''}`;
      return `${name(p.source)} ${what}`;
    }
    case 'edge_feature':
      return `${name(cmd.target)} ${cmd.edges} ${cmd.feature === 'fillet' ? `필렛 R${formatMm(cmd.size)}` : `모따기 ${formatMm(cmd.size)}`}mm`;
    case 'set_edge_feature':
      return `${name(cmd.target)} 모서리 처리 변경`;
    case 'draft':
    case 'set_draft':
      return `${name(cmd.target)} 구배 ${formatMm(cmd.angle)}°`;
    case 'import_step':
      return `STEP 가져오기${cmd.name ? ` "${cmd.name}"` : ''}`;
    case 'helix':
      return `${sketchName(cmd.sketch)}의 ${cmd.profile} 헬릭스 (피치 ${formatMm(cmd.pitch)}mm × ${formatMm(cmd.turns)}바퀴)`;
    case 'loft':
      return `로프트 (${cmd.sections.map((s) => sketchName(s.sketch)).join(' → ')})`;
    case 'sweep':
      return `스윕 (${sketchName(cmd.sketch)} ${cmd.profile} → ${sketchName(cmd.pathSketch)} ${cmd.path} 경로)`;
    case 'add_mate':
      return `메이트 ${MATE_LABEL[cmd.mate]}: ${cmd.refs.join(' ↔ ')}${cmd.value !== undefined ? ` (${formatMm(cmd.value)}${cmd.mate === 'angle' ? '°' : 'mm'})` : ''}`;
    case 'set_mate':
      return `메이트 ${cmd.mate} 변경${cmd.value !== undefined ? ` → ${formatMm(cmd.value)}` : ''}${cmd.flip !== undefined ? ' (방향 뒤집기)' : ''}`;
    case 'delete_mate':
      return `메이트 ${cmd.mate} 삭제`;
    case 'add_reference':
      return `${REF_LABEL[cmd.reference.type]} 추가${cmd.reference.name ? ` (${cmd.reference.name})` : ''}`;
    case 'insert_keyframe':
      return `${name(cmd.target)} 키 (프레임 ${cmd.frame})`;
    case 'delete_keyframe':
      return `${name(cmd.target)} 키 지우기 (프레임 ${cmd.frame})`;
    case 'set_animation':
      return cmd.clear ? '애니메이션 키 모두 지우기' : `애니메이션 설정${cmd.fps !== undefined ? ` ${cmd.fps}fps` : ''}${cmd.end !== undefined ? ` 끝 ${cmd.end}` : ''}`;
    case 'set_explode':
      return cmd.offsets.length ? `분해도 (${cmd.offsets.length}개 부품)` : '분해도 지우기';
    case 'delete_reference':
      return `참조 형상 ${cmd.target} 삭제`;
    case 'rename_reference':
      return `참조 형상 ${cmd.target} 이름 → ${cmd.name}`;
    case 'add_ellipse':
      return `${sketchName(cmd.sketch)}에 타원 ${formatMm(cmd.width)}×${formatMm(cmd.height)}mm`;
    case 'set_spline':
      return `${sketchName(cmd.sketch)}의 ${cmd.entity} ${cmd.spline ? '스플라인으로 (매끈하게)' : '꺾은선으로'}`;
    case 'add_region':
      return `${sketchName(cmd.sketch)}에 영역 단면 (${cmd.items.map((it) => `${it.op === 'add' ? '+' : '−'}${it.entity}`).join(' ')})`;
    case 'set_region':
      return `${sketchName(cmd.sketch)}의 영역 ${cmd.entity} 구성 (${cmd.items.map((it) => `${it.op === 'add' ? '+' : '−'}${it.entity}`).join(' ')})`;
    case 'set_drawing':
      return `도면${cmd.sheet ? ` ${cmd.sheet + 1}장째` : ''} 설정 (${cmd.drawing.paper}${cmd.drawing.section ? ', 단면도' : ''})`;
    case 'delete_drawing_sheet':
      return `도면 ${cmd.sheet + 1}장째 지우기`;
    case 'insert_part':
      return `부품 삽입 "${cmd.name}" (객체 ${cmd.part.objects.length}개)`;
    case 'set_thin':
      return `${name(cmd.target)} 두께 → ${formatMm(cmd.thin)}mm`;
    case 'set_arc':
      return Math.abs(cmd.bulge) > 1e-9 ? `${sketchName(cmd.sketch)}의 ${cmd.entity}.e${cmd.edge} 을(를) 호로 (볼록 ${formatMm(cmd.bulge)})` : `${sketchName(cmd.sketch)}의 ${cmd.entity}.e${cmd.edge} 을(를) 직선으로`;
    case 'convert_to_polygon':
      return `${sketchName(cmd.sketch)}의 ${cmd.entity} 을(를) 다각형으로 바꾸기`;
    case 'add_path':
      return `${sketchName(cmd.sketch)}에 경로 추가 (점 ${cmd.points.length}개)`;
    case 'set_corner':
      return cmd.size > 0
        ? `${sketchName(cmd.sketch)}의 ${cmd.entity} 꼭짓점 ${cmd.corner === 'fillet' ? `필렛 R${formatMm(cmd.size)}` : `모따기 ${formatMm(cmd.size)}`}`
        : `${sketchName(cmd.sketch)}의 ${cmd.entity} 꼭짓점 처리 제거`;
    case 'import_mesh':
      return `메시 가져오기${cmd.name ? ` "${cmd.name}"` : ''}`;
    case 'add_mesh':
      return `메시 추가: ${MESH_LABEL[cmd.primitive]}`;
    case 'convert_to_mesh':
      return `${name(cmd.target)} → 편집 메시 (점 ${cmd.polymesh.verts.length.toLocaleString()} · 면 ${cmd.polymesh.faces.length.toLocaleString()})`;
    case 'set_modifiers':
      return `${name(cmd.target)} 모디파이어: ${cmd.modifiers.map((m) => MODIFIER_LABEL[m.type]).join(' → ') || '없음'}`;
    case 'apply_modifier':
      return `${name(cmd.target)} 모디파이어 ${cmd.all ? '모두' : '맨 위'} 적용`;
    case 'set_shading':
      return `${name(cmd.target)} ${cmd.smooth ? '부드러운' : '각진'} 음영`;
    case 'mesh_edit':
      return `${name(cmd.target)} 메시 편집: ${MESH_EDIT_LABEL[cmd.edit.op]}`;
    case 'offset_entity':
      return `${sketchName(cmd.sketch)}의 ${cmd.entity} ${cmd.distance > 0 ? '바깥' : '안쪽'}으로 ${formatMm(Math.abs(cmd.distance))}mm 오프셋`;
    case 'add_line':
      return `${sketchName(cmd.sketch)}에 구성선 추가`;
    case 'add_slot':
      return `${sketchName(cmd.sketch)}에 슬롯 ${formatMm(cmd.length + cmd.width)}×${formatMm(cmd.width)}mm`;
    case 'set_entity_angle':
      return `${sketchName(cmd.sketch)}의 ${cmd.entity} 방향 → ${formatMm(cmd.angle)}°`;
    case 'hole': {
      const extra = cmd.cboreDiameter ? ` 카운터보어 Ø${formatMm(cmd.cboreDiameter)}` : cmd.csinkDiameter ? ` 카운터싱크 Ø${formatMm(cmd.csinkDiameter)}` : '';
      return `${name(cmd.target)} ${cmd.face} 면에 구멍 Ø${formatMm(cmd.diameter)} × ${formatMm(cmd.depth)}mm${extra}`;
    }
  }
}

