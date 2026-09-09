import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode; resetKey?: string }
interface State { error: Error | null; recovering: boolean }

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recovering: false }

  componentDidUpdate(previousProps: Props) {
    // A page error must not poison the next route. React Router changes the
    // route without remounting the root boundary, so clear a stale fallback
    // as soon as navigation gives us a new reset key.
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, recovering: false })
    }
  }

  static getDerivedStateFromError(error: Error): State { return { error, recovering: false } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[panel-render]', error, info.componentStack)
    const route = `${window.location.pathname}${window.location.search}`
    const buildAsset = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null
    void fetch('/api/monitoring/client-error', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route, message: error.message, stack: error.stack, component_stack: info.componentStack,
        user_agent: navigator.userAgent, build_asset: buildAsset }),
    }).catch(() => undefined)

    // An already-open tab may still reference a lazy chunk from the previous
    // deployment. Vercel then serves the SPA HTML fallback for that obsolete
    // .js URL, which browsers report as a MIME/dynamic-import failure. React
    // caches the rejected import promise, so rerendering cannot recover it;
    // one full reload is required to load the current index + chunk manifest.
    const chunkFailure = /text\/html.*JavaScript MIME|dynamically imported module|module script failed|ChunkLoadError|Loading chunk/i.test(error.message)
    if (chunkFailure) {
      try {
        const reloadKey = `panel-chunk-reload:${buildAsset ?? 'unknown'}`
        if (!sessionStorage.getItem(reloadKey)) {
          sessionStorage.setItem(reloadKey, String(Date.now()))
          this.setState({ recovering: true })
          window.setTimeout(() => window.location.reload(), 250)
          return
        }
      } catch { /* continue to the visible recovery screen */ }
    }

    // A transient render race should not strand the whole panel. Retry once
    // per route/error every five minutes; deterministic errors stay visible
    // after that one retry instead of entering a crash loop.
    try {
      const key = `panel-render-retry:${route}:${error.message}`.slice(0, 500)
      const previous = Number(sessionStorage.getItem(key) ?? 0)
      if (!Number.isFinite(previous) || Date.now() - previous > 5 * 60_000) {
        sessionStorage.setItem(key, String(Date.now()))
        this.setState({ recovering: true })
        window.setTimeout(() => this.setState({ error: null, recovering: false }), 700)
      }
    } catch { /* storage can be unavailable in private/restricted contexts */ }
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="app-crash">
      <img src="/logo.svg" alt="OnTarget" />
      <span>ON TARGET PANEL</span>
      <h1>Something interrupted this screen</h1>
      <p>{this.state.recovering ? 'Recovering this screen automatically…' : 'The error was logged. Try the screen again or reload the panel.'}</p>
      <button disabled={this.state.recovering} onClick={() => this.setState({ error: null, recovering: false })}>Try screen again</button>
      <button onClick={() => window.location.reload()}>Reload panel</button>
      <details><summary>Technical detail</summary><code>{this.state.error.message}</code></details>
    </main>
  }
}
