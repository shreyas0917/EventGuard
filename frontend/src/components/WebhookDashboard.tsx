import { useState, useEffect } from "react";
import { API_BASE, parseResponseJson } from "../config/api";

interface WebhookEvent {
  id: string;
  razorpayEventId: string;
  eventType: string;
  paymentId: string | null;
  status: string;
  receivedAt: string;
  processedAt: string | null;
  errorMessage: string | null;
}

export function WebhookDashboard() {
  const [webhooks, setWebhooks] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState({ received: 0, processed: 0, ignored: 0, failed: 0 });

  const fetchWebhooks = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/api/webhooks/razorpay?limit=10`);
      const data = await parseResponseJson(response);
      if (data.success) {
        setWebhooks(data.data || []);
      }
    } catch (error) {
      console.error("Failed to fetch webhooks:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWebhooks();
    const interval = setInterval(fetchWebhooks, 5000);
    return () => clearInterval(interval);
  }, []);

  // Calculate summary
  useEffect(() => {
    setSummary({
      received: webhooks.filter((w) => w.status === "RECEIVED").length,
      processed: webhooks.filter((w) => w.status === "PROCESSED").length,
      ignored: webhooks.filter((w) => w.status === "IGNORED").length,
      failed: webhooks.filter((w) => w.status === "FAILED").length,
    });
  }, [webhooks]);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-text-primary">Webhook / Payment Events</h2>

      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-xl bg-dark-card p-4 border border-dark-border shadow-glass">
          <h4 className="text-xs uppercase tracking-wider text-text-secondary font-medium">Received</h4>
          <p className="text-3xl font-bold text-amber-400">{summary.received}</p>
        </div>
        <div className="rounded-xl bg-dark-card p-4 border border-dark-border shadow-glass">
          <h4 className="text-xs uppercase tracking-wider text-text-secondary font-medium">Processed</h4>
          <p className="text-3xl font-bold text-emerald-400">{summary.processed}</p>
        </div>
        <div className="rounded-xl bg-dark-card p-4 border border-dark-border shadow-glass">
          <h4 className="text-xs uppercase tracking-wider text-text-secondary font-medium">Ignored</h4>
          <p className="text-3xl font-bold text-blue-400">{summary.ignored}</p>
        </div>
        <div className="rounded-xl bg-dark-card p-4 border border-dark-border shadow-glass">
          <h4 className="text-xs uppercase tracking-wider text-text-secondary font-medium">Failed</h4>
          <p className="text-3xl font-bold text-red-400">{summary.failed}</p>
        </div>
      </div>

      <div className="rounded-xl bg-dark-card border border-dark-border shadow-glass overflow-hidden">
        <div className="px-6 py-4 border-b border-dark-border bg-gradient-to-r from-dark-card/80 to-dark-card/40">
          <h3 className="font-semibold text-text-primary">Recent Webhook Events</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-secondary text-xs uppercase tracking-wider border-b border-dark-border bg-dark-card/30">
              <th className="text-left px-6 py-3 font-medium">Webhook Event ID</th>
              <th className="text-left px-6 py-3 font-medium">Event Type</th>
              <th className="text-left px-6 py-3 font-medium">Payment ID</th>
              <th className="text-left px-6 py-3 font-medium">Status</th>
              <th className="text-left px-6 py-3 font-medium">Received At</th>
            </tr>
          </thead>
          <tbody>
            {webhooks.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-6 text-center text-text-secondary">
                  No webhook events yet. Configure RAZORPAY_WEBHOOK_SECRET for webhook processing.
                </td>
              </tr>
            ) : (
              webhooks.map((w) => (
                <tr key={w.id} className="border-b border-dark-border/50 hover:bg-dark-card/30 transition-colors">
                  <td className="px-6 py-3 font-mono text-xs text-text-secondary truncate max-w-xs">{w.razorpayEventId || w.id}</td>
                  <td className="px-6 py-3 text-text-primary">{w.eventType}</td>
                  <td className="px-6 py-3 text-text-secondary">{w.paymentId || "—"}</td>
                  <td className="px-6 py-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      w.status === "PROCESSED" ? "bg-emerald-900/30 text-emerald-400 border border-emerald-400/30" :
                      w.status === "RECEIVED" ? "bg-amber-900/30 text-amber-400 border border-amber-400/30" :
                      w.status === "IGNORED" ? "bg-blue-900/30 text-blue-400 border border-blue-400/30" :
                      "bg-red-900/30 text-red-400 border border-red-400/30"
                    }`}>
                      {w.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-xs text-text-secondary">{new Date(w.receivedAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}