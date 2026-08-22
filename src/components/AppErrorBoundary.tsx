import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[panel-render]', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="app-crash">
      <img src="/logo.svg" alt="OnTarget" />
      <span>ON TARGET PANEL</span>
      <h1>Something interrupted this screen</h1>
      <p>The application is connected, but this page could not render. Reload to recover.</p>
      <button onClick={() => window.location.reload()}>Reload panel</button>
      <details><summary>Technical detail</summary><code>{this.state.error.message}</code></details>
    </main>
  }
}
