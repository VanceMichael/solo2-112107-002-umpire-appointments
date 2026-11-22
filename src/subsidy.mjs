// 补助裁决。
// 规则来源（README 协议）：
//  - 按实际执裁分钟 × perMinuteFen 计费；另有“已出发未上场”的空跑费；
//  - 场馆重叠区间由场馆决定；按场/角色重复补领的事实号只承认一次；
//  - 补助端已确认的凭据行留原单可查，判定变更触及它时另列差额（不覆盖原单）；
//  - 待确认的取消/替补不产生第二份全额补助。

import { DomainError, instant, minutesBetween, sumBy, unique } from './util.mjs';

function intersectionMinutes(aStart, aEnd, bStart, bEnd) {
  const lo = Math.max(instant(aStart), instant(bStart));
  const hi = Math.min(instant(aEnd), instant(bEnd));
  return hi > lo ? Math.round((hi - lo) / 60000) : 0;
}

export class SubsidyRules {
  constructor(fees) {
    this.currency = fees?.currency ?? 'CNY';
    this.perMinuteFen = Number(fees?.perMinuteFen ?? 0);
    this.travelWithoutDutyFen = Number(fees?.travelWithoutDutyFen ?? 0);
  }
}

export class SubsidyService {
  constructor({ rules, attendance, travel, schedule, roster }) {
    this.rules = rules instanceof SubsidyRules ? rules : new SubsidyRules(rules);
    this.attendance = attendance;
    this.travel = travel;
    this.schedule = schedule;
    this.roster = roster;
  }

