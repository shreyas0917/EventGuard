import { formatDate } from "../utils/formatters";

interface EventItem {
  eventId: string;
  eventType: string;
  status: string;
  createdAt: string;
}

interface Event {
  eventId: string;
  eventType: string;
  status: string;
  createdAt: string;
}

interface EventListProps {
  events: Event[];
  loading: boolean;
  onRefresh: () => void;
}

export function EventList({ events, loading, onRefresh }: EventListProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "RECEIVED":
        return "text-blue-400";
      case "PROCESSING":
        return "text-yellow-400";
      case "COMPLETED":
        return "text-green-400";
      case "FAILED":
        return "text-red-400";
      case "DUPLICATE":
        return "text-orange-400";
      default:
        return "text-text-secondary";
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold text-accent-gold">Recent Events</h2>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-4 py-2 bg-dark-bg border border-dark-border rounded-lg hover:border-accent-gold disabled:opacity-50 transition-colors text-text-primary"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {events.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-text-secondary">No events yet</p>
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
                  Event Type
                </th>
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-text-secondary font-medium">
                  Created At
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={event.eventId}
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
                    {formatDate(event.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 text-sm text-text-secondary">
        Total events: {events.length}
      </div>
    </div>
  );
}
