import { useEffect, useState } from "react";
import { StatusIndicator } from "./StatusIndicator";

interface ServiceHealth {
  service: string;
  status: "ok" | "error" | "unknown" | "checking";
  message?: string;
}

interface HealthStatusProps {
  health: any;
  loading: boolean;
}

export function HealthStatus({ health, loading }: HealthStatusProps) {
  const [services, setServices] = useState<ServiceHealth[]>([]);

  useEffect(() => {
    if (!health || health.error) {
      setServices([
        { service: "API", status: "error" as const, message: "Unreachable" },
        { service: "Database", status: "unknown" as const },
        { service: "Redis", status: "unknown" as const },
        { service: "Kafka", status: "unknown" as const },
      ]);
      return;
    }

    setServices([
      { service: "API", status: "ok" as const, message: health.message },
      { service: "Database", status: "unknown" as const },
      { service: "Redis", status: "unknown" as const },
      { service: "Kafka", status: "unknown" as const },
    ]);
  }, [health]);

  return (
    <div>
      <h2 className="text-2xl font-semibold text-accent-gold mb-6">
        System Status
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {services.map((service) => (
          <div key={service.service} className="card">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-text-primary">
                  {service.service}
                </h3>
                {service.message && (
                  <p className="text-sm text-text-secondary mt-1">
                    {service.message}
                  </p>
                )}
              </div>
              <StatusIndicator
                status={loading ? "checking" : service.status}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-12 card">
        <h3 className="text-lg font-medium text-accent-gold mb-4">
          About EventGuard
        </h3>
        <p className="text-text-secondary leading-relaxed">
          EventGuard is a reliable event processing system that guarantees
          exactly-once business effects. When external systems deliver the same
          event multiple times due to network failures or retries, EventGuard
          ensures the actual business action happens only once.
        </p>
      </div>
    </div>
  );
}
