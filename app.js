// OTTOV 예약 (폰 웹앱)
// PC OTTOV [스레드 예약] → [폰 연결하기]의 QR로 연결하면, 폰에서 글을 써서 OTTOV 서버 예약에 바로 넣는다.
// 서버가 시간에 맞춰 올리고, PC OTTOV는 켜질 때 그 예약을 목록으로 가져간다. (폰 열쇠 말고는 아무것도 폰에 저장하지 않는다)
"use strict";

const FN = "https://lpkkaptlhsfyepihgmxb.supabase.co/functions/v1/ottov-threads";
const PUBLIC_KEY = "sb_publishable_TygRmLZkHqWuHvenTuGICg_nQDlaX0e"; // 공개 키 (PC OTTOV와 같은 값)
const TOKEN_KEY = "ottov-m-token";
const DRAFT_KEY = "ottov-m-draft";
const MAX_LEN = 500;
const MAX_IMAGES = 20;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const S = {
  token: store.get(TOKEN_KEY),
  tab: "write",
  accounts: [],
  schedules: [],
  loaded: false,
  loading: false,
  account: "",
  body: "",
  thread: [],
  photos: [], // { url(미리보기), data(base64), type }
  when: "60-90",
  at: "",
  sending: false,
  installEvt: null,
  installHidden: store.get("ottov-m-install-hidden") === "1",
};
try {
  const d = JSON.parse(store.get(DRAFT_KEY) || "{}");
  S.body = d.body || "";
  S.thread = Array.isArray(d.thread) ? d.thread : [];
  S.when = d.when === "90-120" || d.when === "at" ? d.when : "60-90";
  S.account = d.account || "";
} catch {}
const saveDraft = () => store.set(DRAFT_KEY, JSON.stringify({ body: S.body, thread: S.thread, when: S.when, account: S.account }));

// ── 서버 ──
async function api(action, body = {}) {
  let res;
  try {
    res = await fetch(FN, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: PUBLIC_KEY },
      body: JSON.stringify({ action, mtoken: S.token, ...body }),
    });
  } catch {
    throw new Error("인터넷에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.");
  }
  const j = await res.json().catch(() => ({}));
  if (j.unpaired) {
    S.token = null;
    store.del(TOKEN_KEY);
    render();
  }
  if (!res.ok || j.error) throw new Error(j.error || `서버 오류 (${res.status})`);
  return j;
}

async function load(quiet) {
  if (!S.token || S.loading) return;
  S.loading = true;
  render();
  try {
    const j = await api("m-state");
    S.accounts = j.accounts || [];
    S.schedules = j.schedules || [];
    if (!S.accounts.some((a) => a.threads_user_id === S.account)) S.account = S.accounts[0] ? S.accounts[0].threads_user_id : "";
    S.loaded = true;
  } catch (e) {
    if (!quiet) toast(e.message, true);
  }
  S.loading = false;
  render();
}

// ── 연결 (QR 주소의 #pair=코드) ──
async function claimFromHash() {
  const m = location.hash.match(/pair=([A-Za-z0-9_-]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  const ua = navigator.userAgent;
  const name = /iPhone/.test(ua) ? "아이폰" : /iPad/.test(ua) ? "아이패드" : /Android/.test(ua) ? "안드로이드 폰" : "폰";
  try {
    const j = await api("m-claim", { code: m[1], name });
    S.token = j.token;
    store.set(TOKEN_KEY, j.token);
    toast("PC OTTOV와 연결했어요.");
  } catch (e) {
    toast(e.message, true);
  }
}

// ── 시간 ──
const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
function dayLabel(d) {
  const t = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(d) - start(t)) / 86400000);
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff === -1) return "어제";
  return `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]})`;
}
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmt = (iso) => { const d = new Date(iso); return `${dayLabel(d)} ${hm(d)}`; };
function localInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 서버와 같은 계산: 이 계정의 마지막 예약(올린 글은 올린 시각)과 지금 중 늦은 때 */
function baseTime(uid) {
  const acc = S.accounts.find((a) => a.threads_user_id === uid);
  let last = Date.parse((acc && acc.last_at) || "") || 0;
  for (const s of S.schedules) {
    if (s.threads_user_id !== uid || !["scheduled", "posting", "posted"].includes(s.status)) continue;
    last = Math.max(last, Date.parse((s.status === "posted" && s.posted_at) || s.scheduled_at) || 0);
  }
  return { base: Math.max(last, Date.now()), last };
}
function rangeText(uid, min, max) {
  const { base, last } = baseTime(uid);
  const a = new Date(base + min * 60000);
  const b = new Date(base + max * 60000);
  const sameDay = a.toDateString() === b.toDateString();
  return {
    main: sameDay ? `${dayLabel(a)} ${hm(a)} ~ ${hm(b)}` : `${fmt(a.toISOString())} ~ ${fmt(b.toISOString())}`,
    sub: last > Date.now() ? `마지막 예약 ${fmt(new Date(last).toISOString())} 다음` : "지금부터",
  };
}

