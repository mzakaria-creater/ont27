import { useCallback, useRef, useState } from 'react'
import DecisionReason from '../components/DecisionReason'

// Turns the reason modal into an await.
//
// Six places decide deposits — row buttons, drawers, the detail page and two
// bulk bars — each with its own busy flags and error state. Threading modal
// state through all of them would mean six chances to forget the reason, which
// is the bug being fixed. Here a call site keeps its existing shape:
//
//   const reason = await prompt('approve', 'المعاملة 777…')
//   if (!reason) return                       // operator cancelled
//   ... body: JSON.stringify({ action, note: reason })
//
// Cancelling resolves null rather than rejecting: a cancelled decision is a
// normal outcome, not an error, and callers should not need a try/catch to
// treat it as one.
export function useDecisionReason() {
  const [state, setState] = useState<{ action: 'approve' | 'decline'; subject: string } | null>(null)
  const resolver = useRef<((reason: string | null) => void) | null>(null)

  const settle = useCallback((reason: string | null) => {
    resolver.current?.(reason)
    resolver.current = null
    setState(null)
  }, [])

  const prompt = useCallback((action: 'approve' | 'decline', subject: string) => {
    // A second prompt while one is open would strand the first caller's
    // promise forever; close the old one as cancelled instead.
    resolver.current?.(null)
    setState({ action, subject })
    return new Promise<string | null>((resolve) => { resolver.current = resolve })
  }, [])

  const node = state
    ? <DecisionReason
        action={state.action}
        subject={state.subject}
        onCancel={() => settle(null)}
        onConfirm={(reason) => settle(reason)}
      />
    : null

  return { prompt, node }
}
