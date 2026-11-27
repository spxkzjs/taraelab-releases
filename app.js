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
  // 수집
  collects: [], // 폰에서 보낸 링크 { code, url, kind, status, preview, error }
  collection: [], // PC 수집함 최근 글 요약
  collectOk: true, // 서버에 수집 기능이 준비됐는지
  link: "",
  kind: store.get("ottov-m-kind") === "body" ? "body" : "thread",
  collecting: false,
  q: "",
  // 재업로드
  reItems: [], // PC 재업로드 목록 (서버에 맞춰 둔 것)
  reOk: true, // 서버에 재업로드 기능이 준비됐는지
  reTab: "todo",
  reBusy: {}, // rid → { step, err }
  reEdit: null, // [고쳐서 올리기]로 글 쓰기 칸에 채운 재업로드 { rid, username, views, text, thread }
  aiOpen: false,
  aiBusy: false,
  openItems: new Set(), // 예약 목록에서 펼쳐 본 글

  installEvt: null,
  installHidden: store.get("ottov-m-install-hidden") === "1",
};
try {
  const d = JSON.parse(store.get(DRAFT_KEY) || "{}");
  S.body = d.body || "";
  S.thread = Array.isArray(d.thread) ? d.thread : [];
  S.when = d.when === "90-120" || d.when === "at" ? d.when : "60-90";
  S.account = d.account || "";
  // 재업로드를 고치던 중이면 그 글과 서버에 있는 사진(주소)도 이어서
  if (d.reEdit && d.reEdit.rid) {
    S.reEdit = d.reEdit;
    S.photos = (Array.isArray(d.rePhotos) ? d.rePhotos : []).filter((p) => p && p.path && p.url);
  }
} catch {}
const saveDraft = () => store.set(DRAFT_KEY, JSON.stringify({
  body: S.body, thread: S.thread, when: S.when, account: S.account,
  reEdit: S.reEdit, rePhotos: S.reEdit ? S.photos.filter((p) => p.path).map((p) => ({ url: p.url, path: p.path })) : [],
}));

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
    const [j] = await Promise.all([api("m-state"), loadCollect(), loadReupload()]);
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

// ── 재업로드 ──
async function loadReupload() {
  if (!S.token) return;
  try {
    const j = await api("m-reupload-state");
    S.reItems = j.items || [];
    S.reOk = true;
  } catch {
    S.reOk = false; // 서버에 아직 재업로드 기능이 없음 (다른 기능은 그대로)
  }
}

/** 이 글을 올릴 계정: 원래 올렸던 계정이 있으면 그 계정, 없으면 지금 고른 계정 */
const reAccount = (r) => (S.accounts.some((a) => a.threads_user_id === r.threads_user_id) ? r.threads_user_id : S.account);

function reStep(rid, v) {
  if (v) S.reBusy[rid] = v;
  else delete S.reBusy[rid];
  render();
}

/**
 * [✨ AI로 바꾸기]: 글 쓰기 칸에 원래 글·사진을 채우고 AI로 살짝 바꿔 둔다. 예약은 하지 않는다
 * (읽어 보고 고친 뒤 올릴 시각을 골라 [재업로드 예약하기]를 직접 누른다)
 */
async function aiReupload(r) {
  if (!window.OttovAI.has()) {
    S.aiOpen = true;
    render();
    return toast("AI 키를 먼저 넣어 주세요. 위 [AI 키] 칸에 넣으면 돼요.", true);
  }
  if (r.wait > 0) toast(`사진 ${r.wait}장은 PC가 아직 올리는 중이에요. 지금 있는 사진만 채웠어요.`);
  if (!editReupload(r)) return;
  await remixInEditor();
}

/** [고쳐서 올리기]: 글 쓰기 칸에 원래 글·사진을 채운다. 예약하면 이 재업로드가 '완료'로 옮겨진다. 채웠으면 true */
function editReupload(r) {
  const busy = S.body.trim() || S.thread.some((t) => t.trim()) || S.photos.length;
  if (busy && !S.reEdit && !confirm("글 쓰기 칸에 쓰던 글이 있어요. 이 재업로드 글로 바꿀까요?")) return false;
  S.photos.forEach((p) => { if (!p.path) URL.revokeObjectURL(p.url); });
  S.reEdit = { rid: r.rid, username: r.username, views: r.views, text: r.text || "", thread: (r.thread || []).filter((t) => String(t).trim()) };
  S.body = r.text || "";
  S.thread = S.reEdit.thread.slice();
  S.photos = r.images.map((i) => ({ url: i.url, path: i.path }));
  const uid = reAccount(r);
  if (uid) S.account = uid;
  S.tab = "write";
  saveDraft();
  render();
  scrollTo(0, 0);
  return true;
}

function stopReEdit() {
  S.reEdit = null;
  S.body = "";
  S.thread = [];
  S.photos.forEach((p) => { if (!p.path) URL.revokeObjectURL(p.url); });
  S.photos = [];
  saveDraft();
  render();
}

/** 글 쓰기 칸의 재업로드 글을 AI로 살짝 바꾼다 (원래 글 기준) */
async function remixInEditor() {
  if (!window.OttovAI.has()) {
    S.tab = "reupload";
    S.aiOpen = true;
    render();
    return toast("AI 키를 먼저 넣어 주세요.", true);
  }
  if (S.aiBusy || !S.reEdit) return;
  S.aiBusy = true;
  render();
  try {
    const ai = await window.OttovAI.remix(S.reEdit.text, S.reEdit.thread, tlen, MAX_LEN);
    S.body = ai.body;
    S.thread = ai.thread.slice();
    saveDraft();
    toast(ai.kept.length ? `바꿨어요. (${ai.kept.join(", ")}은 숫자·재료를 지키려고 원래 글로 뒀어요)` : "AI가 살짝 바꿨어요. 읽어 보고 예약해 주세요.");
  } catch (e) {
    toast(e.message, true);
  }
  S.aiBusy = false;
  render();
}

