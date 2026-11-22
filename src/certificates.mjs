// 执裁证档案：分册发布与资格判定。
// 证件只在注明的赛制和级别内适用；through 含当日，revoked_day 自赛地零时起生效，
// 续证 from_day 自当日零时生效。分册按赛地日历的“当日册页”索引发布；
// 缺当日册页或缺证件所在册页时，资格只能判为查不到，并列出缺什么。
// 注意：某批次 503/404 时，即使历史批次曾装载过该册页，本批次也视为不可查，
// 不能拿旧册页充当当前依据。

import { dayCompare, localDay, unique } from './util.mjs';
import { parseIdentity } from './identity.mjs';

// 级别由低到高；持有的级别覆盖自身及以下级别。
export const DEFAULT_LEVEL_ORDER = ['county', 'district', 'city', 'provincial', 'national'];

export class CertificateArchive {
  constructor({ volumeAssociations = {}, levelOrder = DEFAULT_LEVEL_ORDER } = {}) {
    this.volumeAssociations = { ...volumeAssociations };
    this.levelOrder = levelOrder;
    // 册页名 -> { rows: 全部曾装载记录, published: 当前批次是否可查 }
    this._volumes = new Map();
    // 赛地日历日 -> 当日索引声明的册页名集合（按最新批次刷新）
    this._indexByDay = new Map();
  }

  loadIndex(index) {
    if (!index) return;
    this._indexByDay.set(index.day, unique(index.volumes ?? []));
  }

  // 装载一个可查册页；published 标记该册页在当前批次可作为判定依据。
  // 同册页跨批次重复装载时按内容去重，避免重复累计证件行。
  loadVolume(volume, rows = [], { published = true } = {}) {
    if (!this._volumes.has(volume)) this._volumes.set(volume, { rows: [], published: false });
    const entry = this._volumes.get(volume);
    for (const row of rows) {
      const signature = JSON.stringify(row);
      if (!entry.rows.some((existing) => {
        const { volume: _volume, ...rest } = existing;
        return JSON.stringify(rest) === signature;
      })) {
        entry.rows.push({ ...row, volume });
      }
    }
    entry.published = published;
  }

  // 某批次该册页不可查（503/404）：保留历史记录但撤回当前可查标记。
  markVolumeUnavailable(volume) {
    if (!this._volumes.has(volume)) this._volumes.set(volume, { rows: [], published: false });
    this._volumes.get(volume).published = false;
  }

  indexFor(day) {
    return this._indexByDay.get(day);
  }

  isVolumePublished(volume) {
    return this._volumes.get(volume)?.published === true;
  }

  // 协会 -> 证件册页名。登记映射优先，否则约定 north-cert 对应 n、east-cert 对应 e。
  volumesForAssociation(association) {
    if (this.volumeAssociations[association]) return [this.volumeAssociations[association]];
    const compass = { n: 'north-cert', s: 'south-cert', e: 'east-cert', w: 'west-cert' };
    return compass[association] ? [compass[association]] : [];
  }

  // 只读取当前可查册页中的证件记录。
  rowsFor(identity) {
    const { association, id } = parseIdentity(identity);
    const result = [];
    for (const volume of this.volumesForAssociation(association)) {
      const entry = this._volumes.get(volume);
      if (!entry || !entry.published) continue;
      for (const row of entry.rows) if (row.official === id) result.push(row);
    }
    return result;
  }

  _coversLevel(held, required) {
    const heldRank = this.levelOrder.indexOf(held);
    const requiredRank = this.levelOrder.indexOf(required);
    if (heldRank === -1 || requiredRank === -1) return held === required;
    return heldRank >= requiredRank;
  }

  // 单条证件记录在开赛时点的状态。
  _rowState(row, startAt) {
    const gameDay = localDay(startAt);
    if (row.revoked_day && dayCompare(row.revoked_day, gameDay) <= 0) return 'revoked';
    if (dayCompare(row.from_day, gameDay) > 0) return 'not-yet-effective';
    if (dayCompare(gameDay, row.through) > 0) return 'expired';
    return 'active';
  }

  // 判定某个身份对某场比赛的执裁资格。
  // 返回 { decision: 'valid'|'invalid'|'unverifiable', identity, game, matched, reasons, missingVolumes, missingIndex }
  evaluate(identity, game) {
    const day = localDay(game.start);
    const base = { identity, game: game.game, day };
    const { association } = parseIdentity(identity);

    const indexVolumes = this.indexFor(day);
    if (!indexVolumes) {
      return { ...base, decision: 'unverifiable', matched: null,
        reasons: [`缺少 ${day} 当日证件索引，无法确定应查的册页`],
        missingIndex: day, missingVolumes: [] };
    }

    const requiredVolumes = this.volumesForAssociation(association);
    const missingVolumes = requiredVolumes
      .filter((volume) => indexVolumes.includes(volume) && !this.isVolumePublished(volume));
    const notDeclared = requiredVolumes.filter((v) => !indexVolumes.includes(v));

    if (missingVolumes.length) {
      return { ...base, decision: 'unverifiable', matched: null,
        reasons: missingVolumes.map((v) => `当日索引声明的册页 ${v} 当前不可查（未发布或暂不可用）`),
        missingIndex: null, missingVolumes };
    }
    if (notDeclared.length) {
      return { ...base, decision: 'unverifiable', matched: null,
        reasons: notDeclared.map((v) => `${association} 协会证件册页 ${v} 不在当日索引中`),
        missingIndex: null, missingVolumes: notDeclared };
    }

    const rows = this.rowsFor(identity);
    if (!rows.length) {
      return { ...base, decision: 'invalid', matched: null,
        reasons: ['已发布册页中没有该裁判的执裁证记录'], missingVolumes: [] };
    }

    const inScope = rows.filter((row) =>
      row.rules === game.rules && this._coversLevel(row.level, game.level));
    if (inScope.length === 0) {
      return { ...base, decision: 'invalid', matched: null,
        reasons: [`执裁证仅覆盖赛制/级别 ${unique(rows.map((r) => `${r.rules}/${r.level}`)).join('、')}，不适用 ${game.rules}/${game.level}`],
        missingVolumes: [] };
    }

    const states = inScope.map((row) => ({ row, state: this._rowState(row, game.start) }));
    const active = states.find((s) => s.state === 'active');
    if (active) {
      return { ...base, decision: 'valid', matched: active.row, reasons: [], missingVolumes: [] };
    }

    const stateText = {
      revoked: '证件已于开赛日前吊销',
      expired: '证件在开赛日已过有效期',
      'not-yet-effective': '续证生效日晚于开赛时点',
    };
    return { ...base, decision: 'invalid', matched: null,
      reasons: states.map((s) => `${stateText[s.state] ?? s.state}（册页 ${s.row.volume}，${s.row.from_day} 至 ${s.row.through}）`),
      missingVolumes: [] };
  }
}

export function assertQualified(result) {
  if (result.decision !== 'valid') {
    const error = new Error(result.reasons.join('；') || '资格不满足');
    error.code = 'qualification-' + result.decision;
    error.details = result;
    throw error;
  }
}
