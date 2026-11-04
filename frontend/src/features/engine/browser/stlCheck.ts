/** 이진 STL 검사 (테스트용): 부피와 짝이 맞지 않는 모서리 수 (0 = 닫힌 메시) */
export function stlCheck(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  const key = (o: number) => [0, 1, 2].map((k) => dv.getFloat32(o + k * 4, true).toFixed(4)).join(',');
  const edges = new Map<string, number>();
  let volume = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const p = [0, 1, 2].map((j) => [0, 1, 2].map((k) => dv.getFloat32(o + j * 12 + k * 4, true)));
    const [a, b, c] = p as [number[], number[], number[]];
    volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    const v = [0, 1, 2].map((j) => key(o + j * 12));
    for (let j = 0; j < 3; j++) edges.set(`${v[j]}>${v[(j + 1) % 3]}`, (edges.get(`${v[j]}>${v[(j + 1) % 3]}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [e, c] of edges) {
    const [a, b] = e.split('>');
    if (c !== 1 || edges.get(`${b}>${a}`) !== 1) bad++;
  }
  return { volume, bad };
}