// ── 수집 ──
async function loadCollect() {
  if (!S.token) return;
  try {
    const j = await api("m-collect-state");
    S.collects = j.collects || [];
    S.collection = j.collection || [];
    S.collectOk = true;
  } catch {
    S.collectOk = false; // 서버에 아직 수집 기능이 없음 (예약은 그대로 쓸 수 있게 조용히)
  }
}

/**
 * 붙여넣은 글(공유 문구 포함)에서 스레드 주소만 꺼낸다.
 * 보통 글 주소(@아이디/post/코드)가 먼저, 없으면 모양이 다른 스레드 주소(짧은 공유 링크 등)도 받는다 → 서버가 열어서 진짜 글을 찾는다.
 */
function findLink(s) {
  const t = String(s || "");
  const post = t.match(/https?:\/\/(?:www\.)?threads\.(?:com|net)\/(?:@[A-Za-z0-9._]+\/post|t)\/[A-Za-z0-9_-]{5,}[^\s]*/i);
  if (post) return post[0];
  const any = t.match(/https?:\/\/(?:[a-z0-9-]+\.)*threads\.(?:com|net)\/[^\s"'<>]+/i);
  return any ? any[0] : "";
}

async function collect(raw) {
  const url = findLink(raw != null ? raw : S.link);
  if (!url) {
    const got = String(raw != null ? raw : S.link).trim().slice(0, 60);
    return toast(got ? `스레드 주소가 아니에요. (넣은 내용: ${got})` : "스레드 글 링크를 붙여넣어 주세요.", true);
  }
  if (S.collecting) return;
  S.collecting = true;
  render();
  try {
    const r = await api("m-collect", { url, kind: S.kind });
    S.link = "";
    toast(
      r.again ? "이미 수집한 링크예요."
        : r.status === "ready" ? (r.inCollection ? "다시 수집했어요! 숫자·본문을 새로 받았어요." : "수집했어요!")
        : "보냈어요. 서버가 이 글을 바로 못 읽어서, PC 오또브를 켜면 수집돼요.",
    );
    await loadCollect();
  } catch (e) {
    toast(e.message, true);
  }
  S.collecting = false;
  render();
}

async function pasteLink() {
  try {
    const t = await navigator.clipboard.readText();
    const url = findLink(t);
    if (!url) return toast("복사한 내용에 스레드 글 링크가 없어요.", true);
    collect(url); // 붙여넣으면 바로 수집
  } catch {
    toast("붙여넣기를 허락하지 않았어요. 입력칸을 길게 눌러 붙여넣어 주세요.", true);
  }
}

async function removeCollect(c) {
  try {
    await api("m-collect-del", { code: c.code });
  } catch {}
  await loadCollect();
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
    const fresh = S.photos.filter((p) => !p.path).length;
    let n = 0;
    for (const p of S.photos) {
      // 재업로드 사진(서버에 이미 있음)은 그대로, 새로 고른 사진만 올린다
      if (p.path) {
        images.push(p.path);
        continue;
      }
      setSubmitText(`사진 올리는 중… (${++n}/${fresh})`);
      images.push((await api("m-upload", { mimeType: "image/jpeg", data: p.data })).path);
    }
    setSubmitText("예약하는 중…");
    const re = S.reEdit;
    const r = await api(re ? "m-reupload" : "m-create", {
      ...(re ? { rid: re.rid } : {}),
      threads_user_id: S.account,
      body: S.body,
      thread: S.thread.filter((t) => t.trim()),
      images,
      ...(S.when === "at" ? { scheduled_at: new Date(S.at).toISOString() } : { gap: S.when }),
    });
    S.photos.forEach((x) => { if (!x.path) URL.revokeObjectURL(x.url); });
    S.body = "";
    S.thread = [];
    S.photos = [];
    S.at = "";
    S.reEdit = null;
    saveDraft();
    S.tab = "list";
    toast(`${fmt(r.scheduled_at)}에 올라가게 예약했어요.${re ? " 재업로드 완료로 옮겼어요." : ""}`);
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

  const re = S.reEdit;
  return h("div", null,
    re && h("div", { class: "re-banner" },
      h("div", { class: "re-head" },
        h("b", null, "♻️ 재업로드"),
        h("span", null, `@${re.username || "?"}${re.views != null ? ` · 조회 ${nfmt(re.views)}` : ""}`)),
      h("p", null, "원래 글을 채워 뒀어요. 고쳐서 예약하면 PC [재업로드 완료]로 옮겨져요."),
      h("div", { class: "re-acts" },
        h("button", { class: "ai", disabled: S.aiBusy, onclick: remixInEditor }, S.aiBusy ? "AI가 바꾸는 중…" : "✨ AI로 살짝 바꾸기"),
        h("button", { class: "stop", onclick: () => confirm("재업로드 글 쓰기를 그만둘까요? 채운 글이 지워져요.") && stopReEdit() }, "그만두기"))),
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
          h("button", { "aria-label": `사진 ${i + 1} 빼기`, onclick: () => { if (!p.path) URL.revokeObjectURL(p.url); S.photos.splice(i, 1); saveDraft(); render(); } }, "✕"))),
        S.photos.length < MAX_IMAGES && h("label", { class: "photo-add" }, "+ 사진", photoInput))),

    h("div", { class: "field" },
      h("div", { class: "label" }, "올릴 시각"),
      h("div", { class: "when" },
        opt("60-90", "마지막 예약 다음, 60~90분 사이 랜덤", range(60, 90)),
        opt("90-120", "마지막 예약 다음, 90~120분 사이 랜덤", range(90, 120)),
        opt("at", "시각 직접 정하기",
          S.when === "at" && h("input", { type: "datetime-local", "aria-label": "올릴 시각", min: minAt, value: S.at || "", onchange: (e) => { S.at = e.target.value; } })))),

    h("div", { class: "submit-bar" }, h("button", { disabled: S.sending || !S.account || S.aiBusy, onclick: submit }, S.sending ? "예약하는 중…" : re ? "재업로드 예약하기" : "예약하기")));
}

