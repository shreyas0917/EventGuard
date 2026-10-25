import { useState, useEffect } from "react";
import { formatDate } from "../utils/formatters";
import { API_BASE, parseResponseJson } from "../config/api";

interface OutboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  lastError?: string;
  createdAt: string;
  publishedAt?: string;
}

interface OutboxListProps {
  refreshTrigger: number;
}

export function OutboxList({ refreshTrigger }: OutboxListProps) {
  const [outboxEvents, setOutboxEvents] = useState<OutboxEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchOutboxEvents();
  }, [refreshTrigger]);

  const fetchOutboxEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/api/outbox?limit=50`);
      const data = await parseResponseJson(response);
      setOutboxEvents(data.events || []);
    } catch (error) {
      console.error("Failed to fetch outbox events:", error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "PENDING":
        return "text-yellow-400";
      case "PUBLISHED":
        return "text-green-400";
      case "FAILED":
        return "text-red-400";
      default:
        return "text-text-secondary";
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold text-accent-gold">Outbox Queue</h2>
        <button
          onClick={fetchOutboxEvents}
          disabled={loading}
          className="px-4 py-2 bg-dark-bg border border-dark-border rounded-lg hover:border-accent-gold disabled:opacity-50 transition-colors text-text-primary"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <p className="text-sm text-text-secondary mb-4">
        Events queued for Kafka publishing
      </p>

      {outboxEvents.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-text-secondary">No outbox events</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dark-border">
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Event ID
                </th>
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Attempts
                </th>
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {outboxEvents.map((event) => (
                <tr
                  key={event.id}
                  className="border-b border-dark-border hover:bg-dark-card/50"
                >
                  <td className="px-4 py-3 text-text-primary font-mono text-xs">
                    {event.eventId}
                  </td>
                  <td className="px-4 py-3 text-text-primary">
                    {event.eventType}
                  </td>
                  <td className={`px-4 py-3 font-medium ${getStatusColor(event.status)}`}>
                    {event.status}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {event.attemptCount}
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs">
                    {formatDate(event.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 text-sm text-text-secondary">
        Total: {outboxEvents.length}
        {outboxEvents.filter((e) => e.status === "PENDING").length > 0 && (
          <span className="ml-4 text-yellow-400">
            Pending: {outboxEvents.filter((e) => e.status === "PENDING").length}
          </span>
        )}
      </div>
    </div>
  );
}
