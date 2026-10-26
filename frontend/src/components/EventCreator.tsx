import { useState } from "react";
import { API_BASE, parseResponseJson } from "../config/api";
import { authHeaders } from "../config/auth";

interface EventCreatorProps {
  onEventCreated: () => void;
}

/** Demo PAYMENT_SUCCESS payload matching eventWorker requirements (userId, paymentId, orderId, amount). */
function buildDemoPaymentPayload(suffix: string) {
  return {
    userId: "user_42",
    paymentId: `pay_demo_${suffix}`,
    orderId: `order_demo_${suffix}`,
    amount: 500,
  };
}

function nextDemoSuffix() {
  return String(Date.now());
}

export function EventCreator({ onEventCreated }: EventCreatorProps) {
  const [suffix] = useState(() => nextDemoSuffix());
  const [eventId, setEventId] = useState(`evt_demo_${suffix}`);
  const [eventType, setEventType] = useState("PAYMENT_SUCCESS");
  const [payloadText, setPayloadText] = useState(
    JSON.stringify(buildDemoPaymentPayload(suffix), null, 2)
  );
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const prepareNextDemoIds = () => {
    const next = nextDemoSuffix();
    setEventId(`evt_demo_${next}`);
    setEventType("PAYMENT_SUCCESS");
    setPayloadText(JSON.stringify(buildDemoPaymentPayload(next), null, 2));
  };

  const refreshDemoIds = () => {
    prepareNextDemoIds();
    setError(null);
    setResponse(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResponse(null);
    setLoading(true);

    try {
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        setError("Invalid JSON in payload");
        setLoading(false);
        return;
      }

      if (eventType === "PAYMENT_SUCCESS") {
        const missing = ["userId", "paymentId", "orderId", "amount"].filter(
          (k) => payload[k] === undefined || payload[k] === null || payload[k] === ""
        );
        if (missing.length > 0) {
          setError(
            `PAYMENT_SUCCESS requires: userId, paymentId, orderId, amount (missing: ${missing.join(", ")})`
          );
          setLoading(false);
          return;
        }
      }

      const res = await fetch(`${API_BASE}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders("admin") },
        body: JSON.stringify({
          eventId,
          eventType,
          payload,
        }),
      });

      const data = await parseResponseJson(res);

      if (res.status === 201) {
        setResponse({
          success: true,
          message: data.message,
          event: data.event,
        });
        onEventCreated();
        // Prepare a fresh unique demo for the next create (avoids 409 on re-submit)
        prepareNextDemoIds();
      } else if (res.status === 409) {
        setResponse({
          success: false,
          message: `Duplicate: ${data.error}`,
          eventId: data.eventId,
        });
      } else {
        setError(data.error || "Failed to create event");
      }
    } catch (err) {
      setError("Network error: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h2 className="text-2xl font-semibold text-accent-gold mb-6">
        Create Event
      </h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-text-secondary mb-2">
            Event ID
          </label>
          <input
            type="text"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            placeholder="evt_123"
            className="w-full px-4 py-2 bg-dark-bg border border-dark-border rounded-lg text-text-primary focus:outline-none focus:border-accent-gold"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-2">
            Event Type
          </label>
          <input
            type="text"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="PAYMENT_SUCCESS"
            className="w-full px-4 py-2 bg-dark-bg border border-dark-border rounded-lg text-text-primary focus:outline-none focus:border-accent-gold"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-2">
            Payload (JSON)
          </label>
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={6}
            className="w-full px-4 py-2 bg-dark-bg border border-dark-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:border-accent-gold"
          />
          <p className="mt-1 text-xs text-text-secondary">
            PAYMENT_SUCCESS requires userId, paymentId, orderId, and amount.
          </p>
          <button
            type="button"
            onClick={refreshDemoIds}
            className="mt-2 text-xs text-accent-gold hover:underline"
          >
            Reset demo PAYMENT_SUCCESS payload
          </button>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full px-6 py-2 bg-accent-gold text-dark-bg font-medium rounded-lg hover:bg-accent-muted disabled:opacity-50 transition-colors"
        >
          {loading ? "Creating..." : "Create Event"}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-4 bg-red-900/20 border border-red-900 rounded-lg text-red-200">
          {error}
        </div>
      )}

      {response && (
        <div
          className={`mt-4 p-4 rounded-lg border ${
            response.success
              ? "bg-green-900/20 border-green-900 text-green-200"
              : "bg-yellow-900/20 border-yellow-900 text-yellow-200"
          }`}
        >
          <p className="font-medium mb-2">{response.message}</p>
          {response.event && (
            <pre className="text-xs overflow-auto bg-dark-bg p-2 rounded mt-2">
              {JSON.stringify(response.event, null, 2)}
            </pre>
          )}
          {response.eventId && (
            <p className="text-sm mt-2">
              Duplicate event ID: <span className="font-mono">{response.eventId}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
