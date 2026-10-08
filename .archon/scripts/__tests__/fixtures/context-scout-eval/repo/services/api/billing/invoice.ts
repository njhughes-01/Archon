export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Invoice {
  lines: InvoiceLine[];
  taxRate: number;
  totalCents: number;
}

/** Recomputes an invoice and reports every way its numbers do not add up. */
export function validateInvoice(invoice: Invoice): string[] {
  const problems: string[] = [];
  if (invoice.lines.length === 0) problems.push('an invoice needs at least one line');
  for (const [index, line] of invoice.lines.entries()) {
    if (line.quantity <= 0) problems.push(`line ${index + 1}: quantity must be positive`);
    if (line.unitPriceCents < 0) problems.push(`line ${index + 1}: price cannot be negative`);
  }
  if (invoice.taxRate < 0 || invoice.taxRate > 0.3) problems.push('tax rate is out of range');

  const subtotal = invoice.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  const expected = Math.round(subtotal * (1 + invoice.taxRate));
  if (expected !== invoice.totalCents) problems.push(`total should be ${expected}`);
  return problems;
}
