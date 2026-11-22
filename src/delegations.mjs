// 跨场调任（协会间委派）：接收与释放双方都 confirmed，旧任职承诺才算解除。
// 任一方 pending 期间，旧场仍视为占用，新场不得据此派发。

export class Delegations {
  constructor() {
    this._byRef = new Map();
  }

  load(rows = []) {
    for (const row of rows) this.upsert(row);
  }

  upsert(row) {
    this._byRef.set(row.ref, { ...row });
  }

  get(ref) {
    const row = this._byRef.get(ref);
    return row ? { ...row } : undefined;
  }

  all() {
    return [...this._byRef.values()].map((r) => ({ ...r }));
  }

  // 调任是否已被双方确认；旧承诺仅在此处为 true 时才允许解除。
  isFullyConfirmed(ref) {
    const row = this._byRef.get(ref);
    return Boolean(row) &&
      row.receiving_decision === 'confirmed' &&
      row.releasing_decision === 'confirmed';
  }

  pendingSide(ref) {
    const row = this._byRef.get(ref);
    if (!row) return ['receiving', 'releasing'];
    const pending = [];
    if (row.receiving_decision !== 'confirmed') pending.push('receiving');
    if (row.releasing_decision !== 'confirmed') pending.push('releasing');
    return pending;
  }

  forIdentity(identity) {
    return this.all().filter((r) => r.identity === identity);
  }
}
