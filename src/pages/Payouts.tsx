import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Eye, MessageSquare, Pencil, Save, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import PanelShell from "../components/PanelShell";
import MerchantLogo from "../components/MerchantLogo";
import MethodLogo from "../components/MethodLogo";
import { api, ApiError } from "../lib/api";
import { money, statusMeta } from "../lib/deposits";
import { useLocale } from "../lib/locale";
import { usePageSize } from "../lib/pageSize";
import PageSizeSelect from "../components/PageSizeSelect";
import ProofModal from "../components/ProofModal";
import ProofIconButton from "../components/ProofIconButton";

const STATUS_FILTERS = ["PENDING", "APPROVED", "DECLINED"];
const CURRENCY = "EGP";

export interface PayoutRow {
  maven_id: number;
  guid: string | null;
  ontarget_ref: string | null;
  status: string;
  amount: number | null;
  pay_by: string | null;
  merchant: string | null;
  account_name: string | null;
  mobile_no: string | null;
  agent_name: string | null;
  approved_by: string | null;
  commission: number | null;
  remark: string | null;
  image_url: string | null;
  created_utc: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  merchant_reference: string | null;
  payment_type: string | null;
  user_account_number: string | null;
  bank_name: string | null;
  bank_ifsc: string | null;
  utr_number: string | null;
  currency: string | null;
  master_merchant: string | null;
  commission_percentage: number | null;
  linked_sms?: {
    id: number;
    received_at: string | null;
    amount: number | null;
    receiver_number: string | null;
    wallet_number: string | null;
    provider: string | null;
    trx_id: string | null;
    trx_reference: string | null;
    balance_after: number | null;
    message: string | null;
  } | null;
}
interface PayoutDetail extends PayoutRow {
  updated_utc: string | null;
  actions?: Array<{
    id: string;
    actor_name: string | null;
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    created_at: string;
  }>;
}
interface PayoutEditForm {
  account_name: string;
  mobile_no: string;
  pay_by: string;
  merchant: string;
  remark: string;
  status: string;
  image_url: string;
}
interface ListResponse {
  rows: PayoutRow[];
  total: number;
  limit: number;
  offset: number;
}
interface DecisionResult {
  ok: boolean;
  audit_log_id?: number;
  executed_on_provider: boolean;
  mode?: "manual" | "auto";
  note?: string;
  after_status?: string | null;
  provider_raw_status_was?: string | null;
}
interface ExecSettings {
  auto_execute_enabled: boolean;
  max_auto_amount: number | null;
}

