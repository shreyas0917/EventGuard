import { useState, useEffect } from "react";
import { EventCreator } from "./components/EventCreator";
import { EventList } from "./components/EventList";
import { OutboxList } from "./components/OutboxList";
import { IdempotencyDemo } from "./components/IdempotencyDemo";
import PaymentDemo from "./components/PaymentDemo";
import { Header } from "./components/Header";
import { WebhookDashboard } from "./components/WebhookDashboard";
import { API_BASE, parseResponseJson } from "./config/api";

export default function App() {
  const [events, setEvents] = useState<any[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"events" | "idempotency" | "payment">("events");

  useEffect(() => {
    fetchEvents();
  }, [refreshTrigger]);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/api/events`);
      const data = await parseResponseJson(response);
      setEvents(data.events || []);
    } catch (error) {
      console.error("Failed to fetch events:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleEventCreated = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleRefresh = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-dark-bg to-dark-bg">
      <Header />
      <main className="container mx-auto px-6 py-12">
        <div className="mb-6 flex gap-4 border-b border-dark-border">
          <button
            onClick={() => setActiveTab("events")}
            className={`px-4 py-3 font-medium transition-colors ${
              activeTab === "events"
                ? "text-accent-gold border-b-2 border-accent-gold"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Event Processing
          </button>
          <button
            onClick={() => setActiveTab("idempotency")}
            className={`px-4 py-3 font-medium transition-colors ${
              activeTab === "idempotency"
                ? "text-accent-gold border-b-2 border-accent-gold"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Idempotency Demo
          </button>
          <button
            onClick={() => setActiveTab("payment")}
            className={`px-4 py-3 font-medium transition-colors ${
              activeTab === "payment"
                ? "text-accent-gold border-b-2 border-accent-gold"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Payment Demo
          </button>
        </div>

        <div className="space-y-8">
          {activeTab === "events" && (
            <>
              <EventCreator onEventCreated={handleEventCreated} />
              <EventList
                events={events}
                loading={loading}
                onRefresh={handleRefresh}
              />
              <OutboxList refreshTrigger={refreshTrigger} />
            </>
          )}

          {activeTab === "idempotency" && <IdempotencyDemo />}
          {activeTab === "payment" && <PaymentDemo />}
        </div>
      </main>
    </div>
  );
}

