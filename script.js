/**
 * Сатып алу жоспарлаушысы — клиенттік қосымша
 * Авторизация: Firebase Authentication (Email/Password)
 * Деректер: Cloud Firestore  →  users/{uid} (name, email, avatar), users/{uid}/items, users/{uid}/settings
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  collection,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ==========================================================================
   FIREBASE КОНФИГУРАЦИЯСЫ
   ========================================================================== */

// Бұл жерге өз Firebase конфигіңізді қойыңыз
// (Firebase Console → Project settings → Your apps → Web app → SDK setup and configuration)
const firebaseConfig = {
  apiKey: "AIzaSyAS1vX7gIfhK36WgJz8YJfX_EEn8zPTwSI",
  authDomain: "satyp-alu-planner.firebaseapp.com",
  projectId: "satyp-alu-planner",
  storageBucket: "satyp-alu-planner.firebasestorage.app",
  messagingSenderId: "277634903785",
  appId: "1:277634903785:web:edb2be5ba069a986a10a78",
  measurementId: "G-Y1PD724JHK"
};

/* ========================================================================== */

/** Конфиг толтырылған ба (плейсхолдерлер қалмаған ба) */
function isConfigFilled(cfg) {
  return ["apiKey", "authDomain", "projectId", "appId"].every((key) => {
    const v = cfg[key];
    return typeof v === "string" && v.trim() !== "" && !v.startsWith("ӨЗ_") && !v.includes("ӨЗ_");
  });
}

const FIREBASE_READY = isConfigFilled(firebaseConfig);

let app = null;
let auth = null;
let db = null;

if (FIREBASE_READY) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    // Офлайн кэш: интернет жоқта да тізім ашылады, байланыс қалпына келгенде синхрондалады
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn("Firestore офлайн кэші қосылмады:", err);
    db = getFirestore(app);
  }
}

/* ==========================================================================
   НЕГІЗГІ ДЕРЕКТЕР
   ========================================================================== */

/** Жаңа пайдаланушының бастапқы бюджеті — 0 ₸ (өзі енгізеді) */
const DEFAULT_BUDGET = 0;

/**
 * Категориялар: иконка (index.html-дегі sprite) және түс.
 * Қызыл түс тек ескерту үшін сақталған, сондықтан категорияларға берілмейді.
 */
const CATEGORIES = [
  { name: "Азық-түлік", icon: "cart", color: "#16A34A" },
  { name: "Электроника", icon: "phone", color: "#2563EB" },
  { name: "Киім", icon: "shirt", color: "#7C3AED" },
  { name: "Үйге арналған", icon: "home", color: "#D97706" },
  { name: "Денсаулық", icon: "heart", color: "#0D9488" },
  { name: "Балалар тауары", icon: "smile", color: "#0891B2" },
  { name: "Спорт", icon: "activity", color: "#65A30D" },
  { name: "Басқа", icon: "tag", color: "#6B7280" },
];

const UNITS = ["дана", "кг", "литр", "қап", "қорап"];

const PRIORITIES = [
  { id: "low", label: "Төмен", weight: 1 },
  { id: "medium", label: "Орташа", weight: 2 },
  { id: "high", label: "Жоғары", weight: 3 },
];

/**
 * Валюталар. rate — 1 бірлік валютаның теңгедегі бағасы.
 * Курстар шамамен берілген: қажет болса өзіңіз жаңартыңыз.
 */
const CURRENCIES = [
  { code: "KZT", symbol: "₸", label: "₸ — теңге", rate: 1 },
  { code: "USD", symbol: "$", label: "$ — доллар", rate: 500 },
  { code: "EUR", symbol: "€", label: "€ — еуро", rate: 580 },
  { code: "RUB", symbol: "₽", label: "₽ — рубль", rate: 6.5 },
];

/** Бастапқы күй */
function createDefaultState() {
  return {
    budget: DEFAULT_BUDGET,
    items: [],
  };
}

/** Қолданба күйі (Firestore-дан синхрондалады) */
let state = createDefaultState();

/** UI күйі (сүзгілер, іздеу, таб) */
const ui = {
  search: "",
  filterCategory: "all",
  filterStatus: "all",
  sortBy: "date-desc",
  activeTab: "overview",
};

/** Авторизация / синхрондау күйі */
let currentUser = null;
let unsubscribeItems = null;
let unsubscribeSettings = null;
let unsubscribeProfile = null;
let syncReady = { items: false, settings: false };
let registering = false;

/** Профиль деректері (Firestore: users/{uid}.name, users/{uid}.avatar) */
let profile = { name: "", avatar: "" };
/** Профиль модалындағы уақытша аватар: undefined — өзгермеген, "" — өшірілген, "data:..." — жаңа */
let pendingAvatar;

