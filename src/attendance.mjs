// 场馆签退（实际执裁记录）：按场、角色保存事实号与执裁区间。
// 这是“是否实际上场”的唯一权威来源——派遣页仍挂名不代表到场。
// 同场同角色的重叠区间送场馆复核；重复事实号只承认一次。

import { groupBy, overlaps, unique } from './util.mjs';

export class AttendanceBook {
  constructor() {
    this._facts = new Map();
  }

  load(rows = []) {
    for (const row of rows) this.add(row);
  }

  add(row) {
    if (this._facts.has(row.fact)) {
      const existing = this._facts.get(row.fact);
      if (existing.game !== row.game || existing.identity !== row.identity ||
        existing.role !== row.role ||
        existing.from_time !== row.from_time || existing.to_time !== row.to_time) {
        throw new Error(`场馆事实号 ${row.fact} 出现内容冲突，需场馆复核`);
      }
      return;
    }
    this._facts.set(row.fact, { ...row });
  }

  all() {
    return [...this._facts.values()].map((r) => ({ ...r }));
  }

  forGame(game) {
    return this.all().filter((r) => r.game === game);
  }

  forIdentity(identity) {
    return this.all().filter((r) => r.identity === identity);
  }

  // 同一裁判同场同角色的区间合并视角（首尾相接可连成连续执裁）。
  dutyIntervalsForGame(identity, game) {
    return this.forGame(game)
      .filter((r) => r.identity === identity)
      .sort((a, b) => a.from_time.localeCompare(b.from_time))
      .map((r) => ({ fact: r.fact, role: r.role, from: r.from_time, to: r.to_time }));
  }

  // 找同场同角色两名/多名裁判执裁区间重叠的事实对，交场馆决定。
  overlapsForGame(game) {
    const findings = [];
    const byRole = groupBy(this.forGame(game), (r) => r.role);
    for (const [role, rows] of byRole) {
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const a = rows[i];
          const b = rows[j];
          if (a.identity === b.identity) continue;
          if (overlaps(a.from_time, a.to_time, b.from_time, b.to_time)) {
            findings.push({
              game, role,
              facts: [a.fact, b.fact],
              identities: unique([a.identity, b.identity]),
              window: {
                from: a.from_time > b.from_time ? a.from_time : b.from_time,
                to: a.to_time < b.to_time ? a.to_time : b.to_time,
              },
            });
          }
        }
      }
    }
    return findings;
  }
}
