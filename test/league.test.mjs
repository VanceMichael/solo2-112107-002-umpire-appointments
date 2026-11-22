import { test } from 'node:test';
import assert from 'node:assert/strict';
import { League } from '../src/league.mjs';
import { SourceClient } from '../src/source-client.mjs';
import { bundleFromWire, startSource, loadWire } from './helpers.mjs';

// 用离线报文构建三阶段联赛（interim 的 east-cert 按协议 503 不可用）。
function buildLeague() {
  const league = new League();
  league.loadBundle('opening', bundleFromWire('opening'));
  league.loadBundle('interim', bundleFromWire('interim', { unavailable: ['east-cert'] }));
  league.loadBundle('confirmed', bundleFromWire('confirmed'));
  return league;
}

test('名册按协会+裁判号定身份，跨协会同号不合并', () => {
  const league = buildLeague();
  // N-A 与 E-A 都登记为 O1，但属于不同协会，是两个人。
  assert.equal(league.roster.resolve('n', 'N-A'), 'n/O1');
  assert.equal(league.roster.resolve('e', 'E-A'), 'e/O1');
  assert.deepEqual(league.roster.bareIdCandidates('O1'), ['n/O1', 'e/O1']);

  // 行程页只有 bare O1 + 赛地 D，按赛地场次的派遣协会推断为 n/O1。
  const travelO1 = league.travel.forIdentity('n/O1');
  assert.equal(travelO1.length, 1);
  assert.equal(travelO1[0].town, 'D');
  assert.equal(league.travel.forIdentity('e/O1').length, 0);
});

test('派遣页挂名不等于到场：assigned 不构成硬占用，confirmed 才占用', () => {
  const league = buildLeague();
  const g2 = loadWire('confirmed', 'schedule').find((g) => g.game === 'G2');
  // A2 已确认 -> e/O3 在 G2 时段硬占用。
  assert.ok(league.commitments.hasConflict('e/O3', g2.start, g2.end));
  // A1 仅 assigned -> n/O1 的派遣块是软占用（hard=false），不阻塞他人，也不等于到场。
  const dispatchBlocks = league.commitments.forIdentity('n/O1')
    .filter((b) => b.source.startsWith('dispatch:'));
  assert.equal(dispatchBlocks.length, 1);
  assert.equal(dispatchBlocks[0].hard, false);
  // 赛后场馆签退另算硬事实，但不证明派遣页已确认。
  assert.ok(league.commitments.forIdentity('n/O1')
    .some((b) => b.source.startsWith('attendance:') && b.hard));
});

test('赛程提前后重新评估行程：n/O1 赶不上，e/O2 赶得上且无冲突', () => {
  const league = new League();
  league.loadBundle('opening', bundleFromWire('opening'));

  const before = league.travelFeasibility('n/O1', 'G1');
  assert.equal(before.canReport, false, '原 10:00 开赛，10:45 到达也赶不上');
  const o2Before = league.travelFeasibility('e/O2', 'G1');
  assert.equal(o2Before.canReport, true);

  league.loadBundle('interim', bundleFromWire('interim', { unavailable: ['east-cert'] }));
  const reschedule = league.schedule.wasRescheduled('G1');
  assert.equal(reschedule.movedEarlier, true);
  assert.equal(reschedule.to.start, '2026-12-01T09:50+08:00');

  // 改期后仍逐场重新判断，结论不变且改期依据被记录。
  const after = league.travelFeasibility('n/O1', 'G1');
  assert.equal(after.feasible, false);
  assert.match(after.arrivalReason, /10:45/);
});

