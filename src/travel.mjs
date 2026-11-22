// 行程确认：只有 state=confirmed 的记录是可用到达凭据。
// 一人转场时，同一交通确认必须同时满足两边报到时限；
// 外地场在前一场实际签退后至少预留 30 分钟。

import { instant } from './util.mjs';

export class TravelBook {
  constructor() {
    // 身份键 -> 该裁判全部已确认行程（按到达时间排序）
    this._byIdentity = new Map();
  }

  load(rows = []) {
    this._byIdentity.clear();
    for (const row of rows) this.add(row);
    for (const list of this._byIdentity.values()) {
      list.sort((a, b) => instant(a.arrive) - instant(b.arrive));
    }
  }

  add(row) {
    if (row.state !== 'confirmed') return;
    if (!this._byIdentity.has(row.identity)) this._byIdentity.set(row.identity, []);
    this._byIdentity.get(row.identity).push({ ...row });
  }

  forIdentity(identity) {
    return (this._byIdentity.get(identity) ?? []).map((r) => ({ ...r }));
  }

  // 该身份是否有一条已确认行程能在某场报到时限前抵达指定赛地。
  // reportAt 默认为开赛时点；同镇转场时可传入更早的报到时限。
  canReport(identity, town, reportAt) {
    const rows = this._byIdentity.get(identity) ?? [];
    const usable = rows.filter((r) => r.town === town && instant(r.arrive) <= instant(reportAt));
    if (!usable.length) {
      return { ok: false, reason: rows.length
        ? `已确认行程无法在 ${reportAt} 前抵达 ${town}（最早 ${rows.map((r) => r.arrive).join('、')}）`
        : '没有已确认的行程凭据', travel: null };
    }
    return { ok: true, reason: '', travel: usable[usable.length - 1] };
  }

  // 同一条交通确认能否连续覆盖两场（不同赛地）：
  // 抵达要赶得上第一场报到，离开要在第二场报到之后；
  // 并且第二场开赛距第一场实际签退至少 30 分钟（README 协议约束）。
  canCoverTransfer({ identity, firstGame, secondGame, firstDutyEnd, minimumGapMinutes = 30 }) {
    const rows = this._byIdentity.get(identity) ?? [];
    const note = [];
    let usable = null;
    for (const row of rows) {
      if (row.town !== firstGame.town) continue;
      if (instant(row.arrive) > instant(firstGame.start)) {
        note.push(`抵达 ${row.arrive} 晚于首场报到 ${firstGame.start}`);
        continue;
      }
      if (!row.leave) {
        note.push('行程没有离开确认，无法证明能赶到第二场');
        continue;
      }
      if (instant(row.leave) > instant(secondGame.start)) {
        note.push(`离开 ${row.leave} 晚于第二场报到 ${secondGame.start}`);
        continue;
      }
      usable = row;
      break;
    }
    const gap = firstDutyEnd
      ? (instant(secondGame.start) - instant(firstDutyEnd)) / 60000
      : null;
    const gapOk = gap === null || gap >= minimumGapMinutes;
    if (!gapOk) note.push(`两场仅间隔 ${gap} 分钟，少于规定的 ${minimumGapMinutes} 分钟`);
    return {
      ok: Boolean(usable) && gapOk,
      travel: usable,
      gapMinutes: gap,
      reasons: note,
    };
  }
}
