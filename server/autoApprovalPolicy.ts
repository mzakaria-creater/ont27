// Payment methods that must never be approved automatically. They may still
// be linked to an SMS as evidence, but a human must execute the provider
// decision.
export function isWalidCompanyMethod(value: unknown): boolean {
  return /\bwalid\s+company\s+ltd\b/i.test(String(value ?? '').replace(/\s+/g, ' ').trim())
}
