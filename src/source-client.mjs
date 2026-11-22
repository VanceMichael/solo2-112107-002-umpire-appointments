// 合成来源客户端：按阶段拉取资源、向门户提交 substitute / inspect。
// 阶段名只用于选模拟接口；业务含义以资料编号与有效时间为准。
// 404=页未发布（缺册页必须可区分），503=发布方暂不可用（稍后重试）。

import { DomainError } from './util.mjs';

export const PHASES = ['opening', 'interim', 'confirmed'];

export class SourceUnavailableError extends DomainError {
  constructor(phase, resource, status, body) {
    super('source-unavailable', `${phase}/${resource} 暂不可用（HTTP ${status}）`,
      { phase, resource, status, body });
  }
}

export class PageNotPublishedError extends DomainError {
  constructor(phase, resource) {
    super('page-not-published', `${phase}/${resource} 索引声明的页尚未发布`,
      { phase, resource });
  }
}

export class SourceClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new DomainError('bad-config', 'SourceClient 需要 baseUrl');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async getResource(phase, resource) {
    const url = `${this.baseUrl}/v1/${phase}/${resource}`;
    const response = await this.fetch(url, {
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) throw new PageNotPublishedError(phase, resource);
    if (response.status >= 500) {
      let body;
      try { body = await response.json(); } catch { body = null; }
      throw new SourceUnavailableError(phase, resource, response.status, body);
    }
    if (!response.ok) {
      throw new DomainError('source-error', `${phase}/${resource} 返回 HTTP ${response.status}`,
        { phase, resource, status: response.status });
    }
    return {
      release: response.headers.get('x-release') ?? phase,
      data: await response.json(),
    };
  }

  // 尽力拉取：未发布/暂不可用返回结构化缺口而不是抛错，由引擎决定资格可查性。
  async fetchPage(phase, resource) {
    try {
      const page = await this.getResource(phase, resource);
      return { phase, resource, available: true, data: page.data, release: page.release };
    } catch (error) {
      if (error instanceof PageNotPublishedError) {
        return { phase, resource, available: false, reason: 'not-published' };
      }
      if (error instanceof SourceUnavailableError) {
        return { phase, resource, available: false, reason: 'unavailable', status: error.details.status };
      }
      throw error;
    }
  }

  // 提交门户操作。重复报文按原请求返回 200；同 key 换报文 409。
  async postPortal(phase, payload) {
    const response = await this.fetch(`${this.baseUrl}/v1/${phase}/portal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return {
      status: response.status,
      ok: response.status === 200 || response.status === 201,
      duplicated: response.status === 200,
      body,
    };
  }
}
