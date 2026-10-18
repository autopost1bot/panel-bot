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
GRANT ALL ON public.crypto_payments TO service_role;
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
  p record; cu record; t record; price double precision; days integer; result jsonb;
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
    result := jsonb_build_object('ok', true, 'kind', 'sub', 'amount', p.amount, 'expires_at', t.expires_at, 'balance', COALESCE(cu.balance, 0), 'affiliate', award_subscription_affiliate(p.account_id, 'crypto:' || p.id));
    INSERT INTO bot_operations VALUES (0,'crypto:' || p.id,'payment',result,now()) ON CONFLICT DO NOTHING;
    RETURN result;
  END IF;

  UPDATE bot_accounts SET balance = balance + p.amount WHERE id = p.account_id RETURNING * INTO cu;
  result := jsonb_build_object('ok', true, 'kind', 'topup', 'amount', p.amount, 'balance', cu.balance);
  INSERT INTO bot_operations VALUES (0,'crypto:' || p.id,'payment',result,now()) ON CONFLICT DO NOTHING;
  RETURN result;
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

-- Affiliates (main bot). Idempotent.
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS referred_by integer;
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS aff_amount double precision;
CREATE INDEX IF NOT EXISTS bot_accounts_referred_by_idx ON bot_accounts (referred_by);
CREATE TABLE IF NOT EXISTS affiliate_earnings (id serial PRIMARY KEY, referrer_id integer NOT NULL, buyer_id integer NOT NULL, amount double precision NOT NULL, source text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON affiliate_earnings TO service_role;
ALTER TABLE affiliate_earnings ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS affiliate_earnings_referrer_idx ON affiliate_earnings (referrer_id);
CREATE OR REPLACE FUNCTION public.credit_affiliate(p_buyer integer, p_amount double precision, p_source text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE b record; r record; amt double precision;
BEGIN
  SELECT * INTO b FROM bot_accounts WHERE id = p_buyer AND tenant_id = 0;
  IF NOT FOUND OR b.referred_by IS NULL OR b.referred_by = b.id THEN RETURN jsonb_build_object('err', 'no referrer'); END IF;
  SELECT COALESCE(aff_amount, p_amount) INTO amt FROM bot_accounts WHERE id = b.referred_by;
  amt := COALESCE(amt, p_amount);
  IF amt <= 0 THEN RETURN jsonb_build_object('err', 'zero'); END IF;
  INSERT INTO affiliate_earnings (referrer_id, buyer_id, amount, source) VALUES (b.referred_by, b.id, amt, p_source) ON CONFLICT (source) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('err', 'already credited'); END IF;
  UPDATE bot_accounts SET balance = balance + amt WHERE id = b.referred_by AND tenant_id = 0 RETURNING * INTO r;
  RETURN jsonb_build_object('ok', true, 'amount', amt, 'tg_id', r.tg_id, 'balance', r.balance, 'buyer', COALESCE(NULLIF(b.tg_name, ''), 'a referral'));
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.credit_affiliate(integer, double precision, text) FROM PUBLIC, anon, authenticated;
GRANT ALL ON affiliate_earnings TO service_role;
GRANT ALL ON SEQUENCE affiliate_earnings_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_affiliate(integer, double precision, text) TO service_role;
NOTIFY pgrst, 'reload schema';

-- Random unique affiliate codes. Idempotent.
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS ref_code text;
CREATE UNIQUE INDEX IF NOT EXISTS bot_accounts_ref_code_idx ON bot_accounts (ref_code);
NOTIFY pgrst, 'reload schema';

-- Reliability objects are private to the running bot. Reapplied by VPS updater.
CREATE TABLE IF NOT EXISTS public.bot_operations (
  tenant_id integer NOT NULL, request_id text NOT NULL, kind text NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id, kind)
);
GRANT ALL ON public.bot_operations TO service_role;
ALTER TABLE public.bot_operations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.bot_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id integer NOT NULL,
  chat_id bigint NOT NULL, html text NOT NULL, extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text UNIQUE, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
GRANT ALL ON public.bot_outbox TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bot_outbox_id_seq TO service_role;
ALTER TABLE public.bot_outbox ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS bot_outbox_pending_idx ON public.bot_outbox(id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.bot_update_queue (
  tenant_id integer NOT NULL, update_id bigint NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, update_id)
);
GRANT ALL ON public.bot_update_queue TO service_role;
ALTER TABLE public.bot_update_queue ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS bot_update_queue_pending_idx ON public.bot_update_queue(created_at) WHERE status <> 'done';

-- Never guess the owner of an already ambiguous invoice; retain it for review.
WITH duplicates AS (
 SELECT network, amount FROM public.crypto_payments WHERE status = 'pending'
 GROUP BY network, amount HAVING count(*) > 1
)
UPDATE public.crypto_payments p SET status = 'review_amount_conflict'
FROM duplicates d WHERE p.status = 'pending' AND p.network = d.network AND p.amount = d.amount;
CREATE UNIQUE INDEX IF NOT EXISTS crypto_payments_pending_amount_idx
 ON public.crypto_payments(network, amount) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.award_subscription_affiliate(p_account integer, p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE enabled text; amount double precision; result jsonb;
BEGIN
 SELECT value INTO enabled FROM bot_settings WHERE tenant_id = 0 AND key = 'aff_enabled';
 IF enabled = '0' THEN RETURN jsonb_build_object('err', 'disabled'); END IF;
 SELECT value::double precision INTO amount FROM bot_settings WHERE tenant_id = 0 AND key = 'aff_amount';
 result := credit_affiliate(p_account, COALESCE(amount, 5), p_source);
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.adjust_bot_balance(p_tenant integer, p_account integer, p_delta double precision, p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb; account record;
BEGIN
 IF p_delta = 0 OR p_delta::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid amount'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_request || ':balance', 0));
 SELECT response INTO result FROM bot_operations WHERE tenant_id=p_tenant AND request_id=p_request AND kind='balance';
 IF FOUND THEN RETURN result; END IF;
 UPDATE bot_accounts SET balance=balance+p_delta WHERE id=p_account AND tenant_id=p_tenant RETURNING balance,tg_id,username INTO account;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 result := to_jsonb(account);
 INSERT INTO bot_operations VALUES (p_tenant,p_request,'balance',result,now());
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.buy_keys_once(p_tenant integer, p_account integer, p_product integer, p_qty integer, p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_request || ':keys', 0));
 SELECT response INTO result FROM bot_operations WHERE tenant_id=p_tenant AND request_id=p_request AND kind='keys';
 IF FOUND THEN RETURN result; END IF;
 result := buy_keys(p_tenant,p_account,p_product,p_qty);
 INSERT INTO bot_operations VALUES (p_tenant,p_request,'keys',result,now());
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.buy_subscription_once(p_account integer, p_tg bigint, p_price double precision, p_days integer, p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('0:' || p_request || ':subscription', 0));
 SELECT response INTO result FROM bot_operations WHERE tenant_id=0 AND request_id=p_request AND kind='subscription';
 IF FOUND THEN RETURN result; END IF;
 result := buy_subscription(p_account,p_tg,p_price,p_days);
 IF result->>'ok' = 'true' THEN result := result || jsonb_build_object('affiliate', award_subscription_affiliate(p_account,'wallet:' || p_request)); END IF;
 INSERT INTO bot_operations VALUES (0,p_request,'subscription',result,now());
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.add_bot_keys(p_tenant integer, p_product integer, p_keys text[], p_request text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_request || ':inventory', 0));
 SELECT response INTO result FROM bot_operations WHERE tenant_id=p_tenant AND request_id=p_request AND kind='inventory';
 IF FOUND THEN RETURN result; END IF;
 IF NOT EXISTS(SELECT 1 FROM products WHERE id=p_product AND tenant_id=p_tenant) THEN RAISE EXCEPTION 'Product not found'; END IF;
 IF COALESCE(cardinality(p_keys),0)=0 THEN RAISE EXCEPTION 'No keys'; END IF;
 INSERT INTO product_keys(product_id,key) SELECT p_product,unnest(p_keys);
 result := jsonb_build_object('count',cardinality(p_keys));
 INSERT INTO bot_operations VALUES (p_tenant,p_request,'inventory',result,now());
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_bot_updates()
RETURNS SETOF public.bot_update_queue LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 RETURN QUERY WITH candidates AS (
 SELECT q.tenant_id,q.update_id FROM bot_update_queue q
 WHERE q.status='pending' AND (q.lease_until IS NULL OR q.lease_until < now())
 AND NOT EXISTS (SELECT 1 FROM bot_update_queue earlier WHERE earlier.tenant_id=q.tenant_id
   AND earlier.status='pending' AND earlier.update_id < q.update_id)
 ORDER BY q.created_at LIMIT 20 FOR UPDATE SKIP LOCKED
 ) UPDATE bot_update_queue q SET lease_until=now()+interval '5 minutes',attempts=q.attempts+1
 FROM candidates c WHERE q.tenant_id=c.tenant_id AND q.update_id=c.update_id RETURNING q.*;
END; $$;

REVOKE EXECUTE ON FUNCTION public.fulfill_crypto_payment(integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.award_subscription_affiliate(integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.adjust_bot_balance(integer,integer,double precision,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.buy_keys_once(integer,integer,integer,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.buy_subscription_once(integer,bigint,double precision,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.add_bot_keys(integer,integer,text[],text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_bot_updates() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_crypto_payment(integer,text), public.award_subscription_affiliate(integer,text),
 public.adjust_bot_balance(integer,integer,double precision,text), public.buy_keys_once(integer,integer,integer,integer,text),
 public.buy_subscription_once(integer,bigint,double precision,integer,text), public.add_bot_keys(integer,integer,text[],text),
 public.claim_bot_updates() TO service_role;
NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.bot_payment_transfers (
 payment_id integer PRIMARY KEY REFERENCES public.crypto_payments(id), tx_hash text NOT NULL UNIQUE,
 done boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.bot_payment_transfers TO service_role;
ALTER TABLE public.bot_payment_transfers ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.payment_delivery_result(p_id integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
 SELECT response FROM bot_operations WHERE tenant_id=0 AND request_id='crypto:' || p_id AND kind='payment';
$$;
REVOKE EXECUTE ON FUNCTION public.payment_delivery_result(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.payment_delivery_result(integer) TO service_role;
NOTIFY pgrst, 'reload schema';

ALTER TABLE public.bot_outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE OR REPLACE FUNCTION public.claim_bot_delivery(p_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result bot_outbox;
BEGIN
 UPDATE bot_outbox SET lease_until=now()+interval '2 minutes',attempts=attempts+1
 WHERE id=p_id AND status='pending' AND (lease_until IS NULL OR lease_until < now()) RETURNING * INTO result;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(result);
END; $$;
REVOKE EXECUTE ON FUNCTION public.claim_bot_delivery(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bot_delivery(bigint) TO service_role;
NOTIFY pgrst, 'reload schema';

-- Order spam guard: per-account daily cancel counter and temporary order block.
CREATE TABLE IF NOT EXISTS public.bot_order_guards (
 account_id integer PRIMARY KEY,
 cancel_day date NOT NULL DEFAULT CURRENT_DATE,
 cancel_count integer NOT NULL DEFAULT 0,
 blocked_until timestamptz
);
GRANT ALL ON public.bot_order_guards TO service_role;
ALTER TABLE public.bot_order_guards ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
