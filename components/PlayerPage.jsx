const EMBER_COUNT = 18;

function EmberField({ tone = 'fire' }) {
  return (
    <div className={`ember-field ember-field--${tone}`} aria-hidden="true">
      {Array.from({ length: EMBER_COUNT }).map((_, index) => (
        <span
          key={`${tone}-ember-${index}`}
          className="ember-particle"
          style={
            {
              '--x': `${(index * 37) % 100}%`,
              '--delay': `${(index % 7) * 0.6}s`,
              '--duration': `${4.2 + (index % 6) * 0.7}s`,
              '--size': `${4 + (index % 4) * 2}px`,
            }
          }
        />
      ))}
    </div>
  );
}

function FirePanel({ title, subtitle, tone, children }) {
  return (
    <section className={`fire-panel fire-panel--${tone}`}>
      <EmberField tone={tone} />
      <div className="fire-panel__content">
        <header className="fire-panel__header">
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </header>
        {children}
      </div>
    </section>
  );
}

export default function PlayerPage() {
  return (
    <main className="casino-fire-page">
      <div className="casino-fire-bg" />
      <div className="casino-fire-overlay" />

      <section className="player-fire-hero glass-fire-panel">
        <div className="player-fire-hero__image-wrap">
          <img
            src="/assets/player/player_fire_ui_reference.png"
            alt="Fiery casino player UI reference"
            className="player-fire-hero__image"
          />
        </div>
        <div className="player-fire-hero__copy">
          <p className="eyebrow">Player Dashboard</p>
          <h1>Casino Fire Control Room</h1>
          <p>
            Live flames, floating embers, and responsive neon-glass panels crafted for a bright,
            readable casino experience.
          </p>
        </div>
      </section>

      <section className="player-fire-grid">
        <FirePanel
          tone="fire"
          title="Coin + Play Panel"
          subtitle="Orange / red / yellow active flames"
        >
          <div className="panel-metrics">
            <article>
              <span>Coins</span>
              <strong>18,240</strong>
            </article>
            <article>
              <span>Active Games</span>
              <strong>06</strong>
            </article>
            <article>
              <span>Hot Streak</span>
              <strong>3x</strong>
            </article>
          </div>
        </FirePanel>

        <FirePanel
          tone="cash"
          title="Cash + Cashout Panel"
          subtitle="Green flame stack for finance blocks"
        >
          <div className="panel-metrics">
            <article>
              <span>Cash Wallet</span>
              <strong>NPR 56,300</strong>
            </article>
            <article>
              <span>Cashout Pending</span>
              <strong>2</strong>
            </article>
            <article>
              <span>Paid Today</span>
              <strong>NPR 14,000</strong>
            </article>
          </div>
        </FirePanel>

        <FirePanel
          tone="load"
          title="Load Coin Panel"
          subtitle="Purple neon flames for top-up flow"
        >
          <div className="panel-metrics">
            <article>
              <span>Ready Requests</span>
              <strong>4</strong>
            </article>
            <article>
              <span>Expires In</span>
              <strong>09:34</strong>
            </article>
            <article>
              <span>Status</span>
              <strong>Awaiting Pay</strong>
            </article>
          </div>
        </FirePanel>
      </section>
    </main>
  );
}
