// 赛程：保留各场比赛的修订历史，提前或分场改期都能被重新评估。

import { instant, minutesBetween } from './util.mjs';

export class Schedule {
  constructor() {
    this._games = new Map();
  }

  // 用一个发布批次的整页赛程替换视图；保留同 game 编号的历史版本。
  load(rows = [], seenAt = new Date().toISOString()) {
    const live = new Set();
    for (const row of rows) {
      live.add(row.game);
      if (!this._games.has(row.game)) {
        this._games.set(row.game, { current: row, revisions: [{ ...row, seenAt }] });
      } else {
        const entry = this._games.get(row.game);
        const last = entry.current;
        if (last.start !== row.start || last.end !== row.end ||
          last.town !== row.town || last.rules !== row.rules ||
          last.level !== row.level || last.role !== row.role) {
          entry.revisions.push({ ...row, seenAt });
        }
        entry.current = { ...row };
      }
    }
    for (const [game, entry] of this._games) {
      if (!live.has(game)) entry.current = null;
    }
  }

  get(game) {
    const entry = this._games.get(game);
    if (!entry || !entry.current) return undefined;
    return entry.current;
  }

  require(game) {
    const value = this.get(game);
    if (!value) throw new Error(`赛程中没有场次 ${game}`);
    return value;
  }

  revisions(game) {
    return (this._games.get(game)?.revisions ?? []).map((r) => ({ ...r }));
  }

  wasRescheduled(game) {
    const revisions = this.revisions(game);
    if (revisions.length < 2) return null;
    const original = revisions[0];
    const current = this.require(game);
    return {
      game,
      from: { start: original.start, end: original.end },
      to: { start: current.start, end: current.end },
      movedEarlier: instant(current.start) < instant(original.start),
    };
  }

  all() {
    return [...this._games.values()].filter((e) => e.current).map((e) => ({ ...e.current }));
  }

  durationMinutes(game) {
    const g = this.require(game);
    return minutesBetween(g.start, g.end);
  }
}
