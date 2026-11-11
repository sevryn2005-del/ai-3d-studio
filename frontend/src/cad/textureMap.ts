/**
 * 텍스처 박스 투영 (형식 v30): 화면(뷰포트)과 GLB 내보내기(브라우저 exporters.ts · 서버 exporter.py box_uv)가 같은 규칙을 쓴다.
 * 좌표는 객체 로컬 (mm, Z-up) — 객체를 옮기거나 돌려도 무늬가 따라간다. 이미지 한 장 = tile mm 정사각형.
 */
import { BufferAttribute, type BufferGeometry } from 'three';
import type { Texture } from './commandTypes';
import { smartUv } from './smartUv';

/**
 * 박스 투영 UV: 법선에서 가장 큰 축으로 면을 고르고 나머지 두 좌표를 UV 로.
 * X 면: u = ±y, Y 면: u = ∓x, Z 면: u = x, v = ±y … 법선이 음수 쪽이면 거울상이 되지 않게 u(Z 면은 v)를 뒤집는다.
 * glTF 는 이미지 위쪽이 v = 0 이라 v 는 뒤집어 넣는다. scale 기본 0.001 = 1 UV 가 1 m.
 */
export function boxUv(x: number, y: number, z: number, nx: number, ny: number, nz: number, scale = 0.001): [number, number] {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) [u, v] = [nx >= 0 ? y : -y, z];
  else if (ay >= az) [u, v] = [ny >= 0 ? -x : x, z];
  else [u, v] = [x, nz >= 0 ? y : -y];
  return [u * scale, -v * scale];
}

/**
 * 화면용: 객체 로컬 메시 → 인덱스 없는 복사본 + uv (한 장 = tile mm). 면은 삼각형 법선으로 고른다 (한 삼각형은 한 면에만).
 * 텍스처는 flipY = false 로 읽어야 GLB(glTF)와 같은 방향이 된다.
 */
export function boxUvGeometry(g: BufferGeometry, tile: number): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  const p = out.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i + 2 < p.count; i += 3) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [p.getX(i), p.getY(i), p.getZ(i), p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1), p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx] as const;
    for (let k = 0; k < 3; k++) {
      const [u, v] = boxUv(p.getX(i + k), p.getY(i + k), p.getZ(i + k), n[0], n[1], n[2], 1 / tile);
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  return out;
}

/** 스마트 UV 펼치기 (형식 v46): 인덱스 없는 복사본 + 차트마다 펼친 uv (0~1, 한 장). GLB 와 같은 규칙 (smartUv.ts) */
export function smartUvGeometry(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  out.setAttribute('uv', new BufferAttribute(smartUv(out.getAttribute('position').array).uv, 2));
  return out;
}

/** 텍스처 설정에 맞는 UV 메시 */
export function textureUvGeometry(g: BufferGeometry, tex: Pick<Texture, 'tile' | 'projection'>): BufferGeometry {
  return tex.projection === 'smart' ? smartUvGeometry(g) : boxUvGeometry(g, tex.tile);
}
