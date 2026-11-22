// 联赛执裁编排引擎：把协会派遣、名册、证件分册、行程确认、
// 场馆签退、跨场调任、替补与补助裁决接成一套可追溯的领域模型。

import { Roster, identityKey, parseIdentity } from './identity.mjs';
import { CertificateArchive } from './certificates.mjs';
import { Schedule } from './schedule.mjs';
import { TravelBook } from './travel.mjs';
import { Commitments } from './commitments.mjs';
import { AttendanceBook } from './attendance.mjs';
import { Delegations } from './delegations.mjs';
import { SubstitutionBook } from './substitutions.mjs';
import { SubsidyRules, SubsidyService } from './subsidy.mjs';
import { DomainError, localDay, unique } from './util.mjs';

const RESOURCES = ['schedule', 'dispatch', 'roster', 'license-index', 'travel',
  'attendance', 'expense', 'fees', 'delegations'];
const CERT_VOLUMES = ['north-cert', 'east-cert', 'south-cert', 'west-cert'];

export class League {
  constructor(options = {}) {
    this.roster = new Roster();
    this.certificates = new CertificateArchive(options.archive ?? {});
    this.schedule = new Schedule();
    this.travel = new TravelBook();
    this.attendance = new AttendanceBook();
    this.delegations = new Delegations();
    this.substitutions = new SubstitutionBook();
    this.commitments = new Commitments();
    this.phases = [];
    this.timeline = [];
    this.pendingChecks = [];
    this._dispatch = new Map();
    this._ledger = [];
    this._fees = null;
    this._subCounter = 0;
  }

  _log(event, payload) {
    this.timeline.push({ at: new Date().toISOString(), event, ...payload });
  }

  _addPending(check) {
    const signature = JSON.stringify(check);
    if (!this.pendingChecks.some((c) => JSON.stringify(c) === signature)) {
      this.pendingChecks.push(check);
    }
  }

  // ---- 身份消歧 -------------------------------------------------------

  // bare 裁判号 -> 唯一身份。跨协会同号（n/O1 与 e/O1）绝不自动合并，
  // 必须借助协会上下文；无法消歧时显式挂待核对。
  resolveBareId(id, context = {}) {
    const candidates = this.roster.bareIdCandidates(id);
    if (candidates.length === 1) return { identity: candidates[0], ambiguous: false };
    if (context.association) {
      const exact = identityKey(context.association, id);
      if (candidates.includes(exact)) return { identity: exact, ambiguous: false };
    }
    if (context.game) {
      const gameAssociations = unique([...this._dispatch.values()]
        .filter((d) => d.game === context.game)
        .map((d) => d.association));
      const inContext = candidates.filter((identity) =>
        gameAssociations.includes(parseIdentity(identity).association));
      if (inContext.length === 1) return { identity: inContext[0], ambiguous: false };
      if (inContext.length > 1) {
        this._addPending({ kind: 'identity-ambiguous', source: context.source ?? 'record',
          id, game: context.game, candidates: inContext,
          note: '同裁判号在多个协会出现，需按登记裁判号与协会核对，禁止按同名合并' });
        return { identity: null, ambiguous: true, candidates: inContext };
      }
    }
    // 行程页只给赛地：用“赛地 -> 场次 -> 派遣协会”推断，仍不自动合并同号。
    if (context.town) {
      const gamesInTown = this.schedule.all()
        .filter((g) => g.town === context.town).map((g) => g.game);
      const townAssociations = unique([...this._dispatch.values()]
        .filter((d) => gamesInTown.includes(d.game))
        .map((d) => d.association));
      const inTown = candidates.filter((identity) =>
        townAssociations.includes(parseIdentity(identity).association));
      if (inTown.length === 1) return { identity: inTown[0], ambiguous: false };
      if (inTown.length > 1) {
        this._addPending({ kind: 'identity-ambiguous', source: context.source ?? 'record',
          id, town: context.town, candidates: inTown,
          note: '赛地内同裁判号分属多协会，需协会核对，禁止按同名合并' });
        return { identity: null, ambiguous: true, candidates: inTown };
      }
    }
    this._addPending({ kind: 'identity-ambiguous', source: context.source ?? 'record',
      id, game: context.game ?? null, candidates,
      note: '无法确定该裁判号所属协会，需协会核对' });
    return { identity: null, ambiguous: true, candidates };
  }

  // ---- 批次装载 -------------------------------------------------------

