import { test } from 'node:test';
import assert from 'node:assert/strict';
import { League } from '../src/league.mjs';
import { Roster, AttendanceBook, SubsidyService, SubsidyRules } from '../src/index.mjs';
import { bundleFromWire } from './helpers.mjs';

test('无协会/赛地上下文的同号裁判不能自动合并，显式挂身份核对', () => {
  const league = new League();
  league.loadBundle('confirmed', bundleFromWire('confirmed'));

  // O1 同时属于 n、e 两协会；没有场次或赛地线索时拒绝猜测。
  const result = league.resolveBareId('O1', { source: 'unit-test' });
  assert.equal(result.ambiguous, true);
  assert.equal(result.identity, null);
  assert.deepEqual(result.candidates.sort(), ['e/O1', 'n/O1']);
  assert.ok(league.pendingChecks.some((c) =>
    c.kind === 'identity-ambiguous' && c.id === 'O1'));

  // 给出协会上下文即精确消歧，不会落到另一个人。
  const north = league.resolveBareId('O1', { association: 'n', source: 'unit-test' });
  assert.equal(north.identity, 'n/O1');
  const east = league.resolveBareId('O1', { association: 'e', source: 'unit-test' });
  assert.equal(east.identity, 'e/O1');
});

test('名册别名改挂不同裁判号时拒绝静默合并', () => {
  const roster = new Roster();
  roster.add({ association: 'n', alias: 'N-A', id: 'O1' });
  assert.throws(() => roster.add({ association: 'n', alias: 'N-A', id: 'O2' }),
    /登记的裁判号由 O1 变为 O2/);
  // 同协会同号不同别名可以并存（一人多名），不会产生第二个人。
  roster.add({ association: 'n', alias: 'N-A-备用', id: 'O1' });
  assert.equal(roster.resolve('n', 'N-A-备用'), 'n/O1');
});

test('迟到签退证实原派执裁前半场：保留双方区间并按规则分别计费', () => {
  const league = new League();
  league.loadBundle('confirmed', bundleFromWire('confirmed'));

  // 场馆记录：n/O1 执裁前半场后迟到签退，e/O2 接替后半段（首尾相接）。
  const attendance = new AttendanceBook();
  attendance.load([
    { fact: 'V1', game: 'G1', role: 'plate', identity: 'n/O1',
      from_time: '2026-12-01T09:50+08:00', to_time: '2026-12-01T10:55+08:00' },
    { fact: 'V2', game: 'G1', role: 'plate', identity: 'e/O2',
      from_time: '2026-12-01T10:55+08:00', to_time: '2026-12-01T12:00+08:00' },
  ]);

  const service = new SubsidyService({
    rules: new SubsidyRules({ perMinuteFen: 150, travelWithoutDutyFen: 3500 }),
    attendance,
    travel: league.travel,
    schedule: league.schedule,
    roster: league.roster,
  });
  const game = league.schedule.get('G1');
  const result = service.adjudicateGame(game, {
    assignments: [
      // 原派取消仍待协会确认。
      { identity: 'n/O1', dispatchRef: 'A1', dispatchState: 'cancel-pending', accepted: false },
      { identity: 'e/O2', dispatchRef: 'A1', dispatchState: 'substituted',
        substitutionRef: 'SUB-1', accepted: true },
    ],
    // 补助端已按全场给替补确认过一张凭据。
    ledger: [{
      ledger: 'PAY1', official: 'O2', identity: 'e/O2', game: 'G1', role: 'plate',
      from_time: game.start, to_time: game.end, fen: 19500, state: 'confirmed',
    }],
    overlaps: attendance.overlapsForGame('G1'),
  });

  // 双方执裁区间都保留。
  const identities = result.duty.map((d) => d.identity).sort();
  assert.deepEqual(identities, ['e/O2', 'n/O1']);
  assert.equal(result.duty.find((d) => d.identity === 'n/O1').actualMinutes, 65);
  assert.equal(result.duty.find((d) => d.identity === 'e/O2').actualMinutes, 65);

  // 区间首尾相接 -> 无重叠复核；原单保留、差额另列。
  assert.equal(result.venueReviews.length, 0);
  const adjustment = result.adjustments.find((a) => a.againstLedger === 'PAY1');
  assert.equal(adjustment.deltaFen, -9750);
  assert.equal(adjustment.originalRetained, true);

  // 待确认的原派取消显式列出，不产生第二份全场全额。
  assert.ok(result.pending.some((p) => p.kind === 'cancel-pending' && p.identity === 'n/O1'));
});

test('重叠执裁区间进入补助视图时强制场馆复核项', () => {
  const league = new League();
  league.loadBundle('confirmed', bundleFromWire('confirmed'));
  const attendance = new AttendanceBook();
  attendance.load([
    { fact: 'V1', game: 'G1', role: 'plate', identity: 'n/O1',
      from_time: '2026-12-01T09:50+08:00', to_time: '2026-12-01T11:10+08:00' },
    { fact: 'V2', game: 'G1', role: 'plate', identity: 'e/O2',
      from_time: '2026-12-01T10:55+08:00', to_time: '2026-12-01T12:00+08:00' },
  ]);
  const service = new SubsidyService({
    rules: new SubsidyRules({ perMinuteFen: 150, travelWithoutDutyFen: 3500 }),
    attendance, travel: league.travel, schedule: league.schedule, roster: league.roster,
  });
  const result = service.adjudicateGame(league.schedule.get('G1'), {
    assignments: [], ledger: [], overlaps: attendance.overlapsForGame('G1'),
  });
  assert.equal(result.venueReviews.length, 1);
  assert.deepEqual(result.venueReviews[0].facts.sort(), ['V1', 'V2']);
  assert.match(result.venueReviews[0].reason, /待场馆决定/);
});
