import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { setStatusLocale } from './deposits'

export type Locale = 'ar' | 'en'

interface LocaleState {
  locale: Locale
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
  t: (arabic: string, english: string) => string
}

const LocaleContext = createContext<LocaleState | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => (
    localStorage.getItem('panel-language') === 'en' ? 'en' : 'ar'
  ))

  // Keep the status-label locale in sync synchronously so statusMeta() picks the
  // right language on the same render the toggle happens (no stale frame).
  setStatusLocale(locale)

  useEffect(() => {
    localStorage.setItem('panel-language', locale)
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  }, [locale])

  const value: LocaleState = {
    locale,
    setLocale,
    toggleLocale: () => setLocale((current) => current === 'ar' ? 'en' : 'ar'),
    t: (arabic, english) => locale === 'en' ? english : arabic,
  }

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleState {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}
