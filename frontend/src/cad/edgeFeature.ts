/** 박스 모서리 처리(필렛·모따기)의 크기 규칙. 실행기·파일 검증·UI 가 공유한다. */
import type { BoxParams, EdgeFeature } from './commandTypes';
import { formatMm } from './units';

/** 허용되는 최대 크기(미만이어야 함): 모서리가 만나는 면의 가장 짧은 변의 절반 */
export function maxEdgeSize(params: BoxParams, edges: EdgeFeature['edges']): number {
  const dims = edges === 'all' ? [params.width, params.depth, params.height] : [params.width, params.depth];
  return Math.min(...dims) / 2;
}

export function edgeFeatureError(params: BoxParams, f: EdgeFeature): string | null {
  const max = maxEdgeSize(params, f.edges);
  if (f.size < max) return null;
  const what = f.type === 'fillet' ? '모서리 반지름' : '모따기 거리';
  return `${what} ${formatMm(f.size)}mm 가 너무 큽니다 (${formatMm(max)}mm 보다 작아야 합니다)`;
}

export function describeEdgeFeature(f: EdgeFeature): string {
  return `${f.type === 'fillet' ? 'R' : 'C'}${formatMm(f.size)}${f.edges === 'vertical' ? ' 세로' : ''}`;
}
