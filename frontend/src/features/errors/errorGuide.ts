/**
 * 오류 안내 (사람이 쓰다 만나는 오류를 알아듣게): 날것의 메시지 → 짧은 제목 + 무엇을 하면 되는지 + 바로 누를 수 있는 동작.
 * 순수 함수 — 규칙 표를 위에서부터 보고 처음 맞는 것을 쓴다. 맞는 규칙이 없으면 원문을 제목으로 쓰고 일반 안내를 붙인다.
 * 명령이 거부된 경우 설계는 바뀌지 않았다는 것을 꼭 알려 준다 (불안하지 않게).
 */

export type GuideAction = 'undo' | 'select-sketch-constraints' | 'save-file' | 'reload' | 'restore-draft';

export interface ErrorGuide {
  /** 한 줄 제목 (원문 그대로일 수도) */
  title: string;
  /** 무엇을 하면 되는지 */
  hint?: string;
  /** 'error' = 거부·실패, 'warn' = 계속할 수 있음(대체 경로), 'info' = 다시 하면 됨 */
  level: 'error' | 'warn' | 'info';
  actions: GuideAction[];
}

/** 명령 경로 이름 → 사람이 읽는 항목 이름 */
const FIELD_LABEL: Record<string, string> = {
  width: '너비',
  depth: '깊이',
  height: '높이',
  radius: '반지름',
  radiusBottom: '아래 반지름',
  radiusTop: '위 반지름',
  diameter: '지름',
  distance: '거리',
  angle: '각도',
  thickness: '두께',
  bendRadius: '굽힘 반지름',
  size: '크기',
  count: '개수',
  spacing: '간격',
  position: '위치',
  rotation: '회전',
  value: '값',
  name: '이름',
  pitch: '피치',
  turns: '바퀴 수',
  tile: '텍스처 한 장 크기',
  fps: '초당 프레임',
  end: '끝 프레임',
  frame: '프레임',
};

export function fieldLabel(path: string): string {
  const keys = path.split('.').filter((k) => !/^\d+$/.test(k));
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i]!;
    if (FIELD_LABEL[k]) return FIELD_LABEL[k]!;
    if (/^flange(PX|NX|PY|NY)$/.test(k)) return `플랜지 ${k.slice(6, 7) === 'P' ? '+' : '−'}${k.slice(7)} 높이`;
  }
  return keys.at(-1) ?? path;
}

const UNCHANGED = '설계는 바뀌지 않았습니다.';

/** 값 검사 라이브러리(Zod)의 영어 기본 문구 → 한국어 */
export function translateValidation(msg: string): string {
  const num = (v: string) => v.replace(/^0+(?=\d)/, '');
  let m = msg.match(/^Too big: expected (?:number|string|array) to (?:be|have) <=?\s*([-\d.e+]+)/i);
  if (m) return `값이 너무 큽니다 (${num(m[1]!)} 이하로 넣으세요)`;
  m = msg.match(/^Too small: expected (?:number|string|array) to (?:be|have) >=?\s*([-\d.e+]+)/i);
  if (m) return `값이 너무 작습니다 (${num(m[1]!)} 이상으로 넣으세요)`;
  if (/^Too small: expected number to be >0/i.test(msg)) return '0 보다 큰 값을 넣으세요';
  if (/expected int/i.test(msg)) return '정수(소수점 없는 수)를 넣으세요';
  if (/expected number, received (nan|string)/i.test(msg)) return '숫자를 넣으세요';
  if (/expected (number|string|boolean|array|object), received undefined|^Required$/i.test(msg)) return '꼭 필요한 값이 빠졌습니다';
  if (/^Invalid option|^Invalid enum value/i.test(msg)) return '고를 수 없는 값입니다 (목록에 있는 것을 고르세요)';
  if (/^Unrecognized key/i.test(msg)) return '알 수 없는 항목이 들어 있습니다';
  if (/^Invalid string|^Invalid input/i.test(msg)) return '형식이 맞지 않는 값입니다';
  return msg;
}

interface Rule {
  test: RegExp;
  guide: (m: RegExpMatchArray, raw: string) => Omit<ErrorGuide, 'actions'> & { actions?: GuideAction[] };
}

