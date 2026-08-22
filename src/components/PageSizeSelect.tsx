import { PAGE_SIZES } from '../lib/pageSize'
import { useLocale } from '../lib/locale'

// Rows-per-page control, rendered inside the pager next to the page numbers.
// Changing the size resets to page 1 — staying on page 9 after switching from
// 20 to 500 rows would land past the end of most result sets.
export default function PageSizeSelect({
  value, onChange,
}: { value: number; onChange: (n: number) => void }) {
  const { t } = useLocale()
  return (
    <label className="pager-size">
      <span className="pager-info">{t('صفوف', 'Rows')}</span>
      <select
        className="filter-select"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={t('عدد الصفوف في الصفحة', 'Rows per page')}
      >
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  )
}