/** DOM */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** Lucide иконкасы (index.html-дегі sprite-тан) */
const icon = (name, cls = "") =>
  `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ==========================================================================
   FIRESTORE КӨМЕКШІЛЕРІ
   ========================================================================== */

const userDocRef = (uid) => doc(db, "users", uid);
const itemsColRef = (uid) => collection(db, "users", uid, "items");
const itemDocRef = (uid, id) => doc(db, "users", uid, "items", id);
const settingsDocRef = (uid) => doc(db, "users", uid, "settings", "main");

function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Firestore құжатына жазылатын тауар (id құжат атауында сақталады) */
function toCloudItem(item) {
  return {
    name: item.name,
    category: item.category,
    qty: item.qty,
    unit: item.unit,
    price: item.price,
    currency: item.currency || "KZT",
    discount: item.discount || 0,
    priority: item.priority,
    notes: item.notes || "",
    purchased: Boolean(item.purchased),
    createdAt: item.createdAt,
  };
}

/** Firestore құжатынан тауарды оқу (қауіпсіз нормализация) */
function fromCloudItem(id, data) {
  return {
    id,
    name: String(data.name ?? ""),
    category: String(data.category ?? "Басқа"),
    qty: Number(data.qty) || 0,
    unit: String(data.unit ?? UNITS[0]),
    price: Number(data.price) || 0,
    currency: CURRENCIES.some((c) => c.code === data.currency) ? data.currency : "KZT",
    discount: Math.min(100, Math.max(0, Number(data.discount) || 0)),
    priority: PRIORITIES.some((p) => p.id === data.priority) ? data.priority : "medium",
    notes: String(data.notes ?? ""),
    purchased: Boolean(data.purchased),
    createdAt: Number(data.createdAt) || 0,
  };
}

/** Ағымдағы пайдаланушының uid-ын алу */
function requireUid() {
  if (!FIREBASE_READY || !currentUser) {
    toast("Алдымен жүйеге кіріңіз", "error");
    return null;
  }
  return currentUser.uid;
}

/** Firestore жазуы: UI-ды күтпей жібереміз, қате болса хабарлаймыз */
function cloud(promise) {
  Promise.resolve(promise).catch(handleCloudError);
}

function handleCloudError(err) {
  console.error("Firestore қатесі:", err);
  toast(cloudErrorMessage(err), "error");
}

function cloudErrorMessage(err) {
  switch (err?.code) {
    case "permission-denied":
      return "Рұқсат жоқ. Firestore қауіпсіздік ережелерін тексеріңіз";
    case "unavailable":
      return "Сервер қолжетімсіз. Интернет байланысын тексеріңіз";
    case "not-found":
      return "Деректер табылмады (басқа құрылғыда жойылған болуы мүмкін)";
    case "failed-precondition":
      return "Firestore дерекқоры жасалмаған немесе дұрыс бапталмаған";
    default:
      return "Бұлтқа сақтау кезінде қате шықты";
  }
}

/** Бірнеше құжатты пакеттермен жазу (Firestore лимиті — 500 операция) */
function commitInChunks(uid, operations) {
  const CHUNK = 400;
  const batches = [];
  for (let i = 0; i < operations.length; i += CHUNK) {
    const batch = writeBatch(db);
    operations.slice(i, i + CHUNK).forEach((op) => op(batch));
    batches.push(batch.commit());
  }
  return Promise.all(batches);
}

/** Бүкіл бұлттағы деректерді ауыстыру (тазалау) */
function replaceCloudData(budget, newItems) {
  const uid = requireUid();
  if (!uid) return;

  const keepIds = new Set(newItems.map((i) => i.id));
  const operations = [];

  for (const old of state.items) {
    if (!keepIds.has(old.id)) operations.push((b) => b.delete(itemDocRef(uid, old.id)));
  }
  for (const item of newItems) {
    operations.push((b) => b.set(itemDocRef(uid, item.id), toCloudItem(item)));
  }
  operations.push((b) =>
    b.set(settingsDocRef(uid), { budget, updatedAt: serverTimestamp() }, { merge: true })
  );

  cloud(commitInChunks(uid, operations));
}

/** Кіргенде пайдаланушы құжаттары бар екеніне көз жеткізу */
async function ensureUserDocs(user) {
  const userSnap = await getDoc(userDocRef(user.uid));
  if (!userSnap.exists()) {
    await setDoc(userDocRef(user.uid), {
      name: user.displayName || "",
      email: user.email || "",
      createdAt: serverTimestamp(),
    });
  }
  const settingsSnap = await getDoc(settingsDocRef(user.uid));
  if (!settingsSnap.exists()) {
    await setDoc(settingsDocRef(user.uid), {
      budget: DEFAULT_BUDGET,
      updatedAt: serverTimestamp(),
    });
  }
}

/* ==========================================================================
   РЕАЛ-ТАЙМ СИНХРОНДАУ
   ========================================================================== */

function startSync(user) {
  stopSync();
  const uid = user.uid;
  syncReady = { items: false, settings: false };
  setLoader(true, "Деректер жүктелуде...");

  const markReady = (key) => {
    syncReady[key] = true;
    if (syncReady.items && syncReady.settings) setLoader(false);
  };

  const onSyncError = (err) => {
    handleCloudError(err);
    setLoader(false);
  };

  unsubscribeSettings = onSnapshot(
    settingsDocRef(uid),
    (snap) => {
      if (!currentUser || currentUser.uid !== uid) return;
      const data = snap.exists() ? snap.data() : null;
      state.budget = data && typeof data.budget === "number" ? data.budget : DEFAULT_BUDGET;
      renderAll();
      markReady("settings");
    },
    onSyncError
  );

  unsubscribeProfile = onSnapshot(
    userDocRef(uid),
    (snap) => {
      if (!currentUser || currentUser.uid !== uid) return;
      const data = snap.exists() ? snap.data() : {};
      profile = {
        name: typeof data.name === "string" ? data.name : "",
        avatar: typeof data.avatar === "string" ? data.avatar : "",
      };
      updateProfileUI();
    },
    (err) => console.warn("Профильді оқу мүмкін болмады:", err)
  );

  unsubscribeItems = onSnapshot(
    itemsColRef(uid),
    (snap) => {
      if (!currentUser || currentUser.uid !== uid) return;
      state.items = snap.docs.map((d) => fromCloudItem(d.id, d.data()));
      renderAll();
      markReady("items");
    },
    onSyncError
  );
}

function stopSync() {
  if (unsubscribeItems) unsubscribeItems();
  if (unsubscribeSettings) unsubscribeSettings();
  if (unsubscribeProfile) unsubscribeProfile();
  unsubscribeItems = null;
  unsubscribeSettings = null;
  unsubscribeProfile = null;
}

/** Шыққанда жергілікті күйді тазалау */
function resetLocalSession() {
  state = createDefaultState();
  profile = { name: "", avatar: "" };
  pendingAvatar = undefined;
  $("#profileModal").close();
  ui.search = "";
  ui.filterCategory = "all";
  ui.filterStatus = "all";
  ui.sortBy = "date-desc";
  $("#searchInput").value = "";
  $("#filterCategory").value = "all";
  $("#filterStatus").value = "all";
  $("#sortBy").value = "date-desc";
  resetForm();
  closeAllMenus();
  switchTab("overview");
  $("#itemModal").close();
  $("#budgetModal").close();
  $("#confirmModal").close();
  renderAll();
}

/* ==========================================================================
   ФОРМАТТАУ ЖӘНЕ ЕСЕПТЕУЛЕР
   ========================================================================== */

const nfKz = new Intl.NumberFormat("kk-KZ", { maximumFractionDigits: 0 });
const nfFx = new Intl.NumberFormat("kk-KZ", { maximumFractionDigits: 2 });

function formatMoney(n) {
  const val = Number.isFinite(n) ? n : 0;
  return nfKz.format(Math.round(val)) + " ₸";
}

function formatPct(n) {
  return `${Math.round(Number.isFinite(n) ? n : 0)}%`;
}

function currencyOf(code) {
  return CURRENCIES.find((c) => c.code === code) || CURRENCIES[0];
}

function categoryMeta(name) {
  return CATEGORIES.find((c) => c.name === name) || CATEGORIES[CATEGORIES.length - 1];
}

function priorityMeta(id) {
  return PRIORITIES.find((p) => p.id === id) || PRIORITIES[1];
}

/** Жеңілдікке дейінгі сома (₸) */
function lineGross(item) {
  return item.qty * item.price * currencyOf(item.currency).rate;
}

/** Жеңілдіктен кейінгі қорытынды сома (₸) */
function lineTotal(item) {
  return lineGross(item) * (1 - (item.discount || 0) / 100);
}

function lineSaving(item) {
  return lineGross(item) - lineTotal(item);
}

function computeTotals() {
  let planned = 0;
  let spent = 0;
  let savings = 0;
  for (const item of state.items) {
    const t = lineTotal(item);
    planned += t;
    savings += lineSaving(item);
    if (item.purchased) spent += t;
  }
  const remaining = state.budget - spent;
  // Ескерту: жоспарланған шығындар бюджеттен асқанда (немесе қалдық теріс болғанда)
  const over = planned > state.budget || remaining < 0;
  return { planned, spent, remaining, savings, over, overBy: Math.max(planned - state.budget, -remaining, 0) };
}

function categoryTotals() {
  const map = new Map(CATEGORIES.map((c) => [c.name, 0]));
  for (const item of state.items) {
    map.set(item.category, (map.get(item.category) || 0) + lineTotal(item));
  }
  return map;
}

/** Toast хабарлама */
function toast(message, type = "success") {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  while (stack.children.length >= 3) stack.firstElementChild.remove();
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s ease";
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/** Жүктелу индикаторы */
function setLoader(show, text = "Жүктелуде...") {
  const loader = $("#appLoader");
  $("#appLoaderText").textContent = text;
  loader.classList.toggle("hidden", !show);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Сан + септік: «3 тауар» */
function countLabel(n) {
  return `${n} тауар`;
}

/* ==========================================================================
   СҮЗГІЛЕУ ЖӘНЕ СҰРЫПТАУ
   ========================================================================== */

/** Іздеу «Тізімдер» бетінде ғана қолданылады (withSearch = true) */
function getFilteredItems({ withSearch = false } = {}) {
  let list = [...state.items];

  if (withSearch && ui.search.trim()) {
    const q = ui.search.trim().toLowerCase();
    list = list.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        (i.notes && i.notes.toLowerCase().includes(q))
    );
  }

  if (withSearch) {
    if (ui.filterCategory !== "all") list = list.filter((i) => i.category === ui.filterCategory);
    if (ui.filterStatus === "planned") list = list.filter((i) => !i.purchased);
    else if (ui.filterStatus === "purchased") list = list.filter((i) => i.purchased);
    else if (ui.filterStatus === "important") list = list.filter((i) => i.priority === "high");
  }

  const [field, dir] = ui.sortBy.split("-");
  list.sort((a, b) => {
    let cmp = 0;
    if (field === "date") cmp = a.createdAt - b.createdAt;
    else if (field === "price") cmp = lineTotal(a) - lineTotal(b);
    else if (field === "priority") cmp = priorityMeta(a.priority).weight - priorityMeta(b.priority).weight;
    return dir === "asc" ? cmp : -cmp;
  });

  return list;
}

/* ==========================================================================
   РЕНДЕР
   ========================================================================== */

/** HTML: бір тауар жолы */
function renderItemRow(item, { showActions = true } = {}) {
  const cat = categoryMeta(item.category);
  const pri = priorityMeta(item.priority);
  const cur = currencyOf(item.currency);
  const id = escapeHtml(item.id);
  const total = lineTotal(item);
  const hasDiscount = item.discount > 0;

  const hints = [];
  if (hasDiscount) hints.push(`<s>${formatMoney(lineGross(item))}</s>`);
  if (cur.code !== "KZT") {
    hints.push(`${nfFx.format(item.qty)} × ${nfFx.format(item.price)} ${cur.symbol}`);
  }

  const actions = showActions
    ? `<div class="item-row__actions">
         <button type="button" class="icon-btn" data-action="edit" data-id="${id}" aria-label="Өзгерту" title="Өзгерту">${icon("pencil", "i--sm")}</button>
         <button type="button" class="icon-btn icon-btn--danger" data-action="delete" data-id="${id}" aria-label="Жою" title="Жою">${icon("trash", "i--sm")}</button>
       </div>`
    : "";

  return `
    <li class="item-row ${item.purchased ? "item-row--purchased" : ""}" data-id="${id}">
      <label class="check-wrap" title="Сатып алынды деп белгілеу">
        <input type="checkbox" ${item.purchased ? "checked" : ""} data-action="toggle" data-id="${id}" aria-label="«${escapeHtml(item.name)}» сатып алынды деп белгілеу" />
        <span class="check-box">${icon("check")}</span>
      </label>
      <span class="item-row__icon" style="--c:${cat.color}" aria-hidden="true">${icon(cat.icon)}</span>
      <div class="item-row__body">
        <p class="item-row__name">${escapeHtml(item.name)}</p>
        <p class="item-row__meta">
          <span class="item-row__qty">${nfFx.format(item.qty)} ${escapeHtml(item.unit)}</span>
          <span class="pill pill--cat" style="--c:${cat.color}">${escapeHtml(item.category)}</span>
          <span class="pill pill--${item.priority}">${pri.label}</span>
          ${
            item.purchased
              ? `<span class="pill pill--done">${icon("check")}Сатып алынды</span>`
              : '<span class="pill pill--planned">Жоспарланған</span>'
          }
          ${hasDiscount ? `<span class="pill pill--discount">${icon("percent")}−${nfFx.format(item.discount)}%</span>` : ""}
          ${item.notes ? `<span>${escapeHtml(item.notes)}</span>` : ""}
        </p>
      </div>
      <div class="item-row__price">
        <span class="item-row__total">${formatMoney(total)}</span>
        ${hints.length ? `<span class="item-row__hint">${hints.join(" · ")}</span>` : ""}
      </div>
      ${actions}
    </li>
  `;
}

/** Барлық UI жаңарту */
function renderAll() {
  renderDashboard();
  renderLists();
  renderAnalytics();
}

function renderDashboard() {
  const { planned, spent, remaining, over, overBy } = computeTotals();
  const budget = state.budget;

  $("#displayBudget").textContent = formatMoney(budget);
  $("#displayPlanned").textContent = formatMoney(planned);
  $("#displaySpent").textContent = formatMoney(spent);
  $("#displayRemaining").textContent = formatMoney(remaining);

  const plannedCount = state.items.length;
  const doneCount = state.items.filter((i) => i.purchased).length;
  $("#plannedNote").textContent = `${plannedCount} тауар тізімде`;
  $("#spentNote").textContent = `${doneCount} / ${plannedCount} сатып алынды`;

  // A. Бюджет күйі: қызыл карточка және ескерту бейджі
  const card = $("#cardRemaining");
  card.classList.toggle("metric--alert", over);
  $("#overBadge").classList.toggle("hidden", !over);
  $("#remainingNote").textContent = over
    ? `Жоспар бюджеттен ${formatMoney(overBy)} артық`
    : budget > 0
      ? "Бюджет минус орындалған сома"
      : "Бюджетті белгілеңіз";

  // Прогресс: орындалған (қара) және жоспарланған (сұр) үлестер
  const plannedPct = budget > 0 ? (planned / budget) * 100 : planned > 0 ? 100 : 0;
  const spentPct = budget > 0 ? (spent / budget) * 100 : spent > 0 ? 100 : 0;

  $("#usagePlanned").style.width = `${Math.min(100, plannedPct)}%`;
  $("#usageSpent").style.width = `${Math.min(100, spentPct)}%`;
  $("#budgetProgressBar").classList.toggle("progress--over", over);
  $("#budgetProgressBar").setAttribute("aria-valuenow", String(Math.min(100, Math.round(spentPct))));

  const badge = $("#budgetPercentBadge");
  badge.textContent = formatPct(spentPct);
  badge.classList.toggle("pill--danger", over);
  badge.classList.toggle("pill--neutral", !over);

  const msg = $("#budgetProgressMessage");
  msg.classList.toggle("usage__msg--warn", over);
  if (budget <= 0 && planned <= 0) {
    msg.textContent = "Бюджет әлі белгіленбеген. Жоғарыдағы «Жалпы бюджет» карточкасындағы қарындашты басып, сомаңызды енгізіңіз.";
  } else if (over) {
    msg.textContent = `Назар аударыңыз: жоспарланған сома бюджеттен ${formatMoney(overBy)} артық.`;
  } else if (plannedPct >= 85) {
    msg.textContent = "Жоспар бюджет шегіне жақын — абай болыңыз.";
  } else {
    msg.textContent = "Бюджет шегінде — барлығы жақсы.";
  }

  // Жақын сатып алулар: күтудегі тауарлар, маңыздылығы жоғарылары алда
  const upcoming = state.items
    .filter((i) => !i.purchased)
    .sort((a, b) => priorityMeta(b.priority).weight - priorityMeta(a.priority).weight || b.createdAt - a.createdAt)
    .slice(0, 6);
  $("#overviewItemList").innerHTML = upcoming.map((i) => renderItemRow(i, { showActions: false })).join("");
  $("#overviewEmpty").classList.toggle("empty--visible", upcoming.length === 0);
  $("#overviewItemList").style.display = upcoming.length ? "flex" : "none";
  if (upcoming.length === 0 && plannedCount > 0) {
    $("#overviewEmpty .empty__title").textContent = "Барлық тауар сатып алынды";
    $("#overviewEmpty .empty__text").textContent = "Жаңа сатып алу қосу үшін «Тізімдер» бетіне өтіңіз.";
  } else {
    $("#overviewEmpty .empty__title").textContent = "Жоспарланған тауар жоқ";
    $("#overviewEmpty .empty__text").textContent = "«Тізімдер» бетіне өтіп, алғашқы тауарды қосыңыз.";
  }
}

function renderLists() {
  const list = getFilteredItems({ withSearch: true });
  const ul = $("#mainItemList");
  ul.innerHTML = list.map((i) => renderItemRow(i)).join("");
  ul.style.display = list.length ? "flex" : "none";

  const filtering =
    ui.search.trim() || ui.filterCategory !== "all" || ui.filterStatus !== "all";
  $("#listCount").textContent = filtering
    ? `${countLabel(list.length)} · барлығы ${state.items.length}`
    : countLabel(state.items.length);

  const empty = $("#listEmpty");
  empty.classList.toggle("empty--visible", list.length === 0);
  if (list.length === 0) {
    if (state.items.length === 0) {
      $("#listEmptyTitle").textContent = "Тізім бос";
      $("#listEmptyText").textContent = "Алғашқы тауарды қосыңыз.";
      $("#listEmptyCta").classList.remove("hidden");
    } else {
      $("#listEmptyTitle").textContent = "Ештеңе табылмады";
      $("#listEmptyText").textContent = "Іздеу сөзін немесе сүзгілерді өзгертіп көріңіз.";
      $("#listEmptyCta").classList.add("hidden");
    }
  }

  // Себет сомасы сүзгіге тәуелсіз — барлық тауар бойынша
  $("#cartTotal").textContent = formatMoney(state.items.reduce((s, i) => s + lineTotal(i), 0));
}

function barHtml({ label, iconName, color, valueText, pct }) {
  return `
    <div class="bar" style="--c:${color}">
      <div class="bar__top">
        ${iconName ? `<span class="bar__icon">${icon(iconName)}</span>` : ""}
        <span class="bar__label">${escapeHtml(label)}</span>
        <span class="bar__value">${valueText}</span>
        <span class="bar__pct">${formatPct(pct)}</span>
      </div>
      <div class="bar__track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}">
        <div class="bar__fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function renderAnalytics() {
  const { planned, spent, remaining, savings } = computeTotals();
  const totalItems = state.items.length;
  const doneCount = state.items.filter((i) => i.purchased).length;
  const execPct = totalItems ? (doneCount / totalItems) * 100 : 0;

  // Категориялар: үлесі = жалпы жоспарланған сомаға қатысты
  const cats = [...categoryTotals().entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const chart = $("#categoryChart");
  $("#chartEmpty").classList.toggle("empty--visible", cats.length === 0);
  chart.innerHTML = cats
    .map(([name, val]) => {
      const meta = categoryMeta(name);
      return barHtml({
        label: name,
        iconName: meta.icon,
        color: meta.color,
        valueText: formatMoney(val),
        pct: planned > 0 ? (val / planned) * 100 : 0,
      });
    })
    .join("");

  // Маңыздылық бойынша
  const priColors = { high: "#0A0A0A", medium: "#6B7280", low: "#9CA3AF" };
  $("#priorityChart").innerHTML = [...PRIORITIES]
    .reverse()
    .map((p) => {
      const sum = state.items.filter((i) => i.priority === p.id).reduce((s, i) => s + lineTotal(i), 0);
      return barHtml({
        label: p.label,
        color: priColors[p.id],
        valueText: formatMoney(sum),
        pct: planned > 0 ? (sum / planned) * 100 : 0,
      });
    })
    .join("");

  // Орындалу барысы
  $("#execFill").style.width = `${execPct}%`;
  $("#execPct").textContent = formatPct(execPct);
  $("#execText").textContent = `${doneCount} / ${totalItems} тауар сатып алынды`;

  // Калькулятор
  const unpurchased = state.items.filter((i) => !i.purchased).reduce((s, i) => s + lineTotal(i), 0);
  $("#calcPlanned").textContent = formatMoney(planned);
  $("#calcPurchased").textContent = formatMoney(spent);
  $("#calcRemainingItems").textContent = formatMoney(unpurchased);
  $("#calcSavings").textContent = formatMoney(savings);
  const left = $("#calcBudgetLeft");
  left.textContent = formatMoney(remaining);
  left.classList.toggle("is-over", remaining < 0);

  // Қысқаша карточкалар
  const topCat = cats[0];
  $("#miniStats").innerHTML = `
    <div class="mini-stat mini-stat--ink">
      <span class="mini-stat__top">${icon("bag")}Барлық тауар</span>
      <span class="mini-stat__val">${totalItems}</span>
      <span class="mini-stat__sub">${formatMoney(planned)} жоспарланған</span>
    </div>
    <div class="mini-stat">
      <span class="mini-stat__top">${icon("check")}Орындалу</span>
      <span class="mini-stat__val">${formatPct(execPct)}</span>
      <span class="mini-stat__sub">${doneCount} сатып алынды · ${totalItems - doneCount} күтуде</span>
    </div>
    <div class="mini-stat">
      <span class="mini-stat__top">${icon("trend")}Ең үлкен шығын</span>
      <span class="mini-stat__val">${topCat ? escapeHtml(topCat[0]) : "—"}</span>
      <span class="mini-stat__sub">${topCat ? formatMoney(topCat[1]) : "Деректер жоқ"}</span>
    </div>
    <div class="mini-stat">
      <span class="mini-stat__top">${icon("percent")}Үнемдеу</span>
      <span class="mini-stat__val">${formatMoney(savings)}</span>
      <span class="mini-stat__sub">жеңілдіктер есебінен</span>
    </div>
  `;
}

