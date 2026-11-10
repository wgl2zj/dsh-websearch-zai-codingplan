/**
 * dsh-web-search-zhipu-mcp —— Client 侧:设置页「智谱搜索 API Key」。
 *
 * 槽位:settings.section(Settings 左栏一页)。通道与形状对齐本机已验证的
 * dsh-tokens-card:inject 只声明 slots;凭据读写走宿主半注册的本机回环路由
 * `/dsh-web-search-zhipu-mcp/credentials`(GET 查状态 / POST 存清,宿主侧
 * 带跨站栅栏);文案写死中文、<style> 挂在组件内——0.2.0 教训:声明客户端
 * fiber 不提供的服务(remote/remote.credentials)会让 entry 卡 loading,
 * web boot 直接判死;styles/host 内置符号属另一种 code 动态包格式,不可用。
 * 样式只用 --dsw-alias-* 主题 token,zws- 前缀隔离。
 */
/* global window */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-zhipu-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const ROUTE = '/dsh-web-search-zhipu-mcp/credentials'

    const ZH = {
      nav: '智谱搜索',
      page: '智谱搜索 API Key',
      intro: '联网搜索走智谱官方 MCP,计费落在 GLM Coding Plan 套餐搜索额度。',
      statusTitle: '凭据状态',
      dedicatedSet: '已保存本插件专用 Key',
      dedicatedUnset: '未设置专用 Key(回退共用 Key)',
      fallbackSet: '模型通道共用 Key 已设置(可回退)',
      fallbackUnset: '共用 Key 也未设置——搜索不可用',
      keyLabel: '专用 API Key',
      keyPlaceholder: '粘贴智谱 API Key;留空表示保持已保存值',
      keyReveal: '显示',
      keyHide: '隐藏',
      keyHelp: '保存后优先于模型通道共用 Key;只写入 DSH 凭据服务,不会回显。',
      save: '保存',
      saving: '保存中…',
      clear: '清除专用 Key',
      okSaved: '已保存,下一次搜索即生效(无需重启)。',
      okCleared: '已清除,回退模型通道共用 Key。',
      errEmpty: '请先粘贴 API Key。',
      errSave: '保存失败:',
      errClear: '清除失败:',
      errLoad: '凭据状态读取失败:',
      note: 'Key 在智谱开放平台控制台获取;轮换后无需重启,下一次搜索自动用新值。',
    }

    const CSS = `
.zws-page{max-width:640px;display:flex;flex-direction:column;gap:14px}
.zws-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px}
.zws-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zws-intro{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.zws-status{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
.zws-status-title{font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.zws-pill{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary)}
.zws-dot{width:8px;height:8px;border-radius:50%;flex:none}
.zws-dot.ok{background:var(--dsw-alias-state-success-primary)}
.zws-dot.warn{background:var(--dsw-alias-state-warn-primary)}
.zws-dot.idle{background:var(--dsw-alias-state-idle-primary)}
.zws-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.zws-inputrow{display:flex;gap:8px}
.zws-input{flex:1;box-sizing:border-box;height:32px;padding:0 10px;font-size:13px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;min-width:0}
.zws-input:focus{border-color:var(--dsw-alias-brand-primary)}
.zws-btn{height:32px;padding:0 14px;font-size:13px;border-radius:8px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);cursor:pointer}
.zws-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.zws-btn:disabled{opacity:.5;cursor:default}
.zws-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base)}
.zws-actions{display:flex;gap:8px}
.zws-help,.zws-note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.zws-note{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
.zws-notice{font-size:12px;line-height:1.5}
.zws-notice.ok{color:var(--dsw-alias-state-success-primary)}
.zws-notice.error{color:var(--dsw-alias-state-error-primary)}
`

    /** 调宿主半路由;非 2xx 或 ok!=true 抛错(错误文案宿主已给)。 */
    async function callRoute(init) {
      const res = await fetch(ROUTE, { cache: 'no-store', ...init })
      const text = await res.text()
      let body = null
      try { body = text.length > 0 ? JSON.parse(text) : null } catch { body = null }
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(body && body.error ? body.error : `HTTP ${res.status}`)
      }
      return body
    }

    function StatusPill({ dot, text }) {
      return h('div', { className: 'zws-pill' }, h('span', { className: `zws-dot ${dot}` }), text)
    }

    function ZwsSection() {
      const [info, setInfo] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [value, setValue] = useState('')
      const [show, setShow] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const body = await callRoute()
          setInfo(body)
          setLoadError(null)
        } catch (error) {
          setLoadError(`${ZH.errLoad}${String(error.message ?? error)}`)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const dedicated = info?.dedicated?.configured === true
      const fallback = info?.fallback?.configured === true

      const save = async () => {
        const key = value.trim()
        if (!key) { setNotice({ kind: 'error', text: ZH.errEmpty }); return }
        setBusy(true)
        try {
          await callRoute({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'set', value: key }),
          })
          setValue('')
          setNotice({ kind: 'ok', text: ZH.okSaved })
          await refresh()
        } catch (error) {
          setNotice({ kind: 'error', text: `${ZH.errSave}${String(error.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      const remove = async () => {
        setBusy(true)
        try {
          await callRoute({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'unset' }),
          })
          setNotice({ kind: 'ok', text: ZH.okCleared })
          await refresh()
        } catch (error) {
          setNotice({ kind: 'error', text: `${ZH.errClear}${String(error.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'zws-page' },
        h('style', null, CSS),
        h('div', { className: 'zws-card' },
          h('div', { className: 'zws-title' }, ZH.page),
          h('div', { className: 'zws-intro' }, ZH.intro),
          h('div', { className: 'zws-status' },
            h('div', { className: 'zws-status-title' }, ZH.statusTitle),
            loadError !== null
              ? h('div', { className: 'zws-notice error' }, loadError)
              : h(StatusPill, { dot: dedicated ? 'ok' : 'idle', text: ZH[dedicated ? 'dedicatedSet' : 'dedicatedUnset'] }),
            loadError === null && h(StatusPill, {
              dot: fallback ? 'ok' : dedicated ? 'idle' : 'warn',
              text: ZH[fallback ? 'fallbackSet' : 'fallbackUnset'],
            })),
          h('div', null,
            h('div', { className: 'zws-label' }, ZH.keyLabel),
            h('div', { className: 'zws-inputrow', style: { marginTop: 6 } },
              h('input', {
                className: 'zws-input',
                type: show ? 'text' : 'password',
                placeholder: ZH.keyPlaceholder,
                value,
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event) => { setValue(event.target.value); setNotice(null) },
              }),
              h('button', { className: 'zws-btn', type: 'button', onClick: () => setShow((v) => !v) },
                ZH[show ? 'keyHide' : 'keyReveal'])),
            h('div', { className: 'zws-help', style: { marginTop: 6 } }, ZH.keyHelp)),
          notice !== null && h('div', { className: `zws-notice ${notice.kind}` }, notice.text),
          h('div', { className: 'zws-actions' },
            h('button', {
              className: 'zws-btn zws-primary',
              type: 'button',
              disabled: busy || value.trim().length === 0,
              onClick: save,
            }, busy ? ZH.saving : ZH.save),
            dedicated && h('button', {
              className: 'zws-btn',
              type: 'button',
              disabled: busy,
              onClick: remove,
            }, ZH.clear)),
          h('div', { className: 'zws-note' }, ZH.note)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'zhipu-web-search',
          order: 21,
          label: ZH.nav,
        }, ZwsSection))
      },
    }
  },
})
