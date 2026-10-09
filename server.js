"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const bcrypt = require("bcryptjs");
const connectPgSimple = require("connect-pg-simple");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const session = require("express-session");
const helmet = require("helmet");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const { startBackupScheduler } = require("./backup");

const ROLES = new Set(["admin", "manager", "cashier"]);
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_MAX_AGE = 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 12);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text(value, label, maxLength) {
  if (typeof value !== "string") throw httpError(400, `${label} is required.`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw httpError(400, `${label} must be between 1 and ${maxLength} characters.`);
  return result;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(400, `${label} must be a whole number between ${min} and ${max}.`);
  return value;
}

function amount(value, label, allowZero) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 9999999999.99 || (allowZero ? value < 0 : value <= 0) || Math.abs(Math.round(value * 100) - value * 100) > 0.000001) {
    throw httpError(400, `${label} must be a valid ${allowZero ? "non-negative" : "positive"} amount with at most two decimal places.`);
  }
  return value;
}

function mapProduct(row, revealCost) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    price: Number(row.price),
    cost: revealCost ? Number(row.cost) : null,
    stock: row.stock,
    reorderLevel: row.reorder_level,
    createdAt: row.created_at,
  };
}

function mapSale(row) {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price),
    total: Number(row.total),
    date: row.sold_at,
    soldBy: row.sold_by,
    sellerName: row.seller_name || null,
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createApp(pool, options = {}) {
  const app = express();
  const PgSession = connectPgSimple(session);
  const limiter = options.disableRateLimit
    ? (_req, _res, next) => next()
    : rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 12,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: "Too many sign-in or setup attempts. Try again in 15 minutes." }),
    });

  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { "script-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"], "img-src": ["'self'", "data:"] } } }));
  app.use(express.json({ limit: "2mb", strict: true }));
  app.use(session({
    name: "stockroom.sid",
    store: options.sessionStore || new PgSession({
      pool,
      tableName: "http_sessions",
      createTableIfMissing: false,
      pruneSessionInterval: 15 * 60,
    }),
    secret: options.sessionSecret || process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
    },
  }));

  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
  app.get("/index.html", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
  app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
  app.get("/app.js", (_req, res) => res.sendFile(path.join(__dirname, "app.js")));

  app.get("/api/auth/session", asyncRoute(async (req, res) => {
    const user = req.session.userId ? await findUser(pool, req.session.userId) : null;
    const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM users WHERE active = true) AS configured");
    if (req.session.userId && !user) {
      await regenerateSession(req);
    }
    res.json({
      setupRequired: !rows[0].configured,
      user: user ? publicUser(user) : null,
      csrfToken: csrfToken(req),
    });
  }));

  app.post("/api/auth/setup", limiter, requireCsrf, asyncRoute(async (req, res) => {
    const name = text(req.body.name, "Name", 80);
    const email = validEmail(req.body.email);
    const password = validPassword(req.body.password);
    const legacyData = req.body.legacyData === undefined ? null : validateLegacyData(req.body.legacyData);
    ensureEmailDelivery(options);
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    let user;
    let verification;
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const existing = await client.query("SELECT id FROM users LIMIT 1");
      if (existing.rowCount) throw httpError(409, "The first administrator has already been set up.");
      const result = await client.query(
        "INSERT INTO users (name, email, password_hash, email_verified, role) VALUES ($1, $2, $3, false, 'admin') RETURNING id, name, email, role, active",
        [name, email, passwordHash],
      );
      user = result.rows[0];
      if (legacyData) await importLegacyData(client, legacyData, user.id);
      verification = createEmailVerification();
      await client.query(
        "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [user.id, verification.tokenHash, verification.expiresAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw databaseError(error);
    } finally {
      client.release();
    }
    await deliverVerificationEmail(options, user, verification.token);
    res.status(202).json({ message: "Check your email for a verification link to finish administrator setup." });
  }));

  app.post("/api/auth/login", limiter, requireCsrf, asyncRoute(async (req, res) => {
    const email = validEmail(req.body.email);
    if (typeof req.body.password !== "string" || req.body.password.length > 200) throw httpError(400, "Email or password is incorrect.");
    const { rows } = await pool.query("SELECT id, name, email, password_hash, role, active, email_verified FROM users WHERE email = $1", [email]);
    const user = rows[0];
    const storedHash = user ? user.password_hash : await DUMMY_PASSWORD_HASH;
    const matches = await bcrypt.compare(req.body.password, storedHash);
    if (!user || !user.active || !matches) throw httpError(401, "Email or password is incorrect.");
    if (!user.email_verified) throw httpError(403, "Verify your email address before signing in. You can request a new verification link.");
    await regenerateSession(req);
    req.session.userId = user.id;
    res.json({ user: publicUser(user), csrfToken: csrfToken(req) });
  }));

  app.post("/api/auth/verify-email", limiter, asyncRoute(async (req, res) => {
    if (typeof req.body.token !== "string" || !/^[a-f0-9]{64}$/.test(req.body.token)) throw httpError(400, "This verification link is invalid or expired.");
    const client = await pool.connect();
    let user;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT u.id, u.name, u.email, u.role, u.active, u.email_verified
         FROM email_verifications v JOIN users u ON u.id = v.user_id
         WHERE v.token_hash = $1 AND v.expires_at > now()
         FOR UPDATE OF v, u`,
        [hashEmailVerification(req.body.token)],
      );
      user = rows[0];
      if (!user || !user.active) throw httpError(400, "This verification link is invalid or expired.");
      if (!user.email_verified) {
        await client.query("UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1", [user.id]);
      }
      await client.query("DELETE FROM email_verifications WHERE user_id = $1", [user.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await regenerateSession(req);
    req.session.userId = user.id;
    res.json({ user: publicUser({ ...user, email_verified: true }), csrfToken: csrfToken(req) });
  }));

  app.post("/api/auth/resend-verification", limiter, requireCsrf, asyncRoute(async (req, res) => {
    const email = validEmail(req.body.email);
    ensureEmailDelivery(options);
    const { rows } = await pool.query(
      "SELECT id, name, email, role, active FROM users WHERE email = $1 AND email_verified = false AND active = true",
      [email],
    );
    if (rows[0]) {
      await issueAndSendVerification(pool, rows[0], options);
    }
    res.json({ message: "If that address belongs to an unverified account, a new link has been sent." });
  }));

  app.post("/api/auth/logout", requireCsrf, requireAuth(pool), asyncRoute(async (req, res) => {
    await destroySession(req);
    res.clearCookie("stockroom.sid", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });
    res.status(204).end();
  }));

  app.get("/api/bootstrap", requireAuth(pool), asyncRoute(async (req, res) => {
    const revealCost = req.user.role !== "cashier";
    const productsResult = await pool.query("SELECT id, name, sku, category, price, cost, stock, reorder_level, created_at FROM products ORDER BY name");
    const salesResult = await pool.query(
      `SELECT s.id, s.product_id, s.product_name, s.quantity, s.unit_price, s.total, s.sold_by, s.sold_at, u.name AS seller_name
       FROM sales s LEFT JOIN users u ON u.id = s.sold_by
       ${req.user.role === "cashier" ? "WHERE s.sold_by = $1" : ""}
       ORDER BY s.sold_at DESC`,
      req.user.role === "cashier" ? [req.user.id] : [],
    );
    res.json({
      user: publicUser(req.user),
      products: productsResult.rows.map((row) => mapProduct(row, revealCost)),
      sales: salesResult.rows.map(mapSale),
      csrfToken: csrfToken(req),
    });
  }));

  app.get("/api/stock-movements", requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const limit = queryInteger(req.query.limit, "Limit", 100, 1, 100);
    const offset = queryInteger(req.query.offset, "Offset", 0, 0, 1000000000);
    const { rows } = await pool.query(
      `SELECT m.id, m.product_id, m.product_name, m.change_quantity, m.stock_after, m.reason, m.reference, m.created_at,
              u.name AS performer_name
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.performed_by
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json({
      movements: rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        change: row.change_quantity,
        stockAfter: row.stock_after,
        reason: row.reason,
        reference: row.reference || null,
        date: row.created_at,
        performedBy: row.performer_name || null,
      })),
    });
  }));

  app.get("/api/exports/:resource.csv", requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const exports = {
      products: {
        filename: "stockroom-products.csv",
        headers: ["Product", "SKU", "Category", "Selling price", "Unit cost", "Stock", "Reorder level", "Created at"],
        query: `SELECT name, sku, category, price, cost, stock, reorder_level, created_at
                FROM products ORDER BY name`,
        map: (row) => [row.name, row.sku, row.category, row.price, row.cost, row.stock, row.reorder_level, row.created_at],
      },
      sales: {
        filename: "stockroom-sales.csv",
        headers: ["Product", "Quantity", "Unit price", "Total", "Sold by", "Sold at"],
        query: `SELECT s.product_name, s.quantity, s.unit_price, s.total, u.name AS seller_name, s.sold_at
                FROM sales s LEFT JOIN users u ON u.id = s.sold_by
                ORDER BY s.sold_at DESC, s.id DESC`,
        map: (row) => [row.product_name, row.quantity, row.unit_price, row.total, row.seller_name, row.sold_at],
      },
      "stock-history": {
        filename: "stockroom-stock-history.csv",
        headers: ["Product", "Change", "Stock after", "Reason", "Reference", "Recorded by", "Date"],
        query: `SELECT m.product_name, m.change_quantity, m.stock_after, m.reason, m.reference,
                       u.name AS performer_name, m.created_at
                FROM stock_movements m LEFT JOIN users u ON u.id = m.performed_by
                ORDER BY m.created_at DESC, m.id DESC`,
        map: (row) => [row.product_name, row.change_quantity, row.stock_after, row.reason, row.reference, row.performer_name, row.created_at],
      },
      "purchase-orders": {
        filename: "stockroom-purchase-orders.csv",
        headers: ["Order", "Supplier", "Status", "Product", "SKU", "Quantity ordered", "Quantity received", "Unit cost", "Line total", "Ordered at"],
        query: `SELECT po.order_number, po.supplier_name, po.status, poi.product_name, poi.sku,
                       poi.quantity_ordered, poi.quantity_received, poi.unit_cost,
                       poi.quantity_ordered * poi.unit_cost AS line_total, po.created_at
                FROM purchase_orders po
                JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
                ORDER BY po.created_at DESC, po.order_number DESC, poi.product_name`,
        map: (row) => [`PO-${row.order_number}`, row.supplier_name, row.status, row.product_name, row.sku,
          row.quantity_ordered, row.quantity_received, row.unit_cost, row.line_total, row.created_at],
      },
    };
    const resource = exports[req.params.resource];
    if (!resource) throw httpError(404, "CSV export not found.");
    const { rows } = await pool.query(resource.query);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${resource.filename}"`,
      "Cache-Control": "no-store",
    }).send(csvDocument(resource.headers, rows, resource.map));
  }));

  app.get("/api/suppliers", requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT id, name, email, phone, address, created_at FROM suppliers ORDER BY name",
    );
    res.json({ suppliers: rows });
  }));

  app.post("/api/suppliers", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const supplier = validateSupplier(req.body);
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO suppliers (name, email, phone, address, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, phone, address, created_at`,
        [supplier.name, supplier.email, supplier.phone, supplier.address, req.user.id],
      ));
    } catch (error) {
      if (error.code === "23505") throw httpError(409, "A supplier with that name already exists.");
      throw error;
    }
    res.status(201).json({ supplier: rows[0] });
  }));

  app.patch("/api/suppliers/:id", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const supplier = validateSupplier(req.body);
    const supplierId = validUuid(req.params.id, "Supplier ID");
    let rows;
    try {
      ({ rows } = await pool.query(
        `UPDATE suppliers SET name = $1, email = $2, phone = $3, address = $4
         WHERE id = $5
         RETURNING id, name, email, phone, address, created_at`,
        [supplier.name, supplier.email, supplier.phone, supplier.address, supplierId],
      ));
    } catch (error) {
      if (error.code === "23505") throw httpError(409, "A supplier with that name already exists.");
      throw error;
    }
    if (!rows[0]) throw httpError(404, "Supplier not found.");
    res.json({ supplier: rows[0] });
  }));

  app.get("/api/purchase-orders", requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (_req, res) => {
    const { rows: orders } = await pool.query(
      `SELECT id, order_number, supplier_id, supplier_name, status, created_at, updated_at
       FROM purchase_orders
       ORDER BY created_at DESC, order_number DESC`,
    );
    const orderIds = orders.map((order) => order.id);
    const itemsResult = orderIds.length
      ? await pool.query(
        `SELECT id, purchase_order_id, product_id, product_name, sku, quantity_ordered,
                quantity_received, unit_cost
         FROM purchase_order_items
         WHERE purchase_order_id = ANY($1::uuid[])
         ORDER BY product_name`,
        [orderIds],
      )
      : { rows: [] };
    const itemsByOrder = new Map();
    for (const row of itemsResult.rows) {
      const items = itemsByOrder.get(row.purchase_order_id) || [];
      items.push(mapPurchaseOrderItem(row));
      itemsByOrder.set(row.purchase_order_id, items);
    }
    res.json({
      purchaseOrders: orders.map((order) => ({
        id: order.id,
        number: `PO-${order.order_number}`,
        supplierId: order.supplier_id,
        supplierName: order.supplier_name,
        status: order.status,
        date: order.created_at,
        updatedAt: order.updated_at,
        items: itemsByOrder.get(order.id) || [],
      })),
    });
  }));

  app.post("/api/purchase-orders", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const order = validatePurchaseOrder(req.body);
    const client = await pool.connect();
    let createdOrder;
    try {
      await client.query("BEGIN");
      const { rows: supplierRows } = await client.query(
        "SELECT id, name FROM suppliers WHERE id = $1 FOR SHARE",
        [order.supplierId],
      );
      const supplier = supplierRows[0];
      if (!supplier) throw httpError(404, "Supplier not found.");
      const { rows } = await client.query(
        `INSERT INTO purchase_orders (supplier_id, supplier_name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, order_number, supplier_id, supplier_name, status, created_at, updated_at`,
        [supplier.id, supplier.name, req.user.id],
      );
      createdOrder = rows[0];
      for (const item of order.items) {
        const { rows: products } = await client.query(
          "SELECT id, name, sku FROM products WHERE id = $1 FOR SHARE",
          [item.productId],
        );
        if (!products[0]) throw httpError(404, "A selected product no longer exists.");
        await client.query(
          `INSERT INTO purchase_order_items
             (purchase_order_id, product_id, product_name, sku, quantity_ordered, unit_cost)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [createdOrder.id, products[0].id, products[0].name, products[0].sku, item.quantity, item.unitCost],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw databaseError(error);
    } finally {
      client.release();
    }
    res.status(201).json({
      purchaseOrder: {
        id: createdOrder.id,
        number: `PO-${createdOrder.order_number}`,
        supplierId: createdOrder.supplier_id,
        supplierName: createdOrder.supplier_name,
        status: createdOrder.status,
        date: createdOrder.created_at,
        items: order.items,
      },
    });
  }));

  app.post("/api/purchase-orders/:id/receipts", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const receipt = validatePurchaseOrderReceipt(req.body);
    const purchaseOrderId = validUuid(req.params.id, "Purchase order ID");
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      const { rows: orders } = await client.query(
        "SELECT id, order_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE",
        [purchaseOrderId],
      );
      const order = orders[0];
      if (!order) throw httpError(404, "Purchase order not found.");
      if (["received", "cancelled"].includes(order.status)) throw httpError(409, "This purchase order can no longer receive stock.");
      for (const receivedItem of receipt.items) {
        const { rows: items } = await client.query(
          `SELECT id, product_id, product_name, quantity_ordered, quantity_received
           FROM purchase_order_items
           WHERE id = $1 AND purchase_order_id = $2
           FOR UPDATE`,
          [receivedItem.itemId, order.id],
        );
        const item = items[0];
        if (!item) throw httpError(404, "A purchase order line was not found.");
        if (receivedItem.quantity > item.quantity_ordered - item.quantity_received) {
          throw httpError(409, `Received quantity exceeds the remaining quantity for ${item.product_name}.`);
        }
        if (!item.product_id) throw httpError(409, `${item.product_name} no longer exists in inventory.`);
        const { rows: products } = await client.query(
          "SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE",
          [item.product_id],
        );
        const product = products[0];
        if (!product) throw httpError(409, `${item.product_name} no longer exists in inventory.`);
        const stockAfter = product.stock + receivedItem.quantity;
        if (stockAfter > 100000000) throw httpError(400, "Stock quantity exceeds the supported limit.");
        await client.query("UPDATE products SET stock = $1, updated_at = now() WHERE id = $2", [stockAfter, product.id]);
        await client.query(
          `UPDATE purchase_order_items SET quantity_received = quantity_received + $1
           WHERE id = $2`,
          [receivedItem.quantity, item.id],
        );
        await client.query(
          `INSERT INTO purchase_order_receipts (purchase_order_item_id, quantity, received_by)
           VALUES ($1, $2, $3)`,
          [item.id, receivedItem.quantity, req.user.id],
        );
        await client.query(
          `INSERT INTO stock_movements (product_id, product_name, change_quantity, stock_after, reason, reference, performed_by)
           VALUES ($1, $2, $3, $4, 'Purchase order', $5, $6)`,
          [product.id, product.name, receivedItem.quantity, stockAfter, `PO-${order.order_number}`, req.user.id],
        );
      }
      const { rows: remaining } = await client.query(
        `SELECT COALESCE(bool_and(quantity_received = quantity_ordered), false) AS fully_received
         FROM purchase_order_items
         WHERE purchase_order_id = $1`,
        [order.id],
      );
      const status = remaining[0].fully_received ? "received" : "partially_received";
      const updated = await client.query(
        `UPDATE purchase_orders SET status = $1, updated_at = now()
         WHERE id = $2
         RETURNING id, order_number, status, updated_at`,
        [status, order.id],
      );
      result = updated.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw databaseError(error);
    } finally {
      client.release();
    }
    res.json({
      purchaseOrder: {
        id: result.id,
        number: `PO-${result.order_number}`,
        status: result.status,
        updatedAt: result.updated_at,
      },
    });
  }));

  app.post("/api/purchase-orders/:id/cancel", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const purchaseOrderId = validUuid(req.params.id, "Purchase order ID");
    const client = await pool.connect();
    let order;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT id, order_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE",
        [purchaseOrderId],
      );
      order = rows[0];
      if (!order) throw httpError(404, "Purchase order not found.");
      if (order.status !== "ordered") throw httpError(409, "Only orders with no stock received can be cancelled.");
      await client.query(
        "UPDATE purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = $1",
        [order.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.json({ purchaseOrder: { id: order.id, number: `PO-${order.order_number}`, status: "cancelled" } });
  }));

  app.post("/api/products", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const product = validateProduct(req.body);
    const client = await pool.connect();
    let rows;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO products (name, sku, category, price, cost, stock, reorder_level, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, sku, category, price, cost, stock, reorder_level, created_at`,
        [product.name, product.sku, product.category, product.price, product.cost, product.stock, product.reorderLevel, req.user.id],
      );
      rows = result.rows;
      if (product.stock > 0) {
        await client.query(
          `INSERT INTO stock_movements (product_id, product_name, change_quantity, stock_after, reason, performed_by)
           VALUES ($1, $2, $3, $3, 'Opening balance', $4)`,
          [rows[0].id, rows[0].name, product.stock, req.user.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw databaseError(error);
    } finally {
      client.release();
    }
    res.status(201).json({ product: mapProduct(rows[0], true) });
  }));

  app.put("/api/products/:id", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const product = validateProduct(req.body);
    const { rows } = await pool.query(
      `UPDATE products SET name = $1, sku = $2, category = $3, price = $4, cost = $5,
         reorder_level = $6, updated_at = now()
       WHERE id = $7
       RETURNING id, name, sku, category, price, cost, stock, reorder_level, created_at`,
      [product.name, product.sku, product.category, product.price, product.cost, product.reorderLevel, req.params.id],
    );
    if (!rows[0]) throw httpError(404, "Product not found.");
    res.json({ product: mapProduct(rows[0], true) });
  }));

  app.post("/api/products/:id/stock-movements", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const { direction, quantity, reason } = validateStockMovement(req.body);
    const change = direction === "in" ? quantity : -quantity;
    const client = await pool.connect();
    let movement;
    try {
      await client.query("BEGIN");
      const { rows: products } = await client.query(
        "SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE",
        [req.params.id],
      );
      const product = products[0];
      if (!product) throw httpError(404, "Product not found.");
      const stockAfter = product.stock + change;
      if (stockAfter < 0) throw httpError(409, `Only ${product.stock} ${product.stock === 1 ? "unit is" : "units are"} available.`);
      if (stockAfter > 100000000) throw httpError(400, "Stock quantity exceeds the supported limit.");
      await client.query("UPDATE products SET stock = $1, updated_at = now() WHERE id = $2", [stockAfter, product.id]);
      const { rows } = await client.query(
        `INSERT INTO stock_movements (product_id, product_name, change_quantity, stock_after, reason, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, product_name, change_quantity, stock_after, reason, created_at`,
        [product.id, product.name, change, stockAfter, reason, req.user.id],
      );
      movement = { ...rows[0], performer_name: req.user.name };
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw databaseError(error);
    } finally {
      client.release();
    }
    res.status(201).json({ movement: {
      id: movement.id,
      productId: movement.product_id,
      productName: movement.product_name,
      change: movement.change_quantity,
      stockAfter: movement.stock_after,
      reason: movement.reason,
      date: movement.created_at,
      performedBy: movement.performer_name,
    } });
  }));

  app.delete("/api/products/:id", requireCsrf, requireAuth(pool), requireRole("admin", "manager"), asyncRoute(async (req, res) => {
    const result = await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
    if (!result.rowCount) throw httpError(404, "Product not found.");
    res.status(204).end();
  }));

  app.post("/api/sales", requireCsrf, requireAuth(pool), asyncRoute(async (req, res) => {
    const productId = text(req.body.productId, "Product", 64);
    const quantity = integer(req.body.quantity, "Quantity sold", 1, 100000000);
    const unitPrice = amount(req.body.unitPrice, "Sale price", false);
    if (quantity * unitPrice > 999999999999.99) throw httpError(400, "Sale total exceeds the supported amount.");
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      const productResult = await client.query(
        "SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE",
        [productId],
      );
      const product = productResult.rows[0];
      if (!product) throw httpError(404, "Product not found.");
      if (product.stock < quantity) throw httpError(409, `Only ${product.stock} ${product.stock === 1 ? "unit is" : "units are"} available.`);
      await client.query("UPDATE products SET stock = stock - $1, updated_at = now() WHERE id = $2", [quantity, productId]);
      await client.query(
        `INSERT INTO stock_movements (product_id, product_name, change_quantity, stock_after, reason, performed_by)
         VALUES ($1, $2, $3, $4, 'Sale', $5)`,
        [product.id, product.name, -quantity, product.stock - quantity, req.user.id],
      );
      result = await client.query(
        `INSERT INTO sales (product_id, product_name, quantity, unit_price, sold_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, product_id, product_name, quantity, unit_price, total, sold_by, sold_at`,
        [product.id, product.name, quantity, unitPrice, req.user.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw databaseError(error);
    } finally {
      client.release();
    }
    res.status(201).json({ sale: mapSale(result.rows[0]) });
  }));

  app.get("/api/users", requireAuth(pool), requireRole("admin"), asyncRoute(async (_req, res) => {
    const { rows } = await pool.query("SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at");
    res.json({ users: rows.map(publicUser) });
  }));

  app.post("/api/users", requireCsrf, requireAuth(pool), requireRole("admin"), asyncRoute(async (req, res) => {
    ensureEmailDelivery(options);
    const user = validateUser(req.body);
    const passwordHash = await bcrypt.hash(user.password, 12);
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, password_hash, email_verified, role) VALUES ($1, $2, $3, false, $4) RETURNING id, name, email, role, active, created_at",
      [user.name, user.email, passwordHash, user.role],
    );
    await issueAndSendVerification(pool, rows[0], options);
    res.status(201).json({ user: publicUser(rows[0]) });
  }));

  app.patch("/api/users/:id", requireCsrf, requireAuth(pool), requireRole("admin"), asyncRoute(async (req, res) => {
    const role = req.body.role;
    const active = req.body.active;
    const password = req.body.password === undefined ? undefined : validPassword(req.body.password);
    if ((role !== undefined && !ROLES.has(role)) || (active !== undefined && typeof active !== "boolean") || (role === undefined && active === undefined && password === undefined)) {
      throw httpError(400, "Choose a valid role or active status.");
    }
    if (req.params.id === req.user.id && (role && role !== "admin" || active === false)) {
      throw httpError(400, "You cannot remove your own administrator access.");
    }
    const passwordHash = password === undefined ? null : await bcrypt.hash(password, 12);
    const client = await pool.connect();
    let user;
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const current = await client.query("SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (!current.rows[0]) throw httpError(404, "User not found.");
      const nextRole = role || current.rows[0].role;
      const nextActive = active === undefined ? current.rows[0].active : active;
      if (current.rows[0].role === "admin" && current.rows[0].active && (nextRole !== "admin" || !nextActive)) {
        const others = await client.query("SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND active = true AND id <> $1", [req.params.id]);
        if (others.rows[0].count === 0) throw httpError(409, "At least one active administrator is required.");
      }
      const updated = await client.query(
        `UPDATE users SET role = $1, active = $2, password_hash = COALESCE($3, password_hash), updated_at = now()
         WHERE id = $4 RETURNING id, name, email, role, active, created_at`,
        [nextRole, nextActive, passwordHash, req.params.id],
      );
      user = updated.rows[0];
      if (passwordHash) {
        await client.query("DELETE FROM http_sessions WHERE sess->>'userId' = $1 AND sid <> $2", [req.params.id, req.sessionID]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.json({ user: publicUser(user) });
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
  app.use((error, _req, res, _next) => {
    if (error.code === "23505") return res.status(409).json({ error: "That email address or SKU is already in use." });
    const status = error.status || 500;
    if (status >= 500) console.error("Request failed:", error);
    res.status(status).json({ error: status >= 500 ? "The request could not be completed. Please try again." : error.message });
  });
  return app;
}

async function findUser(pool, userId) {
  const { rows } = await pool.query("SELECT id, name, email, role, active, email_verified FROM users WHERE id = $1", [userId]);
  return rows[0]?.active && rows[0]?.email_verified ? rows[0] : null;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.created_at || user.createdAt,
  };
}

function createEmailVerification() {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashEmailVerification(token),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_MAX_AGE),
  };
}

function hashEmailVerification(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function ensureEmailDelivery(options) {
  if (options.sendEmail) return;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    throw httpError(503, "Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in .env.");
  }
}

async function deliverVerificationEmail(options, user, token) {
  const baseUrl = (process.env.APP_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
  const verificationUrl = `${baseUrl}/?verify=${encodeURIComponent(token)}`;
  const message = {
    to: user.email,
    subject: "Verify your Stockroom email",
    text: `Hello ${user.name},\n\nVerify your email address to finish setting up your Stockroom account:\n${verificationUrl}\n\nThis link expires in 24 hours. If you did not expect this email, you can ignore it.`,
    html: `<p>Hello ${escapeEmailHtml(user.name)},</p><p>Verify your email address to finish setting up your Stockroom account:</p><p><a href="${verificationUrl}">Verify email address</a></p><p>This link expires in 24 hours. If you did not expect this email, you can ignore it.</p>`,
  };
  if (options.sendEmail) {
    await options.sendEmail(message);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  try {
    await transporter.sendMail({ ...message, from: process.env.SMTP_FROM });
  } catch (error) {
    console.error("Verification email delivery failed:", {
      code: error.code || null,
      command: error.command || null,
      responseCode: error.responseCode || null,
      host: process.env.SMTP_HOST || null,
      port: Number(process.env.SMTP_PORT) || null,
    });
    throw httpError(503, "Verification email could not be sent. Check SMTP settings and request a new verification link.");
  }
}

async function issueAndSendVerification(pool, user, options) {
  const verification = createEmailVerification();
  await pool.query("DELETE FROM email_verifications WHERE user_id = $1", [user.id]);
  await pool.query(
    "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [user.id, verification.tokenHash, verification.expiresAt],
  );
  await deliverVerificationEmail(options, user, verification.token);
}

function escapeEmailHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function validEmail(value) {
  const email = text(value, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Enter a valid email address.");
  return email;
}

function validPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 200) throw httpError(400, "Password must be between 12 and 200 characters.");
  return value;
}

function validateUser(body) {
  const name = text(body.name, "Name", 80);
  const email = validEmail(body.email);
  const role = body.role;
  if (!ROLES.has(role)) throw httpError(400, "Choose a valid role.");
  return { name, email, role, password: validPassword(body.password) };
}

function validateProduct(body) {
  return {
    name: text(body.name, "Product name", 80),
    sku: text(body.sku, "SKU", 32),
    category: text(body.category, "Category", 40),
    price: amount(body.price, "Selling price", false),
    cost: amount(body.cost, "Unit cost", true),
    stock: integer(body.stock, "Stock quantity", 0, 100000000),
    reorderLevel: integer(body.reorderLevel, "Low stock threshold", 0, 100000000),
  };
}

function validateStockMovement(body) {
  const direction = body.direction;
  const quantity = integer(body.quantity, "Quantity", 1, 100000000);
  const reason = body.reason;
  const reasons = new Set(["Restock", "Customer return", "Stock correction", "Damaged / lost"]);
  if (!["in", "out"].includes(direction) || !reasons.has(reason)) {
    throw httpError(400, "Choose a valid stock direction and reason.");
  }
  if (reason === "Damaged / lost" && direction !== "out" || ["Restock", "Customer return"].includes(reason) && direction !== "in") {
    throw httpError(400, "The selected reason does not match the stock direction.");
  }
  return { direction, quantity, reason };
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, label, maxLength);
}

function validUuid(value, label) {
  const id = text(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw httpError(400, `${label} must be a valid identifier.`);
  }
  return id;
}

function validateSupplier(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Supplier details are required.");
  const email = optionalText(body.email, "Email", 254);
  return {
    name: text(body.name, "Supplier name", 100),
    email: email ? validEmail(email) : null,
    phone: optionalText(body.phone, "Phone", 40),
    address: optionalText(body.address, "Address", 240),
  };
}

function validatePurchaseOrder(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Purchase order details are required.");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    throw httpError(400, "A purchase order must contain between 1 and 100 product lines.");
  }
  const productIds = new Set();
  const items = body.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw httpError(400, "Each purchase order line must be an object.");
    const productId = validUuid(item.productId, "Product ID").toLowerCase();
    if (productIds.has(productId)) throw httpError(400, "A product can only appear once on a purchase order.");
    productIds.add(productId);
    return {
      productId,
      quantity: integer(item.quantity, "Ordered quantity", 1, 100000000),
      unitCost: amount(item.unitCost, "Unit cost", true),
    };
  });
  const supplierId = validUuid(body.supplierId, "Supplier ID").toLowerCase();
  return { supplierId, items };
}

function validatePurchaseOrderReceipt(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    throw httpError(400, "A receipt must include between 1 and 100 purchase order lines.");
  }
  const itemIds = new Set();
  const items = body.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw httpError(400, "Each received line must be an object.");
    const itemId = validUuid(item.itemId, "Purchase order line ID").toLowerCase();
    if (itemIds.has(itemId)) throw httpError(400, "A purchase order line can only be received once per transaction.");
    itemIds.add(itemId);
    return { itemId, quantity: integer(item.quantity, "Received quantity", 1, 100000000) };
  });
  return { items };
}

function mapPurchaseOrderItem(row) {
  const ordered = row.quantity_ordered;
  const received = row.quantity_received;
  const unitCost = Number(row.unit_cost);
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    quantityOrdered: ordered,
    quantityReceived: received,
    quantityRemaining: ordered - received,
    unitCost,
    totalCost: Math.round(ordered * unitCost * 100) / 100,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let result = value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@\t\r]/.test(result)) result = `'${result}`;
  return `"${result.replace(/"/g, '""')}"`;
}

function csvDocument(headers, rows, mapRow) {
  return `\uFEFF${[headers, ...rows.map(mapRow)].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function queryInteger(value, label, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw httpError(400, `${label} must be a whole number between ${min} and ${max}.`);
  return integer(Number(value), label, min, max);
}

function validateLegacyData(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.products) || !Array.isArray(value.sales) || value.products.length > 500 || value.sales.length > 5000) {
    throw httpError(400, "The saved browser data is invalid or exceeds the import limit (500 products and 5,000 sales).");
  }
  const products = value.products.map((product) => ({
    legacyId: text(product.id, "Product ID", 64),
    ...validateProduct(product),
  }));
  const ids = new Set();
  const skus = new Set();
  products.forEach((product) => {
    if (ids.has(product.legacyId)) throw httpError(400, "The saved data contains duplicate product IDs.");
    if (skus.has(product.sku.toLowerCase())) throw httpError(400, "The saved data contains duplicate product SKUs.");
    ids.add(product.legacyId);
    skus.add(product.sku.toLowerCase());
  });
  const sales = value.sales.map((sale) => {
    if (!ids.has(sale.productId)) throw httpError(400, "The saved sales contain a product that is missing from the saved inventory.");
    const date = new Date(sale.date);
    if (Number.isNaN(date.getTime())) throw httpError(400, "The saved sales contain an invalid transaction date.");
    const quantity = integer(sale.quantity, "Sale quantity", 1, 100000000);
    const unitPrice = amount(sale.unitPrice, "Sale price", false);
    if (quantity * unitPrice > 999999999999.99) throw httpError(400, "Saved sale total exceeds the supported amount.");
    return {
      productId: sale.productId,
      productName: text(sale.productName, "Sale product name", 80),
      quantity,
      unitPrice,
      soldAt: date,
    };
  });
  return { products, sales };
}

async function importLegacyData(client, legacyData, userId) {
  const productIds = new Map();
  for (const product of legacyData.products) {
    const { rows } = await client.query(
      `INSERT INTO products (name, sku, category, price, cost, stock, reorder_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [product.name, product.sku, product.category, product.price, product.cost, product.stock, product.reorderLevel, userId],
    );
    productIds.set(product.legacyId, rows[0].id);
    if (product.stock > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, product_name, change_quantity, stock_after, reason, performed_by)
         VALUES ($1, $2, $3, $3, 'Opening balance', $4)`,
        [rows[0].id, product.name, product.stock, userId],
      );
    }
  }
  for (const sale of legacyData.sales) {
    const productId = productIds.get(sale.productId);
    await client.query(
      `INSERT INTO sales (product_id, product_name, quantity, unit_price, sold_by, sold_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [productId, sale.productName, sale.quantity, sale.unitPrice, userId, sale.soldAt],
    );
  }
}

function databaseError(error) {
  if (error.code === "23505") return httpError(409, "That email address or SKU is already in use.");
  return error;
}

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  return req.session.csrfToken;
}

function requireCsrf(req, _res, next) {
  const provided = req.get("x-csrf-token");
  const stored = req.session.csrfToken;
  if (!provided || !stored) return next(httpError(403, "Your security token expired. Refresh and try again."));
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(stored);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return next(httpError(403, "Your security token is invalid. Refresh and try again."));
  }
  next();
}