function itemView(s) {
  const acc = S.accounts.find((a) => a.threads_user_id === s.threads_user_id);
  const who = acc ? `@${acc.username}` : "";
  const label = { scheduled: "예약됨", posting: "올리는 중", posted: "올림", failed: "실패", missed: "놓친 예약" }[s.status] || s.status;
  const pcOnly = s.origin === "mirror"; // PC 오또브가 직접 올리는 예약 (서버는 보여 주기만)
  const canCancel = s.status === "scheduled" || (pcOnly && (s.status === "failed" || s.status === "missed"));
  const when = s.status === "posted" && s.posted_at ? s.posted_at : s.scheduled_at;
  const threads = (s.thread || []).filter((t) => String(t).trim());
  const thread = threads.length;
  // 글을 누르면 펼쳐서 본문 전체·타래·사진을 크게 본다
  const open = S.openItems.has(s.local_id);
  const toggle = () => {
    if (open) S.openItems.delete(s.local_id);
    else S.openItems.add(s.local_id);
    render();
  };
  return h("div", { class: `item${open ? " open" : ""}` },
    h("div", { class: "head" }, h("span", { class: "time" }, fmt(when)), h("span", { class: "who" }, who), h("span", { class: `badge ${s.status}` }, label)),
    h("button", { class: "item-body", "aria-expanded": String(open), onclick: toggle },
      h("p", { class: `text${open ? " full" : ""}` }, s.body || "(본문 없음)"),
      open && threads.map((t, i) => h("div", { class: "item-thread" }, h("span", { class: "tag" }, `타래 ${i + 1}`), h("p", null, t))),
      h("span", { class: "more" }, open ? "접기 ▴" : thread ? `글 전체·타래 ${thread}개 보기 ▾` : "글 전체 보기 ▾")),
    s.images && s.images.length > 0 && h("div", { class: open ? "photos-big" : "thumbs" }, (open ? s.images : s.images.slice(0, 5)).map((u) => h("img", { src: u, alt: "", loading: "lazy" }))),
    (s.status === "failed" || s.status === "missed") && s.error && h("div", { class: "err" }, s.error),
    pcOnly && s.status === "scheduled" && h("div", { class: "pcnote" }, "PC 오또브가 켜져 있어야 올라가요"),
    h("div", { class: "meta" },
      thread > 0 && h("span", null, `타래 ${thread}`),
      s.images && s.images.length > 0 && h("span", null, `사진 ${s.images.length}`),
      s.origin === "mobile" && h("span", null, "폰에서 씀"),
      pcOnly && h("span", null, "💻 PC 예약"),
      canCancel && h("button", { class: "act cancel", onclick: () => cancel(s) }, "취소"),
      s.status === "posted" && s.permalink && h("a", { class: "act", href: s.permalink, target: "_blank", rel: "noopener" }, "스레드에서 보기")));
}

function listView() {
  const up = S.schedules.filter((s) => s.status === "scheduled" || s.status === "posting");
  const failed = S.schedules.filter((s) => s.status === "failed" || s.status === "missed");
  const posted = S.schedules.filter((s) => s.status === "posted").reverse();
  if (!S.schedules.length)
    return h("div", null, h("div", { class: "empty" }, h("b", null, "걸어 둔 예약이 없어요"), "[글 쓰기]에서 새 글을 예약해 보세요."), listNote());
  return h("div", null,
    up.length > 0 && [h("div", { class: "sec" }, `올라갈 글 ${up.length}`), up.map(itemView)],
    failed.length > 0 && [h("div", { class: "sec" }, `못 올린 글 ${failed.length}`), failed.map(itemView)],
    posted.length > 0 && [h("div", { class: "sec" }, "최근 올린 글"), posted.map(itemView)],
    listNote());
}
const listNote = () => h("p", { class: "note" }, "PC에서 건 예약도 여기에 보여요. PC 오또브가 켜져 있으면 1분 안에 맞춰져요. 올린 글은 하루 지나면 목록에서 빠져요.");

// ── 수집 화면 ──
const nfmt = (n) => (n == null ? "" : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}만` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}천` : String(n));

