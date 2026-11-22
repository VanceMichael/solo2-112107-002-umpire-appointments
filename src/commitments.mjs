// 执裁承诺占用：已接受/已确认的派遣与场馆实际签退都构成占用。
// 未确认的原派取消、待确认的替补不产生全额占用（只标记待确认）。

import { overlaps } from './util.mjs';

export const DISPATCH_STATES = {
  assigned: { confirmed: false, label: '已派遣未确认' },
  confirmed: { confirmed: true, label: '协会已确认' },
  'cancel-pending': { confirmed: false, label: '取消待确认' },
  cancelled: { confirmed: false, label: '已取消' },
};

export class Commitments {
  constructor() {
    // 身份键 -> 占用区间数组 { game, role, start, end, source, hard, status }
    this._byIdentity = new Map();
  }

  add(identity, block) {
    if (!this._byIdentity.has(identity)) this._byIdentity.set(identity, []);
    this._byIdentity.get(identity).push({ ...block });
  }

  forIdentity(identity) {
    return (this._byIdentity.get(identity) ?? []).map((b) => ({ ...b }));
  }

  // 硬占用：已确认派遣、已接受的替补、场馆实际执裁区间。
  hardBlocks(identity) {
    return this.forIdentity(identity).filter((b) => b.hard);
  }

  conflicting(identity, start, end) {
    return this.hardBlocks(identity)
      .filter((b) => overlaps(start, end, b.start, b.end))
      .map((b) => ({ ...b }));
  }

  hasConflict(identity, start, end) {
    return this.conflicting(identity, start, end).length > 0;
  }

  // 待确认事项不阻塞，但要让值班员看见，避免两位裁判报同一场全额补助。
  pendingForGame(identity, game) {
    return this.forIdentity(identity)
      .filter((b) => b.game === game && !b.hard)
      .map((b) => ({ ...b }));
  }
}