function requireAuth(pool) {
  return asyncRoute(async (req, _res, next) => {
    if (!req.session.userId) throw httpError(401, "Sign in to continue.");
    req.user = await findUser(pool, req.session.userId);
    if (!req.user) {
      await destroySession(req);
      throw httpError(401, "Your account is inactive. Contact an administrator.");
    }
    next();
  });
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(httpError(403, "Your role does not allow this action."));
    next();
  };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function destroySession(req) {
  if (!req.session) return Promise.resolve();
  return new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
}

async function initializeDatabase(pool) {
  const migration = await fs.readFile(path.join(__dirname, "db", "001_initial.sql"), "utf8");
  await pool.query(migration);
}

function validateConfig(environment = process.env) {
  if (!environment.DATABASE_URL || environment.DATABASE_URL.includes("REPLACE_WITH") || environment.DATABASE_URL.includes("URL_ENCODED_PASSWORD")) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.");
  }
  try {
    const databaseUrl = new URL(environment.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)
      || !databaseUrl.hostname
      || !databaseUrl.pathname || databaseUrl.pathname === "/"
      || (databaseUrl.port && (Number(databaseUrl.port) < 1 || Number(databaseUrl.port) > 65535))) {
      throw new Error("invalid database URL structure");
    }
  } catch {
    throw new Error("DATABASE_URL in the project-root .env must be a valid PostgreSQL connection URL (postgresql://user:password@host:port/database). URL-encode special characters in the username or password.");
  }
  if (!environment.SESSION_SECRET || Buffer.byteLength(environment.SESSION_SECRET) < 32 || /^(REPLACE_|GENERATE_)/i.test(environment.SESSION_SECRET)) {
    throw new Error("SESSION_SECRET must be a unique random value of at least 32 bytes. Generate one and set it in .env.");
  }
}

