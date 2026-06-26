CREATE TABLE IF NOT EXISTS public.staff_coin_wallets (
  staff_uid TEXT PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  balance_coin NUMERIC NOT NULL DEFAULT 0,
  total_allocated_coin NUMERIC NOT NULL DEFAULT 0,
  total_loaded_coin NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  CONSTRAINT staff_coin_wallets_balance_coin_nonnegative
    CHECK (balance_coin >= 0),
  CONSTRAINT staff_coin_wallets_total_allocated_coin_nonnegative
    CHECK (total_allocated_coin >= 0),
  CONSTRAINT staff_coin_wallets_total_loaded_coin_nonnegative
    CHECK (total_loaded_coin >= 0)
);

CREATE INDEX IF NOT EXISTS staff_coin_wallets_coadmin_uid_idx
  ON public.staff_coin_wallets (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_coin_wallets_coadmin_staff_idx
  ON public.staff_coin_wallets (coadmin_uid, staff_uid)
  WHERE deleted_at IS NULL;