  // 单场比赛的完整补助视图。
  // assignments: [{ identity, role, dispatchRef, dispatchState, substitutionRef|null, accepted:bool }]
  adjudicateGame(game, { assignments = [], ledger = [], overlaps = [] } = {}) {
    const facts = this.attendance.forGame(game.game);
    const gameMinutes = minutesBetween(game.start, game.end);
    const result = {
      game: game.game,
      currency: this.rules.currency,
      ledgerLines: [],          // 原单，原样保留
      duty: [],                 // 实际执裁计费行
      travelOnly: [],           // 已出发未上场
      adjustments: [],          // 差额行（另列，不覆盖原单）
      duplicateClaims: [],      // 重复补领
      venueReviews: [...overlaps.map((o) => ({ ...o, reason: '同场同角色执裁区间重叠，待场馆决定' }))],
      pending: [],              // 待确认事项
      totals: { confirmedLedgerFen: 0, proposedDutyFen: 0, proposedTravelFen: 0, proposedDeltaFen: 0 },
    };

    // 1) 原单留档；同一事实号被多张凭据引用时只承认一次。
    const seenFact = new Set();
    for (const line of ledger) {
      const kept = { ...line, retained: true };
      result.ledgerLines.push(kept);
      if (line.state === 'confirmed') {
        result.totals.confirmedLedgerFen += Number(line.fen ?? 0);
      }
      for (const factRef of line.facts ?? []) {
        if (seenFact.has(factRef)) {
          result.duplicateClaims.push({ fact: factRef, ledger: line.ledger, game: game.game });
        } else {
          seenFact.add(factRef);
        }
      }
    }

    // 2) 实际执裁：以场馆签退区间按分钟计费。
    const byIdentity = new Map();
    for (const fact of facts) {
      if (!byIdentity.has(fact.identity)) byIdentity.set(fact.identity, []);
      byIdentity.get(fact.identity).push(fact);
    }
    for (const [identity, rows] of byIdentity) {
      const intervals = rows
        .sort((a, b) => a.from_time.localeCompare(b.from_time))
        .map((r) => ({ fact: r.fact, role: r.role, from: r.from_time, to: r.to_time,
          minutes: minutesBetween(r.from_time, r.to_time) }));
      const minutes = sumBy(intervals, (i) => i.minutes);
      result.duty.push({
        identity,
        roles: unique(intervals.map((i) => i.role)),
        intervals,
        actualMinutes: minutes,
        fen: minutes * this.rules.perMinuteFen,
      });
    }
    result.totals.proposedDutyFen = sumBy(result.duty, (d) => d.fen);

    // 3) 已出发但未上场：有派遣/已接受替补关联、有已确认行程、零执裁区间。
    const dutyIdentities = new Set(byIdentity.keys());
    for (const assignment of assignments) {
      if (dutyIdentities.has(assignment.identity)) continue;
      if (assignment.dispatchState === 'cancelled') continue;
      const travel = this.travel.forIdentity(assignment.identity)
        .find((t) => t.town === game.town);
      if (!travel) {
        if (!assignment.accepted) {
          result.pending.push({ kind: 'no-travel-evidence', identity: assignment.identity,
            game: game.game, note: '派遣未确认且无到达凭据，暂不计费' });
        }
        continue;
      }
      result.travelOnly.push({
        identity: assignment.identity,
        travel: { arrive: travel.arrive, leave: travel.leave, town: travel.town },
        fen: this.rules.travelWithoutDutyFen,
        basis: '已确认行程出发但场馆无执裁签退',
        dispatchRef: assignment.dispatchRef,
      });
    }
    result.totals.proposedTravelFen = sumBy(result.travelOnly, (t) => t.fen);

    // 4) 已确认凭据与实际执裁不一致 -> 原单保留，差额另列。
    for (const line of ledger) {
      if (line.state !== 'confirmed') continue;
      const covered = sumBy(result.duty
        .filter((d) => d.identity === line.identity), (d) =>
        sumBy(d.intervals, (interval) =>
          intersectionMinutes(line.from_time, line.to_time, interval.from, interval.to)));
      const billed = minutesBetween(line.from_time, line.to_time);
      const supportedFen = covered * this.rules.perMinuteFen;
      const delta = supportedFen - Number(line.fen ?? 0);
      if (delta !== 0 || covered < billed) {
        const otherFacts = facts
          .filter((f) => f.identity !== line.identity)
          .map((f) => f.fact);
        result.adjustments.push({
          againstLedger: line.ledger,
          identity: line.identity,
          game: game.game,
          originalFen: Number(line.fen ?? 0),
          billedMinutes: billed,
          supportedMinutes: covered,
          adjustedFen: supportedFen,
          deltaFen: delta,
          status: 'proposed-adjustment',
          reason: otherFacts.length
            ? `凭据区间内有 ${covered} 分钟本裁判签退，其余时段由场馆事实 ${otherFacts.join('、')} 执裁`
            : '凭据区间缺少对应场馆签退支撑',
          originalRetained: true,
        });
        result.totals.proposedDeltaFen += delta;
      }
    }

    // 5) 待确认事项显式列出，防止两人报同一场全额。
    for (const assignment of assignments) {
      if (['assigned', 'cancel-pending'].includes(assignment.dispatchState)) {
        result.pending.push({
          kind: assignment.dispatchState === 'assigned' ? 'dispatch-unconfirmed' : 'cancel-pending',
          identity: assignment.identity, game: game.game, dispatchRef: assignment.dispatchRef,
          note: assignment.dispatchState === 'assigned'
            ? '协会派遣仍为 assigned，挂名不等于到场，待协会确认'
            : '原派取消尚未确认，不产生全额补助',
        });
      }
      if (assignment.substitutionRef && !assignment.accepted) {
        result.pending.push({ kind: 'substitution-pending', identity: assignment.identity,
          game: game.game, substitutionRef: assignment.substitutionRef,
          note: '替补接受仍为待确认，暂不按全场计费' });
      }
    }

    return result;
  }

  // 防止同场同角色两张全额凭据：对已确认凭据做交叉检查。
  detectDoubleFullPayment(game, ledger) {
    const fullWindow = (line) =>
      minutesBetween(line.from_time, line.to_time) >= minutesBetween(game.start, game.end);
    const confirmed = ledger.filter((l) => l.state === 'confirmed' && fullWindow(l));
    const byRole = new Map();
    for (const line of confirmed) {
      const key = line.role ?? 'plate';
      if (!byRole.has(key)) byRole.set(key, []);
      byRole.get(key).push(line);
    }
    const findings = [];
    for (const [role, lines] of byRole) {
      if (lines.length > 1) {
        findings.push({ game: game.game, role, ledgers: lines.map((l) => l.ledger),
          reason: '同场同角色存在多张全场全额凭据，只能承认一次' });
      }
    }
    return findings;
  }
}

export function assertNoBlockingReview(adjudication) {
  const blocking = adjudication.venueReviews.length + adjudication.duplicateClaims.length;
  if (blocking > 0) {
    throw new DomainError('subsidy-awaiting-venue',
      '补助裁决仍有待场馆复核项，不能据此刻意确认全额',
      { venueReviews: adjudication.venueReviews, duplicateClaims: adjudication.duplicateClaims });
  }
}
