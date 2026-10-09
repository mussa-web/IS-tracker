"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("browser UI completes setup, inventory, sale, logout, and a fresh role-based login", async () => {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  const { window } = dom;
  const users = {
    admin: { id: "user-admin", name: "Store Admin", email: "admin@example.test", role: "admin", active: true },
    cashier: { id: "user-cashier", name: "Store Cashier", email: "cashier@example.test", role: "cashier", active: true },
  };
  let currentUser = null;
  let configured = false;
  let csrf = "anonymous-token";
  let productList = [];
  let sales = [];
  let movements = [];
  let suppliers = [];
  let purchaseOrders = [];
  const requests = [];

  window.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ url, method, csrf: options.headers["X-CSRF-Token"] || null });
    if (method !== "GET" && options.headers["X-CSRF-Token"] !== csrf) {
      return { ok: false, status: 403, json: async () => ({ error: "Invalid CSRF token" }) };
    }
    if (url === "/api/auth/session") {
      return { ok: true, status: 200, json: async () => ({ setupRequired: !configured, user: currentUser, csrfToken: csrf }) };
    }
    if (url === "/api/auth/setup" && method === "POST") {
      configured = true;
      return { ok: true, status: 202, json: async () => ({ message: "Check your email for a verification link." }) };
    }
    if (url === "/api/auth/login" && method === "POST") {
      currentUser = body.email === users.cashier.email ? users.cashier : users.admin;
      csrf = `authenticated-${currentUser.role}-token`;
      return { ok: true, status: 200, json: async () => ({ user: currentUser, csrfToken: csrf }) };
    }
    if (url === "/api/auth/logout" && method === "POST") {
      currentUser = null;
      csrf = "fresh-anonymous-token";
      return { ok: true, status: 204, json: async () => null };
    }
    if (url === "/api/bootstrap") {
      const products = currentUser.role === "cashier"
        ? productList.map((product) => ({ ...product, cost: null }))
        : productList;
      return { ok: true, status: 200, json: async () => ({ user: currentUser, csrfToken: csrf, products, sales: currentUser.role === "cashier" ? sales.filter((sale) => sale.soldBy === currentUser.id) : sales }) };
    }
    if (url.startsWith("/api/stock-movements?")) {
      const params = new URLSearchParams(url.split("?")[1]);
      const offset = Number(params.get("offset"));
      const limit = Number(params.get("limit"));
      return { ok: true, status: 200, json: async () => ({ movements: movements.slice().reverse().slice(offset, offset + limit) }) };
    }
    if (url === "/api/suppliers" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ suppliers }) };
    }
    if (url === "/api/purchase-orders" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ purchaseOrders }) };
    }
    if (url === "/api/suppliers" && method === "POST") {
      const supplier = { ...body, id: "supplier-1", createdAt: new Date().toISOString() };
      suppliers.push(supplier);
      return { ok: true, status: 201, json: async () => ({ supplier }) };
    }
    if (url.startsWith("/api/suppliers/") && method === "PATCH") {
      const supplier = suppliers.find((item) => url.includes(item.id));
      Object.assign(supplier, body);
      return { ok: true, status: 200, json: async () => ({ supplier }) };
    }
    if (url === "/api/purchase-orders" && method === "POST") {
      const supplier = suppliers.find((item) => item.id === body.supplierId);
      const order = {
        id: "order-1", number: "PO-1001", supplierId: supplier.id, supplierName: supplier.name,
        status: "ordered", date: new Date().toISOString(),
        items: body.items.map((item, index) => {
          const product = productList.find((entry) => entry.id === item.productId);
          return {
            id: `order-item-${index + 1}`, productId: product.id, productName: product.name, sku: product.sku,
            quantityOrdered: item.quantity, quantityReceived: 0, quantityRemaining: item.quantity,
            unitCost: item.unitCost, totalCost: item.quantity * item.unitCost,
          };
        }),
      };
      purchaseOrders.unshift(order);
      return { ok: true, status: 201, json: async () => ({ purchaseOrder: order }) };
    }
    if (url.startsWith("/api/purchase-orders/") && url.endsWith("/receipts") && method === "POST") {
      const order = purchaseOrders.find((item) => url.includes(item.id));
      for (const receipt of body.items) {
        const item = order.items.find((entry) => entry.id === receipt.itemId);
        item.quantityReceived += receipt.quantity;
        item.quantityRemaining -= receipt.quantity;
        const product = productList.find((entry) => entry.id === item.productId);
        product.stock += receipt.quantity;
        movements.push({
          id: `receipt-${movements.length + 1}`, productId: product.id, productName: product.name,
          change: receipt.quantity, stockAfter: product.stock, reason: "Purchase order",
          reference: order.number, date: new Date().toISOString(), performedBy: currentUser.name,
        });
      }
      order.status = order.items.every((item) => item.quantityRemaining === 0) ? "received" : "partially_received";
      return { ok: true, status: 200, json: async () => ({ purchaseOrder: order }) };
    }
    if (url === "/api/products" && method === "POST") {
      const product = { ...body, id: "product-1", createdAt: new Date().toISOString() };
      productList.push(product);
      if (product.stock > 0) movements.push({ id: "opening-1", productId: product.id, productName: product.name, change: product.stock, stockAfter: product.stock, reason: "Opening balance", date: new Date().toISOString(), performedBy: currentUser.name });
      return { ok: true, status: 201, json: async () => ({ product }) };
    }
    if (url.startsWith("/api/products/") && url.endsWith("/stock-movements") && method === "POST") {
      const product = productList.find((item) => url.includes(encodeURIComponent(item.id)));
      if (!product) return { ok: false, status: 404, json: async () => ({ error: "Product not found" }) };
      const change = body.direction === "in" ? body.quantity : -body.quantity;
      product.stock += change;
      movements.push({ id: "adjustment-1", productId: product.id, productName: product.name, change, stockAfter: product.stock, reason: body.reason, date: new Date().toISOString(), performedBy: currentUser.name });
      return { ok: true, status: 201, json: async () => ({ movement: movements[movements.length - 1] }) };
    }
    if (url === "/api/sales" && method === "POST") {
      const product = productList.find((item) => item.id === body.productId);
      if (!product || product.stock < body.quantity) return { ok: false, status: 409, json: async () => ({ error: "Insufficient stock" }) };
      product.stock -= body.quantity;
      const date = new Date().toISOString();
      sales.push({ id: "sale-1", productId: product.id, productName: product.name, quantity: body.quantity, unitPrice: body.unitPrice, total: body.quantity * body.unitPrice, date, soldBy: currentUser.id });
      movements.push({ id: "sale-movement-1", productId: product.id, productName: product.name, change: -body.quantity, stockAfter: product.stock, reason: "Sale", date, performedBy: currentUser.name });
      return { ok: true, status: 201, json: async () => ({ sale: sales[sales.length - 1] }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };

  window.eval(source);
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for browser UI state.");
  };
  await waitFor(() => !window.document.getElementById("auth-screen").classList.contains("hidden"));
  assert.equal(window.document.getElementById("setup-form").classList.contains("hidden"), false);

  const setupForm = window.document.getElementById("setup-form");
  setupForm.querySelector('[name="name"]').value = "Store Admin";
  setupForm.querySelector('[name="email"]').value = "admin@example.test";
  setupForm.querySelector('[name="password"]').value = "long-enough-admin-password";
  setupForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => window.document.getElementById("auth-subtitle").textContent.includes("verification link"));
  currentUser = users.admin;
  window.document.querySelector('#login-form [name="email"]').value = users.admin.email;
  window.document.querySelector('#login-form [name="password"]').value = "long-enough-admin-password";
  window.document.getElementById("login-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => currentUser && window.document.getElementById("sidebar-user-name").textContent === "Store Admin");

  window.document.querySelector('[data-action="add-product"]').click();
  for (const [id, value] of Object.entries({
    "product-name": "Desk lamp",
    "product-sku": "LAMP-001",
    "product-category": "Lighting",
    "product-price": "12.50",
    "product-cost": "4",
    "product-stock": "5",
    "product-reorder": "2",
  })) window.document.getElementById(id).value = value;
  window.document.getElementById("product-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => productList.length === 1 && window.document.getElementById("toast-region").textContent.includes("Product added"));
  assert.equal(requests.find((item) => item.url === "/api/products").csrf, "authenticated-admin-token");

  window.document.querySelector('[data-action="record-sale"]').click();
  window.document.getElementById("sale-quantity").value = "2";
  window.document.getElementById("sale-price").value = "12.50";
  window.document.getElementById("sale-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => sales.length === 1 && productList[0].stock === 3 && window.document.getElementById("toast-region").textContent.includes("Sale recorded"));
  assert.equal(sales[0].total, 25);

  window.document.querySelector('[data-page="inventory"]').click();
  window.document.querySelector('[data-action="adjust-stock"]').click();
  window.document.getElementById("adjustment-quantity").value = "4";
  window.document.getElementById("adjustment-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => productList[0].stock === 7 && window.document.getElementById("toast-region").textContent.includes("Stock updated"));
  window.document.querySelector('[data-page="movements"]').click();
  await waitFor(() => window.document.getElementById("movements-body").querySelectorAll("tr").length === 3);
  assert.match(window.document.getElementById("movements-body").textContent, /Opening balance/);
  assert.match(window.document.getElementById("movements-body").textContent, /Restock/);
  window.document.querySelector('[data-page="inventory"]').click();
  window.document.querySelector('[data-action="adjust-stock"]').click();
  window.document.getElementById("adjustment-direction").value = "out";
  window.document.getElementById("adjustment-reason").value = "Damaged / lost";
  window.document.getElementById("adjustment-quantity").value = "6";
  window.document.getElementById("adjustment-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => productList[0].stock === 1);

  window.document.querySelector('[data-page="procurement"]').click();
  await waitFor(() => window.document.getElementById("suppliers-body").children.length === 0);
  await waitFor(() => window.document.getElementById("reorder-suggestion-count").textContent === "1");
  assert.match(window.document.getElementById("reorder-suggestions-body").textContent, /Desk lamp[\s\S]*1[\s\S]*2[\s\S]*1/);
  window.document.querySelector('[data-action="create-suggested-order"]').click();
  assert.equal(window.document.querySelector("[data-order-quantity]").value, "1", "suggested order quantity fills the gap to the reorder level");
  window.document.getElementById("modal-close").click();
  window.document.querySelector('[data-action="add-supplier"]').click();
  window.document.getElementById("supplier-name").value = "Local Supply Co";
  window.document.getElementById("supplier-email").value = "orders@local.example.test";
  window.document.getElementById("supplier-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => suppliers.length === 1 && window.document.getElementById("suppliers-body").textContent.includes("Local Supply Co"));
  window.document.querySelector('[data-action="edit-supplier"]').click();
  window.document.getElementById("supplier-phone").value = "555-0101";
  window.document.getElementById("supplier-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => suppliers[0].phone === "555-0101" && window.document.getElementById("suppliers-body").textContent.includes("555-0101"));
  window.document.querySelector('[data-action="create-purchase-order"]').click();
  window.document.querySelector("[data-order-quantity]").value = "5";
  window.document.querySelector("[data-order-cost]").value = "4";
  window.document.getElementById("purchase-order-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => purchaseOrders.length === 1 && window.document.getElementById("purchase-orders-body").textContent.includes("PO-1001"));
  window.document.querySelector('[data-action="receive-purchase-order"]').click();
  window.document.querySelector("[data-receipt-item]").value = "2";
  window.document.getElementById("receipt-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => productList[0].stock === 3
    && purchaseOrders[0].status === "partially_received"
    && window.document.getElementById("purchase-orders-body").textContent.includes("partially received"));
  assert.match(window.document.getElementById("purchase-orders-body").textContent, /partially received/);
  window.document.querySelector('[data-page="movements"]').click();
  await waitFor(() => window.document.getElementById("movements-body").textContent.includes("PO-1001"));
  const csvLinks = [...window.document.querySelectorAll(".export-links a")].map((link) => link.getAttribute("href"));
  assert.deepEqual(csvLinks, [
    "/api/exports/products.csv",
    "/api/exports/sales.csv",
    "/api/exports/stock-history.csv",
    "/api/exports/purchase-orders.csv",
  ]);

  window.document.querySelector('[data-action="logout"]').click();
  await waitFor(() => requests.filter((item) => item.url === "/api/auth/session").length === 2);
  await waitFor(() => !window.document.getElementById("login-form").classList.contains("hidden"));
  assert.equal(csrf, "fresh-anonymous-token");
  window.document.querySelector('#login-form [name="email"]').value = users.cashier.email;
  window.document.querySelector('#login-form [name="password"]').value = "cashier-password-123";
  window.document.getElementById("login-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => currentUser === users.cashier && window.document.getElementById("sidebar-user-name").textContent === "Store Cashier");
  assert.equal(requests.filter((item) => item.url === "/api/auth/login").at(-1).csrf, "fresh-anonymous-token");
  assert.equal(window.document.querySelector('[data-page="reports"]').classList.contains("hidden"), true);
  assert.equal(window.document.querySelector('[data-page="movements"]').classList.contains("hidden"), true);
  assert.equal(window.document.getElementById("page-reports").classList.contains("hidden"), true);
  assert.equal(window.document.querySelector('[data-action="add-product"]').classList.contains("hidden"), true);
  assert.equal(window.document.getElementById("inventory-body").querySelector("tr").children.length, 6);

  dom.window.close();
});

test("verification link confirms email and signs the user in", async () => {
  const token = "a".repeat(64);
  const user = { id: "verified-admin", name: "Verified Admin", email: "verified@example.test", role: "admin", active: true };
  const dom = new JSDOM(html, { url: `http://localhost/?verify=${token}`, runScripts: "outside-only" });
  const { window } = dom;
  let csrf = "verification-csrf";
  const requests = [];
  window.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ url, body, csrf: options.headers["X-CSRF-Token"] || null });
    if (url === "/api/auth/session") {
      return { ok: true, status: 200, json: async () => ({ setupRequired: false, user: null, csrfToken: csrf }) };
    }
    if (url === "/api/auth/verify-email" && body.token === token) {
      csrf = "verified-csrf";
      return { ok: true, status: 200, json: async () => ({ user, csrfToken: csrf }) };
    }
    if (url === "/api/bootstrap") {
      return { ok: true, status: 200, json: async () => ({ user, csrfToken: csrf, products: [], sales: [] }) };
    }
    return { ok: false, status: 400, json: async () => ({ error: "Invalid request" }) };
  };
  window.eval(source);
  const form = window.document.getElementById("email-verification-form");
  for (let attempt = 0; attempt < 60 && form.classList.contains("hidden"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(form.classList.contains("hidden"), false);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  for (let attempt = 0; attempt < 60 && window.document.getElementById("app-shell").classList.contains("hidden"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(window.document.getElementById("app-shell").classList.contains("hidden"), false);
  assert.equal(window.document.getElementById("sidebar-user-name").textContent, "Verified Admin");
  const verifyRequest = requests.find((request) => request.url === "/api/auth/verify-email");
  assert.equal(verifyRequest.body.token, token);
  assert.equal(verifyRequest.csrf, "verification-csrf");
  assert.equal(window.location.search, "");
  dom.window.close();
});
