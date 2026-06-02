import * as XLSX from 'xlsx';

/** A validated opportunity row ready for insertion (tenant/owner added later). */
export interface ParsedOpportunity {
  name: string;
  account_name: string;
  stage: string;
  estimated_revenue: string;
}

/** A precise, per-cell validation failure for the import error report. */
export interface RowError {
  /** 1-based spreadsheet row number (header is row 1, first data row is 2). */
  row: number;
  /** The offending column header. */
  column: string;
  value: unknown;
  message: string;
}

export interface ParseResult {
  rows: ParsedOpportunity[];
  errors: RowError[];
}

export const REQUIRED_COLUMNS = [
  'Opportunity Name',
  'Account Name',
  'Stage',
  'Estimated Revenue',
] as const;

type RawRow = Record<string, unknown>;

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Normalize an estimated-revenue cell to a numeric string, or null if invalid. */
function normalizeRevenue(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : null;
  }
  if (typeof value === 'string') {
    // Tolerate common spreadsheet formatting like "$1,250.50".
    const cleaned = value.replace(/[$,\s]/g, '');
    if (cleaned === '' || Number.isNaN(Number(cleaned))) {
      return null;
    }
    return cleaned;
  }
  return null;
}

/**
 * Parse and validate an uploaded .xlsx/.csv buffer into opportunity rows.
 *
 * Returns both the parsed rows and a list of per-cell errors. The caller MUST
 * treat a non-empty `errors` array as a hard abort and insert nothing — this
 * function never partially accepts a file.
 */
export function parseOpportunityWorkbook(buffer: Buffer): ParseResult {
  const errors: RowError[] = [];
  const rows: ParsedOpportunity[] = [];

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    errors.push({ row: 0, column: '*', value: null, message: 'Workbook contains no sheets' });
    return { rows, errors };
  }
  const sheet = workbook.Sheets[sheetName]!;

  // Header detection via array-of-arrays so we can report missing columns.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  const header = (aoa[0] ?? []).map((h) => (typeof h === 'string' ? h.trim() : String(h ?? '')));

  const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
  if (missing.length > 0) {
    for (const col of missing) {
      errors.push({ row: 1, column: col, value: null, message: `Missing required column "${col}"` });
    }
    return { rows, errors };
  }

  const records = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null, blankrows: false });
  if (records.length === 0) {
    errors.push({ row: 1, column: '*', value: null, message: 'No data rows found' });
    return { rows, errors };
  }

  records.forEach((record, index) => {
    const rowNumber = index + 2; // account for the header row

    const name = record['Opportunity Name'];
    const account = record['Account Name'];
    const stage = record['Stage'];
    const revenueRaw = record['Estimated Revenue'];

    let rowOk = true;

    if (isBlank(name)) {
      errors.push({ row: rowNumber, column: 'Opportunity Name', value: name, message: 'Required value is empty' });
      rowOk = false;
    }
    if (isBlank(account)) {
      errors.push({ row: rowNumber, column: 'Account Name', value: account, message: 'Required value is empty' });
      rowOk = false;
    }
    if (isBlank(stage)) {
      errors.push({ row: rowNumber, column: 'Stage', value: stage, message: 'Required value is empty' });
      rowOk = false;
    }

    const revenue = normalizeRevenue(revenueRaw);
    if (isBlank(revenueRaw)) {
      errors.push({ row: rowNumber, column: 'Estimated Revenue', value: revenueRaw, message: 'Required value is empty' });
      rowOk = false;
    } else if (revenue === null) {
      errors.push({ row: rowNumber, column: 'Estimated Revenue', value: revenueRaw, message: 'Must be a valid number' });
      rowOk = false;
    }

    if (rowOk && revenue !== null) {
      rows.push({
        name: String(name).trim(),
        account_name: String(account).trim(),
        stage: String(stage).trim(),
        estimated_revenue: revenue,
      });
    }
  });

  return { rows, errors };
}
