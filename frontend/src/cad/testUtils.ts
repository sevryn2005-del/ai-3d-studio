import type { CadObject } from './commandTypes';

/** 테스트용: 기본 도형이면 params, 아니면 undefined */
export function paramsOf(o: CadObject | undefined): Record<string, number> | undefined {
  return o && 'params' in o ? (o.params as Record<string, number>) : undefined;
}