test('证件只在注明赛制级别内适用，续证与吊销按开赛时点判定', () => {
  const league = buildLeague();
  const g1 = league.schedule.get('G1');

  // n/O1 证件 through 含开赛日 2026-12-01 -> 有效。
  const valid = league.qualification('n/O1', 'G1');
  assert.equal(valid.decision, 'valid');

  // 赛制不符 -> invalid。
  const wrongRules = league.certificates.evaluate('n/O1',
    { ...g1, game: 'GX', rules: 'baseball' });
  assert.equal(wrongRules.decision, 'invalid');
  assert.match(wrongRules.reasons[0], /不适用/);

  // 续证生效日晚于开赛日 -> 当天不能靠它生效，首张证仍覆盖开赛日。
  const rows = league.certificates.rowsFor('e/O2');
  assert.equal(rows.length, 2);
  const future = rows.find((r) => r.from_day === '2026-12-02');
  assert.ok(future);
  const lateRenewal = league.qualification('e/O2', 'G1');
  assert.equal(lateRenewal.decision, 'valid', '2026-11-20 起的首张证覆盖开赛日');

  // 吊销自赛地零时生效：revoked_day=开赛日当天即失效（用独立册页，避免污染上面的索引）。
  const archive = league.certificates;
  archive.loadVolume('test-cert', [{
    official: 'O9', level: 'district', rules: 'softball',
    from_day: '2026-01-01', through: '2027-12-31', revoked_day: '2026-12-01',
  }]);
  league.roster.add({ association: 't', alias: 'T-A', id: 'O9' });
  archive.volumeAssociations.t = 'test-cert';
  archive.loadIndex({ day: '2026-12-01', volumes: ['north-cert', 'east-cert', 'test-cert'] });
  const revoked = league.qualification('t/O9', 'G1');
  assert.equal(revoked.decision, 'invalid');
  assert.match(revoked.reasons[0], /吊销/);

  // 仅持“未来才生效”的续证、当前无有效证时，开赛时点判失效而非提前生效。
  const archive2 = new league.certificates.constructor({
    volumeAssociations: { x: 'future-only' },
  });
  archive2.loadIndex({ day: '2026-12-01', volumes: ['future-only'] });
  archive2.loadVolume('future-only', [{
    official: 'O8', level: 'district', rules: 'softball',
    from_day: '2026-12-02', through: '2027-01-31', revoked_day: null,
  }]);
  const notYet = archive2.evaluate('x/O8', g1);
  assert.equal(notYet.decision, 'invalid');
  assert.match(notYet.reasons[0], /续证生效日晚于开赛时点/);
});

test('缺少当日册页时逐身份指出哪些资格查不到', () => {
  const league = new League();
  league.loadBundle('opening', bundleFromWire('opening'));
  league.loadBundle('interim', bundleFromWire('interim', { unavailable: ['east-cert'] }));

  const backlog = league.qualificationBacklog('G1');
  const identities = backlog.map((b) => b.identity).sort();
  // 东协所有裁判（含无证件行的 e/O1）在 east-cert 不可查时都只能挂“查不到”，
  // 不能武断判 invalid。
  assert.deepEqual(identities, ['e/O1', 'e/O2', 'e/O3']);
  for (const item of backlog) {
    assert.equal(item.decision, 'unverifiable');
    assert.ok(item.missingVolumes.includes('east-cert'));
  }
  // 北协册页正常，n/O1 仍可判。
  assert.equal(league.qualification('n/O1', 'G1').decision, 'valid');

  // 缺整日本索引时也判查不到。
  const another = new League();
  another.roster.load(loadWire('opening', 'roster'));
  another.schedule.load(loadWire('opening', 'schedule'));
  another.certificates.loadVolume('north-cert', loadWire('opening', 'north-cert'));
  const result = another.qualification('n/O1', 'G1');
  assert.equal(result.decision, 'unverifiable');
  assert.equal(result.missingIndex, '2026-12-01');
});

test('interim 阶段因证件不可用与时间冲突，不能提出替补；confirmed 后依据齐全', () => {
  const league = new League();
  league.loadBundle('opening', bundleFromWire('opening'));
  league.loadBundle('interim', bundleFromWire('interim', { unavailable: ['east-cert'] }));

  const desk = league.substitutionDesk('G1');
  const o2 = desk.candidates.find((c) => c.identity === 'e/O2');
  assert.equal(o2.eligible, false);
  assert.equal(o2.gates.find((g) => g.code === 'qualification').ok, false);

  // 依据不足时硬门槛拒绝（资格查不到，不能凭挂名派替补）。
  assert.throws(() => league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2', reason: '测试',
  }), /不可查|资格|unverifiable/);

  // e/O3 已被 G2 硬占用（11:00–13:00 与 G1 重叠），且调任未完成。
  const o3 = desk.candidates.find((c) => c.identity === 'e/O3');
  assert.equal(o3.gates.find((g) => g.code === 'commitment').ok, false);
  assert.equal(o3.gates.find((g) => g.code === 'delegation').ok, false);

  league.loadBundle('confirmed', bundleFromWire('confirmed'));
  const desk2 = league.substitutionDesk('G1');
  const o2After = desk2.candidates.find((c) => c.identity === 'e/O2');
  assert.equal(o2After.eligible, true);
});

