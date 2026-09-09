import { Check, ChevronDown, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

export interface MultiSelectOption {
  value: string
  label: string
  count?: number
}

interface Props {
  label: string
  allLabel: string
  options: MultiSelectOption[]
  value: string[]
  onChange: (value: string[]) => void
  className?: string
}

export const splitFilterValues = (value: string | null | undefined): string[] =>
  [...new Set(String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean))]

export const toggleFilterValue = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value]

export default function MultiSelectFilter({ label, allLabel, options, value, onChange, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => new Set(value), [value])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return options.filter((option) => !needle || option.label.toLowerCase().includes(needle))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('.multi-select-trigger')?.focus() }
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])

  const summary = value.length === 0
    ? allLabel
    : value.length === 1
      ? options.find((option) => option.value === value[0])?.label ?? value[0]
      : `${value.length} selected`

  return (
    <div className={`multi-select-filter ${className}`.trim()} ref={rootRef}>
      <button type="button" className="multi-select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span><small>{label}</small><strong>{summary}</strong></span>
        {value.length > 0 && <b className="multi-select-count">{value.length}</b>}
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="multi-select-menu">
          {options.length > 6 && <label className="multi-select-search"><Search size={14}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search…" /></label>}
          <div className="multi-select-actions">
            <button type="button" onClick={() => onChange(options.map((option) => option.value))}>{options.length === value.length ? 'Selected all' : 'Select all'}</button>
            <button type="button" onClick={() => onChange([])} disabled={value.length === 0}><X size={12}/> Clear</button>
          </div>
          <div className="multi-select-options" role="listbox" aria-multiselectable="true" aria-label={label}>
            {visible.map((option) => {
              const active = selected.has(option.value)
              return <button type="button" role="option" aria-selected={active} className={active ? 'selected' : ''} key={option.value} onClick={() => onChange(toggleFilterValue(value, option.value))}>
                <span className="multi-select-check">{active && <Check size={13}/>}</span>
                <span>{option.label}</span>
                {option.count != null && <small>{option.count.toLocaleString('en-US')}</small>}
              </button>
            })}
            {visible.length === 0 && <p className="multi-select-empty">No matching options</p>}
          </div>
        </div>
      )}
    </div>
  )
}
