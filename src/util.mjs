// 通用领域工具：时间判断、错误类型与集合辅助。
// 赛程时间带 UTC 偏移，证件日期按赛地日历（直接取 ISO 字符串的日期部分）。

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const instant = (value) => Date.parse(value);

export const localDay = (value) => value.slice(0, 10);

export function minutesBetween(start, end) {
  return Math.round((instant(end) - instant(start)) / 60000);
}

// 两个时间窗是否严格重叠（首尾相接不算重叠）。
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return instant(aStart) < instant(bEnd) && instant(bStart) < instant(aEnd);
}

export const dayCompare = (a, b) => a.localeCompare(b);

export function unique(values) {
  return [...new Set(values)];
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function sumBy(items, fn) {
  return items.reduce((total, item) => total + fn(item), 0);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