function sentView(c) {
  const p = c.preview || {};
  const label = { pending: "PC 켜면 수집", ready: "수집 완료", saved: "수집함에 저장됨", failed: "실패" }[c.status] || c.status;
  const badge = { pending: "posting", ready: "posted", saved: "posted", failed: "failed" }[c.status] || "";
  return h("div", { class: "item" },
    h("div", { class: "head" },
      h("span", { class: "who strong" }, p.username ? `@${p.username}` : "스레드 글"),
      p.views != null && h("span", { class: "who" }, `조회 ${nfmt(p.views)}`),
      h("span", { class: `badge ${badge}` }, label)),
    p.text ? h("p", { class: "text" }, p.text) : h("p", { class: "text dim" }, c.url),
    c.status === "failed" && c.error && h("div", { class: "err" }, c.error),
    c.status === "pending" && h("div", { class: "pcnote" }, "서버가 이 글을 바로 못 읽었어요. PC 오또브를 켜면 PC가 읽어서 수집해요."),
    h("div", { class: "meta" },
      h("span", null, c.kind === "body" ? "본문만" : "본문+타래"),
      c.status === "failed" && h("button", { class: "act", onclick: () => { S.kind = c.kind === "body" ? "body" : "thread"; collect(c.url); } }, "다시 보내기"),
      h("button", { class: c.status === "failed" ? "act x" : "act", "aria-label": "목록에서 지우기", onclick: () => removeCollect(c) }, "✕")));
}

function boxView(p) {
  const when = p.posted_at ? fmt(p.posted_at) : "";
  return h("div", { class: "item" },
    h("div", { class: "head" },
      h("span", { class: "who strong" }, `@${p.username || "?"}`),
      when && h("span", { class: "who" }, when),
      p.views != null && h("span", { class: "views" }, `조회 ${nfmt(p.views)}`)),
    h("p", { class: "text" }, p.text || "(본문 없음)"),
    h("div", { class: "meta" },
      h("span", null, `♥ ${nfmt(p.likes || 0)}`),
      h("span", null, `댓글 ${nfmt(p.replies || 0)}`),
      p.ready && h("span", { class: "new" }, "새로 수집 · PC 켜면 PC에도"),
      p.url && h("a", { class: "act", href: p.url, target: "_blank", rel: "noopener" }, "스레드에서 보기")));
}

function collectView() {
  if (!S.collectOk)
    return h("div", { class: "empty" }, h("b", null, "아직 수집 기능을 쓸 수 없어요"), "OTTOV 서버가 새 버전으로 바뀌면 여기에서 바로 수집할 수 있어요.");

  const linkBox = h("input", {
    id: "link", type: "url", inputmode: "url", autocomplete: "off", placeholder: "스레드 글 링크를 붙여넣어 주세요", value: S.link,
    oninput: (e) => {
      S.link = e.target.value;
      // 칸에 링크를 붙여넣으면 [수집하기]를 누르지 않아도 바로 보낸다
      const url = findLink(S.link);
      const code = url && ((url.match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/) || [])[1] || url);
      if (url && !S.collecting && code !== S.lastAuto) {
        S.lastAuto = code; // 같은 글은 한 번만 자동으로 (다시 보내려면 [수집하기])
        collect(url);
      }
    },
    onkeydown: (e) => { if (e.key === "Enter") collect(); },
  });
  const kindChip = (v, t) =>
    h("button", { class: "chip", "aria-pressed": String(S.kind === v), onclick: () => { S.kind = v; store.set("ottov-m-kind", v); render(); } }, t);

  // 보낸 링크: 아직 수집 못 한 것(PC를 켜야 하는 것)과 실패한 것만
  const pending = S.collects.filter((c) => c.status === "pending" || c.status === "failed");
  // 수집함 = 서버가 바로 수집해 둔 글(PC로 옮기기 전) + PC 수집함
  const inPc = new Set(S.collection.map((p) => p.code));
  const ready = S.collects
    .filter((c) => c.status === "ready" && !inPc.has(c.code))
    .map((c) => ({ ...(c.preview || {}), code: c.code, url: c.url, ready: true }));
  const all = [...ready, ...S.collection];
  const q = S.q.trim().toLowerCase();
  const box = q ? all.filter((p) => `${p.username} ${p.text}`.toLowerCase().includes(q)) : all;

  return h("div", null,
    h("div", { class: "field" },
      h("div", { class: "label" }, "링크로 수집"),
      h("div", { class: "link-row" }, linkBox,
        navigator.clipboard && navigator.clipboard.readText && h("button", { class: "paste", onclick: pasteLink }, "붙여넣기")),
      h("div", { class: "accounts kind" }, kindChip("thread", "본문+타래"), kindChip("body", "본문만")),
      h("button", { class: "go", disabled: S.collecting, onclick: () => collect() }, S.collecting ? "수집하는 중… (몇 초 걸려요)" : "수집하기"),
      h("p", { class: "note" }, "스레드 앱에서 글의 [공유] → [링크 복사] 후, 위 칸에 붙여넣거나 [붙여넣기]를 누르면 바로 수집돼요. PC가 꺼져 있어도 돼요.")),

    pending.length > 0 && [h("div", { class: "sec" }, `기다리는 링크 ${pending.length}`), pending.map(sentView)],

    h("div", { class: "sec" }, `수집함 ${all.length}${S.collection.length >= 300 ? "+ (최근 글만)" : ""}`),
    all.length > 0 && h("input", { id: "q", type: "search", class: "search", placeholder: "작성자·본문 검색", value: S.q, oninput: (e) => { S.q = e.target.value; render(); } }),
    !all.length
      ? h("div", { class: "empty" }, h("b", null, "수집함이 비어 있어요"), "위에 스레드 링크를 붙여넣으면 바로 수집돼요. PC 수집함의 글도 PC 오또브를 한 번 켜면 여기에 보여요.")
      : box.length ? box.map(boxView) : h("div", { class: "empty" }, "검색한 글이 없어요."));
}

