import React, { useState } from 'react';
import {
  Database,
  Plus,
  RefreshCw,
  ExternalLink,
  Table,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  Layers,
  Sparkles,
} from 'lucide-react';
import { DataSource, RawRow } from '../../types';
import { parseCSVToRawRows } from '../../utils/dataEngine';
import { useLanguage } from '../../context/LanguageContext';

class ApiRouteUnavailableError extends Error {}

interface GoogleSheetRef {
  spreadsheetId: string;
  gid?: string;
}

interface GvizResponse {
  status?: string;
  errors?: Array<{ message?: string; detailed_message?: string }>;
  table?: {
    cols?: Array<{ id?: string; label?: string }>;
    rows?: Array<{ c?: Array<{ v?: unknown; f?: string | null } | null> }>;
  };
}

function extractGoogleSheetRef(value: string): GoogleSheetRef {
  const input = value.trim();
  const urlMatch = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const rawIdMatch = /^[a-zA-Z0-9-_]{20,}$/.test(input);

  const spreadsheetId = urlMatch?.[1] || (rawIdMatch ? input : '');
  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheets URL or ID. Please paste a standard share link.');
  }

  let gid: string | undefined;
  if (urlMatch) {
    try {
      const parsed = new URL(input);
      gid =
        parsed.searchParams.get('gid') ||
        parsed.hash.match(/(?:^|[&#])gid=(\d+)/)?.[1] ||
        undefined;
    } catch {
      gid = input.match(/[?#&]gid=(\d+)/)?.[1];
    }
  }

  return { spreadsheetId, gid };
}

function valueToString(value: unknown, formattedValue?: string | null): string {
  if (formattedValue != null) return formattedValue;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeColumns(columns: string[]): string[] {
  const seen = new Map<string, number>();

  return columns.map((column, index) => {
    const baseName = column.trim() || `Column ${index + 1}`;
    const count = seen.get(baseName) || 0;
    seen.set(baseName, count + 1);
    return count === 0 ? baseName : `${baseName} (${count + 1})`;
  });
}

function gvizTableToRows(payload: GvizResponse): { columns: string[]; rows: RawRow[] } {
  if (payload.status && payload.status !== 'ok') {
    const details = payload.errors?.[0]?.detailed_message || payload.errors?.[0]?.message;
    throw new Error(details || 'Google Sheets could not return this spreadsheet. Ensure link sharing is public.');
  }

  const table = payload.table;
  if (!table?.cols || !table.rows) {
    throw new Error('Spreadsheet returned an unexpected response.');
  }

  const columns = normalizeColumns(
    table.cols.map((column, index) => column.label || column.id || `Column ${index + 1}`)
  );

  const rows = table.rows
    .map((row) => {
      const result: RawRow = {};
      columns.forEach((column, index) => {
        const cell = row.c?.[index];
        result[column] = cell ? valueToString(cell.v, cell.f) : '';
      });
      return result;
    })
    .filter((row) => Object.values(row).some((value) => value.trim() !== ''));

  return { columns, rows };
}

async function fetchSheetThroughApi(sheetUrl: string): Promise<{ columns: string[]; rows: RawRow[] }> {
  let response: Response;

  try {
    response = await fetch('/api/sheets/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sheetUrl }),
    });
  } catch {
    throw new ApiRouteUnavailableError('Google Sheets API route is unavailable.');
  }

  // A missing API route in an SPA usually returns index.html. Read text first so
  // an HTML fallback cannot crash the UI with "Unexpected token '<'".
  const rawResponse = await response.text();
  const trimmed = rawResponse.trim();

  if (
    response.status === 404 ||
    response.status === 405 ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html')
  ) {
    throw new ApiRouteUnavailableError('Google Sheets API route returned HTML instead of JSON.');
  }

  let data: any;
  try {
    data = trimmed ? JSON.parse(trimmed) : {};
  } catch {
    throw new ApiRouteUnavailableError('Google Sheets API route returned a non-JSON response.');
  }

  if (!response.ok) {
    throw new Error(data.error || 'Failed to connect Google Sheet.');
  }

  if (typeof data.rawCsv !== 'string') {
    throw new ApiRouteUnavailableError('Google Sheets API response is missing CSV data.');
  }

  return parseCSVToRawRows(data.rawCsv);
}

function fetchSheetThroughGviz(
  spreadsheetId: string,
  gid?: string
): Promise<{ columns: string[]; rows: RawRow[] }> {
  return new Promise((resolve, reject) => {
    const callbackName = `__eventDataHubSheet_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const script = document.createElement('script');
    let timeoutId: number | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      script.remove();
      delete (window as any)[callbackName];
    };

    (window as any)[callbackName] = (payload: GvizResponse) => {
      try {
        resolve(gvizTableToRows(payload));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    };

    const query = new URLSearchParams();
    query.set('tqx', `responseHandler:${callbackName}`);
    query.set('headers', '1');
    if (gid) query.set('gid', gid);

    script.src = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?${query.toString()}`;
    script.async = true;
    script.onerror = () => {
      cleanup();
      reject(
        new Error(
          'Unable to access Google Sheet. Ensure the spreadsheet is public and try again.'
        )
      );
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Google Sheet request timed out. Please try again.'));
    }, 15000);

    document.head.appendChild(script);
  });
}

async function loadPublicGoogleSheet(
  sheetUrl: string
): Promise<{ columns: string[]; rows: RawRow[] }> {
  const { spreadsheetId, gid } = extractGoogleSheetRef(sheetUrl);

  try {
    return await fetchSheetThroughApi(sheetUrl);
  } catch (error) {
    if (!(error instanceof ApiRouteUnavailableError)) {
      throw error;
    }

    // AI Studio/Vite previews can occasionally serve the SPA HTML for /api
    // requests. Google Visualization supports a JSONP response handler for
    // public Sheets, so use it as a browser-safe fallback.
    return fetchSheetThroughGviz(spreadsheetId, gid);
  }
}

interface DataSourcesPageProps {
  sources: DataSource[];
  onAddSource: (newSource: DataSource) => void;
  onLoadDemo: () => void;
  onNavigate: (page: string) => void;
}

export const DataSourcesPage: React.FC<DataSourcesPageProps> = ({
  sources,
  onAddSource,
  onLoadDemo,
  onNavigate,
}) => {
  const { t } = useLanguage();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleConnectSheet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheetUrl.trim()) return;

    setIsLoading(true);
    setErrorMsg('');

    try {
      const { columns, rows } = await loadPublicGoogleSheet(sheetUrl);

      if (columns.length === 0 || rows.length === 0) {
        throw new Error('Spreadsheet appears to be empty or unreadable.');
      }

      const newSource: DataSource = {
        id: `src-custom-${Date.now()}`,
        name: customName.trim() || `Connected Sheet ${sources.length + 1}`,
        sheetName: 'Sheet1',
        rowCount: rows.length,
        columnCount: columns.length,
        columns,
        sampleRows: rows.slice(0, 4),
        fullRows: rows,
        status: 'connected',
        lastSynced: 'Just now',
        url: sheetUrl,
        isDemo: false,
      };

      onAddSource(newSource);
      setIsModalOpen(false);
      setSheetUrl('');
      setCustomName('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error connecting spreadsheet. Ensure link is public.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-8 animate-fadeIn pb-12">
      {/* Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-slate-200/80 shadow-2xs">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Database className="w-5 h-5 text-blue-600" />
            <span>{t.dataSourcesTitle}</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t.dataSourcesSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onLoadDemo}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{t.loadDemoAction}</span>
          </button>

          <button
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            <span>+ {t.addGoogleSheet}</span>
          </button>
        </div>
      </div>

      {/* SCHEMA INCONSISTENCY EXPLANATION BANNER */}
      <div className="bg-amber-50/80 border border-amber-200/80 rounded-2xl p-5 space-y-2">
        <div className="flex items-center gap-2 text-amber-800 text-sm font-bold">
          <Sparkles className="w-4 h-4 text-amber-600" />
          <span>{t.demoDataLoaded}</span>
        </div>
        <p className="text-xs text-amber-700 leading-relaxed">
          {t.demoNotice}
        </p>
      </div>

      {/* DATA SOURCES GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {sources.map((source) => (
          <div
            key={source.id}
            className="bg-white rounded-2xl border border-slate-200/80 shadow-2xs hover:shadow-xs transition p-6 flex flex-col justify-between space-y-6"
          >
            {/* Source Header */}
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                    <FileSpreadsheet className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">{source.name}</h3>
                    <p className="text-xs text-slate-500">{source.sheetName}</p>
                  </div>
                </div>

                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              </div>

              {/* Stats pill */}
              <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs">
                <div>
                  <span className="text-slate-400 font-medium">{t.rows}</span>
                  <p className="font-bold text-slate-900 text-sm">{source.rowCount}</p>
                </div>
                <div>
                  <span className="text-slate-400 font-medium">{t.columns}</span>
                  <p className="font-bold text-slate-900 text-sm">{source.columnCount}</p>
                </div>
              </div>

              {/* Column headers list */}
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Detected Column Schema
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {source.columns.map((col, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-mono font-medium border border-slate-200/60"
                    >
                      {col}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer timestamp & action */}
            <div className="pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <span>Synced {source.lastSynced}</span>
              <button
                onClick={() => onNavigate('normalize')}
                className="text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1"
              >
                {t.runAiNormalize} <Sparkles className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Action CTA to Page 3 */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-6 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-md">
        <div>
          <h3 className="text-base font-bold">{t.normalizeTitle}</h3>
          <p className="text-xs text-blue-100 mt-0.5">
            {t.normalizeSubtitle}
          </p>
        </div>
        <button
          onClick={() => onNavigate('normalize')}
          className="px-5 py-2.5 bg-white text-blue-700 font-bold text-xs rounded-xl shadow-sm hover:bg-blue-50 transition shrink-0"
        >
          {t.runAiNormalize}
        </button>
      </div>

      {/* CONNECT GOOGLE SHEET MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 space-y-6 shadow-xl border border-slate-200 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-slate-900">{t.addGoogleSheet}</h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              {t.pasteSheetUrl}
            </p>

            <form onSubmit={handleConnectSheet} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  {t.sheetNameLabel}
                </label>
                <input
                  type="text"
                  placeholder="e.g., Vietnam Tech Expo 2026"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  {t.pasteSheetUrl} *
                </label>
                <input
                  type="text"
                  required
                  placeholder="https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"
                  value={sheetUrl}
                  onChange={(e) => setSheetUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                />
              </div>

              {errorMsg && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs rounded-xl shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>{t.fetchingSheet}</span>
                    </>
                  ) : (
                    <span>{t.connectSheet}</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