// ── 글자 수 (스레드 규칙: 이모지는 바이트 수) ──
function tlen(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    n += cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) ? new TextEncoder().encode(ch).length : 1;
  }
  return n;
}

// ── 사진: 스레드 규격(JPG, 가로 1440 이하)으로 바꾼다 ──
async function toJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("이 사진은 열지 못했어요. JPG, PNG 사진을 골라 주세요."));
      i.src = url;
    });
    const scale = Math.min(1, 1440 / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
    const data = await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.readAsDataURL(blob);
    });
    return { url: URL.createObjectURL(blob), data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── 예약하기 ──
function problems() {
  const out = [];
  if (!S.account) out.push("계정을 골라 주세요.");
  if (!S.body.trim() && !S.photos.length) out.push("본문을 써 주세요.");
  if (tlen(S.body) > MAX_LEN) out.push(`본문이 ${MAX_LEN}자를 넘어요.`);
  S.thread.forEach((t, i) => { if (tlen(t) > MAX_LEN) out.push(`타래 ${i + 1}이 ${MAX_LEN}자를 넘어요.`); });
  if (S.when === "at") {
    const t = Date.parse(S.at);
    if (!t) out.push("올릴 시각을 골라 주세요.");
    else if (t < Date.now() + 2 * 60000) out.push("올릴 시각은 지금부터 2분 뒤부터 고를 수 있어요.");
  }
  return out;
}

async function submit() {
  const p = problems();
  if (p.length) return toast(p[0], true);
  S.sending = true;
  render();
  try {
    const images = [];
    for (let i = 0; i < S.photos.length; i++) {
      setSubmitText(`사진 올리는 중… (${i + 1}/${S.photos.length})`);
      images.push((await api("m-upload", { mimeType: "image/jpeg", data: S.photos[i].data })).path);
    }
    setSubmitText("예약하는 중…");
    const r = await api("m-create", {
      threads_user_id: S.account,
      body: S.body,
      thread: S.thread.filter((t) => t.trim()),
      images,
      ...(S.when === "at" ? { scheduled_at: new Date(S.at).toISOString() } : { gap: S.when }),
    });
    S.photos.forEach((x) => URL.revokeObjectURL(x.url));
    S.body = "";
    S.thread = [];
    S.photos = [];
    S.at = "";
    saveDraft();
    S.tab = "list";
    toast(`${fmt(r.scheduled_at)}에 올라가게 예약했어요.`);
    S.sending = false;
    await load(true);
  } catch (e) {
    toast(e.message, true);
  }
  S.sending = false;
  render();
}

async function cancel(s) {
  if (!confirm(`${fmt(s.scheduled_at)} 예약을 취소할까요?`)) return;
  try {
    await api("m-cancel", { local_id: s.local_id });
    toast("예약을 취소했어요.");
  } catch (e) {
    toast(e.message, true);
  }
  load(true);
}

async function forget() {
  if (!confirm("이 폰의 연결을 끊을까요? 다시 쓰려면 PC OTTOV에서 QR을 새로 찍어야 해요. (걸어 둔 예약은 그대로 올라가요)")) return;
  try {
    await api("m-forget");
  } catch {}
  S.token = null;
  store.del(TOKEN_KEY);
  render();
}

// ── 화면 ──
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

let toastTimer;
function toast(text, bad) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.className = `on${bad ? " bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 3200);
}
function setSubmitText(t) {
  const b = document.querySelector(".submit-bar button");
  if (b) b.textContent = t;
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function installHint() {
  if (standalone || S.installHidden) return null;
  const hide = () => { S.installHidden = true; store.set("ottov-m-install-hidden", "1"); render(); };
  if (S.installEvt)
    return h("div", { class: "install" }, h("p", null, "홈 화면에 앱으로 설치하면 더 빨리 열 수 있어요."),
      h("button", { onclick: async () => { S.installEvt.prompt(); await S.installEvt.userChoice.catch(() => null); S.installEvt = null; render(); } }, "설치"),
      h("button", { class: "x", "aria-label": "안내 닫기", onclick: hide }, "✕"));
  return h("div", { class: "install" },
    h("p", null, isIOS ? "Safari 아래 공유 버튼(□↑) → [홈 화면에 추가]를 누르면 앱처럼 쓸 수 있어요." : "크롬 메뉴(⋮) → [앱 설치] 또는 [홈 화면에 추가]를 누르면 앱처럼 쓸 수 있어요."),
    h("button", { class: "x", "aria-label": "안내 닫기", onclick: hide }, "✕"));
}

function pairView() {
  return h("div", { class: "wrap" },
    h("div", { class: "pair" },
      h("img", { src: "icon-192.png", alt: "" }),
      h("h2", null, "PC OTTOV와 연결해 주세요"),
      h("p", null, "한 번만 연결하면 폰에서 글을 써서 예약할 수 있어요. 컴퓨터가 꺼져 있어도 시간에 맞춰 올라가요."),
      h("ol", null,
        h("li", null, "PC에서 OTTOV를 켜고 [스레드 예약]으로 가요."),
        h("li", null, "[📱 폰에서 예약하기] → [폰 연결하기] → [연결 QR 만들기]를 눌러요."),
        h("li", null, "폰 카메라로 QR을 찍고 뜨는 주소를 열어요."))));
}

function writeView() {
  const acc = S.accounts;
  if (S.loaded && !acc.length)
    return h("div", { class: "empty" }, h("b", null, "아직 쓸 수 있는 계정이 없어요"),
      "PC OTTOV를 켜 두면 1~3분 안에 연결한 스레드 계정이 여기에 보여요. (PC [스레드 예약]에서 계정을 먼저 연결해 주세요)");

  const n = tlen(S.body);
  const bodyBox = h("textarea", {
    class: "body", id: "body", placeholder: "스레드에 올릴 본문", value: S.body,
    oninput: (e) => { S.body = e.target.value; saveDraft(); const c = document.getElementById("body-count"); c.textContent = `${tlen(S.body)}/${MAX_LEN}`; c.className = `count${tlen(S.body) > MAX_LEN ? " over" : ""}`; },
  });

  const threadRows = S.thread.map((t, i) =>
    h("div", { class: "thread-row" },
      h("span", { class: "tag" }, `타래 ${i + 1}`),
      h("textarea", { class: "thread", "aria-label": `타래 ${i + 1}`, value: t, oninput: (e) => { S.thread[i] = e.target.value; saveDraft(); } }),
      h("button", { class: "del", "aria-label": `타래 ${i + 1} 지우기`, onclick: () => { S.thread.splice(i, 1); saveDraft(); render(); } }, "✕")));

  const photoInput = h("input", {
    type: "file", accept: "image/*", multiple: true,
    onchange: async (e) => {
      const files = [...e.target.files].slice(0, MAX_IMAGES - S.photos.length);
      for (const f of files) {
        try { S.photos.push(await toJpeg(f)); } catch (err) { toast(err.message, true); }
      }
      render();
    },
  });

  const opt = (v, title, extra) =>
    h("label", { class: "opt" },
      h("input", { type: "radio", name: "when", value: v, checked: S.when === v, onchange: () => { S.when = v; saveDraft(); render(); } }),
      h("span", { class: "t" }, title), extra);
  const range = (min, max) => {
    if (!S.account) return null;
    const r = rangeText(S.account, min, max);
    return h("div", { class: "range" }, h("small", null, `${r.sub} · 이 사이 아무 때나`), h("b", null, r.main));
  };
  const minAt = localInput(new Date(Date.now() + 3 * 60000));

  return h("div", null,
    acc.length > 1 && h("div", { class: "field" }, h("div", { class: "label" }, "계정"),
      h("div", { class: "accounts" }, acc.map((a) =>
        h("button", { class: "chip", "aria-pressed": String(S.account === a.threads_user_id), onclick: () => { S.account = a.threads_user_id; saveDraft(); render(); } }, `@${a.username || a.threads_user_id}`)))),
    acc.length === 1 && h("div", { class: "field" }, h("div", { class: "label" }, "계정"), h("div", { class: "accounts" }, h("span", { class: "chip", "aria-pressed": "true" }, `@${acc[0].username || acc[0].threads_user_id}`))),

    h("div", { class: "field" },
      h("label", { class: "label", for: "body" }, "본문", h("span", { id: "body-count", class: `count${n > MAX_LEN ? " over" : ""}` }, `${n}/${MAX_LEN}`)),
      bodyBox),

    h("div", { class: "field" },
      threadRows,
      h("button", { class: "add", onclick: () => { S.thread.push(""); saveDraft(); render(); setTimeout(() => { const all = document.querySelectorAll("textarea.thread"); all[all.length - 1]?.focus(); }); } }, "+ 타래 추가")),

    h("div", { class: "field" },
      h("div", { class: "label" }, "사진", h("span", { class: "count" }, `${S.photos.length}/${MAX_IMAGES}`)),
      h("div", { class: "photos" },
        S.photos.map((p, i) => h("div", { class: "photo" }, h("img", { src: p.url, alt: `사진 ${i + 1}` }),
          h("button", { "aria-label": `사진 ${i + 1} 빼기`, onclick: () => { URL.revokeObjectURL(p.url); S.photos.splice(i, 1); render(); } }, "✕"))),
        S.photos.length < MAX_IMAGES && h("label", { class: "photo-add" }, "+ 사진", photoInput))),

    h("div", { class: "field" },
      h("div", { class: "label" }, "올릴 시각"),
      h("div", { class: "when" },
        opt("60-90", "마지막 예약 다음, 60~90분 사이 랜덤", range(60, 90)),
        opt("90-120", "마지막 예약 다음, 90~120분 사이 랜덤", range(90, 120)),
        opt("at", "시각 직접 정하기",
          S.when === "at" && h("input", { type: "datetime-local", "aria-label": "올릴 시각", min: minAt, value: S.at || "", onchange: (e) => { S.at = e.target.value; } })))),

    h("div", { class: "submit-bar" }, h("button", { disabled: S.sending || !S.account, onclick: submit }, S.sending ? "예약하는 중…" : "예약하기")));
}

function itemView(s) {
  const acc = S.accounts.find((a) => a.threads_user_id === s.threads_user_id);
  const who = acc ? `@${acc.username}` : "";
  const label = { scheduled: "예약됨", posting: "올리는 중", posted: "올림", failed: "실패" }[s.status] || s.status;
  const when = s.status === "posted" && s.posted_at ? s.posted_at : s.scheduled_at;
  const thread = (s.thread || []).filter((t) => String(t).trim()).length;
  return h("div", { class: "item" },
    h("div", { class: "head" }, h("span", { class: "time" }, fmt(when)), h("span", { class: "who" }, who), h("span", { class: `badge ${s.status}` }, label)),
    h("p", { class: "text" }, s.body || "(본문 없음)"),
    s.images && s.images.length > 0 && h("div", { class: "thumbs" }, s.images.slice(0, 5).map((u) => h("img", { src: u, alt: "", loading: "lazy" }))),
    s.status === "failed" && s.error && h("div", { class: "err" }, s.error),
    h("div", { class: "meta" },
      thread > 0 && h("span", null, `타래 ${thread}`),
      s.images && s.images.length > 0 && h("span", null, `사진 ${s.images.length}`),
      s.origin === "mobile" && h("span", null, "폰에서 씀"),
      s.status === "scheduled" && h("button", { class: "act cancel", onclick: () => cancel(s) }, "취소"),
      s.status === "posted" && s.permalink && h("a", { class: "act", href: s.permalink, target: "_blank", rel: "noopener" }, "스레드에서 보기")));
}

function listView() {
  const up = S.schedules.filter((s) => s.status === "scheduled" || s.status === "posting");
  const failed = S.schedules.filter((s) => s.status === "failed");
  const posted = S.schedules.filter((s) => s.status === "posted").reverse();
  if (!S.schedules.length)
    return h("div", null, h("div", { class: "empty" }, h("b", null, "걸어 둔 예약이 없어요"), "[글 쓰기]에서 새 글을 예약해 보세요."), listNote());
  return h("div", null,
    up.length > 0 && [h("div", { class: "sec" }, `올라갈 글 ${up.length}`), up.map(itemView)],
    failed.length > 0 && [h("div", { class: "sec" }, `못 올린 글 ${failed.length}`), failed.map(itemView)],
    posted.length > 0 && [h("div", { class: "sec" }, "최근 올린 글"), posted.map(itemView)],
    listNote());
}
const listNote = () => h("p", { class: "note" }, "OTTOV 서버에 맡긴 예약만 보여요. 올린 글은 PC OTTOV가 결과를 받아 가면 여기서 빠져요.");

function render() {
  const root = document.getElementById("app");
  const active = document.activeElement;
  const keepFocus = active && active.tagName === "TEXTAREA" ? { id: active.id, label: active.getAttribute("aria-label"), pos: active.selectionStart } : null;
  root.replaceChildren(S.token ? mainView() : pairView());
  if (keepFocus) {
    const el = keepFocus.id ? document.getElementById(keepFocus.id) : document.querySelector(`textarea[aria-label="${keepFocus.label}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(keepFocus.pos, keepFocus.pos); } catch {} }
  }
}

