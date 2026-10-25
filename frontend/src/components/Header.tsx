export function Header() {
  return (
    <header className="border-b border-dark-border backdrop-blur-lg bg-dark-bg/80">
      <div className="container mx-auto px-6 py-8">
        <div className="max-w-2xl">
          <h1 className="text-5xl font-bold text-accent-gold mb-2">
            EventGuard
          </h1>
          <p className="text-lg text-text-secondary">
            Reliable events. Exactly-once business effects.
          </p>
        </div>
      </div>
    </header>
  );
}
