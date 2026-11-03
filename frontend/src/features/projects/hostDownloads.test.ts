import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { adaptForHost } from './hostDownloads';

const bytes = async (d: Blob | Uint8Array) => (d instanceof Uint8Array ? d : new Uint8Array(await d.arrayBuffer()));

describe('adaptForHost (호스트 저장 확장자 규칙)', () => {
  it('프로젝트 .ai3d → .ai3d.json (내용 그대로)', async () => {
    const r = await adaptForHost(new Blob(['{"a":1}']), '받침대.ai3d');
    expect(r.filename).toBe('받침대.ai3d.json');
    expect(strFromU8(await bytes(r.data))).toBe('{"a":1}');
  });

  it.each(['stl', '3mf', 'glb', 'step'])('.%s → ZIP 으로 감싸고 압축을 풀면 원본', async (ext) => {
    const original = new Uint8Array([1, 2, 3, 250]);
    const r = await adaptForHost(new Blob([original]), `모델.${ext}`);
    expect(r.filename).toBe(`모델.${ext}.zip`);
    expect(unzipSync(await bytes(r.data))).toEqual({ [`모델.${ext}`]: original });
  });

  it('허용된 확장자는 그대로', async () => {
    expect((await adaptForHost(new Blob(['x']), 'a.json')).filename).toBe('a.json');
  });
});