/** Таңдау тізімдерін толтыру */
function populateSelects() {
  const catOptions = CATEGORIES.map((c) => `<option value="${c.name}">${c.name}</option>`).join("");
  $("#itemCategory").innerHTML = catOptions;
  $("#filterCategory").innerHTML = '<option value="all">Барлық категориялар</option>' + catOptions;
  $("#itemUnit").innerHTML = UNITS.map((u) => `<option value="${u}">${u}</option>`).join("");
  $("#itemPriority").innerHTML = PRIORITIES.map(
    (p) => `<option value="${p.id}"${p.id === "medium" ? " selected" : ""}>${p.label}</option>`
  ).join("");
  $("#itemCurrency").innerHTML = CURRENCIES.map((c) => `<option value="${c.code}">${c.label}</option>`).join("");

  $("#filterCategory").value = ui.filterCategory;
  $("#filterStatus").value = ui.filterStatus;
  $("#sortBy").value = ui.sortBy;
}

/* ==========================================================================
   ТАУАР ӘРЕКЕТТЕРІ (Firestore-ға жазу)
   ========================================================================== */

/** Тізімдегі чекбокс / өзгерту / жою — бір тыңдаушы арқылы (event delegation) */
function onItemAction(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  const item = state.items.find((i) => i.id === id);
  if (!item) return;

  if (action === "toggle" && e.type !== "change") return;
  if (action !== "toggle" && e.type !== "click") return;

  const uid = requireUid();
  if (!uid) {
    if (action === "toggle") el.checked = !el.checked;
    return;
  }

  if (action === "toggle") {
    const purchased = el.checked;
    cloud(updateDoc(itemDocRef(uid, id), { purchased }));
    // Жергілікті күйді бірден жаңартамыз: көрсеткіштер кідіріссіз өзгереді
    item.purchased = purchased;
    renderAll();
    toast(purchased ? "Сатып алынды деп белгіленді" : "Жоспарланған тізімге қайтарылды", "success");
    return;
  }
  if (action === "delete") {
    cloud(deleteDoc(itemDocRef(uid, id)));
    state.items = state.items.filter((i) => i.id !== id);
    renderAll();
    toast("Тауар жойылды", "success");
    return;
  }
  if (action === "edit") openItemModal(item);
}

