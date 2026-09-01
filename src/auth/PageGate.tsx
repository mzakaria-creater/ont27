import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

export default function PageGate({keys,children,fallback='/welcome'}:{keys:string[];children:ReactNode;fallback?:string}){
  const {permissions,status}=useAuth()
  // Do not redirect while the authenticated user's permissions are still
  // being resolved. Redirecting during this brief window makes valid pages
  // (notably Deposits for operators) disappear until a second navigation.
  if (status === 'loading') return <div className="page-loading" role="status">Loading…</div>
  if(keys.some((key)=>permissions.some((row)=>row.page_key===key&&row.can_view)))return children
  return <Navigate to={fallback} replace />
}
