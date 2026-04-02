"use client";

import { useAuth } from "@/components/AuthProvider";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import {
  ActivationKey,
  listKeys,
  createKey,
  topUpCredits,
  revokeKey,
  resetDeviceLock,
} from "@/lib/keys";

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function CreateKeyModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [clientLabel, setClientLabel] = useState("");
  const [credits, setCredits] = useState(100);
  const [expiryDate, setExpiryDate] = useState("");
  const [whitelabel, setWhitelabel] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createKey({
        client_label: clientLabel,
        credits,
        expires_at: expiryDate ? new Date(expiryDate) : null,
        whitelabel,
      });
      onCreated();
      onClose();
      setClientLabel("");
      setCredits(100);
      setExpiryDate("");
      setWhitelabel(false);
    } catch (err) {
      console.error("Failed to create key:", err);
      alert("Failed to create key. Check console for details.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">
          Create Activation Key
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Client Label
            </label>
            <input
              type="text"
              required
              value={clientLabel}
              onChange={(e) => setClientLabel(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              placeholder="e.g. Acme Corp"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Initial Credits
            </label>
            <input
              type="number"
              required
              min={1}
              value={credits}
              onChange={(e) => setCredits(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Expiry Date (optional)
            </label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="whitelabel"
              checked={whitelabel}
              onChange={(e) => setWhitelabel(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-slate-700 focus:ring-slate-500"
            />
            <label
              htmlFor="whitelabel"
              className="text-sm font-medium text-slate-700"
            >
              White-label enabled
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Key"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TopUpModal({
  keyId,
  onClose,
  onDone,
}: {
  keyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(50);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await topUpCredits(keyId, amount);
      onDone();
      onClose();
    } catch (err) {
      console.error("Top-up failed:", err);
      alert("Top-up failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">
          Top Up Credits
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Amount
            </label>
            <input
              type="number"
              required
              min={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {submitting ? "Adding..." : "Add Credits"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  // Show first and last segments, mask the middle two
  const parts = key.split("-");
  if (parts.length !== 4) return key;
  return `${parts[0]}-****-****-${parts[3]}`;
}

function formatDate(ts: { seconds: number } | null): string {
  if (!ts) return "--";
  return new Date(ts.seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    revoked: "bg-red-50 text-red-700 ring-red-600/20",
    expired: "bg-amber-50 text-amber-700 ring-amber-600/20",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[status] || "bg-slate-50 text-slate-700 ring-slate-600/20"}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { user, loading, isAuthorized, signOut } = useAuth();
  const router = useRouter();

  const [keys, setKeys] = useState<ActivationKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [topUpKeyId, setTopUpKeyId] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const data = await listKeys();
      setKeys(data);
    } catch (err) {
      console.error("Failed to fetch keys:", err);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && (!user || !isAuthorized)) {
      router.push("/");
    }
  }, [user, loading, isAuthorized, router]);

  useEffect(() => {
    if (isAuthorized) {
      fetchKeys();
    }
  }, [isAuthorized, fetchKeys]);

  if (loading || !isAuthorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-slate-700" />
      </div>
    );
  }

  // Stats
  const totalKeys = keys.length;
  const activeKeys = keys.filter((k) => k.status === "active").length;
  const totalCredits = keys.reduce((sum, k) => sum + (k.credits || 0), 0);

  const handleRevoke = async (keyId: string) => {
    if (!confirm("Revoke this key? The client will lose access immediately."))
      return;
    try {
      await revokeKey(keyId);
      fetchKeys();
    } catch (err) {
      console.error("Revoke failed:", err);
    }
  };

  const handleResetDevice = async (keyId: string) => {
    if (!confirm("Reset device lock? The client can activate on a new device."))
      return;
    try {
      await resetDeviceLock(keyId);
      fetchKeys();
    } catch (err) {
      console.error("Reset device failed:", err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-semibold text-slate-900">
            DocTransform Admin
          </h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">{user?.email}</span>
            <button
              onClick={signOut}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Stats */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-500">Total Keys</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {totalKeys}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-500">Active Keys</p>
            <p className="mt-1 text-2xl font-semibold text-emerald-600">
              {activeKeys}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-500">
              Total Credits Distributed
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {totalCredits.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Actions Bar */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Activation Keys
          </h2>
          <button
            onClick={() => setShowCreateModal(true)}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Create Key
          </button>
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-3 font-medium text-slate-600">Key</th>
                  <th className="px-4 py-3 font-medium text-slate-600">
                    Client Label
                  </th>
                  <th className="px-4 py-3 font-medium text-slate-600">
                    Credits
                  </th>
                  <th className="px-4 py-3 font-medium text-slate-600">
                    Status
                  </th>
                  <th className="px-4 py-3 font-medium text-slate-600">
                    Device ID
                  </th>
                  <th className="px-4 py-3 font-medium text-slate-600">
                    Created
                  </th>
                  <th className="px-4 py-3 font-medium text-slate-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {keysLoading ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-12 text-center text-slate-500"
                    >
                      Loading...
                    </td>
                  </tr>
                ) : keys.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-12 text-center text-slate-500"
                    >
                      No keys yet. Create one to get started.
                    </td>
                  </tr>
                ) : (
                  keys.map((k) => (
                    <tr
                      key={k.id}
                      className="border-b border-slate-100 transition-colors hover:bg-slate-50"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">
                        {maskKey(k.key)}
                      </td>
                      <td className="px-4 py-3 text-slate-900">
                        {k.client_label}
                      </td>
                      <td className="px-4 py-3 text-slate-900">
                        {k.credits?.toLocaleString() ?? 0}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={k.status} />
                      </td>
                      <td className="max-w-[120px] truncate px-4 py-3 font-mono text-xs text-slate-500">
                        {k.device_id || "--"}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {formatDate(
                          k.created_at as unknown as {
                            seconds: number;
                          } | null
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => setTopUpKeyId(k.id)}
                            className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Top Up
                          </button>
                          {k.status === "active" && (
                            <button
                              onClick={() => handleRevoke(k.id)}
                              className="rounded border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              Revoke
                            </button>
                          )}
                          {k.device_id && (
                            <button
                              onClick={() => handleResetDevice(k.id)}
                              className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Reset Device
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Modals */}
      <CreateKeyModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={fetchKeys}
      />
      {topUpKeyId && (
        <TopUpModal
          keyId={topUpKeyId}
          onClose={() => setTopUpKeyId(null)}
          onDone={fetchKeys}
        />
      )}
    </div>
  );
}
