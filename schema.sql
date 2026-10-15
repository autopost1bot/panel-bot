-- Run this once in your database SQL editor before starting the bot.
CREATE TABLE IF NOT EXISTS bot_sessions (tenant_id integer NOT NULL DEFAULT 0, tg_id bigint NOT NULL, state jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, tg_id));
CREATE TABLE IF NOT EXISTS bot_settings (tenant_id integer NOT NULL DEFAULT 0, key text NOT NULL, value text, PRIMARY KEY (tenant_id, key));
CREATE TABLE IF NOT EXISTS bot_accounts (id serial PRIMARY KEY, tenant_id integer NOT NULL DEFAULT 0, username text NOT NULL, password_hash text NOT NULL, tg_id bigint, balance double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, username));
CREATE TABLE IF NOT EXISTS tenant_bots (id serial PRIMARY KEY, owner_account_id integer NOT NULL UNIQUE REFERENCES bot_accounts(id) ON DELETE CASCADE, owner_tg_id bigint NOT NULL, token text UNIQUE, bot_username text, expires_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'active', reminded integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tenant_bot_payments (id serial PRIMARY KEY, tenant_id integer NOT NULL, amount double precision NOT NULL, days integer NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS categories (id serial PRIMARY KEY, tenant_id integer NOT NULL DEFAULT 0, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS products (id serial PRIMARY KEY, tenant_id integer NOT NULL DEFAULT 0, category_id integer REFERENCES categories(id) ON DELETE SET NULL, parent_id integer REFERENCES products(id) ON DELETE CASCADE, name text NOT NULL, description text, price double precision NOT NULL DEFAULT 0, cost double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS product_keys (id serial PRIMARY KEY, product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE, key text NOT NULL, sold boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS shop_orders (id serial PRIMARY KEY, tenant_id integer NOT NULL DEFAULT 0, account_id integer NOT NULL, product_id integer, product_name text, key text, price double precision NOT NULL, cost double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS account_prices (tenant_id integer NOT NULL DEFAULT 0, account_id integer NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE, product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE, price double precision NOT NULL, PRIMARY KEY (account_id, product_id));

-- Lock tables from public access; the bot uses the service key.
ALTER TABLE bot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_bot_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_prices ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.buy_keys(p_tenant integer, p_account integer, p_product integer, p_qty integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  p record; cu record; k record;
  unit double precision; total double precision;
  keys text[] := '{}'; orders int[] := '{}'; oid int; label text; nkeys int := 0;
BEGIN
  SELECT * INTO p FROM products WHERE id = p_product AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('err', 'Product not found.'); END IF;
  SELECT ap.price INTO unit FROM account_prices ap WHERE ap.account_id = p_account AND ap.product_id = p_product AND ap.tenant_id = p_tenant;
  unit := COALESCE(unit, p.price);
  total := unit * p_qty;
  SELECT * INTO cu FROM bot_accounts WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('err', 'Account not found.'); END IF;
  IF cu.balance < total THEN
    RETURN jsonb_build_object('err', 'Not enough balance. Please ask the seller to add balance.');
  END IF;
  FOR k IN SELECT id, key FROM product_keys WHERE product_id = p_product AND NOT sold ORDER BY id LIMIT p_qty FOR UPDATE SKIP LOCKED LOOP
    nkeys := nkeys + 1;
    keys := keys || k.key;
    UPDATE product_keys SET sold = true WHERE id = k.id;
    INSERT INTO shop_orders (tenant_id, account_id, product_id, product_name, key, price, cost)
      VALUES (p_tenant, p_account, p_product, p.name, k.key, unit, p.cost) RETURNING id INTO oid;
    orders := orders || oid;
  END LOOP;
  IF nkeys < p_qty THEN RAISE EXCEPTION 'STOCK:%', nkeys; END IF;
  UPDATE bot_accounts SET balance = balance - total WHERE id = p_account;
  IF p.parent_id IS NOT NULL THEN
    SELECT (SELECT name FROM products WHERE id = p.parent_id) || ' — ' || p.name INTO label;
  ELSE label := p.name; END IF;
  label := regexp_replace(label, '<[^>]+>', '', 'g');
  RETURN jsonb_build_object('ok', true, 'keys', keys, 'orders', orders, 'total', total, 'balance', cu.balance - total, 'label', label);
END;
$function$;

CREATE OR REPLACE FUNCTION public.buy_subscription(p_account integer, p_tg bigint, p_price double precision, p_days integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE cu record; t record;
BEGIN
  SELECT * INTO cu FROM bot_accounts WHERE id = p_account AND tenant_id = 0 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('err', 'Account not found.', 'balance', 0); END IF;
  IF cu.balance < p_price THEN RETURN jsonb_build_object('err', 'insufficient', 'balance', cu.balance); END IF;
  UPDATE bot_accounts SET balance = balance - p_price WHERE id = p_account;
  INSERT INTO tenant_bots (owner_account_id, owner_tg_id, expires_at, status)
    VALUES (p_account, p_tg, now() + make_interval(days => p_days), 'active')
  ON CONFLICT (owner_account_id) DO UPDATE SET
    expires_at = GREATEST(tenant_bots.expires_at, now()) + make_interval(days => p_days),
    status = 'active', reminded = 0, owner_tg_id = EXCLUDED.owner_tg_id
  RETURNING * INTO t;
  INSERT INTO tenant_bot_payments (tenant_id, amount, days, note) VALUES (t.id, p_price, p_days, 'wallet');
  RETURN jsonb_build_object('ok', true, 'id', t.id, 'expires_at', t.expires_at, 'balance', cu.balance - p_price, 'token', t.token, 'bot_username', t.bot_username);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.buy_keys(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.buy_subscription(integer, bigint, double precision, integer) FROM PUBLIC, anon, authenticated;

-- BEP20 USDT payments (main bot).
CREATE TABLE IF NOT EXISTS public.crypto_payments (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  tenant_id integer NOT NULL DEFAULT 0,
  account_id integer NOT NULL REFERENCES public.bot_accounts(id),
  tg_id bigint NOT NULL,
  kind text NOT NULL DEFAULT 'topup',
  amount double precision NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
ALTER TABLE public.crypto_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crypto_payments ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'bep20';

-- Credits the payment: subscription -> activate/renew the bot, top-up -> balance.
CREATE OR REPLACE FUNCTION public.fulfill_crypto_payment(p_id integer, p_tx text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p record; cu record; t record; price double precision; days integer;
BEGIN
  SELECT * INTO p FROM crypto_payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('err', 'not found'); END IF;
  IF p.status <> 'pending' THEN RETURN jsonb_build_object('err', 'already ' || p.status); END IF;

  UPDATE crypto_payments SET status = 'paid', tx_hash = p_tx, paid_at = now() WHERE id = p_id;

  IF p.kind = 'sub' THEN
    SELECT COALESCE(NULLIF(value, '')::double precision, 30) INTO price FROM bot_settings WHERE tenant_id = 0 AND key = 'bot_price';
    SELECT COALESCE(NULLIF(value, '')::integer, 30) INTO days FROM bot_settings WHERE tenant_id = 0 AND key = 'bot_days';
    price := COALESCE(price, 30); days := COALESCE(days, 30);
    SELECT * INTO cu FROM bot_accounts WHERE id = p.account_id;
    INSERT INTO tenant_bots (owner_account_id, owner_tg_id, expires_at, status)
      VALUES (p.account_id, p.tg_id, now() + make_interval(days => days), 'active')
    ON CONFLICT (owner_account_id) DO UPDATE SET
      expires_at = GREATEST(tenant_bots.expires_at, now()) + make_interval(days => days),
      status = 'active', reminded = 0, owner_tg_id = EXCLUDED.owner_tg_id
    RETURNING * INTO t;
    INSERT INTO tenant_bot_payments (tenant_id, amount, days, note) VALUES (t.id, p.amount, days, 'crypto-' || COALESCE(p.network, 'bep20'));
    RETURN jsonb_build_object('ok', true, 'kind', 'sub', 'amount', p.amount, 'expires_at', t.expires_at, 'balance', COALESCE(cu.balance, 0));
  END IF;

  UPDATE bot_accounts SET balance = balance + p.amount WHERE id = p.account_id RETURNING * INTO cu;
  RETURN jsonb_build_object('ok', true, 'kind', 'topup', 'amount', p.amount, 'balance', cu.balance);
END;
$function$;

-- New tables/functions above must stay reachable by the bot's database role.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- Make the database API see new tables/functions right away.
NOTIFY pgrst, 'reload schema';

-- Logged-in users list (admin) + speed indexes. Idempotent.
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS tg_name text;
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS tg_username text;
CREATE INDEX IF NOT EXISTS bot_accounts_tenant_tg_idx ON bot_accounts (tenant_id, tg_id);
CREATE INDEX IF NOT EXISTS bot_accounts_tenant_login_idx ON bot_accounts (tenant_id, last_login_at DESC);
CREATE INDEX IF NOT EXISTS products_tenant_idx ON products (tenant_id, category_id);
CREATE INDEX IF NOT EXISTS products_parent_idx ON products (parent_id);
CREATE INDEX IF NOT EXISTS product_keys_product_sold_idx ON product_keys (product_id, sold);
CREATE INDEX IF NOT EXISTS shop_orders_tenant_account_idx ON shop_orders (tenant_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_orders_account_idx ON shop_orders (account_id);
CREATE INDEX IF NOT EXISTS account_prices_tenant_idx ON account_prices (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS categories_tenant_idx ON categories (tenant_id);
CREATE INDEX IF NOT EXISTS tenant_bot_payments_tenant_idx ON tenant_bot_payments (tenant_id, created_at DESC);
NOTIFY pgrst, 'reload schema';