function mainView() {
  const up = S.schedules.filter((s) => s.status === "scheduled" || s.status === "posting").length;
  const tab = (id, text, extra) => h("button", { role: "tab", "aria-selected": String(S.tab === id), onclick: () => { S.tab = id; render(); if (id === "list") load(true); } }, text, extra);
  return h("div", { class: "wrap" },
    h("div", { class: "top" },
      h("img", { src: "icon-192.png", alt: "" }),
      h("h1", null, "OTTOV 예약"),
      h("button", { class: "icon-btn", "aria-label": "새로고침", "aria-busy": String(S.loading), onclick: () => load() }, h("span", null, "↻"))),
    installHint(),
    h("div", { class: "tabs", role: "tablist" }, tab("write", "글 쓰기"), tab("list", "예약 목록", up > 0 && h("span", { class: "n" }, up))),
    !S.loaded ? h("div", { class: "empty" }, S.loading ? "불러오는 중…" : "") : S.tab === "write" ? writeView() : listView(),
    S.tab === "list" && h("div", { class: "foot" }, h("button", { onclick: forget }, "이 폰 연결 끊기")));
}

// ── 시작 ──
// 이미 열린 화면에서 연결 주소를 다시 열었을 때 (주소 뒤 #pair= 만 바뀜)
window.addEventListener("hashchange", async () => {
  if (!/pair=/.test(location.hash)) return;
  await claimFromHash();
  render();
  load();
});
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; render(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(true); });
setInterval(() => { if (document.visibilityState === "visible" && S.tab === "list") load(true); }, 60000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  render();
  await claimFromHash();
  render();
  load();
})();