export default function Payouts() {
  const [pageSize, setPageSize] = usePageSize("payouts");
  const { can, user } = useAuth();
  const { t } = useLocale();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const page = Math.max(Number(params.get("page")) || 1, 1);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<PayoutDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<PayoutEditForm>({
    account_name: "",
    mobile_no: "",
    pay_by: "",
    merchant: "",
    remark: "",
    status: "PENDING",
    image_url: "",
  });
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionErr, setDecisionErr] = useState<string | null>(null);
  const [decisionResult, setDecisionResult] = useState<DecisionResult | null>(
    null,
  );
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [viewedProofUrl, setViewedProofUrl] = useState<string | null>(null);
  const [proofName, setProofName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [remark, setRemark] = useState("");
  const [utr, setUtr] = useState("");
  const [execSettings, setExecSettings] = useState<ExecSettings | null>(null);
  const [maxAutoAmount, setMaxAutoAmount] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const appliedQ = params.get("q") ?? "";
  const appliedFrom = params.get("from") ?? "";
  const appliedTo = params.get("to") ?? "";
  const appliedMerchant = params.get("merchant") ?? "";
  const appliedMethod = params.get("method") ?? "";
  const [from, setFrom] = useState(appliedFrom);
  const [to, setTo] = useState(appliedTo);
  const [merchantFilter, setMerchantFilter] = useState(appliedMerchant);
  const [methodFilter, setMethodFilter] = useState(appliedMethod);

  useEffect(() => {
    void api<{ settings: ExecSettings }>("/api/payouts/settings/execution")
      .then((r) => {
        setExecSettings(r.settings);
        setMaxAutoAmount(
          r.settings.max_auto_amount == null
            ? ""
            : String(r.settings.max_auto_amount),
        );
      })
      .catch(() => setExecSettings(null));
  }, []);

  const saveExecutionSettings = async (enabled: boolean) => {
    const cap = Number(maxAutoAmount);
    if (!Number.isFinite(cap) || cap <= 0) {
      setSettingsMessage(
        t(
          "أدخل حداً أقصى موجباً أولاً.",
          "Enter a positive maximum amount first.",
        ),
      );
      return;
    }
    if (
      enabled &&
      !window.confirm(
        t(
          `تفعيل تنفيذ موافقات السحب على NGPay حتى ${cap.toLocaleString("en-US")} EGP لكل عملية؟`,
          `Enable payout approval processing on NGPay up to ${cap.toLocaleString("en-US")} EGP per payout?`,
        ),
      )
    )
      return;
    setSettingsBusy(true);
    setSettingsMessage(null);
    try {
      const result = await api<{ settings: ExecSettings }>(
        "/api/payouts/settings/execution",
        {
          method: "PUT",
          body: JSON.stringify({
            auto_execute_enabled: enabled,
            max_auto_amount: cap,
          }),
        },
      );
      setExecSettings(result.settings);
      setSettingsMessage(
        enabled
          ? t(
              "تم تفعيل التنفيذ على NGPay ضمن الحد.",
              "NGPay processing enabled within the cap.",
            )
          : t("تم إيقاف التنفيذ على NGPay.", "NGPay processing disabled."),
      );
    } catch (e) {
      setSettingsMessage(
        e instanceof ApiError && e.code === "super_admin_required"
          ? t(
              "هذه الإعدادات لـ super_admin فقط.",
              "Only super_admin can change these settings.",
            )
          : t(
              "تعذّر حفظ إعدادات التنفيذ.",
              "Failed to save execution settings.",
            ),
      );
    } finally {
      setSettingsBusy(false);
    }
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setErr(null);
    const search = new URLSearchParams({
      limit: String(pageSize),
      offset: String((page - 1) * pageSize),
    });
    if (status) search.set("status", status);
    if (appliedQ) search.set("q", appliedQ);
    if (appliedFrom) search.set("from", appliedFrom);
    if (appliedTo) search.set("to", appliedTo);
    if (appliedMerchant) search.set("merchant", appliedMerchant);
    if (appliedMethod) search.set("method", appliedMethod);
    try {
      setData(await api<ListResponse>(`/api/payouts?${search}`));
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 403
          ? t(
              "لا تملك صلاحية عرض السحوبات.",
              "You do not have permission to view payouts.",
            )
          : t("تعذّر تحميل السحوبات.", "Failed to load payouts."),
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }, [status, appliedQ, appliedFrom, appliedTo, appliedMerchant, appliedMethod, page, pageSize]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const refresh = () => void load(true);
    window.addEventListener("ontarget:provider-sync", refresh);
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener("ontarget:provider-sync", refresh);
      window.clearInterval(interval);
    };
  }, [load]);

  const setFilter = (next: { status?: string; q?: string; from?: string; to?: string; merchant?: string; method?: string; page?: number }) => {
    const p = new URLSearchParams(params);
    if (next.status !== undefined) {
      next.status ? p.set("status", next.status) : p.delete("status");
      p.delete("page");
    }
    if (next.q !== undefined) {
      next.q ? p.set("q", next.q) : p.delete("q");
      p.delete("page");
    }
    for (const key of ["from", "to", "merchant", "method"] as const) {
      if (next[key] !== undefined) {
        next[key] ? p.set(key, next[key]!) : p.delete(key);
        p.delete("page");
      }
    }
    if (next.page !== undefined) {
      next.page > 1 ? p.set("page", String(next.page)) : p.delete("page");
    }
    setParams(p);
  };
  const dateValue = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const applyDatePreset = (preset: "today" | "week" | "month") => {
    const end = new Date();
    const start = new Date(end);
    if (preset === "week") start.setDate(end.getDate() - ((end.getDay() + 6) % 7));
    if (preset === "month") start.setDate(1);
    const nextFrom = dateValue(start);
    const nextTo = dateValue(end);
    setFrom(nextFrom);
    setTo(nextTo);
    setFilter({ from: nextFrom, to: nextTo });
  };
  const openDetail = async (
    mavenId: number,
    startEditing = false,
    requestedStatus?: string,
  ) => {
    setDetailLoading(true);
    setDecisionErr(null);
    setDecisionResult(null);
    setProofUrl(null);
    setProofName(null);
    setRemark("");
    setUtr("");
    setEditing(false);
    setEditError(null);
    try {
      const payout = (
        await api<{ payout: PayoutDetail }>(`/api/payouts/${mavenId}`)
      ).payout;
      setSelected(payout);
      setEditForm({
        account_name: payout.account_name ?? "",
        mobile_no: payout.mobile_no ?? "",
        pay_by: payout.pay_by ?? "",
        merchant: payout.merchant ?? "",
        remark: payout.remark ?? "",
        status: requestedStatus ?? payout.status,
        image_url: payout.image_url ?? "",
      });
      setEditing(startEditing && can("payouts", "can_edit"));
      setUtr(
        payout.linked_sms?.trx_id ?? payout.linked_sms?.trx_reference ?? "",
      );
    } catch {
      setErr(t("تعذّر تحميل تفاصيل السحب.", "Failed to load payout details."));
    } finally {
      setDetailLoading(false);
    }
  };
  const saveEdit = async () => {
    if (!selected) return;
    const statusChanged = editForm.status !== selected.status;
    if (statusChanged && selected.status !== "PENDING") {
      setEditError(t("لا يمكن عكس حالة نُفذت بالفعل على NagoPay.", "A status already executed on NagoPay cannot be reversed."));
      return;
    }
    if (statusChanged && editForm.status === "APPROVED" && (!editForm.image_url || !utr.trim())) {
      setEditError(t("اختيار Paid يتطلب إثباتاً وUTR.", "Selecting Paid requires proof and UTR."));
      return;
    }
    if (statusChanged && !window.confirm(t("سيتم تغيير الحالة مباشرة على NagoPay. متابعة؟", "This will change the status live on NagoPay. Continue?"))) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await api(`/api/payouts/${selected.maven_id}`, {
        method: "PUT",
        body: JSON.stringify({ ...editForm, status: undefined }),
      });
      if (statusChanged) {
        await api(`/api/payouts/${selected.maven_id}/decision`, {
          method: "POST",
          body: JSON.stringify({
            decision: editForm.status,
            proof_url: editForm.image_url || undefined,
            remark: editForm.remark,
            mode: "auto",
            utr_number: utr.trim() || undefined,
          }),
        });
      }
      setEditing(false);
      await openDetail(selected.maven_id);
      void load();
    } catch (e) {
      setEditError(
        e instanceof ApiError && e.status === 403
          ? t("لا تملك صلاحية التعديل.", "You lack edit permission.")
          : t("تعذّر حفظ التعديلات.", "Failed to save changes."),
      );
    } finally {
      setEditBusy(false);
    }
  };
  const reopenDeclined = async (mavenId: number) => {
    if (!window.confirm(t("إعادة المعاملة المرفوضة إلى PENDING للمراجعة؟", "Reopen this declined payout as PENDING for review?"))) return;
    setErr(null);
    try {
      await api(`/api/payouts/${mavenId}/reopen`, { method: "POST" });
      await load();
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 403
          ? t("الإجراء متاح للمالك وSuper Admin فقط.", "Only owner and Super Admin can use this action.")
          : t("تعذّرت إعادة فتح السحب.", "Failed to reopen payout."),
      );
    }
  };
  const uploadProof = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setDecisionErr(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const result = await api<{ proof_url: string }>("/api/payouts/proof", {
        method: "POST",
        body: form,
      });
      setProofUrl(result.proof_url);
      setEditForm((current) => ({ ...current, image_url: result.proof_url }));
      setProofName(file.name);
    } catch (e) {
      setDecisionErr(
        e instanceof ApiError
          ? `${t("تعذّر رفع الإثبات", "Proof upload failed")}: ${e.code}`
          : t("تعذّر رفع الإثبات.", "Proof upload failed."),
      );
    } finally {
      setUploading(false);
    }
  };
  const decide = async (decision: "APPROVED" | "DECLINED") => {
    if (
      !selected ||
      (decision === "APPROVED" && !proofUrl && !selected.linked_sms)
    )
      return;
    setDecisionBusy(true);
    setDecisionErr(null);
    setDecisionResult(null);
    try {
      const result = await api<DecisionResult>(
        `/api/payouts/${selected.maven_id}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            proof_url: proofUrl?.startsWith("sms-evidence:")
              ? undefined
              : proofUrl,
            remark,
            mode: "auto",
            utr_number: utr.trim() || undefined,
          }),
        },
      );
      setDecisionResult(result);
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_pending") {
        setDecisionErr(
          t(
            "حالة السحب تغيّرت بالفعل — أعد التحميل.",
            "Payout status already changed — reload.",
          ),
        );
        void load();
      } else if (e instanceof ApiError && e.status === 403)
        setDecisionErr(
          t(
            "لا تملك صلاحية الاعتماد الفعلية لهذا الدور.",
            "Your role lacks approval permission.",
          ),
        );
      else if (e instanceof ApiError && e.code === "worker_failed") {
        const worker = e.body?.worker as Record<string, unknown> | undefined;
        setDecisionErr(
          `${t("رفض NGPay التنفيذ", "NGPay processing failed")}: ${String(worker?.error ?? t("راجع الحد وUTR وحالة المعاملة.", "Check the cap, UTR, and payout status."))}`,
        );
      } else
        setDecisionErr(
          t(
            "فشل تسجيل القرار عبر عامل السحوبات.",
            "Failed to record the decision via the payout worker.",
          ),
        );
    } finally {
      setDecisionBusy(false);
    }
  };
  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1;
  const selectedRows = (data?.rows ?? []).filter((row) => selectedIds.has(row.maven_id));
  const toggleSelected = (mavenId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(mavenId)) next.delete(mavenId);
      else if (next.size < 20) next.add(mavenId);
      return next;
    });
  };
  const runBulkDecision = async (decision: "APPROVED" | "DECLINED") => {
    const rows = selectedRows.filter((row) => row.status === "PENDING");
    if (!rows.length) return;
    if (decision === "APPROVED") {
      const incomplete = rows.filter(
        (row) =>
          !row.image_url ||
          !(row.utr_number || row.linked_sms?.trx_id || row.linked_sms?.trx_reference),
      );
      if (incomplete.length) {
        setBulkMessage(
          `${t("أكمل Proof وUTR لكل معاملة أولاً", "Add individual proof and UTR first")}: ${incomplete.map((row) => row.maven_id).join(", ")}`,
        );
        return;
      }
    }
    if (
      !window.confirm(
        t(
          `تأكيد إرسال ${rows.length} معاملة إلى NagoPay؟ كل معاملة ستُنفذ وتُدقق منفصلة.`,
          `Submit ${rows.length} payouts to NagoPay? Each will be executed and audited separately.`,
        ),
      )
    )
      return;
    setBulkBusy(true);
    setBulkMessage(null);
    const succeeded: number[] = [];
    const failed: number[] = [];
    for (const row of rows) {
      try {
        const result = await api<DecisionResult>(`/api/payouts/${row.maven_id}/decision`, {
          method: "POST",
          body: JSON.stringify({
            decision,
            proof_url: decision === "APPROVED" ? row.image_url : undefined,
            utr_number:
              decision === "APPROVED"
                ? row.utr_number || row.linked_sms?.trx_id || row.linked_sms?.trx_reference
                : undefined,
            remark: `Bulk ${decision} from ONT27`,
            mode: "auto",
          }),
        });
        if (result.executed_on_provider) succeeded.push(row.maven_id);
        else failed.push(row.maven_id);
      } catch {
        failed.push(row.maven_id);
      }
    }
    setSelectedIds(new Set(failed));
    setBulkMessage(
      `${t("نجح", "Succeeded")}: ${succeeded.length} · ${t("فشل", "Failed")}: ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`,
    );
    setBulkBusy(false);
    await load(true);
  };

  return (
    <PanelShell>
      <section className="page-head">
        <h2>📤 {t("السحوبات", "Payouts")}</h2>
        <p className="page-sub">
          {t(
            "قرارات السحب تُسجّل عبر عامل القرارات مع سجل تدقيق وإثبات للمقبول.",
            "Payout decisions are recorded via the decision worker with an audit trail and proof for approvals.",
          )}
          {data && <> · {data.total.toLocaleString("en-US")}</>}
        </p>
      </section>
      {user?.role === "super_admin" && (
        <section className="card payout-execution-settings">
          <div>
            <strong>
              {t(
                "تنفيذ موافقات السحب على NGPay",
                "Process payout approvals on NGPay",
              )}
            </strong>
            <p className="page-sub">
              {t(
                "كل موافقة تتطلب إثباتاً وUTR وتأكيداً بشرياً، ولا تتجاوز الحد لكل عملية.",
                "Every approval requires proof, UTR, and human confirmation, and cannot exceed the per-payout cap.",
              )}
            </p>
          </div>
          <label>
            <span>
              {t("الحد الأقصى لكل سحب (EGP)", "Maximum per payout (EGP)")}
            </span>
            <input
              className="login-input control-input mono"
              type="number"
              min="1"
              step="1"
              value={maxAutoAmount}
              onChange={(e) => setMaxAutoAmount(e.target.value)}
            />
          </label>
          <div className="control-row">
            <button
              className="btn-primary btn-sm"
              disabled={settingsBusy || execSettings?.auto_execute_enabled}
              onClick={() => void saveExecutionSettings(true)}
            >
              {t("تفعيل التنفيذ", "Enable processing")}
            </button>
            <button
              className="btn-ghost btn-sm danger"
              disabled={settingsBusy || !execSettings?.auto_execute_enabled}
              onClick={() => void saveExecutionSettings(false)}
            >
              {t("إيقاف", "Disable")}
            </button>
            <span
              className={`pay-status-badge ${execSettings?.auto_execute_enabled ? "st-paid" : "st-dim"}`}
            >
              {execSettings?.auto_execute_enabled
                ? t("NGPay مفعّل", "NGPay enabled")
                : t("متوقف", "Disabled")}
            </span>
          </div>
          {settingsMessage && <p className="drawer-note">{settingsMessage}</p>}
        </section>
      )}
      <section className="card payout-filter-panel">
        <div className="payout-filter-presets">
          <button className="btn-ghost btn-sm" onClick={() => applyDatePreset("today")}>{t("اليوم", "Today")}</button>
          <button className="btn-ghost btn-sm" onClick={() => applyDatePreset("week")}>{t("هذا الأسبوع", "This week")}</button>
          <button className="btn-ghost btn-sm" onClick={() => applyDatePreset("month")}>{t("هذا الشهر", "This month")}</button>
        </div>
        <form
          className="payout-filter-grid"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({
              from,
              to,
              merchant: merchantFilter.trim(),
              method: methodFilter.trim(),
              q: q.trim(),
            });
          }}
        >
          <label className="field-label">
            {t("من", "From")}
            <input className="login-input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field-label">
            {t("إلى", "To")}
            <input className="login-input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="field-label">
            {t("التاجر", "Merchant")}
            <input className="login-input" value={merchantFilter} onChange={(e) => setMerchantFilter(e.target.value)} placeholder={t("كل التجار", "All merchants")} />
          </label>
          <label className="field-label">
            {t("طريقة الدفع", "Payment method")}
            <input className="login-input" value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} placeholder={t("كل الطرق", "All methods")} />
          </label>
          <label className="field-label payout-filter-search">
            {t("بحث", "Search")}
            <input className="login-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("رقم العملية / الهاتف / الاسم", "Transaction / phone / name")} />
          </label>
          <button type="submit" className="btn-primary btn-sm">{t("تطبيق", "Apply")}</button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setFrom(""); setTo(""); setMerchantFilter(""); setMethodFilter(""); setQ("");
              setParams(new URLSearchParams());
            }}
          >
            {t("إعادة ضبط", "Reset")}
          </button>
        </form>
      </section>
      <div className="filter-bar">
        <div className="chip-row">
          <button
            className={`chip${status === "" ? " chip-active" : ""}`}
            onClick={() => setFilter({ status: "" })}
          >
            {t("الكل", "All")}
          </button>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={`chip${status === s ? " chip-active" : ""}`}
              onClick={() => setFilter({ status: s })}
            >
              {statusMeta(s).label}
            </button>
          ))}
        </div>
      </div>
      {can("payouts", "can_approve") && selectedIds.size > 0 && (
        <section className="card payout-bulk-bar">
          <strong>{selectedIds.size} {t("محدد", "selected")}</strong>
          <button className="btn-primary btn-sm" disabled={bulkBusy} onClick={() => void runBulkDecision("APPROVED")}>{t("دفع المحدد على NagoPay", "Pay selected on NagoPay")}</button>
          <button className="btn-ghost btn-sm danger" disabled={bulkBusy} onClick={() => void runBulkDecision("DECLINED")}>{t("رفض المحدد على NagoPay", "Decline selected on NagoPay")}</button>
          <button className="btn-ghost btn-sm" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>{t("إلغاء التحديد", "Clear")}</button>
          {bulkMessage && <span className="cell-sub">{bulkMessage}</span>}
        </section>
      )}
      {err && <div className="card warn">{err}</div>}
      <section className="card recent-card">
        {loading && (
          <p className="sidebar-hint">{t("جارٍ التحميل…", "Loading…")}</p>
        )}
        {!loading && data?.rows.length === 0 && (
          <p>{t("لا توجد نتائج مطابقة.", "No matching results.")}</p>
        )}
        {!loading && data && data.rows.length > 0 && (
          <div className="table-wrap payout-ledger-wrap">
            <table className="data-table clickable payout-ledger-table">
              <thead>
                <tr>
                  <th>
                    <span className="row-actions">
                      {can("payouts", "can_approve") && (
                        <input
                          type="checkbox"
                          aria-label={t("تحديد كل المعلق", "Select pending payouts")}
                          checked={Boolean(data?.rows.filter((row) => row.status === "PENDING").length) && data!.rows.filter((row) => row.status === "PENDING").slice(0, 20).every((row) => selectedIds.has(row.maven_id))}
                          onChange={(e) =>
                            setSelectedIds(
                              e.target.checked
                                ? new Set(data!.rows.filter((row) => row.status === "PENDING").slice(0, 20).map((row) => row.maven_id))
                                : new Set(),
                            )
                          }
                        />
                      )}
                      {t("إجراء", "Action")}
                    </span>
                  </th>
                  <th>{t("رقم المعاملة", "Transaction ID")}</th>
                  <th>{t("مرجع التاجر", "Merchant Reference")}</th>
                  <th>{t("الحالة", "Status")}</th>
                  <th>{t("نوع الدفع", "Payment Type")}</th>
                  <th>{t("رقم هاتف المستخدم", "User Phone Num.")}</th>
                  <th>{t("اسم حساب المستخدم", "User Account Name")}</th>
                  <th>{t("رقم حساب المستخدم", "User Account Number")}</th>
                  <th>{t("اسم البنك", "Bank Name")}</th>
                  <th>{t("رمز IFSC", "Bank IFSC")}</th>
                  <th>{t("رقم UTR", "UTR Number")}</th>
                  <th>{t("العملة", "Currency")}</th>
                  <th>{t("المبلغ", "Amount")}</th>
                  <th>{t("العمولة", "Commission")}</th>
                  <th>{t("نسبة العمولة", "Commission %")}</th>
                  <th>{t("التاجر الرئيسي", "Master Merchant")}</th>
                  <th>{t("التاجر", "Merchant")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const st = statusMeta(row.status);
                  return (
                    <tr
                      key={row.maven_id}
                      onClick={() => void openDetail(row.maven_id)}
                    >
                      <td
                        className="payout-action-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="row-actions">
                          {row.status === "PENDING" && can("payouts", "can_approve") && (
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.maven_id)}
                              aria-label={`${t("تحديد", "Select")} ${row.maven_id}`}
                              onChange={() => toggleSelected(row.maven_id)}
                            />
                          )}
                          <button
                            className="btn-ghost btn-sm icon-text-btn"
                            onClick={() => void openDetail(row.maven_id)}
                          >
                            <Eye size={15} aria-hidden="true" />
                            {row.status === "PENDING" &&
                            can("payouts", "can_approve")
                              ? t("رفع إثبات ودفع", "Upload proof & Pay")
                              : t("تفاصيل", "Details")}
                          </button>
                          {can("payouts", "can_edit") && (
                            <button
                              type="button"
                              className="btn-ghost btn-sm icon-text-btn"
                              title={t("تعديل السحب", "Edit payout")}
                              onClick={() =>
                                void openDetail(row.maven_id, true)
                              }
                            >
                              <Pencil size={15} aria-hidden="true" />
                              {t("تعديل", "Edit")}
                            </button>
                          )}
                          {row.status === "PENDING" &&
                            can("payouts", "can_approve") && (
                              <select
                                className="payout-status-action-select"
                                aria-label={t("اختيار إجراء الحالة", "Select status action")}
                                value=""
                                onChange={(e) => {
                                  const nextStatus = e.target.value;
                                  if (!nextStatus) return;
                                  if (can("payouts", "can_edit"))
                                    void openDetail(row.maven_id, true, nextStatus);
                                  else void openDetail(row.maven_id);
                                }}
                              >
                                <option value="">{t("تغيير الحالة…", "Change status…")}</option>
                                <option value="APPROVED">{t("مدفوع PAID", "Mark PAID")}</option>
                                <option value="DECLINED">{t("مرفوض DECLINED", "Mark DECLINED")}</option>
                              </select>
                            )}
                          {row.status === "DECLINED" &&
                            (user?.role === "owner" || user?.role === "super_admin") && (
                              <select
                                className="payout-status-action-select"
                                aria-label={t("اختيار إجراء الحالة", "Select status action")}
                                value=""
                                onChange={(e) => {
                                  if (e.target.value === "REOPEN") void reopenDeclined(row.maven_id);
                                }}
                              >
                                <option value="">{t("تغيير الحالة…", "Change status…")}</option>
                                <option value="REOPEN">{t("إعادة إلى PENDING", "Reopen as PENDING")}</option>
                              </select>
                            )}
                          {row.linked_sms && (
                            <button
                              type="button"
                              className="proof-icon-button is-compact payout-sms-linked"
                              title={`WD SMS #${row.linked_sms.id} · ${row.linked_sms.trx_id ?? row.linked_sms.trx_reference ?? "—"}`}
                              aria-label={t(
                                "رسالة سحب مرتبطة",
                                "Linked withdrawal SMS",
                              )}
                              onClick={() => void openDetail(row.maven_id)}
                            >
                              <MessageSquare size={16} aria-hidden="true" />
                            </button>
                          )}
                          {row.image_url && (
                            <ProofIconButton
                              url={row.image_url}
                              onOpen={setViewedProofUrl}
                              compact
                            />
                          )}
                        </div>
                      </td>
                      <td className="mono">{row.maven_id}</td>
                      <td className="mono">{row.merchant_reference ?? "—"}</td>
                      <td>
                        <span className={`pay-status-badge ${st.cls}`}>
                          {st.label}
                        </span>
                      </td>
                      <td>
                        <MethodLogo method={row.payment_type} />
                      </td>
                      <td className="mono">{row.mobile_no ?? "—"}</td>
                      <td>{row.account_name ?? "—"}</td>
                      <td className="mono">{row.user_account_number ?? "—"}</td>
                      <td>{row.bank_name ?? "—"}</td>
                      <td className="mono">{row.bank_ifsc ?? "—"}</td>
                      <td className="mono">{row.utr_number ?? "—"}</td>
                      <td className="mono">{row.currency ?? CURRENCY}</td>
                      <td className="mono">
                        {money(row.amount, row.currency ?? CURRENCY)}
                      </td>
                      <td className="mono">
                        {row.commission == null
                          ? "—"
                          : money(row.commission, row.currency ?? CURRENCY)}
                      </td>
                      <td className="mono">
                        {row.commission_percentage == null
                          ? "—"
                          : `${row.commission_percentage.toFixed(2)}%`}
                      </td>
                      <td>
                        {row.master_merchant ? (
                          <MerchantLogo merchant={row.master_merchant} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <MerchantLogo merchant={row.merchant} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && totalPages > 1 && (
          <div className="pager">
            <button
              className="btn-ghost btn-sm"
              disabled={page <= 1}
              onClick={() => setFilter({ page: page - 1 })}
            >
              → {t("السابق", "Prev")}
            </button>
            <PageSizeSelect
              value={pageSize}
              onChange={(n) => {
                setPageSize(n);
                setFilter({ page: 1 });
              }}
            />
            <span className="pager-info mono">
              {page} / {totalPages}
            </span>
            <button
              className="btn-ghost btn-sm"
              disabled={page >= totalPages}
              onClick={() => setFilter({ page: page + 1 })}
            >
              {t("التالي", "Next")} ←
            </button>
          </div>
        )}
      </section>
      {viewedProofUrl && (
        <ProofModal
          url={viewedProofUrl}
          title={t("إثبات الدفع", "Payment proof")}
          onClose={() => setViewedProofUrl(null)}
        />
      )}
      {(selected || detailLoading) && (
        <div
          className="drawer-backdrop"
          onClick={() => !decisionBusy && setSelected(null)}
        >
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {detailLoading && (
              <p className="sidebar-hint">{t("جارٍ التحميل…", "Loading…")}</p>
            )}
            {selected && (
              <>
                <div className="drawer-head">
                  <h3 className="mono">
                    {selected.ontarget_ref ?? selected.maven_id}
                  </h3>
                  <div className="row-actions">
                    {can("payouts", "can_edit") && !editing && (
                      <button
                        className="btn-ghost btn-sm icon-text-btn"
                        onClick={() => setEditing(true)}
                      >
                        <Pencil size={15} aria-hidden="true" />
                        {t("تعديل", "Edit")}
                      </button>
                    )}
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => setSelected(null)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="drawer-amount">
                  <span className="mono">
                    {money(selected.amount, CURRENCY)}
                  </span>
                  <span
                    className={`pay-status-badge ${statusMeta(selected.status).cls}`}
                  >
                    {statusMeta(selected.status).label}
                  </span>
                </div>
                {editing && can("payouts", "can_edit") && (
                  <section className="payout-edit-card">
                    <strong>{t("تعديل بيانات السحب", "Edit payout details")}</strong>
                    <div className="payout-edit-grid">
                      <label className="field-label">
                        {t("الحالة", "Status")}
                        <select
                          className="login-input"
                          value={editForm.status}
                          disabled={selected.status !== "PENDING" || !can("payouts", "can_approve")}
                          onChange={(e) => setEditForm((current) => ({ ...current, status: e.target.value }))}
                        >
                          <option value="PENDING">PENDING</option>
                          <option value="APPROVED">PAID</option>
                          <option value="DECLINED">DECLINED</option>
                        </select>
                      </label>
                      {(
                        [
                          ["account_name", t("اسم المستفيد", "Beneficiary name")],
                          ["mobile_no", t("رقم الهاتف", "Phone number")],
                          ["pay_by", t("طريقة الدفع", "Payment method")],
                          ["merchant", t("التاجر", "Merchant")],
                        ] as Array<[keyof PayoutEditForm, string]>
                      ).map(([key, label]) => (
                        <label className="field-label" key={key}>
                          {label}
                          <input
                            className="login-input"
                            value={editForm[key]}
                            onChange={(e) =>
                              setEditForm((current) => ({
                                ...current,
                                [key]: e.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                      <label className="field-label payout-edit-note">
                        {t("ملاحظة", "Note")}
                        <textarea
                          className="login-input"
                          rows={3}
                          value={editForm.remark}
                          onChange={(e) =>
                            setEditForm((current) => ({
                              ...current,
                              remark: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="field-label payout-edit-note">
                        {t("إثبات الدفع", "Payment proof")}
                        <span className="row-actions">
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,application/pdf"
                            disabled={uploading || !can("payouts", "can_approve")}
                            onChange={(e) => {
                              const file = e.target.files?.[0] ?? null;
                              if (!file) return;
                              void (async () => {
                                await uploadProof(file);
                              })();
                            }}
                          />
                          {(proofUrl || editForm.image_url) && (
                            <ProofIconButton url={proofUrl ?? editForm.image_url} onOpen={setViewedProofUrl} compact />
                          )}
                        </span>
                      </label>
                      {editForm.status === "APPROVED" && editForm.status !== selected.status && (
                        <label className="field-label payout-edit-note">
                          UTR
                          <input className="login-input mono" value={utr} onChange={(e) => setUtr(e.target.value)} />
                        </label>
                      )}
                    </div>
                    {editError && <p className="cell-sub danger-text">{editError}</p>}
                    <div className="row-actions">
                      <button
                        className="btn-primary icon-text-btn"
                        disabled={editBusy}
                        onClick={() => void saveEdit()}
                      >
                        <Save size={15} aria-hidden="true" />
                        {editBusy ? t("جارٍ الحفظ…", "Saving…") : t("حفظ", "Save")}
                      </button>
                      <button
                        className="btn-ghost icon-text-btn"
                        disabled={editBusy}
                        onClick={() => setEditing(false)}
                      >
                        <X size={15} aria-hidden="true" />
                        {t("إلغاء", "Cancel")}
                      </button>
                    </div>
                  </section>
                )}
                <dl className="detail-grid">
                  <dt>{t("رقم العملية", "Ref")}</dt>
                  <dd className="mono">{selected.maven_id}</dd>
                  <dt>{t("المستفيد", "Beneficiary")}</dt>
                  <dd>
                    {selected.account_name ?? "—"}{" "}
                    {selected.mobile_no && (
                      <span className="mono">({selected.mobile_no})</span>
                    )}
                  </dd>
                  <dt>{t("الطريقة", "Method")}</dt>
                  <dd>{selected.pay_by ?? "—"}</dd>
                  <dt>{t("التاجر", "Merchant")}</dt>
                  <dd>{selected.merchant ?? "—"}</dd>
                  <dt>{t("اعتمده", "Approved by")}</dt>
                  <dd>{selected.approved_by ?? "—"}</dd>
                </dl>
                {!!selected.actions?.length && (
                  <section className="payout-action-history">
                    <strong>{t("سجل الإجراءات", "Action history")}</strong>
                    {selected.actions.map((action) => (
                      <div className="payout-history-row" key={action.id}>
                        <span>{action.action}</span>
                        <span>{action.actor_name ?? "—"}</span>
                        <time>{new Date(action.created_at).toLocaleString()}</time>
                      </div>
                    ))}
                  </section>
                )}
                {selected.linked_sms && (
                  <section className="payout-linked-sms-card">
                    <div className="payout-linked-sms-head">
                      <MessageSquare size={18} aria-hidden="true" />
                      <strong>{t("رسالة WD مرتبطة", "Linked WD SMS")}</strong>
                      <span className="pay-status-badge st-paid">
                        #{selected.linked_sms.id}
                      </span>
                    </div>
                    <dl className="detail-grid">
                      <dt>UTR</dt>
                      <dd className="mono">
                        {selected.linked_sms.trx_id ??
                          selected.linked_sms.trx_reference ??
                          "—"}
                      </dd>
                      <dt>{t("رقم المستفيد", "Recipient")}</dt>
                      <dd className="mono">
                        {selected.linked_sms.receiver_number ?? "—"}
                      </dd>
                      <dt>{t("المبلغ", "Amount")}</dt>
                      <dd className="mono">
                        {money(selected.linked_sms.amount, CURRENCY)}
                      </dd>
                    </dl>
                  </section>
                )}
                {selected.image_url && (
                  <ProofIconButton
                    url={selected.image_url}
                    onOpen={setViewedProofUrl}
                  />
                )}
                {decisionErr && <div className="card warn">{decisionErr}</div>}
                {decisionResult &&
                  (decisionResult.executed_on_provider ? (
                    <div className="card">
                      <strong>
                        {t(
                          "نُفِّذ على المزوّد وتأكّد.",
                          "Executed on the provider and verified.",
                        )}
                      </strong>
                      <br />
                      {t(
                        "حالة المزوّد بعد التنفيذ:",
                        "Provider status after execution:",
                      )}{" "}
                      <span className="mono">
                        {decisionResult.after_status ?? "—"}
                      </span>
                      <br />
                      <span className="mono">
                        audit_log_id: {decisionResult.audit_log_id ?? "—"} ·
                        executed_on_provider: true
                      </span>
                    </div>
                  ) : (
                    <div className="card warn">
                      <strong>
                        {t("تم تسجيل القرار فقط.", "Decision recorded only.")}
                      </strong>
                      <br />
                      {t(
                        "التنفيذ على بوابة المزوّد لم يتم من هنا — نفّذه بنفسك.",
                        "Provider execution did not happen from here — do it yourself on the portal.",
                      )}
                      <br />
                      <span className="mono">
                        audit_log_id: {decisionResult.audit_log_id ?? "—"} ·
                        executed_on_provider: false
                      </span>
                    </div>
                  ))}
                {selected.status === "PENDING" &&
                  can("payouts", "can_approve") &&
                  !decisionResult && (
                    <div className="drawer-actions">
                      <label
                        className="btn-ghost btn-sm"
                        style={{ cursor: uploading ? "wait" : "pointer" }}
                      >
                        📎{" "}
                        {uploading
                          ? t("جارٍ رفع الإثبات…", "Uploading proof…")
                          : (proofName ??
                            t(
                              "رفع Screenshot الدفع",
                              "Upload payment screenshot",
                            ))}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          hidden
                          disabled={uploading}
                          onChange={(e) =>
                            void uploadProof(e.target.files?.[0] ?? null)
                          }
                        />
                      </label>
                      <textarea
                        className="login-input"
                        rows={3}
                        value={remark}
                        onChange={(e) => setRemark(e.target.value)}
                        placeholder={t("ملاحظة اختيارية", "Optional note")}
                      />
                      {execSettings?.auto_execute_enabled && (
                        <>
                          <label className="field-label">
                            {t(
                              "رقم التحويل UTR (إلزامي)",
                              "Transfer reference / UTR (required)",
                            )}
                          </label>
                          <input
                            className="login-input"
                            dir="ltr"
                            value={utr}
                            onChange={(e) => setUtr(e.target.value)}
                            placeholder={t(
                              "رقم التحويل الفعلي",
                              "The real transfer reference",
                            )}
                          />
                        </>
                      )}
                      <p className="drawer-note">
                        {execSettings?.auto_execute_enabled
                          ? t(
                              "سيُرسل Screenshot وUTR إلى NagoPay ويضع السحب PAID، ثم يعيد قراءة حالة المزوّد قبل تسجيل النجاح.",
                              "This sends the screenshot and UTR to NagoPay, marks the payout PAID, then reads the provider status back before recording success.",
                            )
                          : t(
                              "إجراءات NagoPay المباشرة متوقفة. فعّل التنفيذ المباشر أولاً؛ لن يسجّل هذا النموذج قراراً يدوياً مضللاً.",
                              "Live NagoPay actions are disabled. Enable live execution first; this form will not record a misleading manual decision.",
                            )}
                      </p>
                      {!execSettings?.auto_execute_enabled && (
                        <p className="cell-sub">
                          {t(
                            "التنفيذ الآلي مُطفأ حالياً.",
                            "Automatic execution is currently switched off.",
                          )}
                        </p>
                      )}
                      <button
                        className="btn-primary"
                        disabled={
                          decisionBusy ||
                          uploading ||
                          !proofUrl ||
                          !execSettings?.auto_execute_enabled ||
                          !utr.trim()
                        }
                        onClick={() => void decide("APPROVED")}
                      >
                        {decisionBusy
                          ? t("جارٍ التحقق من NagoPay…", "Verifying NagoPay…")
                          : t("مدفوع على NagoPay", "Paid on NagoPay")}
                      </button>
                      <button
                        className="btn-ghost danger"
                        disabled={
                          decisionBusy ||
                          uploading ||
                          !execSettings?.auto_execute_enabled
                        }
                        onClick={() => {
                          if (
                            window.confirm(
                              t(
                                "تأكيد رفض هذا السحب مباشرة على NagoPay؟",
                                "Decline this payout live on NagoPay?",
                              ),
                            )
                          )
                            void decide("DECLINED");
                        }}
                      >
                        {t("رفض على NagoPay", "Decline on NagoPay")}
                      </button>
                    </div>
                  )}
                {selected.status === "PENDING" &&
                  !can("payouts", "can_approve") && (
                    <p className="drawer-note">
                      {t("لا تملك صلاحية", "You lack")}{" "}
                      <span className="mono">can_approve</span>{" "}
                      {t("الفعلية على صفحة السحوبات.", "on the payouts page.")}
                    </p>
                  )}
              </>
            )}
          </aside>
        </div>
      )}
    </PanelShell>
  );
}
