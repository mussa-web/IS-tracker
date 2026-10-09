CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(80) NOT NULL,
  email varchar(254) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email_verified boolean NOT NULL DEFAULT true,
  role varchar(16) NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(80) NOT NULL,
  sku varchar(32) NOT NULL UNIQUE,
  category varchar(40) NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price > 0),
  cost numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  reorder_level integer NOT NULL DEFAULT 5 CHECK (reorder_level >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name varchar(80) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price > 0),
  total numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  sold_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sold_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS http_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name varchar(80) NOT NULL,
  change_quantity integer NOT NULL CHECK (change_quantity <> 0),
  stock_after integer NOT NULL CHECK (stock_after >= 0),
  reason varchar(32) NOT NULL,
  performed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reference text,
  CHECK (reason IN ('Opening balance', 'Sale', 'Restock', 'Customer return', 'Stock correction', 'Damaged / lost', 'Purchase order'))
);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reference text;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'stock_movements'::regclass
      AND conname = 'stock_movements_reason_check'
      AND pg_get_constraintdef(oid) LIKE '%Purchase order%'
  ) THEN
    ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_check
      CHECK (reason IN ('Opening balance', 'Sale', 'Restock', 'Customer return', 'Stock correction', 'Damaged / lost', 'Purchase order'));
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL UNIQUE,
  email varchar(254),
  phone varchar(40),
  address varchar(240),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name varchar(100) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('ordered', 'partially_received', 'received', 'cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name varchar(80) NOT NULL,
  sku varchar(32) NOT NULL,
  quantity_ordered integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_received integer NOT NULL DEFAULT 0
    CHECK (quantity_received >= 0 AND quantity_received <= quantity_ordered),
  unit_cost numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (purchase_order_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchase_order_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_item_id uuid NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  received_by uuid REFERENCES users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO stock_movements (product_id, product_name, change_quantity, stock_after, reason, performed_by)
SELECT p.id, p.name, p.stock, p.stock, 'Opening balance', p.created_by
FROM products p
WHERE p.stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements m WHERE m.product_id = p.id
  );

CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
CREATE INDEX IF NOT EXISTS products_name_idx ON products(name);
CREATE INDEX IF NOT EXISTS sales_sold_at_idx ON sales(sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_product_id_idx ON sales(product_id);
CREATE INDEX IF NOT EXISTS sales_sold_by_idx ON sales(sold_by, sold_at DESC);
CREATE INDEX IF NOT EXISTS http_sessions_expire_idx ON http_sessions(expire);
CREATE INDEX IF NOT EXISTS email_verifications_expire_idx ON email_verifications(expires_at);
CREATE INDEX IF NOT EXISTS stock_movements_created_at_idx ON stock_movements(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS stock_movements_product_id_idx ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_created_at_idx ON purchase_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_order_items_order_idx ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS purchase_order_receipts_item_idx ON purchase_order_receipts(purchase_order_item_id, received_at DESC);
