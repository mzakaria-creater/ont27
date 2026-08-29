import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

export default function PageGate({keys,children,fallback='/welcome'}:{keys:string[];children:ReactNode;fallback?:string}){
  const {permissions}=useAuth()
  if(keys.some((key)=>permissions.some((row)=>row.page_key===key&&row.can_view)))return children
  return <Navigate to={fallback} replace />
}