// ── 재업로드 화면 ──
const AI_NAMES = { gemini: "Gemini", openai: "ChatGPT", anthropic: "Claude" };

function aiBox() {
  const s = window.OttovAI.load();
  if (s.apiKey && !S.aiOpen)
    return h("div", { class: "ai-box set" },
      h("span", null, `✓ AI 키: ${AI_NAMES[s.provider] || s.provider}`),
      h("button", { onclick: () => { S.aiOpen = true; render(); } }, "바꾸기"));
  // 쓰는 중인 값은 S.aiDraft 에 (화면을 다시 그려도 남게)
  if (!S.aiDraft) S.aiDraft = { provider: s.provider, key: s.apiKey };
  const d = S.aiDraft;
  const provider = d.provider;
  const keyBox = h("input", { id: "ai-key", type: "password", autocomplete: "off", placeholder: "AI API 키를 붙여넣어 주세요", value: d.key, oninput: (e) => { d.key = e.target.value; } });
  const pick = h("select", { "aria-label": "AI 회사", onchange: (e) => { d.provider = e.target.value; render(); } },
    Object.entries(AI_NAMES).map(([v, t]) => h("option", { value: v, selected: v === d.provider }, t)));
  return h("div", { class: "ai-box" },
    h("div", { class: "label" }, "AI 키 (글을 살짝 바꿀 때 써요)"),
    h("div", { class: "ai-row" }, pick, keyBox),
    h("div", { class: "ai-acts" },
      h("button", { class: "save", onclick: () => {
        const apiKey = d.key.trim();
        if (!apiKey) return toast("키를 붙여넣어 주세요.", true);
        window.OttovAI.save({ provider, apiKey, model: provider === s.provider && s.model ? s.model : window.OttovAI.DEFAULT_MODELS[provider] });
        S.aiOpen = false;
        S.aiDraft = null;
        render();
        toast("AI 키를 이 폰에 저장했어요.");
      } }, "저장"),
      s.apiKey && h("button", { onclick: () => { S.aiOpen = false; S.aiDraft = null; render(); } }, "닫기"),
      s.apiKey && h("button", { class: "del", onclick: () => { if (!confirm("이 폰에서 AI 키를 지울까요?")) return; window.OttovAI.save({ provider, apiKey: "", model: "" }); S.aiOpen = false; S.aiDraft = null; render(); } }, "지우기")),
    h("p", { class: "note" }, "PC 오또브 [설정]에 넣은 것과 같은 키를 넣으면 돼요. 키는 이 폰에만 저장되고 OTTOV 서버로는 보내지 않아요."));
}

function ago(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const hrs = Math.floor((Date.now() - t) / 3600000);
  return hrs < 48 ? `${hrs}시간 전` : `${Math.floor(hrs / 24)}일 전`;
}

function reItemView(r) {
  const busy = S.reBusy[r.rid];
  const doing = busy && !busy.err;
  const thread = (r.thread || []).filter((t) => String(t).trim()).length;
  return h("div", { class: "item" },
    h("div", { class: "head" },
      h("span", { class: "who strong" }, `@${r.username || "?"}`),
      r.posted_at && h("span", { class: "who" }, `올린 지 ${ago(r.posted_at)}`),
      r.views != null && h("span", { class: "views" }, `조회 ${nfmt(r.views)}`)),
    r.status === "done" && h("div", { class: "re-when" }, r.scheduled_at ? `📅 ${fmt(r.scheduled_at)}에 올라가게 예약했어요` : r.done_at ? `완료로 옮겼어요 · ${fmt(r.done_at)}` : "완료로 옮겼어요"),
    h("p", { class: "text" }, r.text || "(사진만 있는 글)"),
    r.images && r.images.length > 0 && h("div", { class: "thumbs" }, r.images.slice(0, 5).map((i) => h("img", { src: i.url, alt: "", loading: "lazy" }))),
    r.wait > 0 && h("div", { class: "pcnote" }, `사진 ${r.wait}장은 PC가 아직 올리는 중이에요. 1~2분 뒤 새로고침해 주세요.`),
    busy && h("div", { class: busy.err ? "err" : "re-step" }, busy.step),
    h("div", { class: "meta" },
      h("span", null, `♥ ${nfmt(r.likes || 0)}`),
      thread > 0 && h("span", null, `타래 ${thread}`),
      r.url && h("a", { class: "act x", href: r.url, target: "_blank", rel: "noopener" }, "원본")),
    h("div", { class: "re-btns" },
      // AI로 바꾼 글을 글 쓰기 칸에 채우기만 한다 (예약은 거기서 직접)
      h("button", { class: "go", disabled: doing || S.aiBusy, onclick: () => aiReupload(r) }, S.aiBusy ? "AI가 바꾸는 중…" : "✨ AI로 바꾸기"),
      h("button", { class: "sub", disabled: doing, onclick: () => editReupload(r) }, r.status === "todo" ? "그대로 고쳐서 올리기" : "한 번 더 올리기")));
}

