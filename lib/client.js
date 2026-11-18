/**
 * Browser half for dsh-baidu-netdisk.
 *
 * Registers the bundle configuration page in the Plugins page. All secrets
 * (BDUSS/STOKEN/PanSou password) are write-only: the host reports presence,
 * never the value.
 */
window.__ModuleLoader__.load({
  id: 'dsh-baidu-netdisk',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-baidu-netdisk'

    const CSS = [
      '.bdn-page{max-width:720px;padding:12px 0 28px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;font-size:13px}',
      '.bdn-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.bdn-head{padding:15px 16px 0}',
      '.bdn-title{margin:0;font-size:14px;line-height:20px;font-weight:600}',
      '.bdn-desc{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.bdn-form{padding:4px 16px 8px}',
      '.bdn-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px;align-items:start;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.bdn-row:last-child{border-bottom:0}',
      '.bdn-label{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:34px}',
      '.bdn-input{width:100%;height:34px;box-sizing:border-box;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.bdn-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.bdn-hint{margin:5px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.bdn-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px 14px}',
      '.bdn-btn{height:32px;padding:0 14px;border:.5px solid transparent;border-radius:6px;font:inherit;font-size:13px;display:inline-flex;align-items:center;cursor:pointer}',
      '.bdn-btn:disabled{cursor:not-allowed;opacity:.55}',
      '.bdn-btn-primary{background:var(--dsw-alias-state-business-primary);color:#fff}',
      '.bdn-btn-ghost{border-color:var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.bdn-msg{font-size:12px}',
      '.bdn-msg[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.bdn-msg[data-kind="err"]{color:var(--dsw-alias-state-error-primary)}',
      '.bdn-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.bdn-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
    ].join('\n')

    if (typeof document !== 'undefined') {
      const tagId = NS + '/settings.css'
      if (!document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
        const tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    function makeInvoke(connection) {
      return async (method, args = {}) => {
        if (!connection || typeof connection.rpc?.call !== 'function') {
          const error = new Error('连接通道不可用（请刷新页面）')
          error.code = 'no_connection'
          throw error
        }
        const result = await connection.rpc.call('/api', 'bd/' + method, { args })
        if (!result || !result.ok) {
          const error = new Error(result?.error?.message ?? ('bd.' + method + ' 调用失败'))
          error.code = result?.error?.code ?? 'rpc_error'
          throw error
        }
        return result.value
      }
    }

    function Field(props) {
      return h('div', { className: 'bdn-row' },
        h('label', { className: 'bdn-label' }, props.label),
        h('div', null,
          h('input', {
            className: 'bdn-input',
            type: props.type || 'text',
            value: props.value,
            placeholder: props.placeholder,
            autoComplete: 'off',
            onChange: (e) => props.onChange(e.target.value),
          }),
          props.hint ? h('p', { className: 'bdn-hint' }, props.hint) : null,
        ),
      )
    }

    function SettingsPage(props) {
      const invoke = props.invoke
      const [status, setStatus] = React.useState(null)
      const [bduss, setBduss] = React.useState('')
      const [stoken, setStoken] = React.useState('')
      const [timeoutMs, setTimeoutMs] = React.useState('15000')
      const [inboxRoot, setInboxRoot] = React.useState('/绿联下载')
      const [allowTransfer, setAllowTransfer] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [testing, setTesting] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const [pUrl, setPUrl] = React.useState('')
      const [pUser, setPUser] = React.useState('')
      const [pPass, setPPass] = React.useState('')
      const [pBusy, setPBusy] = React.useState(false)
      const [pTesting, setPTesting] = React.useState(false)
      const [pMessage, setPMessage] = React.useState(null)

      React.useEffect(() => {
        invoke('status').then((s) => {
          setStatus(s)
          if (s?.timeoutMs) setTimeoutMs(String(s.timeoutMs))
          if (s?.inboxRoot) setInboxRoot(s.inboxRoot)
          if (typeof s?.allowTransfer === 'boolean') setAllowTransfer(s.allowTransfer)
          if (s?.pansouUrl) setPUrl(s.pansouUrl)
          if (s?.pansouUser) setPUser(s.pansouUser)
        }).catch(() => setStatus({ configured: false }))
      }, [])

      const save = async () => {
        setBusy(true); setMessage(null)
        try {
          const s = await invoke('save', { bduss, stoken, timeoutMs: Number(timeoutMs), inboxRoot, allowTransfer })
          setStatus(s); setBduss(''); setStoken('')
          setMessage({ kind: 'ok', text: '已保存' })
        } catch (e) {
          setMessage({ kind: 'err', text: e.message })
        } finally { setBusy(false) }
      }

      const test = async () => {
        setTesting(true); setMessage(null)
        try {
          const r = await invoke('test')
          setMessage(r?.ok
            ? { kind: 'ok', text: '连接正常：' + (r.name || r.uk || '已验证') }
            : { kind: 'err', text: r?.error || '验证失败' })
          setStatus(await invoke('status'))
        } catch (e) {
          setMessage({ kind: 'err', text: e.message })
        } finally { setTesting(false) }
      }

      const clear = async () => {
        setBusy(true); setMessage(null)
        try {
          setStatus(await invoke('clear'))
          setMessage({ kind: 'ok', text: '凭据已清除' })
        } catch (e) {
          setMessage({ kind: 'err', text: e.message })
        } finally { setBusy(false) }
      }

      const savePansou = async () => {
        setPBusy(true); setPMessage(null)
        try {
          const s = await invoke('savePansou', { pansouUrl: pUrl, pansouUser: pUser, pansouPass: pPass })
          setStatus(s); setPPass('')
          setPMessage({ kind: 'ok', text: '已保存' })
        } catch (e) {
          setPMessage({ kind: 'err', text: e.message })
        } finally { setPBusy(false) }
      }

      const testPansou = async () => {
        setPTesting(true); setPMessage(null)
        try {
          const r = await invoke('testPansou')
          setPMessage(r?.ok
            ? { kind: 'ok', text: '连接正常：' + (r.baseUrl || 'PanSou') }
            : { kind: 'err', text: r?.error || '验证失败' })
          setStatus(await invoke('status'))
        } catch (e) {
          setPMessage({ kind: 'err', text: e.message })
        } finally { setPTesting(false) }
      }

      const clearPansou = async () => {
        setPBusy(true); setPMessage(null)
        try {
          setStatus(await invoke('clearPansou'))
          setPUrl(''); setPUser(''); setPPass('')
          setPMessage({ kind: 'ok', text: '已清除' })
        } catch (e) {
          setPMessage({ kind: 'err', text: e.message })
        } finally { setPBusy(false) }
      }

      const configured = Boolean(status?.configured)
      const pansouConfigured = Boolean(status?.pansouConfigured)

      return h('div', { className: 'bdn-page' },
        h('section', { className: 'bdn-card' },
          h('div', { className: 'bdn-head' },
            h('h3', { className: 'bdn-title' }, '百度网盘凭据'),
            h('p', { className: 'bdn-desc' }, 'BDUSS 只保存在本机设置里，不回显、不进入对话。它等价于账号密码级权限，请谨慎保管。保存后在插件页关闭再打开本插件，工具才会注册。'),
          ),
          h('div', { className: 'bdn-form' },
            h(Field, {
              label: 'BDUSS', type: 'password', value: bduss,
              placeholder: configured ? '已设置（留空则不修改）' : '粘贴 BDUSS',
              hint: '浏览器登录 pan.baidu.com → F12 → Application → Cookies → pan.baidu.com → BDUSS',
              onChange: setBduss,
            }),
            h(Field, {
              label: 'STOKEN', type: 'password', value: stoken,
              placeholder: configured ? '已设置（留空则不修改）' : '粘贴 STOKEN（可选，解析分享需要）',
              hint: '同一行 Cookie 里的 STOKEN=',
              onChange: setStoken,
            }),
            h(Field, {
              label: '超时(ms)', value: timeoutMs,
              placeholder: '15000',
              onChange: setTimeoutMs,
            }),
            h(Field, {
              label: '暂存目录', value: inboxRoot,
              placeholder: '/绿联下载',
              hint: '转存只允许写这个前缀下的路径；NAS 端对应 Downloads/BaiduNetDisk',
              onChange: setInboxRoot,
            }),
            h('div', { className: 'bdn-row' },
              h('label', { className: 'bdn-label' }, '允许转存'),
              h('div', null,
                h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', height: '34px', cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: allowTransfer, onChange: (e) => setAllowTransfer(e.target.checked) }),
                  h('span', null, allowTransfer ? '已开启（会注册 baidu_transfer 写工具）' : '已关闭（只读）'),
                ),
                h('p', { className: 'bdn-hint' }, '默认关闭。开启后模型才能把分享里的集转存到暂存目录，仍然不能删除或移动。'),
              ),
            ),
          ),
          h('div', { className: 'bdn-footer' },
            h('button', { className: 'bdn-btn bdn-btn-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存配置'),
            h('button', { className: 'bdn-btn bdn-btn-ghost', disabled: testing || !configured, onClick: test }, testing ? '测试中…' : '测试连接'),
            h('button', { className: 'bdn-btn bdn-btn-ghost', disabled: busy || !configured, onClick: clear }, '清除凭据'),
            h('span', { className: 'bdn-pill', 'data-tone': configured ? 'ok' : '' }, configured ? '已配置' : '未配置'),
            message ? h('span', { className: 'bdn-msg', 'data-kind': message.kind }, message.text) : null,
          ),
        ),

        h('section', { className: 'bdn-card' },
          h('div', { className: 'bdn-head' },
            h('h3', { className: 'bdn-title' }, 'PanSou 搜索源'),
            h('p', { className: 'bdn-desc' }, '用于搜索网盘资源。密码只保存在本机，登录后换取 token，过期自动重登。保存后需重载插件才注册工具。'),
          ),
          h('div', { className: 'bdn-form' },
            h(Field, {
              label: '地址', value: pUrl,
              placeholder: 'http://192.168.5.100:9080',
              hint: '用 NAS 的局域网 IP 或容器网关，不要填 127.0.0.1（那是插件自己）',
              onChange: setPUrl,
            }),
            h(Field, {
              label: '用户名', value: pUser,
              placeholder: 'PanSou 登录用户名',
              onChange: setPUser,
            }),
            h(Field, {
              label: '密码', type: 'password', value: pPass,
              placeholder: pansouConfigured ? '已设置（留空则不修改）' : 'PanSou 登录密码',
              onChange: setPPass,
            }),
          ),
          h('div', { className: 'bdn-footer' },
            h('button', { className: 'bdn-btn bdn-btn-primary', disabled: pBusy, onClick: savePansou }, pBusy ? '保存中…' : '保存配置'),
            h('button', { className: 'bdn-btn bdn-btn-ghost', disabled: pTesting || !pansouConfigured, onClick: testPansou }, pTesting ? '测试中…' : '测试连接'),
            h('button', { className: 'bdn-btn bdn-btn-ghost', disabled: pBusy || !pansouConfigured, onClick: clearPansou }, '清除'),
            h('span', { className: 'bdn-pill', 'data-tone': pansouConfigured ? 'ok' : '' }, pansouConfigured ? '已配置' : '未配置'),
            pMessage ? h('span', { className: 'bdn-msg', 'data-kind': pMessage.kind }, pMessage.text) : null,
          ),
        ),
      )
    }

    function apply(ctx) {
      const connection = ctx.get('connection')
      const invoke = makeInvoke(connection)
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: NS,
      }, (props) => h(SettingsPage, { ...props, invoke })))
    }

    return { name: NS, inject: ['slots', 'connection'], apply, SettingsPage }
  },
})
