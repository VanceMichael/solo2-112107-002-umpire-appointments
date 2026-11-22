import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttendanceBook, Commitments, TravelBook, Delegations,
  SubsidyService, SubsidyRules, Roster, CertificateArchive,
} from '../src/index.mjs';

const fees = new SubsidyRules({ currency: 'CNY', perMinuteFen: 150, travelWithoutDutyFen: 3500 });
const game = { game: 'G9', level: 'district', rules: 'softball', role: 'plate',
  start: '2026-12-01T10:00+08:00', end: '2026-12-01T12:00+08:00', town: 'D' };

test('同场同角色重叠执裁区间送场馆复核，首尾相接不算重叠', () => {
  const book = new AttendanceBook();
  book.load([
    { fact: 'F1', game: 'G9', role: 'plate', identity: 'a/O1',
      from_time: '2026-12-01T10:00+08:00', to_time: '2026-12-01T11:00+08:00' },
    { fact: 'F2', game: 'G9', role: 'plate', identity: 'a/O2',
      from_time: '2026-12-01T11:00+08:00', to_time: '2026-12-01T12:00+08:00' },
  ]);
  assert.equal(book.overlapsForGame('G9').length, 0);

  book.add({ fact: 'F3', game: 'G9', role: 'plate', identity: 'a/O2',
    from_time: '2026-12-01T10:50+08:00', to_time: '2026-12-01T11:30+08:00' });
  const findings = book.overlapsForGame('G9');
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].facts.sort(), ['F1', 'F3']);
  assert.equal(findings[0].window.from, '2026-12-01T10:50+08:00');
  assert.equal(findings[0].window.to, '2026-12-01T11:00+08:00');

  // 同一事实号重复装载只承认一次，内容冲突则报错。
  assert.doesNotThrow(() => book.add({ fact: 'F1', game: 'G9', role: 'plate', identity: 'a/O1',
    from_time: '2026-12-01T10:00+08:00', to_time: '2026-12-01T11:00+08:00' }));
  assert.throws(() => book.add({ fact: 'F1', game: 'G9', role: 'plate', identity: 'a/O9',
    from_time: '2026-12-01T10:00+08:00', to_time: '2026-12-01T11:00+08:00' }), /内容冲突/);
});

test('已出发但未上场只计空跑费，无行程且未确认的派遣不计费', () => {
  const attendance = new AttendanceBook();
  attendance.load([
    { fact: 'F1', game: 'G9', role: 'plate', identity: 'a/O1',
      from_time: game.start, to_time: game.end },
  ]);
  const travel = new TravelBook();
  travel.load([
    { identity: 'a/O2', town: 'D', arrive: '2026-12-01T09:30+08:00', leave: null, state: 'confirmed' },
  ]);
  const roster = new Roster();
  const service = new SubsidyService({ rules: fees, attendance, travel,
    schedule: { require: () => game, get: () => game }, roster });

  const result = service.adjudicateGame(game, {
    assignments: [
      { identity: 'a/O1', dispatchRef: 'A1', dispatchState: 'confirmed', accepted: false },
      { identity: 'a/O2', dispatchRef: 'A2', dispatchState: 'assigned', accepted: false },
      { identity: 'a/O3', dispatchRef: 'A3', dispatchState: 'assigned', accepted: false },
    ],
    ledger: [], overlaps: [],
  });

  const travelOnly = result.travelOnly.find((t) => t.identity === 'a/O2');
  assert.equal(travelOnly.fen, 3500);
  assert.equal(travelOnly.basis, '已确认行程出发但场馆无执裁签退');
  // O3 无行程、派遣未确认 -> 只挂待确认，不产生费用。
  assert.equal(result.travelOnly.some((t) => t.identity === 'a/O3'), false);
  assert.ok(result.pending.some((p) => p.identity === 'a/O3' && p.kind === 'no-travel-evidence'));
  assert.equal(result.totals.proposedTravelFen, 3500);
  assert.equal(result.totals.proposedDutyFen, 120 * 150);
});

test('非 confirmed 行程不是可用到达凭据', () => {
  const travel = new TravelBook();
  travel.load([
    { identity: 'a/O1', town: 'D', arrive: '2026-12-01T09:30+08:00', leave: null, state: 'planned' },
  ]);
  const check = travel.canReport('a/O1', 'D', game.start);
  assert.equal(check.ok, false);
  assert.match(check.reason, /没有已确认的行程凭据/);
});