function reuploadView() {
  if (!S.reOk)
    return h("div", { class: "empty" }, h("b", null, "아직 재업로드를 쓸 수 없어요"), "OTTOV 서버가 새 버전으로 바뀌면 여기에서 재업로드할 수 있어요.");
  const todo = S.reItems.filter((r) => r.status === "todo");
  const done = S.reItems.filter((r) => r.status === "done").sort((a, b) => String(b.done_at || "").localeCompare(String(a.done_at || "")));
  const list = S.reTab === "todo" ? todo : done;
  const chip = (v, t) => h("button", { class: "chip", "aria-pressed": String(S.reTab === v), onclick: () => { S.reTab = v; render(); } }, t);
  return h("div", null,
    aiBox(),
    h("div", { class: "accounts re-tabs" }, chip("todo", `재업로드 전 ${todo.length}`), chip("done", `재업로드 완료 ${done.length}`)),
    !list.length
      ? h("div", { class: "empty" },
        h("b", null, S.reTab === "todo" ? "다시 올릴 글이 없어요" : "재업로드한 글이 없어요"),
        S.reTab === "todo" ? "3시간마다 올린 지 24~48시간 된 내 글 중 조회수가 잘 나온 글을 찾아요. PC가 꺼져 있으면 OTTOV 서버가 대신 찾아요." : "재업로드한 글이 여기에 모여요.")
      : list.map(reItemView),
    h("p", { class: "note" }, "[✨ AI로 바꾸기]는 PC와 똑같이 숫자·재료는 그대로 두고 표현만 살짝 바꿔서 [글 쓰기]에 채워 줘요. 읽어 보고 올릴 시각을 골라 [재업로드 예약하기]를 누르면 예약돼요. PC가 꺼져 있어도 올라가요."));
}

// ── 인지작업 (안드로이드 전용): 'OTTOV 인지작업' 앱이 스레드 앱에서 키워드를 검색하고 결과를 훑어 내려 준다 ──
const NINJI_KW = "ottov-m-ninji-kw";
const NINJI_MIN = "ottov-m-ninji-min";
const isAndroid = /Android/i.test(navigator.userAgent);
const ninjiApk = () => new URL("ottov-ninji.apk", location.href).href;
let ninjiInfo = null; // { version, size } (ottov-ninji.json)

function startNinji() {
  const kws = (store.get(NINJI_KW) || "").split(/[,\n，]/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!kws.length) return toast("키워드를 하나 이상 넣어 주세요.", true);
  const min = Number(store.get(NINJI_MIN)) || 5;
  const q = `kw=${encodeURIComponent(kws.join(","))}&min=${min}`;
  // 앱이 있으면 앱이 열리고 바로 시작, 없으면 APK 받기로
  location.href = `intent://start?${q}#Intent;scheme=ottovninji;package=com.ottov.ninji;S.browser_fallback_url=${encodeURIComponent(ninjiApk())};end`;
}

function ninjiView() {
  if (!ninjiInfo) {
    ninjiInfo = {};
    fetch("ottov-ninji.json", { cache: "no-cache" }).then((r) => r.json()).then((j) => { ninjiInfo = j; if (S.tab === "ninji") render(); }).catch(() => {});
  }
  if (!isAndroid)
    return h("div", { class: "empty" }, h("b", null, "안드로이드 폰 전용이에요"),
      "아이폰은 다른 앱을 대신 움직이는 걸 애플이 막아 둬서 인지작업을 자동으로 할 수 없어요.");
  const min = Number(store.get(NINJI_MIN)) || 5;
  const step = (n, t) => h("p", { style: "margin:6px 0 0;font-size:13.5px" }, h("b", null, `${n}. `), t);
  return h("div", null,
    h("div", { class: "field" },
      h("div", { class: "label" }, h("span", null, "검색할 키워드"), h("span", null, "쉼표로 나눠서, 최대 10개")),
      h("textarea", { id: "ninji-kw", "aria-label": "인지작업 키워드", placeholder: "예: 다이소, 살림템, 주방템", value: store.get(NINJI_KW) || "", oninput: (e) => store.set(NINJI_KW, e.target.value) })),
    h("div", { class: "field" },
      h("div", { class: "label" }, h("span", null, "몇 분 동안")),
      h("div", { class: "accounts" }, [3, 5, 10].map((m) =>
        h("button", { class: "chip", "aria-pressed": String(min === m), onclick: () => { store.set(NINJI_MIN, String(m)); render(); } }, `${m}분`)))),
    h("button", { class: "go", onclick: startNinji }, "▶ 인지작업 시작"),
    h("p", { class: "note" }, "스레드 앱이 열리고 키워드를 하나씩 검색해서, 검색 결과를 사람처럼 불규칙하게 내려 보며 훑어봐요. 매번 순서가 바뀌고, 키워드마다 보는 시간·속도도 달라요. 끝나기 전에 앞에서 본 키워드를 한 번 더 찾아보기도 해요. 시간에 비해 키워드가 많으면 그날은 몇 개만 골라서 하나당 40초 이상 봐요(5분이면 3~5개, 10개를 다 보려면 10분 추천). 좋아요·팔로우·댓글은 누르지 않아요. 하는 동안 화면을 켜 두세요. 다른 앱으로 가거나 화면을 끄면 바로 멈춰요."),
    h("div", { class: "item", style: "margin-top:18px" },
      h("div", { class: "head" }, h("span", { class: "who strong" }, "처음 한 번: 앱 설치"),
        ninjiInfo && ninjiInfo.version && h("span", { class: "who" }, `v${ninjiInfo.version} · ${(ninjiInfo.size / 1048576).toFixed(1)}MB`)),
      step(1, "아래 [앱 받기]를 눌러 받은 파일을 열어요. 경고가 뜨거나 설치가 막히면 아래 '🚫 설치가 막힐 때'를 따라 해 주세요."),
      step(2, "'OTTOV 인지작업' 앱을 열고 [① 접근성에서 켜기] → 설치된 앱 → OTTOV 인지작업 → 켜기."),
      step(3, "안 켜지면(안드로이드 13 이상): 설정 → 애플리케이션 → OTTOV 인지작업 → 오른쪽 위 ⋮ → '제한된 설정 허용' 후 다시 켜기."),
      step(4, "여기로 돌아와 [▶ 인지작업 시작]을 누르면 돼요. 앱이 업데이트되면 [앱 받기]로 다시 받아 설치하면 그대로 이어져요."),
      h("a", { class: "go", style: "text-align:center;text-decoration:none", href: ninjiApk(), download: "ottov-ninji.apk" }, "📲 앱 받기 (APK)")),
    ninjiBlocked());
}

