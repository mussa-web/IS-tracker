"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const request = require("supertest");
const { createApp, validateConfig } = require("../server");

class MemoryPool {
  constructor() {
    this.users = [];
    this.products = [];
    this.sales = [];
    this.movements = [];
    this.emailVerifications = [];
    this.suppliers = [];
    this.purchaseOrders = [];
    this.purchaseOrderItems = [];
    this.purchaseOrderReceipts = [];
    this.nextPurchaseOrderNumber = 1001;
    this.statements = [];
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }

  async query(rawSql, values = []) {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("SELECT EXISTS (SELECT 1 FROM users")) {
      return { rows: [{ configured: this.users.some((user) => user.active) }], rowCount: 1 };
    }
    if (sql === "SELECT id FROM users LIMIT 1") return { rows: this.users.slice(0, 1), rowCount: Math.min(1, this.users.length) };
    if (sql.includes("FROM users WHERE email = $1")) {
      const rows = this.users.filter((user) => user.email === values[0] && (!sql.includes("email_verified = false") || !user.email_verified));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM email_verifications v JOIN users u")) {
      const verification = this.emailVerifications.find((entry) => entry.token_hash === values[0] && entry.expires_at > new Date());
      const user = verification && this.users.find((entry) => entry.id === verification.user_id);
      return { rows: user ? [{ id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, email_verified: user.email_verified }] : [], rowCount: user ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id, name, email, role, active, email_verified FROM users WHERE id = $1")) {
      const rows = this.users.filter((user) => user.id === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT id, name, email, role, active, created_at FROM users ORDER BY")) {
      return { rows: this.users.map((user) => ({ ...user })), rowCount: this.users.length };
    }
    if (sql === "SELECT id, name, email, phone, address, created_at FROM suppliers ORDER BY name") {
      return { rows: this.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name)), rowCount: this.suppliers.length };
    }
    if (sql.startsWith("SELECT name, sku, category, price, cost, stock, reorder_level, created_at FROM products")) {
      return { rows: this.products.map((product) => ({ ...product })), rowCount: this.products.length };
    }
    if (sql.startsWith("SELECT s.product_name, s.quantity, s.unit_price, s.total, u.name AS seller_name, s.sold_at")) {
      const rows = this.sales.map((sale) => ({
        ...sale,
        seller_name: this.users.find((user) => user.id === sale.sold_by)?.name || null,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT m.product_name, m.change_quantity, m.stock_after, m.reason, m.reference")) {
      const rows = this.movements.map((movement) => ({
        ...movement,
        performer_name: this.users.find((user) => user.id === movement.performed_by)?.name || null,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT po.order_number, po.supplier_name, po.status, poi.product_name, poi.sku")) {
      const rows = this.purchaseOrderItems.map((item) => {
        const order = this.purchaseOrders.find((entry) => entry.id === item.purchase_order_id);
        return order ? {
          order_number: order.order_number,
          supplier_name: order.supplier_name,
          status: order.status,
          product_name: item.product_name,
          sku: item.sku,
          quantity_ordered: item.quantity_ordered,
          quantity_received: item.quantity_received,
          unit_cost: item.unit_cost,
          line_total: item.quantity_ordered * item.unit_cost,
          created_at: order.created_at,
        } : null;
      }).filter(Boolean);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT id, name FROM suppliers WHERE id = $1 FOR SHARE")) {
      const supplier = this.suppliers.find((item) => item.id === values[0]);
      return { rows: supplier ? [{ id: supplier.id, name: supplier.name }] : [], rowCount: supplier ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id, order_number, supplier_id, supplier_name, status, created_at, updated_at FROM purchase_orders")) {
      const rows = this.purchaseOrders.slice().sort((a, b) => b.created_at - a.created_at).map((order) => ({ ...order }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT id, purchase_order_id, product_id, product_name, sku, quantity_ordered")) {
      const rows = this.purchaseOrderItems.filter((item) => values[0].includes(item.purchase_order_id)).map((item) => ({ ...item }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT id, order_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE")) {
      const order = this.purchaseOrders.find((item) => item.id === values[0]);
      return { rows: order ? [{ id: order.id, order_number: order.order_number, status: order.status }] : [], rowCount: order ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id, product_id, product_name, quantity_ordered, quantity_received FROM purchase_order_items")) {
      const item = this.purchaseOrderItems.find((entry) => entry.id === values[0] && entry.purchase_order_id === values[1]);
      return { rows: item ? [{ ...item }] : [], rowCount: item ? 1 : 0 };
    }
    if (sql.startsWith("SELECT COALESCE(bool_and(quantity_received = quantity_ordered), false) AS fully_received")) {
      const items = this.purchaseOrderItems.filter((item) => item.purchase_order_id === values[0]);
      return { rows: [{ fully_received: items.length > 0 && items.every((item) => item.quantity_received === item.quantity_ordered) }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, role, active FROM users WHERE id = $1")) {
      const rows = this.users.filter((user) => user.id === values[0]).map(({ id, role, active }) => ({ id, role, active }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT count(*)::int AS count FROM users")) {
      return { rows: [{ count: this.users.filter((user) => user.id !== values[0] && user.active && user.role === "admin").length }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO users")) {
      const role = sql.includes("'admin') RETURNING") ? "admin" : values[3];
      const user = {
        id: crypto.randomUUID(),
        name: values[0],
        email: values[1],
        password_hash: values[2],
        email_verified: !sql.includes("false,"),
        role,
        active: true,
        created_at: new Date(),
      };
      this.users.push(user);
      return { rows: [{ id: user.id, name: user.name, email: user.email, role: user.role, active: true, created_at: user.created_at }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE users SET email_verified = true")) {
      const user = this.users.find((item) => item.id === values[0]);
      if (!user) return { rows: [], rowCount: 0 };
      user.email_verified = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO email_verifications")) {
      this.emailVerifications.push({ user_id: values[0], token_hash: values[1], expires_at: new Date(values[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM email_verifications WHERE user_id")) {
      this.emailVerifications = this.emailVerifications.filter((entry) => entry.user_id !== values[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE users SET role = $1")) {
      const user = this.users.find((item) => item.id === values[3]);
      if (!user) return { rows: [], rowCount: 0 };
      user.role = values[0];
      user.active = values[1];
      if (values[2]) user.password_hash = values[2];
      user.updated_at = new Date();
      return { rows: [{ ...user }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, name, sku, category, price, cost, stock, reorder_level, created_at FROM products ORDER BY")) {
      return { rows: this.products.map((product) => ({ ...product })), rowCount: this.products.length };
    }
    if (sql.startsWith("SELECT m.id, m.product_id, m.product_name")) {
      const rows = this.movements.slice().reverse().slice(values[1], values[1] + values[0]).map((movement) => ({
        ...movement,
        performer_name: this.users.find((user) => user.id === movement.performed_by)?.name || null,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO products")) {
      const product = {
        id: crypto.randomUUID(),
        name: values[0],
        sku: values[1],
        category: values[2],
        price: values[3],
        cost: values[4],
        stock: values[5],
        reorder_level: values[6],
        created_by: values[7] || null,
        created_at: new Date(),
      };
      this.products.push(product);
      return { rows: [{ ...product }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO suppliers")) {
      if (this.suppliers.some((item) => item.name.toLowerCase() === values[0].toLowerCase())) {
        const error = new Error("duplicate supplier");
        error.code = "23505";
        throw error;
      }
      const supplier = { id: crypto.randomUUID(), name: values[0], email: values[1], phone: values[2], address: values[3], created_at: new Date() };
      this.suppliers.push(supplier);
      return { rows: [{ ...supplier }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE suppliers SET name = $1")) {
      const supplier = this.suppliers.find((item) => item.id === values[4]);
      if (!supplier) return { rows: [], rowCount: 0 };
      Object.assign(supplier, { name: values[0], email: values[1], phone: values[2], address: values[3] });
      return { rows: [{ ...supplier }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO purchase_orders")) {
      const order = {
        id: crypto.randomUUID(), order_number: this.nextPurchaseOrderNumber++, supplier_id: values[0],
        supplier_name: values[1], status: "ordered", created_at: new Date(), updated_at: new Date(),
      };
      this.purchaseOrders.push(order);
      return { rows: [{ ...order }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, name, sku FROM products WHERE id = $1 FOR SHARE")) {
      const product = this.products.find((item) => item.id === values[0]);
      return { rows: product ? [{ id: product.id, name: product.name, sku: product.sku }] : [], rowCount: product ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO purchase_order_items")) {
      const item = {
        id: crypto.randomUUID(), purchase_order_id: values[0], product_id: values[1], product_name: values[2],
        sku: values[3], quantity_ordered: values[4], quantity_received: 0, unit_cost: values[5],
      };
      this.purchaseOrderItems.push(item);
      return { rows: [{ ...item }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE purchase_order_items SET quantity_received = quantity_received + $1")) {
      const item = this.purchaseOrderItems.find((entry) => entry.id === values[1]);
      item.quantity_received += values[0];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO purchase_order_receipts")) {
      this.purchaseOrderReceipts.push({ purchase_order_item_id: values[0], quantity: values[1], received_by: values[2] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE purchase_orders SET status = $1")) {
      const order = this.purchaseOrders.find((item) => item.id === values[1]);
      order.status = values[0];
      order.updated_at = new Date();
      return { rows: [{ id: order.id, order_number: order.order_number, status: order.status, updated_at: order.updated_at }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE purchase_orders SET status = 'cancelled'")) {
      const order = this.purchaseOrders.find((item) => item.id === values[0]);
      order.status = "cancelled";
      order.updated_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE products SET name = $1")) {
      const product = this.products.find((item) => item.id === values[6]);
      if (!product) return { rows: [], rowCount: 0 };
      Object.assign(product, {
        name: values[0], sku: values[1], category: values[2], price: values[3],
        cost: values[4], reorder_level: values[5], updated_at: new Date(),
      });
      return { rows: [{ ...product }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE products SET stock = $1")) {
      const product = this.products.find((item) => item.id === values[1]);
      product.stock = values[0];
      product.updated_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM products")) {
      const index = this.products.findIndex((item) => item.id === values[0]);
      if (index < 0) return { rows: [], rowCount: 0 };
      this.products.splice(index, 1);
      this.sales.filter((sale) => sale.product_id === values[0]).forEach((sale) => { sale.product_id = null; });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT s.id, s.product_id")) {
      const sales = this.sales.filter((sale) => !sql.includes("WHERE s.sold_by = $1") || sale.sold_by === values[0]);
      return { rows: sales.map((sale) => ({ ...sale, seller_name: this.users.find((user) => user.id === sale.sold_by)?.name || null })), rowCount: sales.length };
    }
    if (sql.startsWith("SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE")) {
      const product = this.products.find((item) => item.id === values[0]);
      return { rows: product ? [{ id: product.id, name: product.name, stock: product.stock }] : [], rowCount: product ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE products SET stock = stock - $1")) {
      const product = this.products.find((item) => item.id === values[1]);
      product.stock -= values[0];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO stock_movements")) {
      const opening = sql.includes("'Opening balance'");
      const movement = {
        id: crypto.randomUUID(),
        product_id: values[0],
        product_name: values[1],
        change_quantity: values[2],
        stock_after: opening ? values[2] : values[3],
        reason: opening ? "Opening balance" : sql.includes("'Purchase order'") ? "Purchase order" : values[4],
        reference: sql.includes("'Purchase order'") ? values[4] : null,
        performed_by: opening ? values[3] : sql.includes("'Purchase order'") ? values[5] : values[5],
        created_at: new Date(),
      };
      this.movements.push(movement);
      return { rows: [{ ...movement }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO sales (product_id, product_name, quantity, unit_price, sold_by)")) {
      const product = this.products.find((item) => item.id === values[0]);
      const sale = {
        id: crypto.randomUUID(),
        product_id: values[0],
        product_name: values[1],
        quantity: values[2],
        unit_price: values[3],
        total: values[2] * values[3],
        sold_by: values[4],
        sold_at: new Date(),
      };
      this.sales.push(sale);
      this.movements.push({
        id: crypto.randomUUID(), product_id: product.id, product_name: product.name,
        change_quantity: -values[2], stock_after: product.stock, reason: "Sale",
        performed_by: values[4], created_at: sale.sold_at,
      });
      return { rows: [{ ...sale }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO sales (product_id, product_name, quantity, unit_price, sold_by, sold_at)")) {
      this.sales.push({
        id: crypto.randomUUID(), product_id: values[0], product_name: values[1],
        quantity: values[2], unit_price: values[3], total: values[2] * values[3],
        sold_by: values[4], sold_at: values[5],
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const productBody = {
  name: "Desk lamp",
  sku: "LAMP-001",
  category: "Lighting",
  price: 24.99,
  cost: 9.5,
  stock: 5,
  reorderLevel: 2,
};

test("setup, sessions, CSRF protection, and server-enforced role permissions", async () => {
  const pool = new MemoryPool();
  const sentEmails = [];
  const app = createApp(pool, {
    sessionSecret: "test-only-secret-with-at-least-32-bytes",
    sessionStore: new session.MemoryStore(),
    disableRateLimit: true,
    sendEmail: async (message) => sentEmails.push(message),
  });
  const admin = request.agent(app);
  const anonymous = await admin.get("/api/auth/session").expect(200);
  assert.equal(anonymous.body.setupRequired, true);
  assert.equal((await admin.post("/api/products").send(productBody).expect(403)).body.error.includes("security token"), true);

  const badSetup = await admin.post("/api/auth/setup")
    .set("X-CSRF-Token", anonymous.body.csrfToken)
    .send({ name: "Admin", email: "admin@example.test", password: "short" })
    .expect(400);
  assert.match(badSetup.body.error, /12 and 200/);

  const setup = await admin.post("/api/auth/setup")
    .set("X-CSRF-Token", anonymous.body.csrfToken)
    .send({
      name: "Admin",
      email: "admin@example.test",
      password: "correct-horse-battery-staple",
      legacyData: {
        products: [{ id: "old-p1", ...productBody }],
        sales: [{ productId: "old-p1", productName: productBody.name, quantity: 1, unitPrice: productBody.price, date: new Date().toISOString() }],
      },
    })
    .expect(202);
  assert.match(setup.body.message, /verification link/);
  assert.equal(sentEmails.length, 1);
  assert.equal(pool.products.length, 1);
  assert.equal(pool.sales.length, 1);
  assert.equal(pool.products[0].stock, 5, "import preserves already-decremented inventory levels");
  const unverifiedToken = new URL(sentEmails[0].text.match(/http:\/\/localhost:8000\/\?verify=[^\s]+/)[0]).searchParams.get("verify");
  const unverifiedLogin = await admin.post("/api/auth/login")
    .set("X-CSRF-Token", anonymous.body.csrfToken)
    .send({ email: "admin@example.test", password: "correct-horse-battery-staple" })
    .expect(403);
  assert.match(unverifiedLogin.body.error, /Verify your email/);
  const verifiedAdmin = await admin.post("/api/auth/verify-email").send({ token: unverifiedToken }).expect(200);
  assert.equal(verifiedAdmin.body.user.role, "admin");
  assert.notEqual(
    verifiedAdmin.headers["set-cookie"][0].split(";")[0],
    anonymous.headers["set-cookie"][0].split(";")[0],
    "email verification rotates the pre-authentication session identifier",
  );

  const adminData = await admin.get("/api/bootstrap").expect(200);
  assert.equal(adminData.body.products[0].cost, 9.5);
  const csrf = adminData.body.csrfToken;
  for (const resource of ["products", "sales", "stock-history", "purchase-orders"]) {
    const exported = await admin.get(`/api/exports/${resource}.csv`).expect(200);
    assert.match(exported.headers["content-type"], /text\/csv/);
    assert.match(exported.headers["content-disposition"], /attachment; filename="stockroom-/);
    assert.ok(exported.text.startsWith("\uFEFF"), `${resource} export includes a UTF-8 BOM`);
    assert.match(exported.text, /"Product"|"Order"/);
  }
  const originalProductName = pool.products[0].name;
  pool.products[0].name = '=HYPERLINK("https://example.test")';
  const formulaSafeExport = await admin.get("/api/exports/products.csv").expect(200);
  assert.match(formulaSafeExport.text, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  pool.products[0].name = originalProductName;
  await admin.get("/api/exports/not-a-resource.csv").expect(404);
  const invalidCsrf = await admin.post("/api/products").set("X-CSRF-Token", "invalid-token").send(productBody).expect(403);
  assert.match(invalidCsrf.body.error, /security token is invalid/);
  const managerResult = await admin.post("/api/users")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Store Manager", email: "manager@example.test", password: "manager-password-123", role: "manager" })
    .expect(201);
  const cashierResult = await admin.post("/api/users")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Store Cashier", email: "cashier@example.test", password: "cashier-password-123", role: "cashier" })
    .expect(201);
  assert.equal(sentEmails.length, 3);
  const resendCsrf = (await admin.get("/api/auth/session").expect(200)).body.csrfToken;
  await admin.post("/api/auth/resend-verification")
    .set("X-CSRF-Token", resendCsrf)
    .send({ email: "manager@example.test" })
    .expect(200);
  const managerVerificationToken = new URL(sentEmails[3].text.match(/http:\/\/localhost:8000\/\?verify=[^\s]+/)[0]).searchParams.get("verify");
  const cashierVerificationToken = new URL(sentEmails[2].text.match(/http:\/\/localhost:8000\/\?verify=[^\s]+/)[0]).searchParams.get("verify");

  const manager = request.agent(app);
  const managerCsrf = await manager.get("/api/auth/session").then((response) => response.body.csrfToken);
  await manager.post("/api/auth/login")
    .set("X-CSRF-Token", managerCsrf)
    .send({ email: "manager@example.test", password: "manager-password-123" })
    .expect(403);
  const managerLogin = await manager.post("/api/auth/verify-email").send({ token: managerVerificationToken }).expect(200);
  const managerToken = managerLogin.body.csrfToken;
  assert.equal(managerLogin.body.user.role, "manager");
  assert.equal((await manager.get("/api/bootstrap").expect(200)).body.products[0].cost, 9.5);
  assert.equal((await manager.post("/api/products").set("X-CSRF-Token", managerToken).send(productBody).expect(201)).body.product.stock, 5);
  assert.equal((await manager.get("/api/users").expect(403)).body.error, "Your role does not allow this action.");

  const cashier = request.agent(app);
  const cashierCsrf = await cashier.get("/api/auth/session").then((response) => response.body.csrfToken);
  const invalidLogin = await cashier.post("/api/auth/login")
    .set("X-CSRF-Token", cashierCsrf)
    .send({ email: "cashier@example.test", password: "incorrect-password-123" })
    .expect(401);
  assert.equal(invalidLogin.body.error, "Email or password is incorrect.");
  await cashier.post("/api/auth/login")
    .set("X-CSRF-Token", cashierCsrf)
    .send({ email: "cashier@example.test", password: "cashier-password-123" })
    .expect(403);
  const cashierLogin = await cashier.post("/api/auth/verify-email").send({ token: cashierVerificationToken }).expect(200);
  const cashierToken = cashierLogin.body.csrfToken;
  const cashierData = await cashier.get("/api/bootstrap").expect(200);
  assert.equal(cashierData.body.products[0].cost, null);
  assert.equal(cashierData.body.sales.length, 0);
  await cashier.post("/api/products").set("X-CSRF-Token", cashierToken).send(productBody).expect(403);
  await cashier.put(`/api/products/${cashierData.body.products[0].id}`).set("X-CSRF-Token", cashierToken).send(productBody).expect(403);
  await cashier.delete(`/api/products/${cashierData.body.products[0].id}`).set("X-CSRF-Token", cashierToken).expect(403);
  await cashier.post("/api/users").set("X-CSRF-Token", cashierToken)
    .send({ name: "Other user", email: "other@example.test", password: "other-password-123", role: "cashier" }).expect(403);

  const sale = await cashier.post("/api/sales")
    .set("X-CSRF-Token", cashierToken)
    .send({ productId: cashierData.body.products[0].id, quantity: 2, unitPrice: 20.25 })
    .expect(201);
  assert.equal(sale.body.sale.total, 40.5);
  assert.equal(pool.products.find((product) => product.id === cashierData.body.products[0].id).stock, 3);
  await cashier.get("/api/stock-movements").expect(403);
  await cashier.get("/api/exports/products.csv").expect(403);
  await cashier.get("/api/suppliers").expect(403);
  await cashier.get("/api/purchase-orders").expect(403);
  await cashier.post(`/api/products/${cashierData.body.products[0].id}/stock-movements`)
    .set("X-CSRF-Token", cashierToken)
    .send({ direction: "in", quantity: 1, reason: "Restock" })
    .expect(403);
  await cashier.post("/api/sales")
    .set("X-CSRF-Token", cashierToken)
    .send({ productId: cashierData.body.products[0].id, quantity: 4, unitPrice: 20.25 })
    .expect(409);
  assert.equal(pool.products.find((product) => product.id === cashierData.body.products[0].id).stock, 3);
  assert.equal((await cashier.get("/api/bootstrap").expect(200)).body.sales.length, 1);
  assert.equal((await admin.get("/api/bootstrap").expect(200)).body.sales.length, 2);
  await admin.patch(`/api/users/${managerResult.body.user.id}`)
    .set("X-CSRF-Token", csrf)
    .send({ active: false })
    .expect(200);
  await manager.get("/api/bootstrap").expect(401);
  await admin.patch(`/api/users/${managerResult.body.user.id}`)
    .set("X-CSRF-Token", csrf)
    .send({ active: true })
    .expect(200);

  await cashier.post("/api/auth/logout").set("X-CSRF-Token", cashierToken).expect(204);
  await cashier.get("/api/bootstrap").expect(401);
  const loggedOut = await cashier.get("/api/auth/session").expect(200);
  assert.equal(loggedOut.body.user, null);
  assert.equal((await cashier.post("/api/sales").send({ productId: "x", quantity: 1, unitPrice: 1 }).expect(403)).status, 403);
  assert.equal(managerResult.body.user.role, "manager");
  assert.equal(cashierResult.body.user.role, "cashier");
  const administratorId = pool.users.find((user) => user.role === "admin").id;
  const selfDemotion = await admin.patch(`/api/users/${administratorId}`)
    .set("X-CSRF-Token", csrf)
    .send({ role: "manager" })
    .expect(400);
  assert.match(selfDemotion.body.error, /own administrator access/);
  const resetPassword = await admin.patch(`/api/users/${cashierResult.body.user.id}`)
    .set("X-CSRF-Token", csrf)
    .send({ password: "new-cashier-password-123" })
    .expect(200);
  assert.equal(resetPassword.body.user.role, "cashier");
  assert.ok(pool.statements.some((statement) => statement.startsWith("DELETE FROM http_sessions")), "password resets revoke previous sessions");
  const selfDeactivation = await admin.patch(`/api/users/${administratorId}`)
    .set("X-CSRF-Token", csrf)
    .send({ active: false })
    .expect(400);
  assert.match(selfDeactivation.body.error, /own administrator access/);

  const returningCashier = request.agent(app);
  const returningCsrf = (await returningCashier.get("/api/auth/session").expect(200)).body.csrfToken;
  await returningCashier.post("/api/auth/login")
    .set("X-CSRF-Token", returningCsrf)
    .send({ email: "cashier@example.test", password: "cashier-password-123" })
    .expect(401);
  await returningCashier.post("/api/auth/login")
    .set("X-CSRF-Token", returningCsrf)
    .send({ email: "cashier@example.test", password: "new-cashier-password-123" })
    .expect(200);
  assert.equal((await returningCashier.get("/api/bootstrap").expect(200)).body.sales.length, 1, "the sale remains available after a new login");
  const adjustment = await admin.post(`/api/products/${adminData.body.products[0].id}/stock-movements`)
    .set("X-CSRF-Token", csrf)
    .send({ direction: "in", quantity: 4, reason: "Restock" })
    .expect(201);
  assert.equal(adjustment.body.movement.change, 4);
  assert.equal(adjustment.body.movement.stockAfter, 7);
  const movementCount = pool.movements.length;
  await admin.put(`/api/products/${adminData.body.products[0].id}`)
    .set("X-CSRF-Token", csrf)
    .send({ ...productBody, stock: 99 })
    .expect(200);
  assert.equal(pool.products.find((product) => product.id === adminData.body.products[0].id).stock, 7, "product edits cannot bypass the movement history");
  assert.equal(pool.movements.length, movementCount, "non-stock product edits do not create stock entries");
  const movements = await admin.get("/api/stock-movements?limit=20&offset=0").expect(200);
  assert.ok(movements.body.movements.some((movement) => movement.reason === "Sale" && movement.change === -2));
  assert.ok(movements.body.movements.some((movement) => movement.reason === "Restock" && movement.stockAfter === 7));
  await admin.post(`/api/products/${adminData.body.products[0].id}/stock-movements`)
    .set("X-CSRF-Token", csrf)
    .send({ direction: "out", quantity: 1, reason: "Restock" })
    .expect(400);
  await admin.get("/api/stock-movements?limit=101").expect(400);
  await admin.post(`/api/products/${adminData.body.products[0].id}/stock-movements`)
    .set("X-CSRF-Token", csrf)
    .send({ direction: "out", quantity: 8, reason: "Damaged / lost" })
    .expect(409);

  const supplierResponse = await admin.post("/api/suppliers")
    .set("X-CSRF-Token", csrf)
    .send({ name: "Local Supply Co", email: "orders@local.example.test", phone: "555-0100", address: "12 Market Street" })
    .expect(201);
  const supplierId = supplierResponse.body.supplier.id;
  const updatedSupplier = await admin.patch(`/api/suppliers/${supplierId}`)
    .set("X-CSRF-Token", csrf)
    .send({ name: "Local Supply Co", email: "orders@local.example.test", phone: "555-0101", address: "12 Market Street" })
    .expect(200);
  assert.equal(updatedSupplier.body.supplier.phone, "555-0101");
  const productId = adminData.body.products[0].id;
  const orderResponse = await admin.post("/api/purchase-orders")
    .set("X-CSRF-Token", csrf)
    .send({ supplierId, items: [{ productId, quantity: 10, unitCost: 9.5 }] })
    .expect(201);
  const orderId = orderResponse.body.purchaseOrder.id;
  await admin.post(`/api/purchase-orders/${orderId}/receipts`)
    .set("X-CSRF-Token", csrf)
    .send({ items: [] })
    .expect(400);
  const firstReceipt = await admin.post(`/api/purchase-orders/${orderId}/receipts`)
    .set("X-CSRF-Token", csrf)
    .send({ items: [{ itemId: pool.purchaseOrderItems[0].id, quantity: 4 }] })
    .expect(200);
  assert.equal(firstReceipt.body.purchaseOrder.status, "partially_received");
  assert.equal(pool.products.find((product) => product.id === productId).stock, 11);
  await admin.post(`/api/purchase-orders/${orderId}/receipts`)
    .set("X-CSRF-Token", csrf)
    .send({ items: [{ itemId: pool.purchaseOrderItems[0].id, quantity: 7 }] })
    .expect(409);
  assert.equal(pool.products.find((product) => product.id === productId).stock, 11, "an excessive receipt does not change stock");
  const finalReceipt = await admin.post(`/api/purchase-orders/${orderId}/receipts`)
    .set("X-CSRF-Token", csrf)
    .send({ items: [{ itemId: pool.purchaseOrderItems[0].id, quantity: 6 }] })
    .expect(200);
  assert.equal(finalReceipt.body.purchaseOrder.status, "received");
  assert.equal(pool.products.find((product) => product.id === productId).stock, 17);
  assert.equal(pool.purchaseOrderReceipts.reduce((total, receipt) => total + receipt.quantity, 0), 10);
  const purchaseOrderList = await admin.get("/api/purchase-orders").expect(200);
  assert.equal(purchaseOrderList.body.purchaseOrders[0].status, "received");
  assert.equal(purchaseOrderList.body.purchaseOrders[0].items[0].quantityReceived, 10);
  const purchaseMovements = await admin.get("/api/stock-movements?limit=100").expect(200);
  assert.equal(purchaseMovements.body.movements.filter((movement) => movement.reason === "Purchase order").length, 2);
  assert.ok(purchaseMovements.body.movements.some((movement) => movement.reference === orderResponse.body.purchaseOrder.number));

  const cancelOrder = await admin.post("/api/purchase-orders")
    .set("X-CSRF-Token", csrf)
    .send({ supplierId, items: [{ productId, quantity: 2, unitCost: 9.5 }] })
    .expect(201);
  await admin.post(`/api/purchase-orders/${cancelOrder.body.purchaseOrder.id}/cancel`)
    .set("X-CSRF-Token", csrf)
    .expect(200);
  await admin.post(`/api/purchase-orders/${cancelOrder.body.purchaseOrder.id}/receipts`)
    .set("X-CSRF-Token", csrf)
    .send({ items: [{ itemId: pool.purchaseOrderItems[1].id, quantity: 1 }] })
    .expect(409);
});

test("PostgreSQL schema explicitly creates the session table without removed OIDS syntax", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "001_initial.sql"), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS http_sessions/);
  assert.match(schema, /sid varchar PRIMARY KEY/);
  assert.match(schema, /sess json NOT NULL/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS stock_movements/);
  assert.match(schema, /email_verified boolean NOT NULL DEFAULT true/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS email_verifications/);
  assert.match(schema, /token_hash char\(64\) NOT NULL UNIQUE/);
  assert.match(schema, /stock_movements_created_at_idx/);
  assert.match(schema, /Opening balance/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS suppliers/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS purchase_orders/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS purchase_order_receipts/);
  assert.doesNotMatch(schema, /WITH\s*\(\s*OIDS/i);
});

test("startup rejects missing database credentials and example session-secret placeholders", () => {
  assert.throws(() => validateConfig({}), /DATABASE_URL is required/);
  assert.throws(() => validateConfig({
    DATABASE_URL: "postgresql://user:password@localhost:5432/stockroom",
    SESSION_SECRET: "GENERATE_A_UNIQUE_RANDOM_VALUE_AT_LEAST_32_BYTES_LONG",
  }), /SESSION_SECRET must be a unique random value/);
  assert.throws(() => validateConfig({
    DATABASE_URL: "postgresql://stockroom_app:URL_ENCODED_PASSWORD@localhost:2510/stockroom",
    SESSION_SECRET: "a-unique-random-session-secret-at-least-32-bytes",
  }), /DATABASE_URL is required/);
  assert.throws(() => validateConfig({
    DATABASE_URL: "not-a-postgres-url",
    SESSION_SECRET: "a-unique-random-session-secret-at-least-32-bytes",
  }), /valid PostgreSQL connection URL/);
  assert.doesNotThrow(() => validateConfig({
    DATABASE_URL: "postgresql://user:password@localhost:5432/stockroom",
    SESSION_SECRET: "a-unique-random-session-secret-at-least-32-bytes",
  }));
});

test("validation rejects malformed amounts and duplicate legacy identifiers", async () => {
  const pool = new MemoryPool();
  const app = createApp(pool, { sessionSecret: "another-test-secret-with-32-bytes-minimum", sessionStore: new session.MemoryStore(), disableRateLimit: true });
  const agent = request.agent(app);
  const csrf = (await agent.get("/api/auth/session").expect(200)).body.csrfToken;
  const result = await agent.post("/api/auth/setup").set("X-CSRF-Token", csrf).send({
    name: "First Admin",
    email: "first@example.test",
    password: "long-enough-test-password",
    legacyData: {
      products: [
        { id: "duplicate", ...productBody },
        { id: "duplicate", ...{ ...productBody, sku: "LAMP-002" } },
      ],
      sales: [],
    },
  }).expect(400);
  assert.match(result.body.error, /duplicate product IDs/);
  assert.equal(pool.users.length, 0, "invalid first-admin import rolls back user creation");
});