/* ----- Тауар модалы ----- */

function resetForm() {
  $("#itemForm").reset();
  $("#itemId").value = "";
  $("#itemQty").value = "1";
  $("#itemPrice").value = "0";
  $("#itemDiscount").value = "0";
  $("#itemCurrency").value = "KZT";
  $("#itemPriority").value = "medium";
  $("#formTitle").textContent = "Жаңа тауар қосу";
  $("#btnSubmitItem").textContent = "Қосу";
  $$("#itemForm .is-invalid").forEach((el) => el.classList.remove("is-invalid"));
  updateCalc();
}

function openItemModal(item = null) {
  if (!requireUid()) return;
  closeAllMenus();
  resetForm();
  if (item) {
    $("#itemId").value = item.id;
    $("#itemName").value = item.name;
    $("#itemCategory").value = item.category;
    $("#itemQty").value = item.qty;
    $("#itemUnit").value = item.unit;
    $("#itemPrice").value = item.price;
    $("#itemCurrency").value = item.currency;
    $("#itemDiscount").value = item.discount || 0;
    $("#itemPriority").value = item.priority;
    $("#itemNotes").value = item.notes || "";
    $("#formTitle").textContent = "Тауарды өзгерту";
    $("#btnSubmitItem").textContent = "Сақтау";
    updateCalc();
  }
  const modal = $("#itemModal");
  if (!modal.open) modal.showModal();
  $("#itemName").focus();
}