/** 설치가 막힐 때 (Play 프로텍트·삼성 자동 차단) */
function ninjiBlocked() {
  const li = (...t) => h("li", { style: "margin-top:6px" }, ...t);
  const box = (title, open, ...kids) => h("details", { class: "item", style: "margin-top:10px", open: open || null },
    h("summary", { style: "font-weight:800;cursor:pointer" }, title), ...kids);
  const ol = (...items) => h("ol", { style: "margin:8px 0 0;padding-left:20px;font-size:13.5px;line-height:1.6" }, ...items);
  const why = (t) => h("p", { class: "note", style: "margin-top:8px" }, t);
  return h("div", { style: "margin-top:18px" },
    h("div", { class: "label" }, h("span", null, "🚫 설치가 막힐 때")),
    why("인지작업 앱은 플레이스토어 밖에서 받는 앱이고, 스레드 앱을 대신 움직이려고 '접근성' 권한을 써요. 그래서 구글이 확인하지 않은 앱으로 보고 경고하거나 막아요. 아래 순서대로 하면 설치돼요. 스레드 앱 말고 다른 앱은 보지 않고, 개인정보도 가져가지 않아요."),

    box("① '앱 설치가 권장되지 않음'이 떠요", true,
      ol(
        li("경고 창 아래쪽의 ", h("b", null, "[자세히]"), " (또는 ˅ 화살표)를 눌러요."),
        li(h("b", null, "[무시하고 설치]"), "를 눌러요."),
        li("그래도 '기기 보호를 위해 앱 차단됨'이 뜨면 아래 ②번으로 가세요."))),

    box("② '기기 보호를 위해 앱 차단됨'이 떠요 ← 가장 많이 막히는 곳", true,
      why("구글 'Play 프로텍트'가 막는 거예요. 설치하는 동안만 잠깐 끄고, 설치가 끝나면 바로 다시 켜요."),
      ol(
        li("차단 창은 ", h("b", null, "[확인]"), "으로 닫아요."),
        li(h("b", null, "Play 스토어"), " 앱을 열어요."),
        li("오른쪽 위 ", h("b", null, "내 프로필 동그라미"), "를 눌러요."),
        li(h("b", null, "[Play 프로텍트]"), "를 눌러요."),
        li("오른쪽 위 ", h("b", null, "⚙ 톱니바퀴(설정)"), "를 눌러요."),
        li(h("b", null, "'Play 프로텍트로 앱 검사'"), "를 꺼요. '사용 중지할까요?'가 나오면 [사용 중지]."),
        li("이 화면(폰 OTTOV → 인지작업)으로 돌아와 ", h("b", null, "[📲 앱 받기]"), "를 다시 눌러 설치해요. (이미 받은 파일이 있으면 '내 파일 → 다운로드'의 ottov-ninji.apk를 눌러도 돼요)"),
        li("설치가 끝나면 Play 스토어 → 프로필 → Play 프로텍트 → ⚙ 에서 ", h("b", null, "'Play 프로텍트로 앱 검사'를 다시 켜요."))),
      why("다시 켠 뒤 '유해한 앱'이라고 알림이 오면 [무시]나 [앱 유지]를 눌러 주세요. [삭제]를 누르면 인지작업 앱이 지워져요."),
      h("p", { style: "margin:14px 0 0;font-weight:800;font-size:14px" }, "😣 껐는데도 '기기 보호를 위해 앱 차단됨'이 또 떠요"),
      ol(
        li(h("b", null, "Play 프로텍트 ⚙ 화면을 다시 열어 꺼졌는지 확인해요."), " 스위치 2개가 있으면 ", h("b", null, "'Play 프로텍트로 앱 검사'"), "와 ", h("b", null, "'유해한 앱 감지 개선'"), "을 둘 다 꺼요."),
        li(h("b", null, "폰을 껐다 켜요."), " 끄기 전에 받은 차단 기록이 남아 있으면 또 막혀요."),
        li(h("b", null, "예전에 받은 파일을 지워요."), " 내 파일 → 다운로드에서 ottov-ninji.apk, ottov-ninji (1).apk 같은 파일을 전부 지워요."),
        li("이 화면에서 ", h("b", null, "[📲 앱 받기]"), "로 새로 받은 뒤, 크롬 알림의 [열기] 대신 ", h("b", null, "내 파일 → 다운로드 → ottov-ninji.apk"), "를 눌러 설치해요."),
        li(h("b", null, "삼성 폰이면 아래 ③번 '자동 차단'도 꺼져 있는지"), " 꼭 확인해요. 둘 중 하나만 켜져 있어도 막혀요."),
        li("다 했는데도 막히면 Play 스토어 앱을 길게 눌러 → 앱 정보 → ", h("b", null, "⋮ → 업데이트 삭제"), " 후 1~4번을 다시 해요. (Play 스토어는 나중에 알아서 다시 업데이트돼요)"))),

    box("③ 삼성 폰: '자동 차단에 의해 차단됨'이 떠요", false,
      why("삼성 갤럭시(One UI 6 이상)의 '자동 차단' 기능이 막는 거예요."),
      ol(
        li(h("b", null, "설정"), " → ", h("b", null, "보안 및 개인정보 보호"), " → ", h("b", null, "자동 차단"), "으로 가요."),
        li(h("b", null, "자동 차단을 꺼요."), " (끌 때 본인 확인을 할 수 있어요)"),
        li("[📲 앱 받기]로 다시 설치해요."),
        li("설치가 끝나면 자동 차단을 다시 켜도 돼요. 이미 깔린 앱은 그대로 써져요."))),

    box("④ '출처를 알 수 없는 앱'이라고 떠요", false,
      ol(
        li("창의 ", h("b", null, "[설정]"), "을 눌러요."),
        li(h("b", null, "'이 출처 허용'"), "(크롬 또는 내 파일)을 켜요."),
        li("뒤로 가기를 누르면 설치 화면으로 돌아와요. [설치]를 눌러요."))),

    box("⑤ 설치는 됐는데 접근성이 안 켜져요 (회색으로 막혀 있어요)", false,
      ol(
        li(h("b", null, "설정"), " → ", h("b", null, "애플리케이션"), " → ", h("b", null, "OTTOV 인지작업"), "을 눌러요."),
        li("오른쪽 위 ", h("b", null, "⋮"), " → ", h("b", null, "'제한된 설정 허용'"), "을 눌러요. (안 보이면 먼저 접근성에서 한 번 켜 보려고 눌러 본 뒤 다시 와요)"),
        li("설정 → ", h("b", null, "접근성"), " → ", h("b", null, "설치된 앱"), " → ", h("b", null, "OTTOV 인지작업"), " → 켜기."))),

    why("그래도 안 되면 막힌 화면을 캡처해서 OTTOV 판매자에게 보내 주세요."));
}