test('转场同一交通确认必须覆盖两边报到，且外场间隔至少 30 分钟', () => {
  const travel = new TravelBook();
  const first = { game: 'G1', town: 'D', start: '2026-12-01T09:00+08:00', end: '2026-12-01T11:00+08:00' };
  const second = { game: 'G2', town: 'E', start: '2026-12-01T11:20+08:00', end: '2026-12-01T13:00+08:00' };
  travel.load([
    { identity: 'a/O1', town: 'D', arrive: '2026-12-01T08:30+08:00',
      leave: '2026-12-01T11:05+08:00', state: 'confirmed' },
  ]);

  // 首场 11:00 签退，第二场 11:20 报到 -> 仅 20 分钟，不满足 30 分钟。
  const tooTight = travel.canCoverTransfer({
    identity: 'a/O1', firstGame: first, secondGame: second,
    firstDutyEnd: '2026-12-01T11:00+08:00',
  });
  assert.equal(tooTight.ok, false);
  assert.equal(tooTight.gapMinutes, 20);

  const later = { ...second, start: '2026-12-01T11:35+08:00' };
  const ok = travel.canCoverTransfer({
    identity: 'a/O1', firstGame: first, secondGame: later,
    firstDutyEnd: '2026-12-01T11:00+08:00',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.gapMinutes, 35);

  // 没有离开确认 -> 无法证明赶得到第二场。
  const noLeave = new TravelBook();
  noLeave.load([
    { identity: 'a/O1', town: 'D', arrive: '2026-12-01T08:30+08:00', leave: null, state: 'confirmed' },
  ]);
  const blocked = noLeave.canCoverTransfer({
    identity: 'a/O1', firstGame: first, secondGame: second, firstDutyEnd: null,
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.reasons.some((r) => r.includes('没有离开确认')));
});

test('级别高的证件覆盖低级别场次，反过来不成立', () => {
  const archive = new CertificateArchive({ volumeAssociations: { a: 'vol' } });
  archive.loadIndex({ day: '2026-12-01', volumes: ['vol'] });
  archive.loadVolume('vol', [
    { official: 'O1', level: 'city', rules: 'softball',
      from_day: '2026-01-01', through: '2027-01-01', revoked_day: null },
  ]);
  const districtGame = { ...game, level: 'district' };
  assert.equal(archive.evaluate('a/O1', districtGame).decision, 'valid');
  const nationalGame = { ...game, level: 'national' };
  assert.equal(archive.evaluate('a/O1', nationalGame).decision, 'invalid');
});

test('待确认事项不产生硬占用，已确认派遣与签退才阻塞时间冲突场', () => {
  const commitments = new Commitments();
  commitments.add('a/O1', { game: 'G1', role: 'plate', start: game.start, end: game.end,
    source: 'dispatch:A1', hard: false, status: 'cancel-pending' });
  assert.equal(commitments.hasConflict('a/O1', game.start, game.end), false);
  commitments.add('a/O1', { game: 'G2', role: 'plate',
    start: '2026-12-01T11:30+08:00', end: '2026-12-01T13:00+08:00',
    source: 'attendance:V9', hard: true, status: 'signed-out' });
  assert.equal(commitments.hasConflict('a/O1', game.start, game.end), true);
});

test('调任接收与释放任一方 pending 都不算承诺解除', () => {
  const delegations = new Delegations();
  delegations.load([{ ref: 'M1', old_game: 'G2', new_game: 'G1', identity: 'a/O1',
    receiving_decision: 'confirmed', releasing_decision: 'pending' }]);
  assert.equal(delegations.isFullyConfirmed('M1'), false);
  assert.deepEqual(delegations.pendingSide('M1'), ['releasing']);
  delegations.upsert({ ref: 'M1', old_game: 'G2', new_game: 'G1', identity: 'a/O1',
    receiving_decision: 'confirmed', releasing_decision: 'confirmed' });
  assert.equal(delegations.isFullyConfirmed('M1'), true);
});

test('同场同角色多张全场全额凭据被识别为重复补领', () => {
  const attendance = new AttendanceBook();
  const travel = new TravelBook();
  const roster = new Roster();
  const service = new SubsidyService({ rules: fees, attendance, travel,
    schedule: { require: () => game, get: () => game }, roster });
  const findings = service.detectDoubleFullPayment(game, [
    { ledger: 'P1', identity: 'a/O1', game: 'G9', from_time: game.start, to_time: game.end,
      fen: 18000, state: 'confirmed', role: 'plate' },
    { ledger: 'P2', identity: 'a/O2', game: 'G9', from_time: game.start, to_time: game.end,
      fen: 18000, state: 'confirmed', role: 'plate' },
  ]);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].ledgers, ['P1', 'P2']);
});