function closeItemModal() {
  const modal = $("#itemModal");
  if (modal.open) modal.close();
}

/** Формадағы қорытынды сома калькуляторы (F: жеңілдік және валюта) */
function readForm() {
  const qty = parseFloat($("#itemQty").value);
  const price = parseFloat($("#itemPrice").value);
  const discount = parseFloat($("#itemDiscount").value);
  return {
    qty: Number.isFinite(qty) ? qty : 0,
    price: Number.isFinite(price) ? price : 0,
    discount: Number.isFinite(discount) ? Math.min(100, Math.max(0, discount)) : 0,
    currency: $("#itemCurrency").value || "KZT",
  };
}

function updateCalc() {
  const f = readForm();
  const cur = currencyOf(f.currency);
  const gross = f.qty * f.price * cur.rate;
  const saving = gross * (f.discount / 100);

  $("#calcFormula").textContent = `${nfFx.format(f.qty)} × ${nfFx.format(f.price)} ${cur.symbol}`;
  $("#calcGross").textContent = formatMoney(gross);
  $("#calcDiscountLine").classList.toggle("hidden", f.discount <= 0);
  $("#calcDiscountLabel").textContent = `Жеңілдік ${nfFx.format(f.discount)}%`;
  $("#calcDiscount").textContent = `−${formatMoney(saving)}`;
  $("#calcFinal").textContent = formatMoney(gross - saving);

  const note = $("#calcRateNote");
  note.classList.toggle("hidden", cur.code === "KZT");
  if (cur.code !== "KZT") note.textContent = `Курс: 1 ${cur.symbol} ≈ ${nfFx.format(cur.rate)} ₸ (шамамен)`;
}

function markInvalid(selector, message) {
  const el = $(selector);
  el.classList.add("is-invalid");
  el.focus();
  toast(message, "error");
}

function handleFormSubmit(e) {
  e.preventDefault();
  const uid = requireUid();
  if (!uid) return;
  $$("#itemForm .is-invalid").forEach((el) => el.classList.remove("is-invalid"));

  const name = $("#itemName").value.trim();
  if (!name) return markInvalid("#itemName", "Тауар атауын енгізіңіз");

  const qty = parseFloat($("#itemQty").value);
  if (!(qty > 0)) return markInvalid("#itemQty", "Саны дұрыс емес");

  const price = parseFloat($("#itemPrice").value);
  if (!Number.isFinite(price) || price < 0) return markInvalid("#itemPrice", "Баға дұрыс емес");

  const rawDiscount = $("#itemDiscount").value.trim();
  const discount = rawDiscount === "" ? 0 : parseFloat(rawDiscount);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
    return markInvalid("#itemDiscount", "Жеңілдік 0-ден 100%-ға дейін болуы керек");
  }

  const payload = {
    name,
    category: $("#itemCategory").value,
    qty,
    unit: $("#itemUnit").value,
    price,
    currency: $("#itemCurrency").value,
    discount,
    priority: $("#itemPriority").value,
    notes: $("#itemNotes").value.trim(),
  };

  const editId = $("#itemId").value;
  if (editId) {
    if (state.items.some((i) => i.id === editId)) {
      cloud(updateDoc(itemDocRef(uid, editId), payload));
      toast("Өзгерістер сақталды", "success");
    }
  } else {
    cloud(setDoc(itemDocRef(uid, newId()), { ...payload, purchased: false, createdAt: Date.now() }));
    toast("Тауар қосылды", "success");
  }
  closeItemModal();
}

/* ----- Табтар ----- */
function switchTab(tabId) {
  ui.activeTab = tabId;
  document.body.classList.toggle("tab-lists", tabId === "lists");
  closeAllMenus();
  $$(".tabs__item").forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle("tabs__item--active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$(".panel").forEach((panel) => {
    const active = panel.id.replace("panel-", "") === tabId;
    panel.classList.toggle("panel--active", active);
    panel.hidden = !active;
  });
}

function resetAll() {
  replaceCloudData(DEFAULT_BUDGET, []);
  state.items = [];
  state.budget = DEFAULT_BUDGET;
  ui.search = "";
  $("#searchInput").value = "";
  renderAll();
  toast("Деректер тазартылды", "success");
}

function setSearch(value) {
  ui.search = value;
  renderLists();
}

/** Бюджет модалы */
function openBudgetModal() {
  $("#budgetInput").value = state.budget;
  $("#budgetModal").showModal();
  $("#budgetInput").select();
}

/* ----- Ашылмалы мәзірлер (экспорт, профиль) ----- */
const MENUS = [
  { btn: "#btnExport", menu: "#exportMenu" },
  { btn: "#btnProfile", menu: "#profileMenu" },
];

