const PAGE_EMBERS = 26;
const PANEL_EMBERS = 10;

const navItems = ['Lobby', 'Play Now', 'Wallet', 'Cashout', 'Support'];

const quickStats = [
  { label: 'Coin Balance', value: '18,240', tone: 'fire' },
  { label: 'Cash Wallet', value: 'NPR 56,300', tone: 'cash' },
  { label: 'Jackpot Heat', value: '3.8X', tone: 'fire' },
  { label: 'Load Window', value: '09:34', tone: 'load' },
];

const playCards = [
  { title: 'Live Roulette', meta: 'Table 07 ready', value: 'Play 2,500', tone: 'fire' },
  { title: 'Dragon Slots', meta: 'Bonus stack hot', value: 'Play 1,200', tone: 'fire' },
  { title: 'VIP Baccarat', meta: 'Dealer online', value: 'Play 5,000', tone: 'fire' },
];

const notices = [
  'Jackpot ladder is burning tonight with boosted rewards.',
  'Cashout processing is now auto-routed for faster approvals.',
  'Load coin codes expire in ten minutes after release.',
];

function EmberLayer({ count, className = '' }) {
  return (
    <div className={`player-fire-embers ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <span
          key={index}
          className="player-fire-ember"
          style={{
            '--left': `${(index * 17) % 100}%`,
            '--delay': `${(index % 9) * 0.55}s`,
            '--duration': `${5.8 + (index % 6) * 0.7}s`,
            '--drift': `${(index % 2 === 0 ? 1 : -1) * (10 + (index % 5) * 4)}px`,
            '--size': `${5 + (index % 4) * 3}px`,
          }}
        />
      ))}
    </div>
  );
}

function FireSurface({
  title,
  eyebrow,
  tone = 'fire',
  children,
  className = '',
  as: Tag = 'section',
}) {
  return (
    <Tag className={`fire-surface fire-surface--${tone} ${className}`.trim()}>
      <EmberLayer count={PANEL_EMBERS} className="player-fire-embers--panel" />
      <div className="fire-surface__content">
        {(eyebrow || title) && (
          <header className="fire-surface__header">
            {eyebrow ? <p className="fire-surface__eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </header>
        )}
        {children}
      </div>
    </Tag>
  );
}

export default function PlayerPage() {
  return (
    <main className="player-fire-page">
      <div className="player-fire-background" aria-hidden="true" />
      <div className="player-fire-background player-fire-background--mesh" aria-hidden="true" />
      <EmberLayer count={PAGE_EMBERS} className="player-fire-embers--page" />

      <div className="player-fire-shell">
        <FireSurface as="header" className="player-fire-topbar" tone="fire">
          <div className="player-fire-brand">
            <span className="player-fire-brand__chip">777</span>
            <div>
              <p className="player-fire-brand__eyebrow">Neon Casino</p>
              <h1>Inferno Player Lounge</h1>
            </div>
          </div>

          <nav className="player-fire-nav" aria-label="Player sections">
            {navItems.map((item) => (
              <button key={item} type="button" className="player-fire-nav__button">
                {item}
              </button>
            ))}
          </nav>

          <div className="player-fire-user">
            <p>VIP Player</p>
            <strong>ID 0482</strong>
          </div>
        </FireSurface>

        <FireSurface className="player-fire-jackpot" tone="fire">
          <div className="player-fire-jackpot__copy">
            <p className="fire-surface__eyebrow">Jackpot Banner</p>
            <h2>Jackpot is blazing at NPR 980,000</h2>
            <p>
              Flame overlays, moving borders, and live ember motion keep the reward board hot at
              all times.
            </p>
          </div>

          <div className="player-fire-jackpot__meta">
            <div>
              <span>Multiplier</span>
              <strong>12.4X</strong>
            </div>
            <div>
              <span>Claim Window</span>
              <strong>02:18</strong>
            </div>
            <button type="button" className="fire-action fire-action--fire">
              Enter Hot Table
            </button>
          </div>
        </FireSurface>

        <section className="player-fire-stats" aria-label="Wallet overview">
          {quickStats.map((stat) => (
            <FireSurface
              key={stat.label}
              className="player-fire-stat"
              tone={stat.tone}
              eyebrow="Live Meter"
              title={stat.label}
            >
              <div className="player-fire-stat__value">{stat.value}</div>
              <p className="player-fire-stat__hint">Animated panel fire stays active without hover.</p>
            </FireSurface>
          ))}
        </section>

        <section className="player-fire-grid">
          <FireSurface className="player-fire-main-card" tone="fire" eyebrow="Coin + Play" title="Live play controls">
            <div className="player-fire-playcards">
              {playCards.map((card) => (
                <article key={card.title} className={`player-fire-playcard player-fire-playcard--${card.tone}`}>
                  <div>
                    <h3>{card.title}</h3>
                    <p>{card.meta}</p>
                  </div>
                  <button type="button" className="fire-action fire-action--fire">
                    {card.value}
                  </button>
                </article>
              ))}
            </div>
          </FireSurface>

          <FireSurface className="player-fire-wallet-card" tone="cash" eyebrow="Cash + Cashout" title="Green vault flames">
            <div className="player-fire-wallet">
              <div className="player-fire-wallet__row">
                <span>Available Cash</span>
                <strong>NPR 56,300</strong>
              </div>
              <div className="player-fire-wallet__row">
                <span>Cashout Queue</span>
                <strong>2 pending</strong>
              </div>
              <div className="player-fire-wallet__actions">
                <button type="button" className="fire-action fire-action--cash">
                  Instant Cashout
                </button>
                <button type="button" className="fire-action fire-action--cash ghost">
                  Check History
                </button>
              </div>
            </div>
          </FireSurface>

          <FireSurface className="player-fire-load-card" tone="load" eyebrow="Load Coin" title="Purple ignition">
            <div className="player-fire-load">
              <p>One-time code ready with visible moving violet flame layers and neon glass depth.</p>
              <div className="player-fire-code">
                <span>16-digit code</span>
                <strong>7744 1088 2291 5520</strong>
              </div>
              <button type="button" className="fire-action fire-action--load">
                Load Coins
              </button>
            </div>
          </FireSurface>

          <FireSurface className="player-fire-notice-card" tone="fire" eyebrow="Notice Board" title="Fiery player notices">
            <ul className="player-fire-notices">
              {notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          </FireSurface>
        </section>
      </div>
    </main>
  );
}
