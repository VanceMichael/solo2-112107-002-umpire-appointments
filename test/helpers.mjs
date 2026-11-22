// 测试辅助：直接读 wire/ 原始报文构造页面集合，或启动合成来源服务走 HTTP。
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { makeSource } from '../source.mjs';

export const loadWire = (phase, name) =>
  JSON.parse(readFileSync(new URL(`../wire/${phase}/${name}.json`, import.meta.url), 'utf8'));

export function bundleFromWire(phase, { unavailable = [] } = {}) {
  const names = ['schedule', 'dispatch', 'roster', 'license-index', 'travel',
    'attendance', 'expense', 'fees', 'delegations'];
  const pages = {};
  for (const name of names) {
    pages[name] = { phase, resource: name, available: true, data: loadWire(phase, name) };
  }
  // 以当日索引声明的证件册页为准。
  const index = loadWire(phase, 'license-index');
  for (const volume of index.volumes) {
    if (unavailable.includes(volume)) {
      // 与真实来源一致：键存在，但页不可查（interim east-cert 协议 503）。
      pages[volume] = { phase, resource: volume, available: false, reason: 'unavailable', status: 503 };
    } else {
      try {
        pages[volume] = { phase, resource: volume, available: true, data: loadWire(phase, volume) };
      } catch {
        pages[volume] = { phase, resource: volume, available: false, reason: 'not-published', status: 404 };
      }
    }
  }
  return pages;
}

export async function startSource() {
  const server = makeSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}
