import { useState } from 'react'
import { useLocale } from '../lib/locale'
import FinanceOperations from './FinanceOperations'
import RevenueCenterLegacy from './RevenueCenterLegacy'
import PressToPayNav from '../components/PressToPayNav'

type Workspace = 'operations' | 'cfo'

export default function RevenueCenter() {
  const { t } = useLocale()
  const [workspace, setWorkspace] = useState<Workspace>('operations')

  if (workspace === 'cfo') {
    return <><PressToPayNav /><div className="revenue-workspace-host">
      <div className="revenue-workspace-switch revenue-workspace-switch-floating">
        <button type="button" onClick={() => setWorkspace('operations')}>{t('العمليات المالية V2', 'Finance Operations V2')}</button>
        <button type="button" className="active">{t('مساحة CFO', 'CFO Workspace')}</button>
      </div>
      <RevenueCenterLegacy />
    </div></>
  }

  return <>
    <PressToPayNav />
    <div className="revenue-workspace-switch">
      <button type="button" className="active">{t('العمليات المالية V2', 'Finance Operations V2')}</button>
      <button type="button" onClick={() => setWorkspace('cfo')}>{t('مساحة CFO', 'CFO Workspace')}</button>
    </div>
    <FinanceOperations />
  </>
}