test('一个原派只允许一项生效替补，同场角色不得重复确认', () => {
  const league = buildLeague();
  const first = league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2', ref: 'SUB-1',
    reason: 'G1 提前，原派行程 10:45 才到',
  });
  assert.equal(first.state, 'proposed');
  assert.throws(() => league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O3', ref: 'SUB-2', reason: '再试一个',
  }), /已有生效替补/);

  league.markSubstitutionAccepted('SUB-1');
  // 终态后原派取消只标待确认。
  assert.equal(league.dispatch('A1').state, 'cancel-pending');
  assert.throws(() => league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O3', ref: 'SUB-3', reason: '已确认过',
  }), /已有确认替补|生效替补/);
});

test('被其他场次确认占用的裁判不能派到时间冲突的场', () => {
  const league = buildLeague();
  // e/O3 在 G2 已确认，G1 与 G2 时间窗重叠。
  assert.throws(() => league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O3', ref: 'SUB-X', reason: '冲突尝试',
  }), /硬占用|门槛/);
});

test('调任双方未全部确认前旧承诺继续占用，confirmed 后才可派发', () => {
  const league = new League();
  league.loadBundle('opening', bundleFromWire('opening'));
  league.loadBundle('interim', bundleFromWire('interim', { unavailable: ['east-cert'] }));

  const pending = league.delegationStatus('MOVE8');
  assert.equal(pending.fullyConfirmed, false);
  assert.deepEqual(pending.awaiting, ['releasing']);
  assert.equal(pending.dispatchable, false);
  assert.equal(pending.oldCommitmentReleased, false);

  league.loadBundle('confirmed', bundleFromWire('confirmed'));
  const done = league.delegationStatus('MOVE8');
  assert.equal(done.fullyConfirmed, true);
  assert.deepEqual(done.awaiting, []);
  // O3 行程只到 E 镇且无离开后再赴 D 镇的覆盖记录，转场交通仍不满足。
  assert.equal(done.transferCheck.ok, false);
});

test('赛后按场馆签退保留双方执裁区间，已确认凭据留原单并另列差额', () => {
  const league = buildLeague();
  league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2', ref: 'SUB-1',
    reason: 'G1 提前至 09:50，n/O1 10:45 才能到',
  });
  league.markSubstitutionAccepted('SUB-1');

  const dossier = league.subsidyDossier('G1');
  const adjudication = dossier.adjudication;

  // 两个执裁区间都保留：O1 前 65 分钟、O2 后 65 分钟。
  const duty = Object.fromEntries(adjudication.duty.map((d) => [d.identity, d]));
  assert.equal(duty['n/O1'].actualMinutes, 65);
  assert.equal(duty['e/O2'].actualMinutes, 65);
  assert.equal(duty['n/O1'].fen, 65 * 150);
  assert.equal(duty['e/O2'].fen, 65 * 150);

  // 已确认原单 PAY1 原样保留。
  const pay1 = adjudication.ledgerLines.find((l) => l.ledger === 'PAY1');
  assert.equal(pay1.state, 'confirmed');
  assert.equal(pay1.retained, true);
  assert.equal(pay1.fen, 19500);

  // 差额另列：PAY1 按全场 130 分钟计 19500，O2 签退仅支撑 65 分钟 = 9750。
  const adjustment = adjudication.adjustments.find((a) => a.againstLedger === 'PAY1');
  assert.equal(adjustment.originalFen, 19500);
  assert.equal(adjustment.supportedMinutes, 65);
  assert.equal(adjustment.adjustedFen, 9750);
  assert.equal(adjustment.deltaFen, -9750);
  assert.equal(adjustment.originalRetained, true);

  // 同场两区间首尾相接（10:55），不构成重叠，无需场馆复核。
  assert.equal(adjudication.venueReviews.length, 0);

  // 待确认事项包含原派取消待确认，且不会出现两人全场全额。
  assert.ok(adjudication.pending.some((p) => p.kind === 'cancel-pending'));
});

