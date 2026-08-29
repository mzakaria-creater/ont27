import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import { labelFor } from '../nav/pageCatalog'

const destinations:Record<string,string>={dashboard:'/',deposits:'/deposits',payouts:'/payouts',transactions:'/transactions',all_transactions:'/transactions',approvals:'/approvals','approval-queue':'/approvals',sms_live:'/sms',wallets:'/wallets',merchants:'/merchants',automation:'/automation',automation_rules:'/automation',reports:'/reports',review:'/review',settings:'/admin',users:'/admin/users',permissions:'/admin/permissions'}

export default function Welcome(){
  const {user,permissions}=useAuth();const {t}=useLocale()
  const visible=permissions.filter((row)=>row.can_view&&destinations[row.page_key]).filter((row,index,all)=>all.findIndex((x)=>destinations[x.page_key]===destinations[row.page_key])===index)
  return <PanelShell><section className="page-head"><h2>{t(`مرحباً ${user?.display_name??user?.username??''}`,`Welcome ${user?.display_name??user?.username??''}`)}</h2><p className="page-sub">{t('هذه هي الصفحات المتاحة حسب دورك وصلاحياتك المعيّنة.','These are the pages available to your role and assigned permissions.')}</p></section><div className="welcome-access-grid">{visible.map((row)=><Link className="card welcome-access-card" to={destinations[row.page_key]} key={row.page_key}><strong>{labelFor(row.page_key)}</strong><span>{[row.can_create&&'Create',row.can_edit&&'Edit',row.can_approve&&'Approve',row.can_export&&'Export'].filter(Boolean).join(' · ')||'View only'}</span></Link>)}{visible.length===0&&<div className="card warn">{t('لا توجد صفحة معيّنة لهذا الحساب. تواصل مع مسؤول الصلاحيات.','No page is assigned to this account. Contact a permissions administrator.')}</div>}</div></PanelShell>
}
