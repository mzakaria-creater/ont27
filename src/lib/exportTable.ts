// Shared CSV/XLSX export for any page showing a row of transactions.
// One implementation instead of copy-pasting the ExcelJS dance on every
// page — columns are passed in per page since each table has different
// fields, but the download mechanics (file naming, header styling,
// autofilter, blob creation) stay identical everywhere.

export interface ExportColumn<T> {
  header: string
  key: string
  width?: number
  value: (row: T) => string | number | null | undefined
  numFmt?: string
}

function timestamp() {
  return new Date().toISOString().slice(0, 10)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function exportCsv<T>(rows: T[], columns: ExportColumn<T>[], baseName: string) {
  const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const lines = [
    columns.map((col) => col.header),
    ...rows.map((row) => columns.map((col) => col.value(row))),
  ].map((line) => line.map(esc).join(','))
  triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `${baseName}-${timestamp()}.csv`)
}

export async function exportXlsx<T>(rows: T[], columns: ExportColumn<T>[], baseName: string, sheetName = 'Sheet1') {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'OnTarget'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = columns.map((col) => ({ header: col.header, key: col.key, width: col.width ?? 18 }))
  rows.forEach((row) => {
    const record: Record<string, unknown> = {}
    for (const col of columns) record[col.key] = col.value(row)
    sheet.addRow(record)
  })
  sheet.getRow(1).font = { bold: true, color: { argb: 'FF111827' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7B84B' } }
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columns.length)}1` }
  for (const col of columns) {
    if (col.numFmt) sheet.getColumn(col.key).numFmt = col.numFmt
  }
  const bytes = await workbook.xlsx.writeBuffer()
  triggerDownload(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${baseName}-${timestamp()}.xlsx`)
}