test('排裁判个人记录视图含资格、行程与承诺；补助档案说明为何联系替补及等待项', () => {
  const league = buildLeague();
  league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2', ref: 'SUB-1',
    reason: 'G1 提前至 09:50，n/O1 行程 10:45 到不了',
  });

  const record = league.personalRecord('e/O2');
  assert.equal(record.travel.length, 1);
  assert.ok(Array.isArray(record.commitments));

  const dossier = league.subsidyDossier('G1');
  assert.equal(dossier.substitutionReasons[0].reason,
    'G1 提前至 09:50，n/O1 行程 10:45 到不了');
  assert.ok(dossier.substitutionReasons[0].basis.reschedule.movedEarlier);
  // confirmed 阶段 east-cert 已发布，不再有缺册等待项。
  assert.equal(
    dossier.awaiting.filter((a) => a.kind === 'certificate-volume-missing').length, 0);
});

test('通过 HTTP 来源完成 ingest、门户 substitute 与 inspect 对账', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const client = new SourceClient({ baseUrl: base });
  const league = new League();

  await league.ingest(client, 'opening');
  await league.ingest(client, 'interim');
  // interim east-cert 协议 503 -> 资格查不到。
  assert.ok(league.qualificationBacklog('G1')
    .some((b) => b.missingVolumes.includes('east-cert')));

  await league.ingest(client, 'confirmed');
  const sub = league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2', ref: 'SUB-HTTP-1',
    reason: 'G1 提前，原派赶不上',
  });
  const submitted = await league.submitToPortal(client, 'confirmed', sub.ref, {
    key: 'http-sub-g1', facts: { triggeredBy: 'test' },
  });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.receipt.result, 'accepted');

  const reconciled = await league.reconcilePortal(client, 'confirmed', sub.ref);
  assert.equal(reconciled.found, true);
  assert.equal(reconciled.substitution.state, 'accepted');
  assert.equal(league.dispatch('A1').state, 'cancel-pending');

  // 同 key 同报文重放 -> 门户按原请求返回（duplicated），本地状态不被破坏。
  const replay = await league.submitToPortal(client, 'confirmed', sub.ref, {
    key: 'http-sub-g1', facts: { triggeredBy: 'test' },
  });
  assert.equal(replay.duplicated, true);
});

test('门户 503 时保留本地请求并可重试，inspect 404 显式挂待核对', async (t) => {
  const league = buildLeague();
  league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2', ref: 'SUB-DOWN', reason: '门户故障演练',
  });
  const flakyClient = {
    postPortal: async () => ({ status: 503, ok: false, duplicated: false, body: null }),
  };
  const attempt = await league.submitToPortal(flakyClient, 'interim', 'SUB-DOWN', {
    key: 'down-key', facts: {},
  });
  assert.equal(attempt.submitted, false);
  assert.equal(league.substitutions.get('SUB-DOWN').state, 'proposed');
  assert.ok(league.pendingChecks.some((c) => c.kind === 'portal-retry'));

  const missingClient = {
    postPortal: async () => ({ status: 404, ok: false, duplicated: false, body: null }),
  };
  // 手动登记已提交后才能 inspect；404 不抛致命错误。
  league.substitutions.markPortalSubmitted('SUB-DOWN', {
    portalKey: 'down-key', sourceRef: 'interim-1', at: new Date().toISOString(),
  });
  const inspect = await league.reconcilePortal(missingClient, 'interim', 'SUB-DOWN');
  assert.equal(inspect.found, false);
  assert.ok(league.pendingChecks.some((c) => c.kind === 'portal-receipt-missing'));
});