function closeAllMenus() {
  for (const { btn, menu } of MENUS) {
    $(menu).classList.add("hidden");
    $(btn).setAttribute("aria-expanded", "false");
  }
}

function toggleMenu(target) {
  const wasHidden = $(target.menu).classList.contains("hidden");
  closeAllMenus();
  if (wasHidden) {
    $(target.menu).classList.remove("hidden");
    $(target.btn).setAttribute("aria-expanded", "true");
  }
}

/* ==========================================================================
   ЭКСПОРТ: Excel және PDF
   ========================================================================== */

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Экспорт үшін сұрыпталған тізім: ағымдағы сұрыптау, бірақ сүзгісіз */
function itemsForExport() {
  return [...state.items].sort((a, b) => a.createdAt - b.createdAt);
}

function exportRow(item, index) {
  const cur = currencyOf(item.currency);
  return {
    "№": index + 1,
    "Атауы": item.name,
    "Категория": item.category,
    "Саны": item.qty,
    "Өлшем бірлігі": item.unit,
    "Бірлік бағасы": item.price,
    "Валюта": cur.symbol,
    "Жеңілдік, %": item.discount || 0,
    "Сомасы, ₸": Math.round(lineTotal(item)),
    "Маңыздылығы": priorityMeta(item.priority).label,
    "Күйі": item.purchased ? "Сатып алынды" : "Жоспарланған",
    "Ескертпе": item.notes || "",
    "Қосылған күні": item.createdAt ? new Date(item.createdAt).toLocaleDateString("kk-KZ") : "",
  };
}

function summaryRows() {
  const t = computeTotals();
  return [
    ["Көрсеткіш", "Мәні"],
    ["Есеп күні", new Date().toLocaleDateString("kk-KZ")],
    ["Жалпы бюджет, ₸", Math.round(state.budget)],
    ["Жоспарланған сома, ₸", Math.round(t.planned)],
    ["Орындалған сома, ₸", Math.round(t.spent)],
    ["Қалдық, ₸", Math.round(t.remaining)],
    ["Жеңілдіктен үнемделген, ₸", Math.round(t.savings)],
    ["Бюджет күйі", t.over ? "Бюджеттен асты" : "Бюджет шегінде"],
  ];
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("script-load-failed"));
    document.head.appendChild(s);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV (SheetJS жүктелмесе қосалқы нұсқа). BOM — Excel-де қазақ әріптері дұрыс көрінуі үшін */
function exportCsvFallback(rows) {
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(esc).join(";"), ...rows.map((r) => headers.map((h) => esc(r[h])).join(";"))].join("\r\n");
  downloadBlob(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }), `satyp-alu-${todayStamp()}.csv`);
}

async function exportExcel() {
  closeAllMenus();
  if (state.items.length === 0) return toast("Экспорттауға тауар жоқ", "error");
  const rows = itemsForExport().map(exportRow);

  try {
    await loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [5, 30, 16, 8, 12, 14, 8, 12, 14, 14, 15, 26, 14].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, "Сатып алу тізімі");

    const ws2 = XLSX.utils.aoa_to_sheet(summaryRows());
    ws2["!cols"] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Қорытынды");

    XLSX.writeFile(wb, `satyp-alu-${todayStamp()}.xlsx`);
    toast("Excel файлы жүктелді", "success");
  } catch (err) {
    console.warn("SheetJS жүктелмеді, CSV қолданылады:", err);
    exportCsvFallback(rows);
    toast("Excel кітапханасы қолжетімсіз — CSV жүктелді", "success");
  }
}