const RULES: Rule[] = [
  // 서버·네트워크
  {
    test: /failed to fetch|networkerror|load failed|econnrefused|서버에 연결할 수 없|fetch failed/i,
    guide: () => ({
      title: '로컬 CAD 서버에 연결할 수 없습니다',
      hint: '서버가 꺼져 있거나 다시 시작하는 중입니다. 편집·저장은 그대로 되고, 형상은 브라우저 엔진으로 계속 계산합니다.',
      level: 'warn',
    }),
  },
  {
    test: /timed? ?out|시간이 초과|시간 초과/i,
    guide: () => ({
      title: '계산이 너무 오래 걸려 멈췄습니다',
      hint: '형상이 아주 복잡합니다. 패턴 개수·세분 횟수·텍스트 길이를 줄이거나 방금 바꾼 값을 되돌려 보세요 (Ctrl+Z).',
      level: 'error',
      actions: ['undo'],
    }),
  },
  // 동시 편집
  {
    test: /편집하는 동안 다른 변경이 먼저/,
    guide: () => ({ title: '다른 변경과 겹쳐 이번 편집은 건너뛰었습니다', hint: '같은 동작을 한 번 더 하면 됩니다.', level: 'info' }),
  },
  // 명령 값 검사 (Zod)
  {
    test: /^잘못된 (?:명령|파라미터)(?: \(([^)]*)\))?: (.*)$/,
    guide: (m) => ({
      title: translateValidation(m[2]!),
      hint: `${m[1] ? `'${fieldLabel(m[1])}' 값을 확인하세요. ` : ''}${UNCHANGED}`,
      level: 'error',
    }),
  },
  // 메이트·구속
  {
    test: /메이트.*(만족할 수 없|모순|과하게)/,
    guide: (_m, raw) => ({
      title: raw,
      hint: '방금 추가·변경한 메이트가 다른 메이트와 맞지 않습니다. 메이트 목록에서 마지막 메이트를 지우거나 "반대 방향"을 바꿔 보세요. ' + UNCHANGED,
      level: 'error',
    }),
  },
  {
    test: /구속.*(만족할 수 없|모순|과하게|충돌)|과도하게 정의/,
    guide: (_m, raw) => ({
      title: raw,
      hint: '구속이 서로 부딪힙니다. 스케치 속성의 구속 목록에서 빨갛게 표시된 구속(또는 마지막에 넣은 치수)을 지우세요. ' + UNCHANGED,
      level: 'error',
      actions: ['select-sketch-constraints'],
    }),
  },
  // 형상 계산
  {
    test: /둥글게 할 수 없|모따기를 할 수 없|필렛.*(실패|할 수 없)/,
    guide: (_m, raw) => ({
      title: raw,
      hint: '반지름(크기)을 줄여 보세요. 가장 짧은 모서리 길이의 절반보다 작아야 둥글게 깎을 수 있습니다.',
      level: 'error',
      actions: ['undo'],
    }),
  },
  {
    test: /형상을 만들 수 없|형상 계산 (중 내부 오류|실패)|형상이 비었|빈 형상/,
    guide: (_m, raw) => ({
      title: raw,
      hint: '값 조합으로는 모양을 만들 수 없습니다. 방금 바꾼 값을 되돌리거나(Ctrl+Z) 크기·두께를 조금 바꿔 보세요.',
      level: 'error',
      actions: ['undo'],
    }),
  },
  // 이름·참조
  {
    test: /이미 존재하는 ID|이미 쓰이는|ID .*중복/,
    guide: (_m, raw) => ({ title: raw, hint: '다른 이름(ID)을 쓰세요. ' + UNCHANGED, level: 'error' }),
  },
  {
    test: /존재하지 않는|찾을 수 없|이\(가\) 없습니다/,
    guide: (_m, raw) => ({ title: raw, hint: '그 대상이 지워졌거나 이름이 바뀌었을 수 있습니다. 목록에서 다시 고르세요. ' + UNCHANGED, level: 'error' }),
  },
  // 한도
  {
    test: /최대 [\d,]+ ?(개|장|자|번)/,
    guide: (_m, raw) => ({ title: raw, hint: '한도를 넘었습니다. 쓰지 않는 항목을 지우거나 여러 객체로 나누세요. ' + UNCHANGED, level: 'error' }),
  },
  // 파일
  {
    test: /quota|저장 공간|용량이 부족/i,
    guide: () => ({
      title: '브라우저 저장 공간이 가득 찼습니다',
      hint: '자동 저장이 더 이상 들어가지 않습니다. 지금 "저장"으로 파일에 저장해 두세요 (큰 텍스처·메시가 공간을 많이 씁니다).',
      level: 'warn',
      actions: ['save-file'],
    }),
  },
  {
    test: /unexpected token|json|프로젝트 파일.*(읽을 수|형식)|손상/i,
    guide: (_m, raw) => ({
      title: '프로젝트 파일을 읽을 수 없습니다',
      hint: `파일이 손상되었거나 AI 3D Studio 프로젝트(.ai3d)가 아닙니다. 지금 열린 설계는 그대로입니다. (${raw})`,
      level: 'error',
    }),
  },
  {
    test: /PNG·JPEG|이미지.*(아닙|읽을 수)/,
    guide: (_m, raw) => ({ title: raw, hint: 'PNG 또는 JPG 그림 파일을 고르세요 (약 3MB 이하).', level: 'error' }),
  },
  // 고정된 점·부품
  {
    test: /고정되어 있어 (옮길|끌) 수 없|고정된 부품/,
    guide: (_m, raw) => ({ title: raw, hint: '고정(⊕) 구속·메이트를 먼저 지우면 움직일 수 있습니다. ' + UNCHANGED, level: 'error' }),
  },
];

/** 날것 오류 메시지 → 안내 */
export function explainError(raw: string): ErrorGuide {
  const text = raw.trim().replace(/^Error:\s*/, '');
  for (const r of RULES) {
    const m = text.match(r.test);
    if (m) {
      const g = r.guide(m, text);
      return { ...g, actions: g.actions ?? [] };
    }
  }
  return { title: text || '알 수 없는 오류', hint: `${UNCHANGED} 계속 같은 오류가 나면 방금 바꾼 값을 되돌려 보세요 (Ctrl+Z).`, level: 'error', actions: [] };
}

/** 예상하지 못한 프로그램 오류 (화면 그리기·스크립트) — 사용자 탓이 아님을 분명히 */
export function unexpectedError(raw: string): ErrorGuide {
  return {
    title: '예상하지 못한 문제가 생겼습니다',
    hint: `작업은 자동 저장되어 있어 잃지 않습니다. 계속 반복되면 "다시 불러오기"를 누르세요. (${raw.slice(0, 160)})`,
    level: 'warn',
    actions: ['reload'],
  };
}

/** 무시해도 되는 브라우저 소음 (사용자에게 보여 주지 않음) */
export function isNoise(raw: string): boolean {
  return /ResizeObserver loop|^Script error\.?$|AbortError|The user aborted|PickerCancelled/i.test(raw);
}