function databaseConnectionError(error) {
  switch (error.code) {
    case "28P01":
    case "28000":
      return new Error("PostgreSQL rejected the credentials in DATABASE_URL. Check the database username and password in the project-root .env.");
    case "3D000":
      return new Error("The PostgreSQL server is reachable, but the database named in DATABASE_URL does not exist. Create it or correct the database name in .env.");
    case "ECONNREFUSED":
      return new Error(`Could not reach PostgreSQL at the configured address${error.address ? ` (${error.address}${error.port ? `:${error.port}` : ""})` : ""}. Confirm the service is running and DATABASE_URL uses the correct host and port.`);
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new Error("The PostgreSQL host in DATABASE_URL could not be resolved. Check the hostname and network/DNS settings.");
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new Error("The PostgreSQL host did not respond. Check that it is reachable from this machine and that its firewall allows the configured database port.");
    default:
      if (/password authentication failed/i.test(error.message || "")) {
        return new Error("PostgreSQL rejected the credentials in DATABASE_URL. Check the database username and password in the project-root .env.");
      }
      if (/database .* does not exist/i.test(error.message || "")) {
        return new Error("The PostgreSQL server is reachable, but the database named in DATABASE_URL does not exist. Create it or correct the database name in .env.");
      }
      return new Error("Could not connect to PostgreSQL using DATABASE_URL. Check the URL, SSL requirements, and server logs; connection details are intentionally not printed.");
  }
}

async function main() {
  validateConfig();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 15, idleTimeoutMillis: 30000 });
  pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error:", error));
  try {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      throw databaseConnectionError(error);
    }
    await initializeDatabase(pool);
    const app = createApp(pool);
    const port = Number(process.env.PORT) || 8000;
    app.listen(port, () => console.log(`Stockroom listening on http://localhost:${port}`));
    startBackupScheduler({ databaseUrl: process.env.DATABASE_URL });
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Could not start Stockroom:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp, initializeDatabase, validateProduct, validateUser, validateConfig, databaseConnectionError, requireAuth, requireRole, ROLES };