function exportPdf() {
  closeAllMenus();
  if (state.items.length === 0) return toast("Экспорттауға тауар жоқ", "error");

  const t = computeTotals();
  const items = itemsForExport();
  const name = getDisplayName();
  const rows = items
    .map((item, i) => {
      const cur = currencyOf(item.currency);
      const price = `${nfFx.format(item.price)} ${cur.symbol}`;
      return `<tr class="${item.purchased ? "is-done" : ""}">
        <td>${i + 1}</td>
        <td>${escapeHtml(item.name)}${item.notes ? `<br><small>${escapeHtml(item.notes)}</small>` : ""}</td>
        <td>${escapeHtml(item.category)}</td>
        <td class="num">${nfFx.format(item.qty)} ${escapeHtml(item.unit)}</td>
        <td class="num">${price}</td>
        <td class="num">${item.discount ? `−${nfFx.format(item.discount)}%` : "—"}</td>
        <td class="num">${formatMoney(lineTotal(item))}</td>
        <td>${priorityMeta(item.priority).label}</td>
        <td>${item.purchased ? "Сатып алынды" : "Жоспарланған"}</td>
      </tr>`;
    })
    .join("");

  const cats = [...categoryTotals().entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const catRows = cats
    .map(([c, v]) => `<tr><td>${escapeHtml(c)}</td><td class="num">${formatMoney(v)}</td><td class="num">${formatPct(t.planned ? (v / t.planned) * 100 : 0)}</td></tr>`)
    .join("");

  $("#printReport").innerHTML = `
    <div class="report__head">
      <div class="report__title">Сатып алу есебі</div>
      <div class="report__meta">${escapeHtml(name)}<br>${new Date().toLocaleDateString("kk-KZ")}</div>
    </div>
    <div class="report__summary">
      <div class="report__box"><span>Жалпы бюджет</span><strong>${formatMoney(state.budget)}</strong></div>
      <div class="report__box"><span>Жоспарланған сома</span><strong>${formatMoney(t.planned)}</strong></div>
      <div class="report__box"><span>Орындалған сома</span><strong>${formatMoney(t.spent)}</strong></div>
      <div class="report__box ${t.over ? "report__box--alert" : ""}"><span>Қалдық${t.over ? " · Бюджеттен асу!" : ""}</span><strong>${formatMoney(t.remaining)}</strong></div>
    </div>
    <h3>Сатып алу тізімі</h3>
    <table>
      <thead><tr><th>№</th><th>Атауы</th><th>Категория</th><th class="num">Саны</th><th class="num">Бағасы</th><th class="num">Жеңілдік</th><th class="num">Сомасы</th><th>Маңыздылығы</th><th>Күйі</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="6">Жалпы себет сомасы</td><td class="num">${formatMoney(t.planned)}</td><td colspan="2"></td></tr></tfoot>
    </table>
    <h3>Категориялар бойынша</h3>
    <table>
      <thead><tr><th>Категория</th><th class="num">Сома</th><th class="num">Үлесі</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>
    <p class="report__foot">Жеңілдіктен үнемделген: ${formatMoney(t.savings)}. Шетел валюталары шамамен курс бойынша теңгеге ауыстырылған.</p>
  `;

  const prevTitle = document.title;
  document.title = `satyp-alu-esebi-${todayStamp()}`;
  document.body.classList.add("is-printing");
  const cleanup = () => {
    document.body.classList.remove("is-printing");
    document.title = prevTitle;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Браузер макеті есептеп үлгерсін
  setTimeout(() => window.print(), 50);
}

/* ==========================================================================
   АВТОРИЗАЦИЯ ИНТЕРФЕЙСІ
   ========================================================================== */

function authErrorMessage(err) {
  switch (err?.code) {
    case "auth/invalid-email":
      return "Электрондық пошта форматы дұрыс емес";
    case "auth/email-already-in-use":
      return "Бұл электрондық пошта бұрын тіркелген. «Кіру» бөліміне өтіңіз";
    case "auth/weak-password":
      return "Құпия сөз өте әлсіз. Кемінде 6 таңба енгізіңіз";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
      return "Электрондық пошта немесе құпия сөз қате";
    case "auth/user-disabled":
      return "Бұл есептік жазба өшірілген";
    case "auth/too-many-requests":
      return "Тым көп әрекет жасалды. Кейінірек қайталап көріңіз";
    case "auth/network-request-failed":
      return "Желі қатесі. Интернет байланысын тексеріңіз";
    case "auth/operation-not-allowed":
      return "Firebase-те «Email/Password» кіру әдісі қосылмаған";
    case "auth/invalid-api-key":
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
      return "Firebase API кілті дұрыс емес. firebaseConfig-ті тексеріңіз";
    case "auth/unauthorized-domain":
      return "Бұл домен Firebase-те рұқсат етілмеген (Authentication → Settings → Authorized domains)";
    default:
      return "Қате орын алды. Қайталап көріңіз";
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function showAuthError(message) {
  const el = $("#authError");
  el.textContent = message;
  el.classList.remove("hidden");
}

function clearAuthError() {
  const el = $("#authError");
  el.textContent = "";
  el.classList.add("hidden");
}

function switchAuthTab(tab) {
  const isLogin = tab === "login";
  $$("[data-auth-tab]").forEach((btn) => {
    const active = btn.dataset.authTab === tab;
    btn.classList.toggle("auth-tabs__item--active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#loginForm").classList.toggle("hidden", !isLogin);
  $("#registerForm").classList.toggle("hidden", isLogin);
  $("#authSubtitle").textContent = isLogin
    ? "Есептік жазбаңызға кіріңіз"
    : "Жаңа есептік жазба жасаңыз";
  clearAuthError();
}

function setAuthBusy(form, busy, idleText) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = busy;
  btn.textContent = busy ? "Күте тұрыңыз..." : idleText;
  form.querySelectorAll("input").forEach((i) => (i.disabled = busy));
}

function openAuthModal() {
  const modal = $("#authModal");
  if (!modal.open) modal.showModal();
}

function closeAuthModal() {
  const modal = $("#authModal");
  if (modal.open) modal.close();
  $("#loginForm").reset();
  $("#registerForm").reset();
  clearAuthError();
  switchAuthTab("login");
}

/** Көрсетілетін аты: Firestore → Auth displayName → email */
function getDisplayName() {
  const user = auth?.currentUser;
  if (!user) return "";
  return (profile.name || user.displayName || "").trim() || (user.email || "").split("@")[0];
}

/** Аватарды (сурет немесе бас әріп) элементке салу */
function paintAvatar(el, name, avatar) {
  if (!el) return;
  if (avatar) {
    el.style.backgroundImage = `url("${avatar}")`;
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = (name || "?").trim().charAt(0) || "?";
  }
}

/** Шапка мен профиль мәзірін жаңарту */
function updateProfileUI() {
  const user = auth?.currentUser;
  if (!user) return;
  const name = getDisplayName();
  $("#userGreeting").textContent = name;
  $("#menuName").textContent = name;
  $("#menuEmail").textContent = user.email || "";
  paintAvatar($("#profileAvatar"), name, profile.avatar);
  paintAvatar($("#menuAvatar"), name, profile.avatar);
}

/* ----- Профиль мәзірі: жалпы closeAllMenus()/toggleMenu() қолданылады ----- */

/* ----- Профиль модалы ----- */
function showProfileError(message) {
  const el = $("#profileError");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function openProfileModal() {
  const user = auth?.currentUser;
  if (!user) return;
  closeAllMenus();
  pendingAvatar = undefined;
  showProfileError("");
  $("#profileName").value = getDisplayName();
  $("#profileEmail").value = user.email || "";
  paintAvatar($("#profileEditAvatar"), getDisplayName(), profile.avatar);
  $("#btnAvatarRemove").classList.toggle("hidden", !profile.avatar);
  $("#profileModal").showModal();
  $("#profileName").focus();
}

function closeProfileModal() {
  pendingAvatar = undefined;
  $("#profileModal").close();
}

/** Суретті 192×192 шаршыға кішірейтіп, JPEG data URL қайтару (Firestore-ға сыйымды) */
function resizeImageToDataUrl(file, size = 192) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#F3F4F6";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("invalid-image"));
    };
    img.src = url;
  });
}

async function handleAvatarPicked(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return showProfileError("Тек сурет файлын таңдаңыз");
  if (file.size > 5 * 1024 * 1024) return showProfileError("Сурет 5 МБ-тан аспауы керек");
  try {
    pendingAvatar = await resizeImageToDataUrl(file);
    showProfileError("");
    const name = $("#profileName").value.trim() || getDisplayName();
    paintAvatar($("#profileEditAvatar"), name, pendingAvatar);
    $("#btnAvatarRemove").classList.remove("hidden");
  } catch {
    showProfileError("Суретті оқу мүмкін болмады");
  }
}

function handleAvatarRemove() {
  pendingAvatar = "";
  paintAvatar($("#profileEditAvatar"), $("#profileName").value.trim() || getDisplayName(), "");
  $("#btnAvatarRemove").classList.add("hidden");
}

async function handleProfileSave(e) {
  e.preventDefault();
  const user = auth?.currentUser;
  const uid = requireUid();
  if (!user || !uid) return;

  const name = $("#profileName").value.trim();
  if (!name) return showProfileError("Аты-жөніңізді енгізіңіз");

  const saveBtn = $("#profileSave");
  saveBtn.disabled = true;
  saveBtn.textContent = "Күте тұрыңыз...";
  showProfileError("");

  try {
    const patch = { name };
    if (pendingAvatar !== undefined) patch.avatar = pendingAvatar;

    // Firestore: users/{uid}
    await setDoc(userDocRef(uid), patch, { merge: true });
    // Firebase Auth профилі (displayName)
    await updateProfile(user, { displayName: name });

    profile = {
      name,
      avatar: pendingAvatar !== undefined ? pendingAvatar : profile.avatar,
    };
    updateProfileUI();
    closeProfileModal();
    toast("Профиль сақталды", "success");
  } catch (err) {
    console.error("Профильді сақтау қатесі:", err);
    showProfileError(cloudErrorMessage(err));
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Сақтау";
  }
}

function ensureFirebaseConfigured() {
  if (FIREBASE_READY) return true;
  showAuthError("Firebase конфигі толтырылмаған. script.js файлының басына өз firebaseConfig мәндеріңізді қойыңыз.");
  return false;
}

async function handleLogin(e) {
  e.preventDefault();
  clearAuthError();
  const form = e.currentTarget;
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;

  if (!isValidEmail(email)) return showAuthError("Электрондық поштаны дұрыс енгізіңіз");
  if (!password) return showAuthError("Құпия сөзді енгізіңіз");
  if (!ensureFirebaseConfigured()) return;

  setAuthBusy(form, true, "Кіру");
  try {
    await signInWithEmailAndPassword(auth, email, password);
    // Қалғанын onAuthStateChanged өңдейді
  } catch (err) {
    console.error("Кіру қатесі:", err);
    showAuthError(authErrorMessage(err));
  } finally {
    setAuthBusy(form, false, "Кіру");
  }
}

async function handleRegister(e) {
  e.preventDefault();
  clearAuthError();
  const form = e.currentTarget;
  const name = $("#registerName").value.trim();
  const email = $("#registerEmail").value.trim();
  const password = $("#registerPassword").value;

  if (!name) return showAuthError("Аты-жөніңізді енгізіңіз");
  if (!isValidEmail(email)) return showAuthError("Электрондық поштаны дұрыс енгізіңіз");
  if (password.length < 6) return showAuthError("Құпия сөз кемінде 6 таңбадан тұруы керек");
  if (!ensureFirebaseConfigured()) return;

  setAuthBusy(form, true, "Тіркелу");
  registering = true;
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error("Тіркелу қатесі:", err);
    registering = false;
    showAuthError(authErrorMessage(err));
    setAuthBusy(form, false, "Тіркелу");
    return;
  }

  // Тіркелу сәтті: профиль мен Firestore құжаттарын жасаймыз
  try {
    await updateProfile(cred.user, { displayName: name });
  } catch (err) {
    console.warn("Атын сақтау мүмкін болмады:", err);
  }
  updateProfileUI();

  try {
    const batch = writeBatch(db);
    batch.set(userDocRef(cred.user.uid), {
      name,
      email,
      createdAt: serverTimestamp(),
    });
    batch.set(settingsDocRef(cred.user.uid), {
      budget: DEFAULT_BUDGET,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
    toast(`Қош келдіңіз, ${name.split(/\s+/)[0]}!`, "success");
  } catch (err) {
    handleCloudError(err);
  } finally {
    registering = false;
    setAuthBusy(form, false, "Тіркелу");
  }
}

async function handleLogout() {
  closeAllMenus();
  if (!auth) return;
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Шығу қатесі:", err);
    toast("Шығу кезінде қате шықты", "error");
  }
}

/** Auth күйінің өзгеруі: кіру / шығу */
function handleAuthState(user) {
  currentUser = user;

  if (user) {
    document.body.classList.add("is-authed");
    closeAuthModal();
    updateProfileUI();
    if (!registering) {
      ensureUserDocs(user).catch((err) => console.warn("Пайдаланушы құжаттарын тексеру мүмкін болмады:", err));
    }
    startSync(user);
  } else {
    document.body.classList.remove("is-authed");
    stopSync();
    resetLocalSession();
    setLoader(false);
    openAuthModal();
  }
}

/* ==========================================================================
   БАСТАПҚЫ БАЙЛАНЫСТЫРУ
   ========================================================================== */

function initAuth() {
  // Авторизация терезесін Esc арқылы жабуға болмайды
  const authModal = $("#authModal");
  authModal.addEventListener("cancel", (e) => e.preventDefault());
  authModal.addEventListener("close", () => {
    if (!currentUser) setTimeout(openAuthModal, 0);
  });

  $$("[data-auth-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchAuthTab(btn.dataset.authTab));
  });
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#registerForm").addEventListener("submit", handleRegister);
  $("#btnLogout").addEventListener("click", handleLogout);

  if (!FIREBASE_READY) {
    $("#authConfigWarning").classList.remove("hidden");
    setLoader(false);
    openAuthModal();
    return;
  }

  setLoader(true, "Жүктелуде...");
  onAuthStateChanged(auth, handleAuthState);
}

function init() {
  populateSelects();
  resetForm();

  $$(".tabs__item").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("#btnGoLists").addEventListener("click", () => switchTab("lists"));

  // Іздеу (шапкада, тек «Тізімдер» бетінде көрінеді)
  $("#searchInput").addEventListener("input", (e) => setSearch(e.target.value));

  $("#filterCategory").addEventListener("change", (e) => { ui.filterCategory = e.target.value; renderLists(); });
  $("#filterStatus").addEventListener("change", (e) => { ui.filterStatus = e.target.value; renderLists(); });
  $("#sortBy").addEventListener("change", (e) => { ui.sortBy = e.target.value; renderAll(); });

  // Тізімдер: чекбокс, өзгерту, жою
  for (const sel of ["#mainItemList", "#overviewItemList"]) {
    $(sel).addEventListener("change", onItemAction);
    $(sel).addEventListener("click", onItemAction);
  }

  // Тауар модалы
  $("#btnAddItem").addEventListener("click", () => openItemModal());
  $$("[data-open-add]").forEach((b) => b.addEventListener("click", () => openItemModal()));
  $("#itemForm").addEventListener("submit", handleFormSubmit);
  $("#btnCancelEdit").addEventListener("click", closeItemModal);
  $("#btnCloseItem").addEventListener("click", closeItemModal);
  ["#itemQty", "#itemPrice", "#itemDiscount", "#itemCurrency"].forEach((s) => {
    $(s).addEventListener("input", updateCalc);
    $(s).addEventListener("change", updateCalc);
  });
  $$("#itemForm input").forEach((el) => el.addEventListener("input", () => el.classList.remove("is-invalid")));

  // Модал артқы фонын басқанда жабу
  for (const sel of ["#itemModal", "#budgetModal", "#profileModal", "#confirmModal"]) {
    $(sel).addEventListener("mousedown", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.close();
    });
  }

  // Бюджет
  $("#btnEditBudget").addEventListener("click", openBudgetModal);
  $("#budgetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = parseFloat($("#budgetInput").value);
    if (!Number.isFinite(v) || v < 0) {
      toast("Бюджет сомасы дұрыс емес", "error");
      return;
    }
    const uid = requireUid();
    if (!uid) return;
    cloud(setDoc(settingsDocRef(uid), { budget: v, updatedAt: serverTimestamp() }, { merge: true }));
    state.budget = v;
    renderAll();
    $("#budgetModal").close();
    toast("Бюджет жаңартылды", "success");
  });
  $("#budgetCancel").addEventListener("click", () => $("#budgetModal").close());

  // Мәзірлер: экспорт, профиль
  MENUS.forEach((m) => {
    $(m.btn).addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(m);
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown")) closeAllMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllMenus();
  });
  $("#btnExportPdf").addEventListener("click", exportPdf);
  $("#btnExportXlsx").addEventListener("click", exportExcel);

  // Профиль
  $("#btnOpenProfile").addEventListener("click", openProfileModal);
  $("#profileForm").addEventListener("submit", handleProfileSave);
  $("#profileCancel").addEventListener("click", closeProfileModal);
  $("#btnAvatarPick").addEventListener("click", () => $("#avatarFile").click());
  $("#avatarFile").addEventListener("change", handleAvatarPicked);
  $("#btnAvatarRemove").addEventListener("click", handleAvatarRemove);
  $("#profileName").addEventListener("input", () => {
    if (pendingAvatar === undefined ? !profile.avatar : !pendingAvatar) {
      paintAvatar($("#profileEditAvatar"), $("#profileName").value.trim(), "");
    }
  });

  // Тазалау
  $("#btnReset").addEventListener("click", () => $("#confirmModal").showModal());
  $("#confirmCancel").addEventListener("click", () => $("#confirmModal").close());
  $("#confirmOk").addEventListener("click", () => {
    $("#confirmModal").close();
    resetAll();
  });

  renderAll();
  initAuth();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
