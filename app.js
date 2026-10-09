(function () {
  "use strict";

  const colors = [
    { bg: "#edf4ef", fg: "#719278", icon: "◈" },
    { bg: "#f5eee6", fg: "#bb8e60", icon: "▤" },
    { bg: "#eef0f7", fg: "#8189ad", icon: "✳" },
    { bg: "#f7eded", fg: "#bd8181", icon: "◉" },
    { bg: "#eef4f5", fg: "#6f9ba0", icon: "▱" },
  ];
  const dayMs = 24 * 60 * 60 * 1000;
  let data = { products: [], sales: [] };
  let procurement = { suppliers: [], purchaseOrders: [] };
  let currentUser = null;
  let csrf = null;
  let legacyImportData = null;
  let activePage = "dashboard";
  let movementOffset = 0;
  let movementHasMore = false;
  let activeReceiptOrderId = null;
  const verificationToken = new URLSearchParams(window.location.search).get("verify");
  const displayPreferenceKey = "stockroom-display-preferences";
  let toastTimer;
  const byId = (id) => document.getElementById(id);
  const money = (amount) => new Intl.NumberFormat("en-TZ", {
    style: "currency",
    currency: "TZS",
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
  const number = (value) => new Intl.NumberFormat().format(Number(value) || 0);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const getProduct = (id) => data.products.find((product) => product.id === id);
  const colorFor = (text) => colors[(Array.from(String(text || "")).reduce((sum, char) => sum + char.charCodeAt(0), 0)) % colors.length];
  const productIcon = (name, extraClass) => {
    const color = colorFor(name);
    return `<span class="${extraClass}" style="background:${color.bg};color:${color.fg}" aria-hidden="true">${color.icon}</span>`;
  };
  const formatDate = (value, options) => new Intl.DateTimeFormat(undefined, options).format(new Date(value));
  const sortSales = () => [...data.sales].sort((a, b) => new Date(b.date) - new Date(a.date));
  const lowStockProducts = () => data.products.filter((product) => product.stock <= product.reorderLevel);
  const salesSince = (days) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);
    return data.sales.filter((sale) => new Date(sale.date) >= start);
  };
  const sum = (items, getValue) => items.reduce((total, item) => total + getValue(item), 0);

  async function api(path, options) {
    const config = options || {};
    const headers = { "Content-Type": "application/json", ...(config.headers || {}) };
    if (config.method && config.method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
    let response;
    try {
      response = await fetch(path, {
        method: config.method || "GET",
        credentials: "same-origin",
        headers,
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
      });
    } catch (error) {
      console.error("Stockroom API request failed:", error);
      throw new Error("Could not reach the Stockroom server. Check your connection and try again.");
    }
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && currentUser) {
        currentUser = null;
        try {
          const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin" });
          if (sessionResponse.ok) {
            const sessionState = await sessionResponse.json();
            csrf = sessionState.csrfToken;
          }
        } catch (sessionError) {
          console.error("Could not renew the sign-in session:", sessionError);
        }
        showAuth(false, "Your session expired. Sign in again.");
      }
      throw new Error(result.error || "The request could not be completed.");
    }
    if (result.csrfToken) csrf = result.csrfToken;
    return result;
  }

  async function refreshData() {
    const result = await api("/api/bootstrap");
    data = { products: result.products, sales: result.sales };
    currentUser = result.user;
    csrf = result.csrfToken || csrf;
    renderAll();
    updateRoleUI();
  }

  async function save(nextData, successMessage) {
    const addedSale = nextData.sales.find((sale) => !data.sales.some((item) => item.id === sale.id));
    if (addedSale) {
      await api("/api/sales", { method: "POST", body: { productId: addedSale.productId, quantity: addedSale.quantity, unitPrice: addedSale.unitPrice } });
    } else {
      const removed = data.products.find((product) => !nextData.products.some((item) => item.id === product.id));
      const added = nextData.products.find((product) => !data.products.some((item) => item.id === product.id));
      const changed = nextData.products.find((product) => {
        const before = data.products.find((item) => item.id === product.id);
        return before && JSON.stringify(before) !== JSON.stringify(product);
      });
      if (removed) {
        await api(`/api/products/${encodeURIComponent(removed.id)}`, { method: "DELETE" });
      } else if (added) {
        await api("/api/products", { method: "POST", body: productPayload(added) });
      } else if (changed) {
        await api(`/api/products/${encodeURIComponent(changed.id)}`, { method: "PUT", body: productPayload(changed) });
      }
    }
    await refreshData();
    if (successMessage) showToast(successMessage);
    return true;
  }

  function productPayload(product) {
    return {
      name: product.name,
      sku: product.sku,
      category: product.category,
      price: product.price,
      cost: product.cost ?? 0,
      stock: product.stock,
      reorderLevel: product.reorderLevel,
    };
  }

  function showAuth(setupRequired, message) {
    byId("app-shell").classList.add("hidden");
    byId("auth-screen").classList.remove("hidden");
    byId("setup-form").classList.toggle("hidden", !setupRequired);
    byId("login-form").classList.toggle("hidden", setupRequired);
    byId("email-verification-form").classList.add("hidden");
    byId("resend-verification-form").classList.add("hidden");
    byId("show-resend-verification").classList.toggle("hidden", setupRequired);
    byId("auth-eyebrow").textContent = setupRequired ? "FIRST-TIME SETUP" : "WELCOME BACK";
    byId("auth-title").textContent = setupRequired ? "Create your administrator" : "Sign in to your workspace";
    byId("auth-subtitle").textContent = message || (setupRequired ? "Set up the first administrator to secure this workspace." : "Your inventory and sales, all in one place.");
    byId("legacy-import-option").classList.toggle("hidden", !setupRequired || !legacyImportData);
    if (message) showToast(message, true);
  }

  function updateRoleUI() {
    if (!currentUser) return;
    const isAdmin = currentUser.role === "admin";
    const canManageProducts = isAdmin || currentUser.role === "manager";
    document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", !isAdmin));
    document.querySelectorAll(".manager-only").forEach((element) => element.classList.toggle("hidden", !canManageProducts));
    byId("sidebar-user-name").textContent = currentUser.name;
    byId("sidebar-user-role").textContent = `${currentUser.role[0].toUpperCase()}${currentUser.role.slice(1)} · Workspace`;
    byId("sidebar-avatar").textContent = currentUser.name.trim().charAt(0).toUpperCase();
    byId("topbar-avatar").textContent = currentUser.name.trim().charAt(0).toUpperCase();
  }

  function showToast(message, isError) {
    const region = byId("toast-region");
    region.innerHTML = `<div class="toast${isError ? " error" : ""}" role="status">${escapeHtml(message)}</div>`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { region.innerHTML = ""; }, 3400);
  }

  function readDisplayPreferences() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(displayPreferenceKey) || "{}");
      return {
        theme: saved.theme === "dark" ? "dark" : "light",
        fontSize: ["small", "normal", "large"].includes(saved.fontSize) ? saved.fontSize : "normal",
      };
    } catch (error) {
      console.info("Display preferences are unavailable in this browser.", error);
      return { theme: "light", fontSize: "normal" };
    }
  }

  function applyDisplayPreferences(preferences) {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.fontSize = preferences.fontSize;
    document.querySelectorAll("[data-display-setting]").forEach((button) => {
      const value = button.dataset.displaySetting === "theme" ? preferences.theme : preferences.fontSize;
      button.setAttribute("aria-pressed", String(button.dataset.value === value));
    });
    const themeColor = byId("theme-color");
    if (themeColor) themeColor.content = preferences.theme === "dark" ? "#171a20" : "#f7f8fa";
  }

  function saveDisplayPreference(setting, value) {
    const preferences = readDisplayPreferences();
    if (setting === "theme") preferences.theme = value;
    else preferences.fontSize = value;
    applyDisplayPreferences(preferences);
    try {
      window.localStorage.setItem(displayPreferenceKey, JSON.stringify(preferences));
    } catch (error) {
      console.info("Display preferences could not be saved in this browser.", error);
    }
  }

  function metricCard(label, value, icon, tone, foot) {
    return `<article class="metric-card"><div class="metric-top"><span>${label}</span><span class="metric-icon ${tone || ""}">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></article>`;
  }

  function renderMetrics(targetId, cards) {
    byId(targetId).innerHTML = cards.join("");
  }

  function updateDashboardGreeting() {
    const now = new Date();
    const hour = now.getHours();
    byId("greeting-text").textContent = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    byId("today-label").textContent = formatDate(now, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
  }

  function renderDashboard() {
    updateDashboardGreeting();
    const todaysSales = salesSince(1);
    const lastSevenDays = salesSince(7);
    const todaysRevenue = sum(todaysSales, (sale) => sale.total);
    const weekRevenue = sum(lastSevenDays, (sale) => sale.total);
    const stockAlerts = lowStockProducts();
    const units = sum(data.products, (product) => product.stock);
    const dailySales = getDailySales(7);
    const yesterdayStart = new Date();
    yesterdayStart.setHours(0, 0, 0, 0);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayRevenue = sum(data.sales.filter((sale) => new Date(sale.date) >= yesterdayStart && new Date(sale.date) < new Date(yesterdayStart.getTime() + dayMs)), (sale) => sale.total);
    const change = yesterdayRevenue ? ((todaysRevenue - yesterdayRevenue) / yesterdayRevenue) * 100 : null;
    const changeText = change === null ? "No sales yesterday" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs yesterday`;
    const changeClass = change === null ? "trend-neutral" : change >= 0 ? "trend-up" : "trend-down";

    renderMetrics("dashboard-metrics", [
      metricCard("Sales today", money(todaysRevenue), '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16M8 15l3.2-3.5 3 2 5.3-6"/></svg>', "", `<span class="${changeClass}">${changeText}</span>`),
      metricCard("Orders today", number(todaysSales.length), '<svg viewBox="0 0 24 24"><path d="M6 3h12l2 4v14H4V7l2-4Z"/><path d="M4 7h16M9 11h6"/></svg>', "purple", `<span class="trend-neutral">${number(sum(todaysSales, (sale) => sale.quantity))} items sold today</span>`),
      metricCard("Products in stock", number(units), '<svg viewBox="0 0 24 24"><path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z"/><path d="m4.5 7.2 7.5 3.9 7.5-3.9M12 11v9.5"/></svg>', "blue", `<span class="trend-neutral">${number(data.products.length)} unique products</span>`),
      metricCard("Low stock items", number(stockAlerts.length), '<svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/></svg>', "orange", `<span class="${stockAlerts.length ? "trend-down" : "trend-up"}">${stockAlerts.length ? "Restock soon" : "Stock levels healthy"}</span>`),
    ]);

    byId("chart-total").textContent = money(weekRevenue);
    byId("chart-range").textContent = "Last 7 days";
    renderChart("revenue-chart", "chart-y-axis", "chart-x-axis", dailySales);

    byId("stock-alert-list").innerHTML = stockAlerts.length
      ? stockAlerts.slice(0, 4).map((product) => `<div class="stock-alert-item">${productIcon(product.name, "product-mini-icon")}<div class="product-mini-copy"><strong>${escapeHtml(product.name)}</strong><span class="${product.stock === 0 ? "stock-critical" : "stock-warning"}">${product.stock === 0 ? "Out of stock" : `Only ${number(product.stock)} left`}</span></div><span class="stock-item-count">${number(product.stock)} / ${number(product.reorderLevel)} min</span></div>`).join("")
      : '<div class="stock-empty">Looking good — all products are above their low-stock thresholds.</div>';

    byId("recent-sales-body").innerHTML = sortSales().slice(0, 5).map((sale) => `<tr><td><span class="table-product">${productIcon(sale.productName, "sale-product-icon")}<span class="table-product-name">${escapeHtml(sale.productName)}</span></span></td><td>${relativeDate(sale.date)}</td><td>${number(sale.quantity)}</td><td class="align-right">${money(sale.total)}</td></tr>`).join("")
      || '<tr><td colspan="4" class="report-empty">No sales yet. Record your first sale to see it here.</td></tr>';

    byId("inventory-value").textContent = money(sum(data.products, (product) => product.stock * product.cost));
    byId("retail-value").textContent = money(sum(data.products, (product) => product.stock * product.price));
    byId("units-in-stock").textContent = number(units);
    byId("low-stock-count").textContent = number(stockAlerts.length);
    byId("inventory-nav-count").textContent = number(data.products.length);
    byId("alerts-button").setAttribute("aria-label", `${stockAlerts.length} low-stock items. View inventory`);
    byId("alerts-button").querySelector(".notification-dot").classList.toggle("hidden", stockAlerts.length === 0);
  }

  function relativeDate(value) {
    const date = new Date(value);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const difference = Math.floor((start - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / dayMs);
    if (difference === 0) return "Today";
    if (difference === 1) return "Yesterday";
    return formatDate(date, { month: "short", day: "numeric" });
  }

  function getDailySales(days) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(todayStart);
      date.setDate(todayStart.getDate() - (days - index - 1));
      const nextDay = new Date(date);
      nextDay.setDate(date.getDate() + 1);
      const sales = data.sales.filter((sale) => new Date(sale.date) >= date && new Date(sale.date) < nextDay);
      return { date, total: sum(sales, (sale) => sale.total) };
    });
  }

  function renderChart(chartId, yAxisId, xAxisId, days) {
    const svg = byId(chartId);
    const maxValue = Math.max(...days.map((item) => item.total), 0);
    const ceiling = maxValue > 0 ? Math.ceil(maxValue / 4 / 10) * 10 * 4 : 40;
    const width = 560;
    const height = chartId === "report-chart" ? 190 : 112;
    const padding = { top: 8, right: 6, bottom: 5, left: 2 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const points = days.map((item, index) => ({
      x: padding.left + (days.length === 1 ? innerWidth / 2 : (index / (days.length - 1)) * innerWidth),
      y: padding.top + innerHeight - (item.total / ceiling) * innerHeight,
    }));
    const grid = [0, 1, 2, 3, 4].map((step) => {
      const y = padding.top + (innerHeight / 4) * step;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#eff1f2" stroke-dasharray="${step === 4 ? "0" : "3 5"}" />`;
    }).join("");
    const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
    const area = `${path} L${points[points.length - 1].x},${height} L${points[0].x},${height} Z`;
    const markers = points.map((point, index) => `<circle cx="${point.x}" cy="${point.y}" r="${index === points.length - 1 ? 4 : 2.5}" fill="${index === points.length - 1 ? "#389a74" : "#fff"}" stroke="#389a74" stroke-width="2"><title>${escapeHtml(formatDate(days[index].date, { weekday: "long", month: "short", day: "numeric" }))}: ${money(days[index].total)}</title></circle>`).join("");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = `${grid}<path d="${area}" fill="url(#chartFill-${chartId})"/><defs><linearGradient id="chartFill-${chartId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#64ae89" stop-opacity=".19"/><stop offset="100%" stop-color="#64ae89" stop-opacity=".015"/></linearGradient></defs><path d="${path}" fill="none" stroke="#439d77" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${markers}`;
    const axisLabels = [4, 3, 2, 1, 0].map((step) => money(ceiling * step / 4).replace(/\.00$/, ""));
    byId(yAxisId).innerHTML = axisLabels.map((label) => `<span>${label}</span>`).join("");
    byId(xAxisId).innerHTML = days.map((item) => `<span>${escapeHtml(formatDate(item.date, { weekday: "short" }))}</span>`).join("");
  }

  function stockStatus(product) {
    if (product.stock === 0) return { label: "Out of stock", css: "status-out" };
    if (product.stock <= product.reorderLevel) return { label: "Low stock", css: "status-low" };
    return { label: "In stock", css: "status-healthy" };
  }

  function renderInventory() {
    const categories = [...new Set(data.products.map((product) => product.category))].sort((a, b) => a.localeCompare(b));
    const selectedCategory = byId("category-filter").value;
    byId("category-filter").innerHTML = `<option value="">All categories</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
    if (categories.includes(selectedCategory)) byId("category-filter").value = selectedCategory;
    byId("category-options").innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");

    const query = byId("inventory-search").value.trim().toLowerCase();
    const filterCategory = byId("category-filter").value;
    const filterStock = byId("stock-filter").value;
    const products = [...data.products].filter((product) => {
      const matchesQuery = [product.name, product.sku, product.category].some((value) => String(value).toLowerCase().includes(query));
      const matchesCategory = !filterCategory || product.category === filterCategory;
      const matchesStock = !filterStock || (filterStock === "out" ? product.stock === 0 : filterStock === "low" ? product.stock <= product.reorderLevel : product.stock > product.reorderLevel);
      return matchesQuery && matchesCategory && matchesStock;
    }).sort((a, b) => a.name.localeCompare(b.name));

    byId("product-count").textContent = `${products.length}${products.length !== data.products.length ? ` / ${data.products.length}` : ""}`;
    const canManageProducts = currentUser && currentUser.role !== "cashier";
    byId("inventory-body").innerHTML = products.map((product) => {
      const status = stockStatus(product);
      const actions = canManageProducts
        ? `<td class="align-right"><span class="row-actions"><button class="action-button" type="button" data-action="sell-product" data-id="${escapeHtml(product.id)}" aria-label="Sell ${escapeHtml(product.name)}" title="Record sale">↗</button><button class="action-button" type="button" data-action="adjust-stock" data-id="${escapeHtml(product.id)}" aria-label="Adjust stock for ${escapeHtml(product.name)}" title="Adjust stock">±</button><button class="action-button" type="button" data-action="edit-product" data-id="${escapeHtml(product.id)}" aria-label="Edit ${escapeHtml(product.name)}" title="Edit product">✎</button><button class="action-button delete" type="button" data-action="delete-product" data-id="${escapeHtml(product.id)}" aria-label="Delete ${escapeHtml(product.name)}" title="Delete product">×</button></span></td>`
        : "";
      return `<tr><td><span class="table-product">${productIcon(product.name, "sale-product-icon")}<span class="table-product-name">${escapeHtml(product.name)}</span></span></td><td><span class="sku-text">${escapeHtml(product.sku)}</span></td><td>${escapeHtml(product.category)}</td><td>${money(product.price)}</td><td>${number(product.stock)} <span class="sku-text">/ ${number(product.reorderLevel)} min</span></td><td><span class="status-pill ${status.css}">${status.label}</span></td>${actions}</tr>`;
    }).join("");
    byId("inventory-empty").classList.toggle("hidden", products.length > 0);
    byId("inventory-table").classList.toggle("hidden", products.length === 0);

    const units = sum(data.products, (product) => product.stock);
    byId("inventory-summary").innerHTML = [
      ["Total products", number(data.products.length)],
      ["Units on hand", number(units)],
      ["Items to restock", number(lowStockProducts().length)],
    ].map(([label, value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  }

  function renderSales() {
    const sales = sortSales();
    const query = byId("sales-search").value.trim().toLowerCase();
    const filtered = sales.filter((sale) => sale.productName.toLowerCase().includes(query));
    const today = salesSince(1);
    renderMetrics("sales-metrics", [
      metricCard("Revenue today", money(sum(today, (sale) => sale.total)), '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16M8 15l3.2-3.5 3 2 5.3-6"/></svg>', "", `${number(today.length)} transactions`),
      metricCard("Items sold today", number(sum(today, (sale) => sale.quantity)), '<svg viewBox="0 0 24 24"><path d="M6 3h12l2 4v14H4V7l2-4Z"/><path d="M4 7h16"/></svg>', "purple", "Across all products"),
      metricCard("Sales this week", money(sum(salesSince(7), (sale) => sale.total)), '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16"/></svg>', "blue", `${salesSince(7).length} transactions`),
      metricCard("All-time transactions", number(sales.length), '<svg viewBox="0 0 24 24"><path d="M5 20V11m7 9V4m7 16v-6"/></svg>', "orange", "Since you started tracking"),
    ]);
    byId("sales-count").textContent = `${filtered.length}${filtered.length !== sales.length ? ` / ${sales.length}` : ""}`;
    byId("sales-body").innerHTML = filtered.map((sale) => `<tr><td><span class="table-product">${productIcon(sale.productName, "sale-product-icon")}<span class="table-product-name">${escapeHtml(sale.productName)}</span></span></td><td>${escapeHtml(formatDate(sale.date, { month: "short", day: "numeric", year: "numeric" }))}<span class="sku-text"> · ${escapeHtml(formatDate(sale.date, { hour: "numeric", minute: "2-digit" }))}</span></td><td>${money(sale.unitPrice)}</td><td>${number(sale.quantity)}</td><td class="align-right"><strong>${money(sale.total)}</strong></td></tr>`).join("");
    byId("sales-empty").classList.toggle("hidden", filtered.length > 0);
    byId("sales-body").closest("table").classList.toggle("hidden", filtered.length === 0);
  }

  function renderReports() {
    const allTimeRevenue = sum(data.sales, (sale) => sale.total);
    const weeklyRevenue = sum(salesSince(7), (sale) => sale.total);
    const units = sum(data.products, (product) => product.stock);
    renderMetrics("reports-metrics", [
      metricCard("All-time revenue", money(allTimeRevenue), '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16M8 15l3.2-3.5 3 2 5.3-6"/></svg>', "", `${number(data.sales.length)} total transactions`),
      metricCard("Revenue this week", money(weeklyRevenue), '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16"/></svg>', "purple", `${salesSince(7).length} transactions in last 7 days`),
      metricCard("Average sale", money(data.sales.length ? allTimeRevenue / data.sales.length : 0), '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M16 8H9.5a2 2 0 0 0 0 4h5a2 2 0 0 1 0 4H8"/></svg>', "blue", "Revenue per transaction"),
      metricCard("Units in stock", number(units), '<svg viewBox="0 0 24 24"><path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z"/></svg>', "orange", `${lowStockProducts().length} items at or below threshold`),
    ]);
    const daily = getDailySales(7);
    byId("report-chart-total").textContent = money(weeklyRevenue);
    renderChart("report-chart", "report-y-axis", "report-x-axis", daily);

    const productStats = data.products.map((product) => ({
      product,
      quantity: sum(data.sales.filter((sale) => sale.productId === product.id), (sale) => sale.quantity),
    })).sort((a, b) => b.quantity - a.quantity).filter((item) => item.quantity > 0).slice(0, 5);
    byId("top-products-list").innerHTML = productStats.length
      ? productStats.map((item, index) => `<div class="top-product-row"><span class="rank-number">${index + 1}</span>${productIcon(item.product.name, "sale-product-icon")}<div class="top-product-copy"><strong>${escapeHtml(item.product.name)}</strong><span>${money(item.product.price)} per unit</span></div><span class="top-product-units">${number(item.quantity)} sold</span></div>`).join("")
      : '<div class="report-empty">Your best sellers will appear here after your first sale.</div>';

    const categories = new Map();
    data.products.forEach((product) => categories.set(product.category, (categories.get(product.category) || 0) + product.stock));
    const categoryEntries = [...categories.entries()].sort((a, b) => b[1] - a[1]);
    const maxCategory = Math.max(...categoryEntries.map((entry) => entry[1]), 1);
    byId("category-breakdown").innerHTML = categoryEntries.length
      ? categoryEntries.map(([name, quantity]) => `<div class="category-row"><div class="category-row-head"><span>${escapeHtml(name)}</span><strong>${number(quantity)} units</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(3, quantity / maxCategory * 100)}%"></div></div></div>`).join("")
      : '<div class="report-empty">Add products to see stock by category.</div>';
  }

  async function renderUsers() {
    const { users } = await api("/api/users");
    byId("user-count").textContent = number(users.length);
    byId("users-body").innerHTML = users.map((member) => `<tr><td><span class="table-product">${productIcon(member.name, "sale-product-icon")}<span class="table-product-name">${escapeHtml(member.name)}${member.id === currentUser.id ? " (you)" : ""}</span></span></td><td>${escapeHtml(member.email)}</td><td><select class="select-control user-role-select" data-user-role="${escapeHtml(member.id)}" aria-label="Role for ${escapeHtml(member.name)}"${member.id === currentUser.id ? " disabled" : ""}><option value="admin"${member.role === "admin" ? " selected" : ""}>Admin</option><option value="manager"${member.role === "manager" ? " selected" : ""}>Manager</option><option value="cashier"${member.role === "cashier" ? " selected" : ""}>Cashier</option></select></td><td><button class="status-pill ${member.active ? "status-healthy" : "status-out"} user-status-button" type="button" data-user-active="${escapeHtml(member.id)}" data-active="${member.active}"${member.id === currentUser.id ? " disabled" : ""}>${member.active ? "Active" : "Inactive"}</button></td><td>${member.createdAt ? escapeHtml(formatDate(member.createdAt, { month: "short", day: "numeric", year: "numeric" })) : "—"}</td><td class="align-right"><button class="text-link" type="button" data-action="reset-user-password" data-id="${escapeHtml(member.id)}">Reset password</button></td></tr>`).join("");
  }

  function renderMovementHistory(movements, append) {
    const body = byId("movements-body");
    const rows = movements.map((movement) => {
      const positive = movement.change > 0;
      const change = `${positive ? "+" : ""}${number(movement.change)}`;
      const reference = movement.reference ? `<span class="sku-text movement-reference">${escapeHtml(movement.reference)}</span>` : "";
      return `<tr><td>${escapeHtml(formatDate(movement.date, { month: "short", day: "numeric", year: "numeric" }))}<span class="sku-text"> · ${escapeHtml(formatDate(movement.date, { hour: "numeric", minute: "2-digit" }))}</span></td><td><span class="table-product-name">${escapeHtml(movement.productName)}</span></td><td class="movement-quantity ${positive ? "movement-in" : "movement-out"}">${change}</td><td>${number(movement.stockAfter)}</td><td>${escapeHtml(movement.reason)}${reference}</td><td>${escapeHtml(movement.performedBy || "Former team member")}</td></tr>`;
    }).join("");
    if (append) body.insertAdjacentHTML("beforeend", rows);
    else body.innerHTML = rows;
    const count = body.querySelectorAll("tr").length;
    byId("movement-count").textContent = number(count);
    byId("movements-empty").classList.toggle("hidden", count > 0);
    byId("movement-load-more").classList.toggle("hidden", !movementHasMore);
  }

  async function loadMovements(reset) {
    if (reset) movementOffset = 0;
    const limit = 100;
    const result = await api(`/api/stock-movements?limit=${limit}&offset=${movementOffset}`);
    renderMovementHistory(result.movements, !reset);
    movementOffset += result.movements.length;
    movementHasMore = result.movements.length === limit;
    byId("movement-load-more").classList.toggle("hidden", !movementHasMore);
  }

  function renderAll() {
    renderDashboard();
    renderInventory();
    renderSales();
    renderReports();
    document.querySelectorAll("[data-page]").forEach((button) => {
      if (button.classList.contains("nav-link")) {
        button.classList.toggle("active", button.dataset.page === activePage);
      }
    });
  }

  function renderProcurement() {
    const suppliersBody = byId("suppliers-body");
    suppliersBody.innerHTML = procurement.suppliers.map((supplier) => `
      <tr><td><strong>${escapeHtml(supplier.name)}</strong><button class="text-link supplier-edit-link" type="button" data-action="edit-supplier" data-id="${escapeHtml(supplier.id)}">Edit</button></td><td>${escapeHtml(supplier.email || "—")}</td>
      <td>${escapeHtml(supplier.phone || "—")}</td><td>${escapeHtml(supplier.address || "—")}</td></tr>`).join("");
    byId("supplier-count").textContent = number(procurement.suppliers.length);
    byId("suppliers-empty").classList.toggle("hidden", procurement.suppliers.length > 0);
    const suggestions = data.products
      .filter((product) => product.stock < product.reorderLevel)
      .sort((a, b) => (a.stock - a.reorderLevel) - (b.stock - b.reorderLevel));
    byId("reorder-suggestions-body").innerHTML = suggestions.map((product) => `
      <tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.sku)}</td>
      <td>${number(product.stock)}</td><td>${number(product.reorderLevel)}</td>
      <td><strong>${number(product.reorderLevel - product.stock)}</strong></td></tr>`).join("");
    byId("reorder-suggestion-count").textContent = number(suggestions.length);
    byId("reorder-suggestions-empty").classList.toggle("hidden", suggestions.length > 0);
    byId("create-suggested-order").disabled = suggestions.length === 0;
    const ordersBody = byId("purchase-orders-body");
    ordersBody.innerHTML = procurement.purchaseOrders.map((order) => {
      const value = sum(order.items, (item) => item.totalCost);
      const itemSummary = order.items.map((item) =>
        `<div>${escapeHtml(item.productName)} <span class="subtle-count">${number(item.quantityReceived)}/${number(item.quantityOrdered)} received</span></div>`,
      ).join("");
      const receiveAction = ["ordered", "partially_received"].includes(order.status)
        ? `<button class="button button-secondary button-compact" type="button" data-action="receive-purchase-order" data-id="${escapeHtml(order.id)}">Receive</button>`
        : "";
      const cancelAction = order.status === "ordered"
        ? `<button class="text-link danger-link" type="button" data-action="cancel-purchase-order" data-id="${escapeHtml(order.id)}">Cancel</button>`
        : "";
      return `<tr>
        <td><strong>${escapeHtml(order.number)}</strong></td>
        <td>${escapeHtml(order.supplierName)}</td>
        <td>${escapeHtml(formatDate(order.date, { month: "short", day: "numeric", year: "numeric" }))}</td>
        <td><details class="order-item-details"><summary>${number(order.items.length)} ${order.items.length === 1 ? "product" : "products"} · ${money(value)}</summary>${itemSummary}</details></td>
        <td><span class="order-status order-status-${escapeHtml(order.status)}">${escapeHtml(order.status.replaceAll("_", " "))}</span></td>
        <td class="align-right action-cell">${receiveAction}${cancelAction}</td>
      </tr>`;
    }).join("");
    byId("purchase-order-count").textContent = number(procurement.purchaseOrders.length);
    byId("purchase-orders-empty").classList.toggle("hidden", procurement.purchaseOrders.length > 0);
  }

  async function loadProcurement() {
    const [supplierResult, orderResult] = await Promise.all([
      api("/api/suppliers"),
      api("/api/purchase-orders"),
    ]);
    procurement = { suppliers: supplierResult.suppliers, purchaseOrders: orderResult.purchaseOrders };
    renderProcurement();
  }

  function navigate(page, focusSearch) {
    if (!["dashboard", "inventory", "sales", "reports", "movements", "procurement", "users", "settings"].includes(page)) return;
    if (["reports", "movements", "procurement"].includes(page) && currentUser.role === "cashier" || page === "users" && currentUser.role !== "admin") return;
    activePage = page;
    document.querySelectorAll(".page-view").forEach((view) => view.classList.toggle("active", view.id === `page-${page}`));
    byId("breadcrumb-current").textContent = { dashboard: "Overview", inventory: "Inventory", sales: "Sales", reports: "Reports", movements: "Stock history", procurement: "Purchasing", users: "Team", settings: "Settings" }[page];
    document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
    if (page === "inventory" && focusSearch !== false) byId("inventory-search").focus({ preventScroll: true });
    if (page === "users") renderUsers().catch((error) => showToast(error.message, true));
    if (page === "movements") loadMovements(true).catch((error) => showToast(error.message, true));
    if (page === "procurement") loadProcurement().catch((error) => showToast(error.message, true));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openProductModal(product) {
    hideModalForms();
    byId("product-form").reset();
    byId("product-id").value = product ? product.id : "";
    byId("product-name").value = product ? product.name : "";
    byId("product-sku").value = product ? product.sku : "";
    byId("product-category").value = product ? product.category : "";
    byId("product-price").value = product ? product.price : "";
    byId("product-cost").value = product ? product.cost : "";
    byId("product-stock").value = product ? product.stock : "";
    byId("product-stock").disabled = Boolean(product);
    byId("product-stock-note").classList.toggle("hidden", !product);
    byId("product-reorder").value = product ? product.reorderLevel : 5;
    byId("modal-eyebrow").textContent = product ? "UPDATE YOUR CATALOG" : "PRODUCT DETAILS";
    byId("modal-title").textContent = product ? "Edit product" : "Add a product";
    byId("product-submit").textContent = product ? "Save changes" : "Save product";
    byId("product-error").classList.add("hidden");
    byId("product-form").classList.remove("hidden");
    byId("sale-form").classList.add("hidden");
    byId("adjustment-form").classList.add("hidden");
    byId("user-form").classList.add("hidden");
    showModal("product-name");
  }

  function openAdjustmentModal(product) {
    hideModalForms();
    byId("adjustment-form").reset();
    byId("adjustment-product-id").value = product.id;
    byId("adjustment-quantity").value = "1";
    byId("adjustment-stock-hint").textContent = `${product.name}: ${number(product.stock)} units currently in stock`;
    byId("adjustment-error").classList.add("hidden");
    byId("modal-eyebrow").textContent = "INVENTORY CONTROL";
    byId("modal-title").textContent = "Adjust stock";
    byId("adjustment-form").classList.remove("hidden");
    byId("product-form").classList.add("hidden");
    byId("sale-form").classList.add("hidden");
    byId("user-form").classList.add("hidden");
    showModal("adjustment-direction");
  }

  function openSaleModal(selectedProductId) {
    hideModalForms();
    byId("sale-form").reset();
    const available = data.products.filter((product) => product.stock > 0);
    byId("sale-product").innerHTML = available.length
      ? available.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} — ${number(product.stock)} in stock</option>`).join("")
      : '<option value="">No products in stock</option>';
    if (available.some((product) => product.id === selectedProductId)) byId("sale-product").value = selectedProductId;
    byId("sale-form").querySelector('button[type="submit"]').disabled = available.length === 0;
    byId("sale-price").value = available.length ? available[0].price.toFixed(2) : "";
    byId("sale-quantity").max = available.length ? available[0].stock : "0";
    byId("sale-stock-hint").textContent = available.length ? `${number(available[0].stock)} units currently available` : "Add stock to a product before recording a sale.";
    byId("sale-error").classList.add("hidden");
    byId("modal-eyebrow").textContent = "NEW TRANSACTION";
    byId("modal-title").textContent = "Record a sale";
    byId("sale-form").classList.remove("hidden");
    byId("product-form").classList.add("hidden");
    byId("user-form").classList.add("hidden");
    byId("adjustment-form").classList.add("hidden");
    updateSaleTotal();
    if (available.length) updateSaleSelection();
    showModal("sale-product");
  }

  function openUserModal() {
    hideModalForms();
    byId("user-form").reset();
    byId("user-id").value = "";
    byId("user-error").classList.add("hidden");
    document.querySelectorAll(".user-create-only").forEach((element) => element.classList.remove("hidden"));
    byId("user-name").required = true;
    byId("user-email").required = true;
    byId("user-role").required = true;
    byId("user-form").querySelector('button[type="submit"]').textContent = "Create account";
    byId("modal-eyebrow").textContent = "WORKSPACE ACCESS";
    byId("modal-title").textContent = "Add a team member";
    byId("user-form").classList.remove("hidden");
    byId("product-form").classList.add("hidden");
    byId("sale-form").classList.add("hidden");
    byId("adjustment-form").classList.add("hidden");
    showModal("user-name");
  }

  function openPasswordReset(userId) {
    hideModalForms();
    byId("user-form").reset();
    byId("user-id").value = userId;
    byId("user-error").classList.add("hidden");
    document.querySelectorAll(".user-create-only").forEach((element) => element.classList.add("hidden"));
    byId("user-name").required = false;
    byId("user-email").required = false;
    byId("user-role").required = false;
    byId("modal-eyebrow").textContent = "ACCOUNT SECURITY";
    byId("modal-title").textContent = "Reset team member password";
    byId("user-form").querySelector('button[type="submit"]').textContent = "Save password";
    byId("user-form").classList.remove("hidden");
    byId("product-form").classList.add("hidden");
    byId("sale-form").classList.add("hidden");
    byId("adjustment-form").classList.add("hidden");
    showModal("user-password");
  }

  function showModal(focusId) {
    const backdrop = byId("modal-backdrop");
    backdrop.classList.remove("hidden");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    window.setTimeout(() => byId(focusId).focus(), 30);
  }

  function hideModalForms() {
    document.querySelectorAll(".modal-form").forEach((form) => form.classList.add("hidden"));
  }

  function openSupplierModal(supplier) {
    hideModalForms();
    byId("supplier-form").reset();
    byId("supplier-id").value = supplier ? supplier.id : "";
    byId("supplier-name").value = supplier ? supplier.name : "";
    byId("supplier-email").value = supplier ? supplier.email || "" : "";
    byId("supplier-phone").value = supplier ? supplier.phone || "" : "";
    byId("supplier-address").value = supplier ? supplier.address || "" : "";
    byId("supplier-error").classList.add("hidden");
    byId("modal-eyebrow").textContent = "SUPPLIER DETAILS";
    byId("modal-title").textContent = supplier ? "Edit supplier" : "Add a supplier";
    byId("supplier-form").querySelector('button[type="submit"]').textContent = supplier ? "Save changes" : "Save supplier";
    byId("supplier-form").classList.remove("hidden");
    showModal("supplier-name");
  }

  function orderLineMarkup(selectedProductId, quantity) {
    const options = data.products.map((product) =>
      `<option value="${escapeHtml(product.id)}"${product.id === selectedProductId ? " selected" : ""}>${escapeHtml(product.name)} · ${escapeHtml(product.sku)}</option>`,
    ).join("");
    const selectedProduct = getProduct(selectedProductId) || data.products[0];
    return `<div class="order-line">
      <label class="field">Product<select data-order-product required>${options || '<option value="">No products available</option>'}</select></label>
      <label class="field">Quantity<input data-order-quantity type="number" min="1" max="100000000" step="1" value="${quantity || 1}" required /></label>
      <label class="field">Unit cost<div class="input-prefix"><span>TSh</span><input data-order-cost type="number" min="0" step="0.01" value="${selectedProduct ? Number(selectedProduct.cost || 0).toFixed(2) : "0.00"}" required /></div></label>
      <button class="text-link danger-link remove-order-line" type="button" aria-label="Remove product line">Remove</button>
    </div>`;
  }

  function openPurchaseOrderModal(suggestedProducts) {
    hideModalForms();
    byId("purchase-order-form").reset();
    byId("purchase-order-error").classList.add("hidden");
    const supplierSelect = byId("order-supplier");
    supplierSelect.innerHTML = procurement.suppliers.length
      ? procurement.suppliers.map((supplier) => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)}</option>`).join("")
      : '<option value="">Add a supplier first</option>';
    const initialLines = suggestedProducts && suggestedProducts.length
      ? suggestedProducts.map((product) => orderLineMarkup(product.id, product.reorderLevel - product.stock)).join("")
      : orderLineMarkup();
    byId("purchase-order-lines").innerHTML = data.products.length ? initialLines : '<p class="product-stock-hint">Add a product to inventory before placing an order.</p>';
    byId("purchase-order-form").querySelector('button[type="submit"]').disabled = !procurement.suppliers.length || !data.products.length;
    byId("modal-eyebrow").textContent = "SUPPLIER REPLENISHMENT";
    byId("modal-title").textContent = "New purchase order";
    byId("purchase-order-form").classList.remove("hidden");
    showModal("order-supplier");
  }

  function openReceiptModal(order) {
    hideModalForms();
    activeReceiptOrderId = order.id;
    byId("receipt-form").reset();
    byId("receipt-error").classList.add("hidden");
    byId("receipt-order-hint").textContent = `${order.number} · ${order.supplierName}. Enter the quantities delivered now; the remaining balance stays open for later deliveries.`;
    byId("receipt-lines").innerHTML = order.items.filter((item) => item.quantityRemaining > 0).map((item) => `
      <div class="receipt-line">
        <div><strong>${escapeHtml(item.productName)}</strong><small>${escapeHtml(item.sku)} · ${number(item.quantityRemaining)} remaining</small></div>
        <label class="field">Delivered now<input data-receipt-item="${escapeHtml(item.id)}" type="number" min="0" max="${item.quantityRemaining}" step="1" value="0" /></label>
      </div>`).join("");
    byId("modal-eyebrow").textContent = "RECORD DELIVERY";
    byId("modal-title").textContent = "Receive purchase order";
    byId("receipt-form").classList.remove("hidden");
    showModal("receipt-lines");
  }

  function closeModal() {
    byId("modal-backdrop").classList.add("hidden");
    byId("modal-backdrop").setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function updateSaleSelection() {
    const product = getProduct(byId("sale-product").value);
    if (!product) return;
    byId("sale-price").value = product.price.toFixed(2);
    byId("sale-quantity").max = String(product.stock);
    byId("sale-stock-hint").textContent = `${number(product.stock)} units currently available`;
    updateSaleTotal();
  }

  function updateSaleTotal() {
    const quantity = Number(byId("sale-quantity").value) || 0;
    const price = Number(byId("sale-price").value) || 0;
    byId("sale-total").textContent = money(quantity * price);
  }

  document.addEventListener("click", (event) => {
    const displayButton = event.target.closest("[data-display-setting]");
    if (displayButton) {
      saveDisplayPreference(displayButton.dataset.displaySetting, displayButton.dataset.value);
      return;
    }
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) { navigate(pageButton.dataset.page); return; }
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const product = getProduct(actionButton.dataset.id);
      if (actionButton.dataset.action === "add-product") openProductModal();
      if (actionButton.dataset.action === "record-sale") openSaleModal();
      if (actionButton.dataset.action === "sell-product") openSaleModal(actionButton.dataset.id);
      if (actionButton.dataset.action === "edit-product" && product) openProductModal(product);
      if (actionButton.dataset.action === "adjust-stock" && product && currentUser.role !== "cashier") openAdjustmentModal(product);
      if (actionButton.dataset.action === "add-user" && currentUser.role === "admin") openUserModal();
      if (actionButton.dataset.action === "reset-user-password" && currentUser.role === "admin") openPasswordReset(actionButton.dataset.id);
      if (actionButton.dataset.action === "add-supplier" && currentUser.role !== "cashier") openSupplierModal();
      if (actionButton.dataset.action === "edit-supplier" && currentUser.role !== "cashier") {
        const supplier = procurement.suppliers.find((item) => item.id === actionButton.dataset.id);
        if (supplier) openSupplierModal(supplier);
      }
      if (actionButton.dataset.action === "create-purchase-order" && currentUser.role !== "cashier") openPurchaseOrderModal();
      if (actionButton.dataset.action === "create-suggested-order" && currentUser.role !== "cashier") {
        const suggestedProducts = data.products.filter((product) => product.stock < product.reorderLevel);
        if (suggestedProducts.length) openPurchaseOrderModal(suggestedProducts);
      }
      if (actionButton.dataset.action === "receive-purchase-order" && currentUser.role !== "cashier") {
        const order = procurement.purchaseOrders.find((item) => item.id === actionButton.dataset.id);
        if (order) openReceiptModal(order);
      }
      if (actionButton.dataset.action === "cancel-purchase-order" && currentUser.role !== "cashier") {
        const order = procurement.purchaseOrders.find((item) => item.id === actionButton.dataset.id);
        if (order && window.confirm(`Cancel ${order.number}? It can only be cancelled before any stock is received.`)) {
          api(`/api/purchase-orders/${encodeURIComponent(order.id)}/cancel`, { method: "POST" })
            .then(loadProcurement)
            .then(() => showToast(`${order.number} cancelled.`))
            .catch((error) => showToast(error.message, true));
        }
      }
      if (actionButton.dataset.action === "logout") {
        api("/api/auth/logout", { method: "POST" }).then(() => {
          currentUser = null;
          data = { products: [], sales: [] };
          return api("/api/auth/session");
        }).then((sessionState) => {
          csrf = sessionState.csrfToken;
          showAuth(false);
        }).catch((error) => {
          if (currentUser) showToast(error.message, true);
          else showAuth(false, error.message);
        });
      }
      if (actionButton.dataset.action === "delete-product" && product) {
        if (window.confirm(`Delete "${product.name}" from your inventory? Previous sales will remain in your sales history.`)) {
          const next = { ...data, products: data.products.filter((item) => item.id !== product.id) };
          save(next, `${product.name} removed from inventory.`).catch((error) => showToast(error.message, true));
        }
      }
      return;
    }
    if (event.target.closest("[data-close-modal]") || event.target === byId("modal-close")) closeModal();
    if (event.target === byId("modal-backdrop")) closeModal();
  });

  byId("product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = byId("product-id").value;
    const previous = id ? getProduct(id) : null;
    const product = {
      id: previous ? previous.id : `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: byId("product-name").value.trim(),
      sku: byId("product-sku").value.trim(),
      category: byId("product-category").value.trim(),
      price: Number(byId("product-price").value),
      cost: Number(byId("product-cost").value) || 0,
      stock: Number(byId("product-stock").value),
      reorderLevel: Number(byId("product-reorder").value) || 0,
      createdAt: previous ? previous.createdAt : new Date().toISOString(),
    };
    const error = product.sku && data.products.some((item) => item.sku.toLowerCase() === product.sku.toLowerCase() && item.id !== product.id)
      ? "That SKU is already used by another product. Each product needs a unique SKU."
      : product.price <= 0
        ? "Selling price must be greater than zero."
        : product.stock < 0 || !Number.isInteger(product.stock)
          ? "Stock quantity must be a whole number of zero or more."
          : product.cost < 0
            ? "Unit cost cannot be negative."
            : "";
    if (error) {
      byId("product-error").textContent = error;
      byId("product-error").classList.remove("hidden");
      return;
    }
    const products = previous
      ? data.products.map((item) => item.id === product.id ? product : item)
      : [...data.products, product];
    try {
      await save({ ...data, products }, previous ? "Product updated successfully." : "Product added to your inventory.");
      closeModal();
    } catch (saveError) {
      byId("product-error").textContent = saveError.message;
      byId("product-error").classList.remove("hidden");
    }
  });

  byId("sale-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const product = getProduct(byId("sale-product").value);
    const quantity = Number(byId("sale-quantity").value);
    const unitPrice = Number(byId("sale-price").value);
    const error = !product
      ? "Choose a product that is in stock before recording a sale."
      : !Number.isInteger(quantity) || quantity < 1
        ? "Quantity sold must be a whole number greater than zero."
        : quantity > product.stock
          ? `Only ${number(product.stock)} ${product.stock === 1 ? "unit is" : "units are"} available. Update the quantity or add stock first.`
          : !Number.isFinite(unitPrice) || unitPrice <= 0
            ? "Sale price must be greater than zero."
            : "";
    if (error) {
      byId("sale-error").textContent = error;
      byId("sale-error").classList.remove("hidden");
      return;
    }
    const sale = {
      id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice,
      total: Math.round(unitPrice * quantity * 100) / 100,
      date: new Date().toISOString(),
    };
    const next = {
      products: data.products.map((item) => item.id === product.id ? { ...item, stock: item.stock - quantity } : item),
      sales: [sale, ...data.sales],
    };
    try {
      await save(next, "Sale recorded and inventory updated.");
      closeModal();
    } catch (saveError) {
      byId("sale-error").textContent = saveError.message;
      byId("sale-error").classList.remove("hidden");
    }
  });

  byId("adjustment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const product = getProduct(byId("adjustment-product-id").value);
    if (!product) return;
    const body = {
      direction: byId("adjustment-direction").value,
      quantity: Number(byId("adjustment-quantity").value),
      reason: byId("adjustment-reason").value,
    };
    try {
      await api(`/api/products/${encodeURIComponent(product.id)}/stock-movements`, { method: "POST", body });
      await refreshData();
      closeModal();
      if (activePage === "movements") await loadMovements(true);
      showToast("Stock updated and movement recorded.");
    } catch (error) {
      byId("adjustment-error").textContent = error.message;
      byId("adjustment-error").classList.remove("hidden");
    }
  });

  byId("user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const userId = byId("user-id").value;
    const body = userId
      ? { password: byId("user-password").value }
      : {
        name: byId("user-name").value.trim(),
        email: byId("user-email").value.trim(),
        password: byId("user-password").value,
        role: byId("user-role").value,
      };
    try {
      if (userId) {
        await api(`/api/users/${encodeURIComponent(userId)}`, { method: "PATCH", body });
      } else {
        await api("/api/users", { method: "POST", body });
      }
      closeModal();
      await renderUsers();
      showToast(userId ? "Password updated." : "Team member account created.");
    } catch (error) {
      byId("user-error").textContent = error.message;
      byId("user-error").classList.remove("hidden");
    }
  });

  byId("supplier-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const supplierId = byId("supplier-id").value;
    const body = {
      name: byId("supplier-name").value.trim(),
      email: byId("supplier-email").value.trim(),
      phone: byId("supplier-phone").value.trim(),
      address: byId("supplier-address").value.trim(),
    };
    try {
      await api(supplierId ? `/api/suppliers/${encodeURIComponent(supplierId)}` : "/api/suppliers", {
        method: supplierId ? "PATCH" : "POST",
        body,
      });
      await loadProcurement();
      closeModal();
      showToast(supplierId ? "Supplier updated." : "Supplier added.");
    } catch (error) {
      byId("supplier-error").textContent = error.message;
      byId("supplier-error").classList.remove("hidden");
    }
  });

  byId("add-order-line").addEventListener("click", () => {
    if (data.products.length) byId("purchase-order-lines").insertAdjacentHTML("beforeend", orderLineMarkup());
  });
  byId("purchase-order-lines").addEventListener("click", (event) => {
    const removeButton = event.target.closest(".remove-order-line");
    if (!removeButton) return;
    if (byId("purchase-order-lines").querySelectorAll(".order-line").length > 1) {
      removeButton.closest(".order-line").remove();
    }
  });
  byId("purchase-order-lines").addEventListener("change", (event) => {
    const productSelect = event.target.closest("[data-order-product]");
    if (!productSelect) return;
    const product = getProduct(productSelect.value);
    if (product) productSelect.closest(".order-line").querySelector("[data-order-cost]").value = Number(product.cost || 0).toFixed(2);
  });
  byId("purchase-order-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const items = [...byId("purchase-order-lines").querySelectorAll(".order-line")].map((line) => ({
      productId: line.querySelector("[data-order-product]").value,
      quantity: Number(line.querySelector("[data-order-quantity]").value),
      unitCost: Number(line.querySelector("[data-order-cost]").value),
    }));
    try {
      if (!items.length) throw new Error("Add at least one product to the purchase order.");
      await api("/api/purchase-orders", {
        method: "POST",
        body: { supplierId: byId("order-supplier").value, items },
      });
      await loadProcurement();
      closeModal();
      showToast("Purchase order placed.");
    } catch (error) {
      byId("purchase-order-error").textContent = error.message;
      byId("purchase-order-error").classList.remove("hidden");
    }
  });

  byId("receipt-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const items = [...byId("receipt-lines").querySelectorAll("[data-receipt-item]")]
      .map((input) => ({ itemId: input.dataset.receiptItem, quantity: Number(input.value) }))
      .filter((item) => item.quantity > 0);
    try {
      if (!items.length) throw new Error("Enter a quantity for at least one delivered product.");
      if (items.some((item) => !Number.isInteger(item.quantity))) throw new Error("Delivered quantities must be whole numbers.");
      await api(`/api/purchase-orders/${encodeURIComponent(activeReceiptOrderId)}/receipts`, {
        method: "POST",
        body: { items },
      });
      await Promise.all([refreshData(), loadProcurement()]);
      if (activePage === "movements") await loadMovements(true);
      closeModal();
      showToast("Delivery recorded and inventory updated.");
    } catch (error) {
      byId("receipt-error").textContent = error.message;
      byId("receipt-error").classList.remove("hidden");
    }
  });

  byId("users-body").addEventListener("change", async (event) => {
    const roleSelect = event.target.closest("[data-user-role]");
    if (!roleSelect) return;
    try {
      await api(`/api/users/${encodeURIComponent(roleSelect.dataset.userRole)}`, { method: "PATCH", body: { role: roleSelect.value } });
      await renderUsers();
      showToast("Team member role updated.");
    } catch (error) {
      showToast(error.message, true);
      renderUsers().catch((loadError) => showToast(loadError.message, true));
    }
  });
  byId("users-body").addEventListener("click", async (event) => {
    const statusButton = event.target.closest("[data-user-active]");
    if (!statusButton) return;
    try {
      await api(`/api/users/${encodeURIComponent(statusButton.dataset.userActive)}`, { method: "PATCH", body: { active: statusButton.dataset.active !== "true" } });
      await renderUsers();
      showToast("Team member status updated.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  byId("sale-product").addEventListener("change", updateSaleSelection);
  byId("adjustment-reason").addEventListener("change", () => {
    if (["Restock", "Customer return"].includes(byId("adjustment-reason").value)) byId("adjustment-direction").value = "in";
    if (byId("adjustment-reason").value === "Damaged / lost") byId("adjustment-direction").value = "out";
  });
  byId("sale-quantity").addEventListener("input", updateSaleTotal);
  byId("sale-price").addEventListener("input", updateSaleTotal);
  byId("inventory-search").addEventListener("input", renderInventory);
  byId("category-filter").addEventListener("change", renderInventory);
  byId("stock-filter").addEventListener("change", renderInventory);
  byId("sales-search").addEventListener("input", renderSales);
  byId("movement-load-more").addEventListener("click", () => {
    loadMovements(false).catch((error) => showToast(error.message, true));
  });
  byId("global-search").addEventListener("input", (event) => {
    byId("inventory-search").value = event.target.value;
    navigate("inventory", false);
    renderInventory();
  });
  byId("alerts-button").addEventListener("click", () => {
    navigate("inventory");
    byId("stock-filter").value = "low";
    renderInventory();
  });
  byId("modal-close").addEventListener("click", closeModal);
  byId("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const setup = Object.fromEntries(formData.entries());
      if (byId("legacy-import").checked && legacyImportData) setup.legacyData = legacyImportData;
      delete setup.legacyImport;
      const result = await api("/api/auth/setup", { method: "POST", body: setup });
      showAuth(false);
      byId("auth-subtitle").textContent = result.message;
      byId("resend-email").value = setup.email;
      showToast("Verification email sent.");
    } catch (error) {
      if (error.message.includes("Verification email could not be sent")) {
        showAuth(false);
        byId("auth-subtitle").textContent = error.message;
        byId("resend-email").value = formData.get("email");
        return;
      }
      byId("setup-error").textContent = error.message;
      byId("setup-error").classList.remove("hidden");
    }
  });
  byId("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const result = await api("/api/auth/login", { method: "POST", body: Object.fromEntries(formData.entries()) });
      csrf = result.csrfToken;
      currentUser = result.user;
      byId("auth-screen").classList.add("hidden");
      byId("app-shell").classList.remove("hidden");
      await refreshData();
    } catch (error) {
      byId("login-error").textContent = error.message;
      byId("login-error").classList.remove("hidden");
      if (error.message.includes("Verify your email")) {
        byId("resend-email").value = formData.get("email");
        byId("show-resend-verification").classList.remove("hidden");
      }
    }
  });
  byId("email-verification-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/auth/verify-email", { method: "POST", body: { token: verificationToken } });
      window.history.replaceState({}, "", window.location.pathname);
      currentUser = result.user;
      csrf = result.csrfToken;
      byId("auth-screen").classList.add("hidden");
      byId("app-shell").classList.remove("hidden");
      await refreshData();
      showToast("Email verified. Welcome to Stockroom.");
    } catch (error) {
      byId("verification-error").textContent = error.message;
      byId("verification-error").classList.remove("hidden");
    }
  });
  byId("show-resend-verification").addEventListener("click", () => {
    byId("resend-verification-form").classList.remove("hidden");
    byId("show-resend-verification").classList.add("hidden");
    byId("resend-email").focus();
  });
  byId("resend-verification-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/auth/resend-verification", { method: "POST", body: { email: byId("resend-email").value } });
      byId("auth-subtitle").textContent = result.message;
      byId("resend-error").classList.add("hidden");
      showToast("If the account needs verification, a new link has been sent.");
    } catch (error) {
      byId("resend-error").textContent = error.message;
      byId("resend-error").classList.remove("hidden");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("modal-backdrop").classList.contains("hidden")) closeModal();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      byId("global-search").focus();
    }
  });
  window.addEventListener("resize", () => {
    renderChart("revenue-chart", "chart-y-axis", "chart-x-axis", getDailySales(7));
    renderChart("report-chart", "report-y-axis", "report-x-axis", getDailySales(7));
  });

  applyDisplayPreferences(readDisplayPreferences());
  window.setInterval(updateDashboardGreeting, 60 * 1000);

  async function initialize() {
    try {
      const sessionState = await api("/api/auth/session");
      csrf = sessionState.csrfToken;
      if (verificationToken) {
        showAuth(false);
        byId("auth-subtitle").textContent = "Confirm your email address to continue.";
        byId("login-form").classList.add("hidden");
        byId("show-resend-verification").classList.add("hidden");
        byId("email-verification-form").classList.remove("hidden");
        return;
      }
      if (sessionState.setupRequired) {
        try {
          const stored = window.localStorage.getItem("stockroom-data-v1");
          if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && Array.isArray(parsed.products) && Array.isArray(parsed.sales)) {
              legacyImportData = parsed;
              const option = byId("legacy-import-option");
              const description = ` Import ${number(parsed.products.length)} products and ${number(parsed.sales.length)} sales from this browser`;
              option.lastChild.textContent = description;
            }
          }
        } catch (storageError) {
          console.info("Optional browser-data migration is unavailable.", storageError);
        }
        showAuth(true);
      } else if (sessionState.user) {
        currentUser = sessionState.user;
        byId("auth-screen").classList.add("hidden");
        byId("app-shell").classList.remove("hidden");
        await refreshData();
      } else {
        showAuth(false);
      }
    } catch (error) {
      showAuth(false, error.message);
    }
  }

  initialize();
}());
