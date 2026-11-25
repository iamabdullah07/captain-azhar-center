import { useCallback, useEffect, useState } from 'react';
import {
  Ban,
  CheckCircle,
  FileText,
  Film,
  Flag,
  HardDrive,
  Image as ImageIcon,
  Link2,
  LogOut,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import { AdminGeminiSettings } from '../components/AdminGeminiSettings';
import { adminApi } from '../lib/api';
import { formatBytes } from '../lib/fileCheck';

interface AdminDashboardProps {
  ownerEmail: string;
  onLoggedOut: () => void;
}

type DashboardTab = 'files' | 'reports' | 'logs' | 'gemini' | 'settings';

export function AdminDashboard({ ownerEmail, onLoggedOut }: AdminDashboardProps) {
  const [tab, setTab] = useState<DashboardTab>('files');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<Awaited<ReturnType<typeof adminApi.stats>> | null>(null);
  const [filesData, setFilesData] = useState<Awaited<ReturnType<typeof adminApi.files>> | null>(null);
  const [reports, setReports] = useState<Awaited<ReturnType<typeof adminApi.reports>>['reports']>([]);

  const [searchQ, setSearchQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  // Settings form state
  const [triggerPct, setTriggerPct] = useState(80);
  const [targetPct, setTargetPct] = useState(70);
  const [expireMonths, setExpireMonths] = useState<string>('');
  const [runningCleanup, setRunningCleanup] = useState(false);

  const loadStatsAndReports = useCallback(async () => {
    const [s, r] = await Promise.all([adminApi.stats(), adminApi.reports()]);
    setStats(s);
    setReports(r.reports);
    setTriggerPct(s.triggerPct);
    setTargetPct(s.targetPct);
    setExpireMonths(s.expireLinksMonths ? String(s.expireLinksMonths) : '');
  }, []);

  const loadFiles = useCallback(async () => {
    const f = await adminApi.files({
      q: searchQ,
      type: typeFilter,
      status: statusFilter,
      page,
    });
    setFilesData(f);
  }, [searchQ, typeFilter, statusFilter, page]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadStatsAndReports(), loadFiles()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, [loadStatsAndReports, loadFiles]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleLogout = async () => {
    await adminApi.logout().catch(() => {});
    onLoggedOut();
  };

  const handleManualCleanup = async () => {
    setRunningCleanup(true);
    setNotice(null);
    setError(null);
    try {
      const res = await adminApi.runCleanup();
      setNotice(
        `Cleanup finished: ${res.filesDeleted} files removed, ${formatBytes(res.bytesFreed)} freed.`
      );
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed.');
    } finally {
      setRunningCleanup(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await adminApi.deleteFile(id);
      setNotice(`Item ${id} deleted.`);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  const handleToggleBlock = async (id: string, currentStatus: string) => {
    setError(null);
    const action = currentStatus === 'blocked' ? 'unblock' : 'block';
    try {
      await adminApi.blockItem(id, action);
      setNotice(`Item ${id} ${action === 'block' ? 'blocked' : 'unblocked'}.`);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    }
  };

  const handleResolveReport = async (reportId: number) => {
    try {
      await adminApi.resolveReport(reportId);
      await loadStatsAndReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve report.');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const exp = expireMonths.trim() ? Number.parseInt(expireMonths.trim(), 10) : null;
      await adminApi.updateSettings({
        triggerPct,
        targetPct,
        expireLinksMonths: exp,
      });
      setNotice('Cleanup & retention settings saved.');
      await loadStatsAndReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update settings.');
    }
  };

  const pct = stats?.percentUsed ?? 0;
  const barColor =
    pct >= (stats?.triggerPct ?? 80)
      ? 'bg-rose-500'
      : pct >= 70
      ? 'bg-[#D9A441]'
      : 'bg-emerald-500';

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Top Header */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <h1 className="text-xl font-extrabold text-[#0A1832]">Owner Admin Dashboard</h1>
          <p className="text-xs text-slate-500">Signed in as {ownerEmail}</p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={refreshAll}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-[#0A1832] hover:bg-slate-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#0A1832] text-white text-xs font-bold hover:bg-[#13294B] cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5 text-[#D9A441]" />
            Logout
          </button>
        </div>
      </div>

      {notice && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-sm">
          {notice}
        </div>
      )}
      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Storage Usage & Quick Stats */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-[#0A1832]">
                <HardDrive className="w-4 h-4 text-[#D9A441]" />
                <span>R2 Storage Usage</span>
              </div>
              <span className="text-sm font-extrabold text-[#0A1832]">
                {formatBytes(stats.totalBytes)} / 10 GB ({pct}%)
              </span>
            </div>

            <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full ${barColor} transition-all`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                Auto-cleanup: <strong>{stats.triggerPct}%</strong> &rarr;{' '}
                <strong>{stats.targetPct}%</strong>
              </span>
              <span>
                Oldest file:{' '}
                {stats.oldestActiveFileDate
                  ? new Date(stats.oldestActiveFileDate).toLocaleDateString()
                  : 'None'}
              </span>
            </div>

            <button
              type="button"
              onClick={handleManualCleanup}
              disabled={runningCleanup}
              className="w-full py-2 px-3 rounded-xl border border-slate-200 hover:border-[#0A1832] text-xs font-bold text-[#0A1832] transition cursor-pointer disabled:opacity-50"
            >
              {runningCleanup ? 'Running Cleanup...' : 'Run Storage Cleanup Now'}
            </button>
          </div>

          <div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: 'Images', count: stats.countsByType.image ?? 0, icon: ImageIcon },
              { label: 'Documents', count: stats.countsByType.document ?? 0, icon: FileText },
              { label: 'Videos', count: stats.countsByType.video ?? 0, icon: Film },
              { label: 'Links', count: stats.countsByType.link ?? 0, icon: Link2 },
              { label: 'Open Reports', count: stats.unresolvedReportsCount, icon: Flag },
            ].map(({ label, count, icon: Icon }) => (
              <div
                key={label}
                className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col justify-between shadow-xs"
              >
                <Icon className="w-4 h-4 text-[#D9A441]" />
                <div className="mt-3">
                  <div className="text-2xl font-extrabold text-[#0A1832]">{count}</div>
                  <div className="text-xs text-slate-500">{label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['files', 'Files & Links'],
            ['reports', `Abuse Reports (${stats?.unresolvedReportsCount ?? 0})`],
            ['logs', 'Cleanup & Login Logs'],
            ['gemini', 'Gemini AI Keys'],
            ['settings', 'Cleanup Settings'],
          ] as Array<[DashboardTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition cursor-pointer ${
              tab === id
                ? 'bg-[#0A1832] text-[#D9A441]'
                : 'bg-white border border-slate-200 text-slate-600 hover:text-[#0A1832]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab 1: Files & Links */}
      {tab === 'files' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQ}
                onChange={(e) => {
                  setSearchQ(e.target.value);
                  setPage(1);
                }}
                placeholder="Search by ID, filename, or URL..."
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm outline-none focus:border-[#0A1832]"
              />
            </div>

            <select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 rounded-xl border border-slate-300 text-sm bg-white"
            >
              <option value="">All Types</option>
              <option value="image">Image</option>
              <option value="document">Document</option>
              <option value="video">Video</option>
              <option value="link">Link</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 rounded-xl border border-slate-300 text-sm bg-white"
            >
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="removed">Removed</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2.5 pr-3 font-semibold">ID</th>
                  <th className="py-2.5 pr-3 font-semibold">Type</th>
                  <th className="py-2.5 pr-3 font-semibold">Name / Target</th>
                  <th className="py-2.5 pr-3 font-semibold">Size</th>
                  <th className="py-2.5 pr-3 font-semibold">Created</th>
                  <th className="py-2.5 pr-3 font-semibold">Status</th>
                  <th className="py-2.5 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(filesData?.items ?? []).map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70">
                    <td className="py-3 pr-3 font-mono text-xs text-[#0A1832]">{item.id}</td>
                    <td className="py-3 pr-3 capitalize">{item.type}</td>
                    <td className="py-3 pr-3 max-w-[260px] truncate text-slate-600">
                      {item.original_name || item.target_url || '-'}
                    </td>
                    <td className="py-3 pr-3 whitespace-nowrap">
                      {item.size_bytes > 0 ? formatBytes(item.size_bytes) : '-'}
                    </td>
                    <td className="py-3 pr-3 whitespace-nowrap text-slate-500">
                      {new Date(item.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 pr-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                          item.status === 'active'
                            ? 'bg-emerald-50 text-emerald-700'
                            : item.status === 'blocked'
                            ? 'bg-rose-50 text-rose-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="py-3 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => handleToggleBlock(item.id, item.status)}
                        title={item.status === 'blocked' ? 'Unblock' : 'Block'}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 hover:border-amber-400 text-xs font-semibold text-slate-700 cursor-pointer"
                      >
                        <Ban className="w-3 h-3" />
                        {item.status === 'blocked' ? 'Unblock' : 'Block'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        title="Delete permanently"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {(filesData?.items.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      No matching items found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {filesData && filesData.total > filesData.pageSize && (
            <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
              <span>
                Page {filesData.page} of {Math.ceil(filesData.total / filesData.pageSize)} ({filesData.total}{' '}
                items)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer"
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={page * filesData.pageSize >= filesData.total}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Abuse Reports */}
      {tab === 'reports' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-xs">
          {reports.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No abuse reports submitted.</p>
          ) : (
            reports.map((rep) => (
              <div
                key={rep.id}
                className="border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-bold text-[#0A1832]">{rep.file_id}</span>
                    <span className="text-slate-400">
                      {new Date(rep.time).toLocaleString()}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        rep.resolved ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-800'
                      }`}
                    >
                      {rep.resolved ? 'Resolved' : 'Open'}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700">{rep.reason}</p>
                  {(rep.original_name || rep.target_url) && (
                    <p className="text-xs text-slate-500 truncate max-w-xl">
                      Target: {rep.original_name || rep.target_url} ({rep.item_status})
                    </p>
                  )}
                </div>

                {!rep.resolved && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleToggleBlock(rep.file_id, 'active')}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold cursor-pointer"
                    >
                      Block Item
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResolveReport(rep.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold cursor-pointer"
                    >
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 3: Cleanup & Login Logs */}
      {tab === 'logs' && stats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <h3 className="font-bold text-[#0A1832] mb-3 text-sm">Storage Cleanup Runs</h3>
            <div className="space-y-2 text-xs">
              {stats.cleanupLogs.length === 0 && (
                <p className="text-slate-400 py-4 text-center">No cleanup runs logged yet.</p>
              )}
              {stats.cleanupLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center justify-between border-b border-slate-100 pb-2"
                >
                  <div>
                    <div className="font-semibold text-[#0A1832] capitalize">
                      {log.trigger} trigger &middot; {log.files_deleted} deleted
                    </div>
                    <div className="text-slate-400">{new Date(log.run_time).toLocaleString()}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-emerald-700">
                      -{formatBytes(log.bytes_freed)}
                    </div>
                    <div className="text-slate-400">After: {formatBytes(log.total_after)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <h3 className="font-bold text-[#0A1832] mb-3 text-sm">Recent Admin Login Attempts</h3>
            <div className="space-y-2 text-xs">
              {stats.loginAttempts.length === 0 && (
                <p className="text-slate-400 py-4 text-center">No login attempts recorded.</p>
              )}
              {stats.loginAttempts.map((attempt) => (
                <div
                  key={attempt.id}
                  className="flex items-center justify-between border-b border-slate-100 pb-2"
                >
                  <div>
                    <div className="font-mono text-[#0A1832]">{attempt.ip}</div>
                    <div className="text-slate-400">{new Date(attempt.time).toLocaleString()}</div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full font-bold ${
                      attempt.success
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {attempt.success ? 'Success' : 'Failed'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: Gemini AI Keys & Extraction Settings */}
      {tab === 'gemini' && (
        <AdminGeminiSettings onNotice={setNotice} onError={setError} />
      )}

      {/* Tab 5: Settings */}
      {tab === 'settings' && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-white rounded-2xl border border-slate-200 p-6 max-w-lg space-y-4 shadow-xs"
        >
          <div className="flex items-center gap-2 font-bold text-[#0A1832]">
            <Settings className="w-4 h-4 text-[#D9A441]" />
            <span>Auto-Cleanup &amp; Retention Thresholds</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Trigger Threshold (%)
              </label>
              <input
                type="number"
                min={50}
                max={90}
                value={triggerPct}
                onChange={(e) => setTriggerPct(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Target After Cleanup (%)
              </label>
              <input
                type="number"
                min={30}
                max={85}
                value={targetPct}
                onChange={(e) => setTargetPct(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Optional Link Expiry (months, leave blank to keep OFF)
            </label>
            <input
              type="number"
              min={1}
              max={60}
              placeholder="Disabled (recommended)"
              value={expireMonths}
              onChange={(e) => setExpireMonths(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
            />
          </div>

          <button
            type="submit"
            className="px-5 py-2.5 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white font-bold text-sm cursor-pointer"
          >
            Save Thresholds
          </button>
        </form>
      )}
    </main>
  );
}
