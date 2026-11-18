/**
 * Host-side Remote gateway for the browser settings page.
 *
 * The browser half (lib/client.js) talks to these methods through the /api
 * connection RPC channel under the wire namespace `bd`:
 *   connection.rpc.call('/api', 'bd/<method>', { args })
 *
 * Method parameters must be plain identifiers (the gateway's source-mode
 * validation rejects defaults, destructuring and rest parameters).
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

function markRemote(prototype, method, exportName = method) {
  Remote(exportName)(prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      initializer.call(Object.create(prototype))
    },
  })
}

export class BaiduGateway extends TypertRemoteService {
  /**
   * @param {object} ctx cordis context
   * @param {{ owner: {
   *   status: () => object,
   *   update: (patch: object) => Promise<object>,
   *   test: () => Promise<object>,
   * } }} config
   */
  constructor(ctx, config) {
    super(ctx, 'bd')
    this.owner = config.owner
  }

  /** Current settings view. BDUSS/STOKEN are never returned, only presence. */
  status() {
    return this.owner.status()
  }

  /** Persist new credentials/timeout. Empty secret keeps the stored one. */
  async save(bduss, stoken, timeoutMs, inboxRoot, allowTransfer) {
    const patch = {}
    if (typeof bduss === 'string' && bduss.trim()) patch.bduss = bduss.trim()
    if (typeof stoken === 'string' && stoken.trim()) patch.stoken = stoken.trim()
    patch.timeoutMs = Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs)) : 15000
    if (typeof inboxRoot === 'string' && inboxRoot.trim()) patch.inboxRoot = inboxRoot.trim().replace(/\/+$/, '')
    if (typeof allowTransfer === 'boolean') patch.allowTransfer = allowTransfer
    await this.owner.update(patch)
    return this.status()
  }

  /** Verify the cookie against Baidu right now. */
  async test() {
    return this.owner.test()
  }

  /** Persist PanSou connection settings. Empty password keeps the stored one. */
  async savePansou(pansouUrl, pansouUser, pansouPass) {
    const patch = {}
    patch.pansouUrl = String(pansouUrl ?? '').trim()
    patch.pansouUser = String(pansouUser ?? '').trim()
    if (typeof pansouPass === 'string' && pansouPass.trim()) patch.pansouPass = pansouPass.trim()
    await this.owner.update(patch)
    return this.status()
  }

  /** Verify PanSou reachability and credentials. */
  async testPansou() {
    return this.owner.testPansou()
  }

  /** Wipe stored credentials. */
  async clear() {
    await this.owner.update({ bduss: '', stoken: '' })
    return this.status()
  }

  /** Wipe PanSou settings. */
  async clearPansou() {
    await this.owner.update({ pansouUrl: '', pansouUser: '', pansouPass: '' })
    return this.status()
  }
}

markRemote(BaiduGateway.prototype, 'status')
markRemote(BaiduGateway.prototype, 'save')
markRemote(BaiduGateway.prototype, 'test')
markRemote(BaiduGateway.prototype, 'savePansou')
markRemote(BaiduGateway.prototype, 'testPansou')
markRemote(BaiduGateway.prototype, 'clear')
markRemote(BaiduGateway.prototype, 'clearPansou')
