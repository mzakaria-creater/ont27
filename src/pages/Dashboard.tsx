import { useAuth } from '../auth/AuthContext'

export default function Dashboard() {
  const { user, permissions, twofaEnrolled } = useAuth()
  const visible = permissions.filter((p) => p.can_view)
  const approvals = permissions.filter((p) => p.can_approve)

  return (
    <main className="main">
      <div className="card">
        <h2>أهلاً {user?.display_name} 👋</h2>
        <p>
          الدور: <span className="mono">{user?.role}</span>
          {' · '}صفحات مسموح عرضها: <span className="mono">{visible.length}</span>
          {' · '}صلاحيات اعتماد: <span className="mono">{approvals.length}</span>
        </p>
        {approvals.length > 0 && !twofaEnrolled && (
          <p className="warn">
            ⚠️ دورك يملك صلاحية اعتماد (can_approve) بدون 2FA مفعّل — التفعيل إلزامي قبل فتح
            شاشات الإيداعات.
          </p>
        )}
        <p>
          الخطوة القادمة حسب ترتيب البناء: Dashboard الفعلي ← Deposits (الأولوية التشغيلية
          القصوى).
        </p>
      </div>
    </main>
  )
}
