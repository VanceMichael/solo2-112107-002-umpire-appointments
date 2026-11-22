// 替补派遣台账。
// 规则：
//  - 一个原派任务只允许一项生效替补（proposed / accept-pending 都算生效中）；
//  - 同一场次同一角色不得同时有两项已确认替补；
//  - 未确认的原派取消与替补接受只标待确认，不产生第二份全额补助占用；
//  - 被其他场次硬占用（时间冲突）的裁判不得作为替补。

import { DomainError } from './util.mjs';

export const SUB_STATES = ['proposed', 'accept-pending', 'accepted', 'rejected', 'withdrawn'];
const ACTIVE = new Set(['proposed', 'accept-pending']);

export class SubstitutionBook {
  constructor() {
    this._requests = new Map();
    this._byDispatch = new Map();
  }

  all() {
    return [...this._requests.values()].map((r) => ({ ...r }));
  }

  get(ref) {
    const row = this._requests.get(ref);
    return row ? { ...row } : undefined;
  }

  require(ref) {
    const row = this.get(ref);
    if (!row) throw new DomainError('unknown-substitution', `没有替补请求 ${ref}`, { ref });
    return row;
  }

  activeForDispatch(dispatchRef) {
    return (this._byDispatch.get(dispatchRef) ?? [])
      .map((ref) => this._requests.get(ref))
      .filter((row) => row && ACTIVE.has(row.state))
      .map((row) => ({ ...row }));
  }

  confirmedForGameRole(game, role) {
    return this.all().filter((r) => r.game === game && r.role === role && r.state === 'accepted');
  }

  // 值班员提出替补前的硬性门槛（资格与行程由 League 先算好，把依据传进来）。
  assertCanPropose({ ref, dispatchRef, game, role, substitute, conflictBlocks = [], gateResults = [] }) {
    const existingDispatch = this._byDispatch.get(dispatchRef) ?? [];
    const active = existingDispatch
      .map((r) => this._requests.get(r))
      .filter((row) => row && ACTIVE.has(row.state));
    if (active.length) {
      throw new DomainError('substitution-already-open',
        `原派 ${dispatchRef} 已有生效替补 ${active[0].ref}，一项原派只允许一项生效替补`,
        { dispatchRef, active: active[0].ref });
    }
    const alreadyConfirmed = this.confirmedForGameRole(game, role);
    if (alreadyConfirmed.length) {
      throw new DomainError('substitution-confirmed-twice',
        `${game}/${role} 已有确认替补 ${alreadyConfirmed[0].ref}，不得重复确认`,
        { game, role, existing: alreadyConfirmed[0].ref });
    }
    if (conflictBlocks.length) {
      throw new DomainError('substitute-time-conflict',
        `裁判 ${substitute} 在比赛时段已有硬占用：${conflictBlocks.map((b) => b.game).join('、')}`,
        { substitute, conflictBlocks });
    }
    for (const gate of gateResults) {
      if (!gate.ok) {
        throw new DomainError('substitution-gate-failed',
          `替补门槛未通过：${gate.reason ?? gate.code}`, gate);
      }
    }
  }

  recordProposed(entry) {
    if (this._requests.has(entry.ref)) {
      throw new DomainError('duplicate-substitution', `替补请求号 ${entry.ref} 已存在`, { ref: entry.ref });
    }
    const row = {
      state: 'proposed',
      portalKey: null,
      portalSourceRef: null,
      timeline: [{ at: entry.at, event: 'proposed', note: entry.reason }],
      ...entry,
    };
    this._requests.set(entry.ref, row);
    if (!this._byDispatch.has(entry.dispatchRef)) this._byDispatch.set(entry.dispatchRef, []);
    this._byDispatch.get(entry.dispatchRef).push(entry.ref);
    return { ...row };
  }

  markPortalSubmitted(ref, { portalKey, sourceRef, at }) {
    const row = this._requests.get(ref);
    if (!row) throw new DomainError('unknown-substitution', `没有替补请求 ${ref}`, { ref });
    row.portalKey = portalKey;
    row.portalSourceRef = sourceRef;
    row.state = 'accept-pending';
    row.timeline.push({ at, event: 'portal-submitted', note: `门户请求号 ${portalKey}` });
    return { ...row };
  }

  markAccepted(ref, at, note = '派遣端确认接受替补') {
    const row = this._requests.get(ref);
    if (!row) throw new DomainError('unknown-substitution', `没有替补请求 ${ref}`, { ref });
    if (row.state === 'rejected' || row.state === 'withdrawn') {
      throw new DomainError('substitution-closed', `替补 ${ref} 已终态（${row.state}），不能再接受`, { ref });
    }
    row.state = 'accepted';
    row.timeline.push({ at, event: 'accepted', note });
    return { ...row };
  }

  markRejected(ref, at, note) {
    const row = this._requests.get(ref);
    if (!row) throw new DomainError('unknown-substitution', `没有替补请求 ${ref}`, { ref });
    row.state = 'rejected';
    row.timeline.push({ at, event: 'rejected', note });
    return { ...row };
  }

  markWithdrawn(ref, at, note) {
    const row = this._requests.get(ref);
    if (!row) throw new DomainError('unknown-substitution', `没有替补请求 ${ref}`, { ref });
    row.state = 'withdrawn';
    row.timeline.push({ at, event: 'withdrawn', note });
    return { ...row };
  }
}
