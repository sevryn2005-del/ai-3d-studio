/**
 * 부품표 (BOM, 형식 v11 조립품): 계산되는(억제되지 않은) 최상위 객체 = 부품. 형상 키가 같은 부품은 한 줄로 묶어 수량을 센다
 * (같은 부품을 여러 번 넣은 경우 — 색·위치는 형상과 무관).
 */
import type { ModelDefinition } from '../../cad/commandTypes';
import { byId, sketchIndex, topLevelObjects } from '../../cad/modelGraph';
import { isSuppressed } from '../../cad/features';
import { kindLabel, sizeSummary } from '../../cad/objectKinds';
import { geometryKey } from '../backend/renderMesh';

export interface BomRow {
  no: number;
  name: string;
  kind: string;
  size: string;
  qty: number;
  ids: string[];
}

export function bomRows(model: ModelDefinition): BomRow[] {
  const index = byId(model);
  const sketches = sketchIndex(model);
  const groups = new Map<string, BomRow>();
  for (const o of topLevelObjects(model)) {
    if (isSuppressed(o, index)) continue;
    const key = geometryKey(o, index, sketches);
    const row = groups.get(key);
    if (row) {
      row.qty++;
      row.ids.push(o.id);
    } else groups.set(key, { no: groups.size + 1, name: o.name, kind: kindLabel(o), size: sizeSummary(o, model), qty: 1, ids: [o.id] });
  }
  return [...groups.values()];
}

/** CSV (엑셀에서 한글이 깨지지 않도록 BOM 문자 포함) */
export function bomCsv(rows: BomRow[]): string {
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['번호', '이름', '종류', '크기', '수량'], ...rows.map((r) => [r.no, r.name, r.kind, r.size, r.qty])];
  return '﻿' + lines.map((l) => l.map(esc).join(',')).join('\n') + '\n';
}
