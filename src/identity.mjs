// 裁判身份登记。
// 协会内别名通过登记的裁判号对应；身份键是“协会 + 裁判号”。
// 不同协会出现相同裁判号（如 n/O1 与 e/O1）是两个人，任何情况下不得合并。

import { DomainError } from './util.mjs';

const SEP = '/';
const aliasKey = (association, alias) => `${association}${SEP}${alias}`;

export const identityKey = (association, id) => `${association}${SEP}${id}`;

export function parseIdentity(key) {
  const [association, id] = key.split(SEP);
  return { association, id };
}

export class Roster {
  constructor() {
    this._alias = new Map();
    this._idsByAssociation = new Map();
  }

  load(rows = []) {
    for (const row of rows) this.add(row);
  }

  add({ association, alias, id }) {
    const key = aliasKey(association, alias);
    const previous = this._alias.get(key);
    if (previous && previous !== id) {
      throw new DomainError('roster-conflict',
        `别名 ${association}/${alias} 登记的裁判号由 ${previous} 变为 ${id}，需协会核对`,
        { association, alias, from: previous, to: id });
    }
    this._alias.set(key, id);
    if (!this._idsByAssociation.has(association)) {
      this._idsByAssociation.set(association, new Set());
    }
    this._idsByAssociation.get(association).add(id);
  }

  // 派遣页只给协会内别名，必须经名册换成裁判号身份。
  resolve(association, alias) {
    const id = this._alias.get(aliasKey(association, alias));
    if (!id) {
      throw new DomainError('unknown-alias',
        `名册中查不到 ${association} 协会的别名 ${alias}`,
        { association, alias });
    }
    return identityKey(association, id);
  }

  has(association, alias) {
    return this._alias.has(aliasKey(association, alias));
  }

  //  bare 裁判号（行程、场馆、证件、费用页使用）在多个协会同时出现时，
  //  返回全部候选身份，由调用方按场次上下文消歧，绝不自动合并。
  bareIdCandidates(id) {
    const candidates = [];
    for (const [association, ids] of this._idsByAssociation) {
      if (ids.has(id)) candidates.push(identityKey(association, id));
    }
    return candidates;
  }

  *identities() {
    for (const [association, ids] of this._idsByAssociation) {
      for (const id of ids) yield identityKey(association, id);
    }
  }
}