  async ingest(client, phase) {
    const pages = {};
    await Promise.all(RESOURCES.map(async (resource) => {
      pages[resource] = await client.fetchPage(phase, resource);
    }));
    for (const volume of CERT_VOLUMES) {
      pages[volume] = await client.fetchPage(phase, volume);
    }
    this.loadBundle(phase, pages);
    return pages;
  }

  // 直接吃入一个阶段的页面集合（值同 SourceClient.fetchPage 的返回，也可传裸数组）。
  loadBundle(phase, pages) {
    if (!this.phases.includes(phase)) this.phases.push(phase);
    const data = (name) => {
      const page = pages[name];
      if (page === undefined) return undefined;
      return page && Object.hasOwn(page, 'data') ? page.data : page;
    };
    const pageState = (name) =>
      (pages[name] && Object.hasOwn(pages[name], 'available')) ? pages[name] : null;

    this.roster.load(data('roster') ?? []);
    this.schedule.load(data('schedule') ?? [], phase);

    const indexPage = data('license-index');
    if (indexPage) this.certificates.loadIndex(indexPage);

    // 证件分册：每批次按当日索引重建“当前可查”状态。
    // 未发布或暂不可用不装载，资格判定处会指出缺哪一册；
    // 即使历史批次曾装载过，本批次缺页也撤回可查标记，不能拿旧册页当现依据。
    this._missingCertVolumes = [];
    this.pendingChecks = this.pendingChecks.filter((c) => c.kind !== 'certificate-volume-missing');
    if (indexPage) {
      for (const volume of indexPage.volumes ?? []) {
        const state = pageState(volume);
        const availableHere = state ? state.available === true : data(volume) !== undefined;
        if (availableHere) {
          const rows = data(volume);
          this.certificates.loadVolume(volume, Array.isArray(rows) ? rows : rows.data ?? []);
        } else {
          this.certificates.markVolumeUnavailable(volume);
          const reason = state?.reason === 'unavailable' ? '发布方暂不可用' : '页尚未发布';
          this._missingCertVolumes.push({ volume, day: indexPage.day,
            reason: state?.reason ?? 'not-published', status: state?.status ?? null });
          this._addPending({ kind: 'certificate-volume-missing', volume, day: indexPage.day, reason });
        }
      }
    }

    this._loadDispatch(data('dispatch') ?? []);
    this._loadAttendance(data('attendance') ?? []);
    this._loadTravel(data('travel') ?? []);
    this._loadDelegations(data('delegations') ?? []);
    this._loadExpense(data('expense') ?? []);
    if (data('fees')) this._fees = new SubsidyRules(data('fees'));

    this._rebuildCommitments();
    this._refreshDelegationChecks();
    this._log('bundle-loaded', { phase });
  }

