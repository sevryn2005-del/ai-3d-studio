import { describe, expect, it } from 'vitest';
import { emptyModel, type ModelDefinition } from '../../cad/commandTypes';
import { executeCommand } from '../../cad/commandExecutor';
import { bomCsv, bomRows } from './bom';

function run(cmds: unknown[]) {
  let m: ModelDefinition = emptyModel();
  for (const c of cmds) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error);
    m = r.model;
  }
  return m;
}

describe('부품표', () => {
  it('같은 형상은 한 줄로 묶어 수량을 센다 (위치·색은 무관, 억제는 빠짐)', () => {
    const m = run([
      { type: 'create_box', id: 'a', name: '받침', width: 40, depth: 40, height: 10 },
      { type: 'create_cylinder', id: 'p1', name: '핀', radius: 3, height: 20, position: [10, 0, 0] },
      { type: 'create_cylinder', id: 'p2', name: '핀', radius: 3, height: 20, position: [-10, 0, 0] },
      { type: 'set_appearance', target: 'p2', color: '#ff0000' },
      { type: 'create_box', id: 'x', width: 5, depth: 5, height: 5 },
      { type: 'set_suppressed', target: 'x', suppressed: true },
    ]);
    const rows = bomRows(m);
    expect(rows.map((r) => [r.name, r.qty])).toEqual([['받침', 1], ['핀', 2]]);
    const csv = bomCsv(rows);
    expect(csv.startsWith('﻿번호,이름,종류,크기,수량\n1,받침,')).toBe(true);
    expect(csv).toContain(',핀,원통,Ø6×20,2');
  });
});