function render() {
  const root = document.getElementById("app");
  const active = document.activeElement;
  const keepFocus = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.id)) ? { id: active.id, label: active.getAttribute("aria-label"), pos: active.selectionStart } : null;
  root.replaceChildren(S.token ? mainView() : pairView());
  if (keepFocus) {
    const el = keepFocus.id ? document.getElementById(keepFocus.id) : document.querySelector(`textarea[aria-label="${keepFocus.label}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(keepFocus.pos, keepFocus.pos); } catch {} }
  }
}

function mainView() {
  const up = S.schedules.filter((s) => s.status === "scheduled" || s.status === "posting").length;
  const waiting = S.collects.filter((c) => c.status === "pending").length;
  const reTodo = S.reItems.filter((r) => r.status === "todo").length;
  const tab = (id, text, extra) => h("button", { role: "tab", "aria-selected": String(S.tab === id), onclick: () => { S.tab = id; render(); if (id !== "write") load(true); } }, text, extra);
  return h("div", { class: "wrap" },
    h("div", { class: "top" },
      h("img", { src: "icon-192.png", alt: "" }),
      h("h1", null, "OTTOV 예약"),
      h("button", { class: "icon-btn", "aria-label": "새로고침", "aria-busy": String(S.loading), onclick: () => load() }, h("span", null, "↻"))),
    installHint(),
    h("div", { class: "tabs", role: "tablist" },
      tab("write", "글 쓰기"),
      tab("list", "예약 목록", up > 0 && h("span", { class: "n" }, up)),
      tab("collect", "수집", waiting > 0 && h("span", { class: "n" }, waiting)),
      tab("reupload", "재업로드", reTodo > 0 && h("span", { class: "n" }, reTodo)),
      tab("ninji", "인지작업")),
    S.tab === "ninji" ? ninjiView()
      : !S.loaded ? h("div", { class: "empty" }, S.loading ? "불러오는 중…" : "")
      : S.tab === "write" ? writeView() : S.tab === "collect" ? collectView() : S.tab === "reupload" ? reuploadView() : listView(),
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
setInterval(() => { if (document.visibilityState === "visible" && (S.tab === "list" || S.tab === "reupload")) load(true); }, 60000);
// 수집: PC로 옮기는 중인 링크가 있으면 15초마다 결과를 확인한다
setInterval(async () => {
  if (document.visibilityState !== "visible" || S.tab !== "collect" || !S.collects.some((c) => c.status === "pending")) return;
  await loadCollect();
  render();
}, 15000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/** 안드로이드: 스레드 앱 [공유] → OTTOV 예약 으로 들어온 링크 (manifest 의 share_target) */
function sharedLink() {
  const q = new URLSearchParams(location.search);
  if (!q.has("shared")) return "";
  history.replaceState(null, "", location.pathname + location.hash);
  return findLink(`${q.get("url") || ""} ${q.get("text") || ""} ${q.get("title") || ""}`) || "-";
}

(async () => {
  const shared = sharedLink();
  if (shared) S.tab = "collect";
  render();
  await claimFromHash();
  render();
  await load();
  if (shared === "-") toast("공유한 내용에 스레드 글 링크가 없어요.", true);
  else if (shared && S.token) collect(shared);
})();