  _loadDispatch(rows) {
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.ref);
      if (!this.roster.has(row.association, row.official)) {
        this._addPending({ kind: 'unknown-alias', dispatchRef: row.ref,
          association: row.association, alias: row.official });
        continue;
      }
      const identity = this.roster.resolve(row.association, row.official);
      const previous = this._dispatch.get(row.ref);
      const next = { ref: row.ref, game: row.game, association: row.association,
        alias: row.official, identity, state: row.state };
      this._dispatch.set(row.ref, next);
      if (previous && previous.state !== next.state) {
        this._log('dispatch-state-changed', { ref: row.ref, from: previous.state, to: next.state });
      }
    }
    // 本批次未列出的派遣不删除（派遣页到赛后才改人，历史要留痕）。
  }

  dispatches() {
    return [...this._dispatch.values()].map((d) => ({ ...d }));
  }

  dispatch(ref) {
    const row = this._dispatch.get(ref);
    return row ? { ...row } : undefined;
  }

  _loadAttendance(rows) {
    for (const row of rows) {
      const { identity } = this.resolveBareId(row.official,
        { game: row.game, source: `attendance:${row.fact}` });
      if (!identity) continue;
      this.attendance.add({
        fact: row.fact, game: row.game, role: row.role, identity,
        from_time: row.from_time, to_time: row.to_time,
      });
    }
  }

  _loadTravel(rows) {
    this.travel = new TravelBook();
    for (const row of rows) {
      if (row.state !== 'confirmed') continue;
      const { identity } = this.resolveBareId(row.official,
        { town: row.town, source: `travel:${row.arrive}` });
      if (!identity) continue;
      this.travel.add({
        identity, town: row.town, arrive: row.arrive,
        leave: row.leave ?? null, state: row.state,
      });
    }
  }

  _loadDelegations(rows) {
    for (const row of rows) {
      const { identity } = this.resolveBareId(row.official,
        { game: row.new_game, source: `delegation:${row.ref}` });
      if (!identity) continue;
      this.delegations.upsert({ ...row, identity });
    }
  }

  _loadExpense(rows) {
    const ledger = [];
    for (const row of rows) {
      const { identity } = this.resolveBareId(row.official,
        { game: row.game, source: `expense:${row.ledger}` });
      if (!identity) continue;
      ledger.push({ ...row, identity });
    }
    this._ledger = ledger;
  }

  // ---- 占用重建 -------------------------------------------------------

  _rebuildCommitments() {
    this.commitments = new Commitments();
    for (const d of this._dispatch.values()) {
      if (d.state === 'cancelled') continue;
      const game = this.schedule.get(d.game);
      if (!game) continue;
      const hard = d.state === 'confirmed';
      this.commitments.add(d.identity, {
        game: d.game, role: game.role, start: game.start, end: game.end,
        source: `dispatch:${d.ref}`, hard, status: d.state,
      });
    }
    for (const sub of this.substitutions.all()) {
      if (sub.state !== 'accepted') continue;
      const game = this.schedule.get(sub.game);
      if (!game) continue;
      this.commitments.add(sub.substitute, {
        game: sub.game, role: sub.role, start: game.start, end: game.end,
        source: `substitution:${sub.ref}`, hard: true, status: 'accepted',
      });
    }
    for (const fact of this.attendance.all()) {
      this.commitments.add(fact.identity, {
        game: fact.game, role: fact.role, start: fact.from_time, end: fact.to_time,
        source: `attendance:${fact.fact}`, hard: true, status: 'signed-out',
      });
    }
  }

  _refreshDelegationChecks() {
    this.pendingChecks = this.pendingChecks.filter((c) => c.kind !== 'delegation-pending');
    for (const delegation of this.delegations.all()) {
      if (!this.delegations.isFullyConfirmed(delegation.ref)) {
        this._addPending({ kind: 'delegation-pending', ref: delegation.ref,
          identity: delegation.identity, oldGame: delegation.old_game,
          newGame: delegation.new_game,
          awaiting: this.delegations.pendingSide(delegation.ref),
          note: '接收与释放决定未全部 confirmed 前，旧承诺继续占用，新场不得派发' });
      }
    }
  }

  // ---- 资格与行程依据 -------------------------------------------------

  qualification(identity, gameRef) {
    const game = this.schedule.require(gameRef);
    return this.certificates.evaluate(identity, game);
  }

  // 汇总“还查不到”的资格（缺当日册页/索引时，逐身份列出）。
  qualificationBacklog(gameRef) {
    const game = this.schedule.require(gameRef);
    const day = localDay(game.start);
    const backlog = [];
    for (const identity of this.roster.identities()) {
      const result = this.certificates.evaluate(identity, game);
      if (result.decision === 'unverifiable') {
        backlog.push({ identity, game: gameRef, day, ...result });
      }
    }
    return backlog;
  }

  travelFeasibility(identity, gameRef) {
    const game = this.schedule.require(gameRef);
    const arrival = this.travel.canReport(identity, game.town, game.start);
    const conflicts = this.commitments.conflicting(identity, game.start, game.end);
    return {
      identity, game: gameRef,
      canReport: arrival.ok,
      travel: arrival.travel,
      arrivalReason: arrival.reason,
      conflictingCommitments: conflicts,
      feasible: arrival.ok && conflicts.length === 0,
    };
  }

  // 替补候选综合门槛：资格 valid + 行程可到 + 无硬占用冲突 + 调任未完成拦截。
  // 注意：该候选在“目标场本身”的赛后签退是替补上场的既成事实，不是另一场的承诺冲突。
  evaluateCandidate(identity, gameRef) {
    const game = this.schedule.require(gameRef);
    const qualification = this.qualification(identity, gameRef);
    const travel = this.travelFeasibility(identity, gameRef);
    const externalConflicts = travel.conflictingCommitments
      .filter((block) => block.game !== gameRef);
    const delegationBlockers = this.delegations.forIdentity(identity)
      .filter((d) => d.new_game === gameRef && !this.delegations.isFullyConfirmed(d.ref))
      .map((d) => ({ ref: d.ref, awaiting: this.delegations.pendingSide(d.ref) }));
    const gates = [
      { code: 'qualification', ok: qualification.decision === 'valid',
        reason: qualification.decision === 'valid' ? '' : qualification.reasons.join('；') },
      { code: 'travel', ok: travel.canReport, reason: travel.arrivalReason },
      { code: 'commitment', ok: externalConflicts.length === 0,
        reason: externalConflicts.length
          ? `与其他场次已确认执裁承诺冲突：${unique(externalConflicts.map((b) => b.game)).join('、')}` : '' },
      { code: 'delegation', ok: delegationBlockers.length === 0,
        reason: delegationBlockers.length
          ? `跨场调任待确认：${delegationBlockers.map((b) => `${b.ref} 待 ${b.awaiting.join('、')}`).join('；')}` : '' },
    ];
    return {
      identity, game: gameRef,
      eligible: gates.every((g) => g.ok),
      gates,
      qualification,
      travel: { ...travel, conflictingCommitments: externalConflicts },
      delegationBlockers,
    };
  }

  // ---- 替补提出与门户对接 ---------------------------------------------

  proposeSubstitution({ dispatchRef, substitute, reason, at = new Date().toISOString(), ref }) {
    const dispatch = this.dispatch(dispatchRef);
    if (!dispatch) throw new DomainError('unknown-dispatch', `没有派遣 ${dispatchRef}`, { dispatchRef });
    const game = this.schedule.require(dispatch.game);
    const candidate = this.evaluateCandidate(substitute, game.game);
    // 硬占用只看其他场次；目标场本身的赛后签退是替补要上场的既成事实。
    const conflicts = this.commitments
      .conflicting(substitute, game.start, game.end)
      .filter((block) => block.game !== game.game);
    this.substitutions.assertCanPropose({
      ref: ref ?? `SUB-${String(++this._subCounter).padStart(2, '0')}`,
      dispatchRef, game: game.game, role: game.role, substitute,
      conflictBlocks: conflicts,
      gateResults: candidate.gates,
    });
    const subRef = ref ?? `SUB-${String(this._subCounter).padStart(2, '0')}`;
    const record = this.substitutions.recordProposed({
      ref: subRef, dispatchRef, game: game.game, role: game.role,
      original: dispatch.identity, substitute, reason, at,
      basis: {
        qualification: { decision: candidate.qualification.decision, volume: candidate.qualification.matched?.volume ?? null },
        travel: candidate.travel.travel ? { ...candidate.travel.travel } : null,
        reschedule: this.schedule.wasRescheduled(game.game),
      },
    });
    this._log('substitution-proposed', { ref: subRef, dispatchRef, substitute, reason });
    return record;
  }

  // 向派遣端门户提交 substitute；503 保留本地 proposed，可凭 key 重试。
  async submitToPortal(client, phase, subRef, { key, facts, at = new Date().toISOString() }) {
    const sub = this.substitutions.require(subRef);
    const payload = { action: 'substitute', key,
      facts: { dispatchRef: sub.dispatchRef, game: sub.game, role: sub.role,
        substitute: sub.substitute, ...facts } };
    const receipt = await client.postPortal(phase, payload);
    if (receipt.status >= 500) {
      this._addPending({ kind: 'portal-retry', substitutionRef: subRef, key,
        note: '门户暂未回传回执，本地请求保留，可用同 key 重试' });
      return { submitted: false, status: receipt.status, substitution: sub };
    }
    if (receipt.status === 409) {
      throw new DomainError('portal-key-conflict', '门户请求号已对应其他报文', { key });
    }
    if (!receipt.ok) {
      throw new DomainError('portal-rejected', '门户拒绝替补请求', { receipt });
    }
    const updated = this.substitutions.markPortalSubmitted(subRef, {
      portalKey: key, sourceRef: receipt.body?.sourceRef ?? null, at,
    });
    this._log('substitution-portal-submitted', { ref: subRef, key, sourceRef: updated.portalSourceRef, duplicated: receipt.duplicated });
    return { submitted: true, duplicated: receipt.duplicated, receipt: receipt.body, substitution: updated };
  }

  // 用 inspect 回执对齐门户状态。
  async reconcilePortal(client, phase, subRef, { at = new Date().toISOString() } = {}) {
    const sub = this.substitutions.require(subRef);
    if (!sub.portalKey) {
      throw new DomainError('portal-not-submitted', `替补 ${subRef} 尚未提交门户`, { ref: subRef });
    }
    const receipt = await client.postPortal(phase, {
      action: 'inspect', key: sub.portalKey,
    });
    if (receipt.status === 404) {
      this._addPending({ kind: 'portal-receipt-missing', substitutionRef: subRef, key: sub.portalKey });
      return { found: false, substitution: this.substitutions.get(subRef) };
    }
    if (!receipt.ok) {
      throw new DomainError('portal-inspect-failed', '查询门户回执失败', { receipt });
    }
    let updated = this.substitutions.get(subRef);
    if (receipt.body?.result === 'accepted' && updated.state !== 'accepted') {
      updated = this.substitutions.markAccepted(subRef, at,
        `门户回执 ${sub.portalKey} 确认 accepted（sourceRef ${receipt.body.sourceRef ?? '?'}）`);
      this._applyOriginalCancellation(subRef, at);
      this._rebuildCommitments();
    }
    return { found: true, receipt: receipt.body, substitution: updated };
  }

  // 原派取消只标“待确认”，不立刻产生第二份全额占用。
  _applyOriginalCancellation(subRef, at) {
    const sub = this.substitutions.require(subRef);
    const dispatch = this._dispatch.get(sub.dispatchRef);
    if (dispatch && dispatch.state !== 'cancelled') {
      dispatch.state = 'cancel-pending';
      this._log('dispatch-cancel-pending', { ref: dispatch.ref, substitutionRef: subRef });
      this._addPending({ kind: 'cancel-confirmation', dispatchRef: dispatch.ref,
        association: dispatch.association, note: '原派取消待协会确认，双方都不得报全场全额' });
      this._rebuildCommitments();
    }
  }

  // 门户确认接受后也可由本地显式登记（离线/演练场景）。
  markSubstitutionAccepted(subRef, at = new Date().toISOString()) {
    const updated = this.substitutions.markAccepted(subRef, at);
    this._applyOriginalCancellation(subRef, at);
    this._rebuildCommitments();
    return updated;
  }

  // ---- 调任 -----------------------------------------------------------

  // 主办方确认跨场调任的可派发判断：下一场只有在前一承诺也确认解除时才可派发。
  delegationStatus(ref) {
    const delegation = this.delegations.get(ref);
    if (!delegation) throw new DomainError('unknown-delegation', `没有调任 ${ref}`, { ref });
    const fullyConfirmed = this.delegations.isFullyConfirmed(ref);
    const oldGame = this.schedule.get(delegation.old_game);
    const newGame = this.schedule.get(delegation.new_game);
    const transferCheck = oldGame && newGame
      ? this.travel.canCoverTransfer({
        identity: delegation.identity,
        firstGame: oldGame, secondGame: newGame,
        firstDutyEnd: this.attendance.forGame(delegation.old_game)
          .filter((f) => f.identity === delegation.identity)
          .map((f) => f.to_time).sort().at(-1) ?? null,
      })
      : { ok: false, reasons: ['赛程缺少调任场次'] };
    return {
      ...delegation,
      fullyConfirmed,
      awaiting: this.delegations.pendingSide(ref),
      oldCommitmentReleased: fullyConfirmed,
      dispatchable: fullyConfirmed && transferCheck.ok,
      transferCheck,
    };
  }

  // ---- 视图：排裁判的人 -----------------------------------------------

  // 个人记录：资格、行程、已承诺场次、待确认事项。
  personalRecord(identity) {
    const blocks = this.commitments.forIdentity(identity);
    return {
      identity,
      commitments: blocks,
      hardConflicts: blocks.filter((b) => b.hard),
      travel: this.travel.forIdentity(identity),
      delegations: this.delegations.forIdentity(identity)
        .map((d) => this.delegationStatus(d.ref)),
      substitutions: this.substitutions.all()
        .filter((s) => s.original === identity || s.substitute === identity),
      attendance: this.attendance.forIdentity(identity),
    };
  }

  // 排裁判视角：某场有哪些可派替补及各自门槛依据。
  substitutionDesk(gameRef) {
    const game = this.schedule.require(gameRef);
    const reschedule = this.schedule.wasRescheduled(gameRef);
    const candidates = [];
    for (const identity of this.roster.identities()) {
      candidates.push(this.evaluateCandidate(identity, gameRef));
    }
    const openRequests = this.substitutions.all().filter((s) => s.game === gameRef);
    return {
      game: gameRef,
      schedule: game,
      reschedule,
      eligibilityBacklog: this.qualificationBacklog(gameRef),
      candidates: candidates.map((c) => ({
        identity: c.identity,
        eligible: c.eligible,
        gates: c.gates,
        travel: c.travel,
      })),
      openRequests,
      pendingChecks: this.pendingChecks.filter((c) =>
        c.game === gameRef || c.newGame === gameRef || c.oldGame === gameRef),
    };
  }

  // ---- 视图：结补助的人 -----------------------------------------------

  subsidyService() {
    if (!this._fees) throw new DomainError('fees-missing', '尚未载入费用规则 fees');
    return new SubsidyService({
      rules: this._fees, attendance: this.attendance, travel: this.travel,
      schedule: this.schedule, roster: this.roster,
    });
  }

  gameView(gameRef) {
    const game = this.schedule.require(gameRef);
    const service = this._fees ? this.subsidyService() : null;
    const assignments = this.dispatches()
      .filter((d) => d.game === gameRef)
      .map((d) => {
        const sub = this.substitutions.all().find((s) =>
          s.dispatchRef === d.ref && ['accept-pending', 'accepted'].includes(s.state));
        return {
          identity: d.identity, dispatchRef: d.ref, dispatchState: d.state,
          role: game.role, substitutionRef: sub?.ref ?? null,
          accepted: sub?.state === 'accepted',
        };
      });
    for (const sub of this.substitutions.all().filter((s) =>
      s.game === gameRef && s.state === 'accepted')) {
      if (!assignments.some((a) => a.identity === sub.substitute)) {
        assignments.push({ identity: sub.substitute, dispatchRef: sub.dispatchRef,
          dispatchState: 'substituted', role: sub.role,
          substitutionRef: sub.ref, accepted: true });
      }
    }

    const ledger = this._ledger.filter((l) => l.game === gameRef);
    const overlaps = this.attendance.overlapsForGame(gameRef);
    const adjudication = service
      ? service.adjudicateGame(game, { assignments, ledger, overlaps })
      : null;
    if (service) {
      for (const finding of service.detectDoubleFullPayment(game, ledger)) {
        adjudication.venueReviews.push({ ...finding });
      }
    }

    const delegationChecks = this.delegations.all()
      .filter((d) => d.old_game === gameRef || d.new_game === gameRef)
      .map((d) => this.delegationStatus(d.ref));

    return {
      game: gameRef,
      schedule: game,
      revisions: this.schedule.revisions(gameRef),
      dispatchPage: this.dispatches().filter((d) => d.game === gameRef),
      attendance: this.attendance.forGame(gameRef),
      overlapReviews: overlaps,
      substitutions: this.substitutions.all().filter((s) => s.game === gameRef)
        .map((s) => ({
          ref: s.ref, state: s.state, original: s.original, substitute: s.substitute,
          reason: s.reason, basis: s.basis, timeline: s.timeline,
          portalKey: s.portalKey, portalSourceRef: s.portalSourceRef,
        })),
      delegationChecks,
      adjudication,
      pendingChecks: this.pendingChecks.filter((c) =>
        c.game === gameRef || c.newGame === gameRef || c.oldGame === gameRef),
    };
  }

  // 补助视角关心的“为什么联系替补、还等谁核对”。
  subsidyDossier(gameRef) {
    const view = this.gameView(gameRef);
    return {
      game: gameRef,
      actualDuty: view.attendance.map((f) => ({
        fact: f.fact, identity: f.identity, role: f.role,
        from: f.from_time, to: f.to_time,
      })),
      substitutionReasons: view.substitutions.map((s) => ({
        ref: s.ref, state: s.state, reason: s.reason, basis: s.basis, timeline: s.timeline,
      })),
      awaiting: unique([
        ...view.pendingChecks.map((c) => JSON.stringify(c)),
        ...view.overlapReviews.map((c) => JSON.stringify({ kind: 'venue-overlap', ...c })),
        ...view.delegationChecks.filter((d) => !d.fullyConfirmed)
          .map((d) => JSON.stringify({ kind: 'delegation-pending', ref: d.ref, awaiting: d.awaiting })),
        ...(view.adjudication?.pending ?? []).map((c) => JSON.stringify(c)),
        ...(view.adjudication?.adjustments ?? []).map((c) =>
          JSON.stringify({ kind: 'ledger-adjustment', againstLedger: c.againstLedger, status: c.status })),
      ]).map((text) => JSON.parse(text)),
      adjudication: view.adjudication,
    };
  }
}
