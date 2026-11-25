// OTTOV 폰 웹앱 — 재업로드 'AI로 살짝 바꾸기'
// PC OTTOV와 같은 지시문·같은 숫자/재료 지키기 규칙 (web/src/lib/reupload-prompt.ts, recipe-guard.ts, reupload-client.ts 를 옮긴 것).
// PC에서 고치면 여기도 같이 고친다.
// AI 키는 이 폰(localStorage)에만 저장하고, AI 회사에만 보낸다. OTTOV 서버로는 보내지 않는다.
"use strict";

(function () {
  const KEY = "ottov-m-ai";
  const DEFAULT_MODELS = { gemini: "gemini-2.5-flash", openai: "gpt-5-mini", anthropic: "claude-sonnet-5-5" };
  const GEMINI_FALLBACKS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-flash-lite-latest"];

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && s.provider) return { provider: s.provider, apiKey: s.apiKey || "", model: s.model || DEFAULT_MODELS[s.provider] || "" };
    } catch {}
    return { provider: "gemini", apiKey: "", model: DEFAULT_MODELS.gemini };
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  }

  // ── 레시피·숫자 지키기 (recipe-guard.ts) ──
  const UNITS = [
    "kg", "g", "mg", "ml", "mL", "L", "l", "cc", "oz", "lb",
    "큰술", "작은술", "숟가락", "밥숟가락", "티스푼", "테이블스푼", "스푼", "T", "t", "Ts", "ts",
    "컵", "종이컵", "국자", "줌", "꼬집", "방울", "알", "개", "쪽", "톨", "장", "대", "뿌리", "포기", "통", "마리", "모",
    "봉", "봉지", "팩", "캔", "병", "인분", "근", "덩이", "조각", "줄", "공기", "그릇",
    "분", "초", "시간", "도", "℃", "%", "cm", "mm", "원", "만원",
  ];
  const NUM = String.raw`(?:\d+(?:[.,/]\d+)?(?:\s*[~-]\s*\d+(?:[.,/]\d+)?)?|[½⅓⅔¼¾]|반|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)`;
  const unitRe = UNITS.slice().sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\%]/g, "\\$&")).join("|");
  const NOT_AMOUNT = String.raw`(?!\s*(?:요약|정리|평|후기|댓글|리뷰))`;
  const QTY = new RegExp(`${NUM}\\s*(?:${unitRe})(?![가-힣a-zA-Z])${NOT_AMOUNT}`, "g");
  const quantities = (text) => (text.match(QTY) || []).map((q) => q.replace(/\s+/g, "").replace(/,/g, "."));
  const isRecipeLike = (text) => /재료|만드는\s*법|레시피|양념|🛒|👩‍🍳|황금\s*비율/.test(text) || quantities(text).length >= 3;
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  function quantityDiff(orig, next) {
    const a = count(quantities(orig));
    const b = count(quantities(next));
    const missing = [];
    const added = [];
    a.forEach((n, k) => { for (let i = b.get(k) || 0; i < n; i++) missing.push(k); });
    b.forEach((n, k) => { for (let i = a.get(k) || 0; i < n; i++) added.push(k); });
    return { missing, added, same: !missing.length && !added.length };
  }
  const VAGUE = "약간|조금|적당량|적당히|넉넉히|취향껏|한꼬집|소량";
  const NOT_FOOD_UNITS = new Set(["분", "초", "시간", "도", "℃", "%", "cm", "mm", "원", "만원"]);
  const NAME_RE = new RegExp(`([가-힣A-Za-z]{1,15})\\s*[:：]?\\s*(?:(${NUM}\\s*(?:${unitRe}))(?![가-힣a-zA-Z])${NOT_AMOUNT}|(?:${VAGUE}))`, "g");
  const PARTICLE = /(으로|하고|에서|랑|은|는|이|가|을|를|도|만|와|과)$/;
  const STOP = new Set(["약", "총", "각", "더", "또", "한", "딱", "그냥", "대략", "정도", "넣고", "넣어", "넣기"]);
  function ingredientNames(text) {
    const out = new Set();
    for (const m of text.matchAll(NAME_RE)) {
      const unit = m[2] && m[2].replace(/^[\d\s.,/~½⅓⅔¼¾-]+|^(반|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*/, "");
      if (unit && NOT_FOOD_UNITS.has(unit)) continue;
      let w = m[1];
      if (w.length >= 3) w = w.replace(PARTICLE, "");
      if (w.length && !STOP.has(w)) out.add(w);
    }
    return [...out];
  }
  function recipeSame(orig, next) {
    const q = quantityDiff(orig, next);
    const flat = (s) => s.replace(/\s+/g, "");
    const o = flat(orig);
    const n = flat(next);
    return q.same && !ingredientNames(orig).some((w) => !n.includes(w)) && !ingredientNames(next).some((w) => !o.includes(w));
  }
  const LAYOUTS = {
    lines: "재료를 한 줄에 하나씩 세로로 적는 목록",
    slash: '재료를 한두 줄에 " / "로 이어 붙여 쓰기 (예: 감자 2개 / 햄 50g / 쪽파 3대)',
    group: '재료를 성격별로 묶어서 쓰기 (예: "주재료: 감자 2개, 햄 50g" / "반죽: 부침가루 3T, 계란 1개" / "간: 소금·후추 약간")',
    emoji: "재료마다 그 재료에 어울리는 이모지를 앞에 붙여 쓰기 (예: 🥔 감자 2개)",
    talk: '재료를 목록이 아니라 말하듯 문장으로 풀어 쓰기 (예: "감자 2개에 햄 50g, 쪽파 3대만 있으면 돼")',
  };
  const HEADERS = ["🛒 준비물", "장보기 리스트", "이것만 있으면 돼", "필요한 거", "재료 체크", "📝 준비할 것"];
  function detectLayout(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const qtyLines = lines.filter((l) => quantities(l).length > 0 || new RegExp(VAGUE).test(l));
    if (qtyLines.some((l) => /\s\/\s|\s\|\s/.test(l) && quantities(l).length >= 2)) return "slash";
    if (qtyLines.filter((l) => /^[^\w가-힣\s*\-•·]/u.test(l)).length >= 3) return "emoji";
    if (qtyLines.filter((l) => /^[가-힣\s]{1,6}\s*[:：]/.test(l) && quantities(l).length >= 2).length >= 2) return "group";
    if (qtyLines.filter((l) => quantities(l).length <= 1 && l.length <= 20).length >= 3) return "lines";
    return "talk";
  }
  function recipeLayoutRule(orig) {
    const now = detectLayout(orig);
    const pick = Object.keys(LAYOUTS).filter((k) => k !== now);
    const to = pick[Math.floor(Math.random() * pick.length)];
    const head = HEADERS[Math.floor(Math.random() * HEADERS.length)];
    return `레시피 칸의 재료 나열 구도는 원문과 다르게 쓴다. 원문은 "${LAYOUTS[now]}" 모양이니 이번에는 "${LAYOUTS[to]}" 모양으로 쓴다. 재료 칸 제목도 원문과 다른 말로 바꾼다 (예: "${head}"). 재료 순서는 바꿔도 되지만, 재료 이름과 분량·단위는 하나도 빼거나 바꾸지 않는다. 만드는 법도 원문 문장을 그대로 옮기지 말고 다른 말투·다른 번호 모양으로 쓴다.`;
  }
  const digitAmounts = (text) => quantities(text).filter((q) => /^\d/.test(q));
  function guardRewrite(orig, next) {
    if (!orig.trim()) return { text: next, kept: "" };
    if (isRecipeLike(orig)) return recipeSame(orig, next) ? { text: next, kept: "" } : { text: orig, kept: "recipe" };
    const a = digitAmounts(orig).sort().join("|");
    const b = digitAmounts(next).sort().join("|");
    return a === b ? { text: next, kept: "" } : { text: orig, kept: "amount" };
  }

  // ── 지시문 (reupload-prompt.ts) ──
  const SYSTEM = `너는 한국 스레드(Threads) 글을 다시 올릴 수 있게 살짝 고쳐 쓰는 작가다.
글쓴이가 예전에 직접 올려서 반응이 좋았던 글을, 같은 글로 보이지 않을 만큼만 표현을 바꿔 다시 쓴다.

규칙:
- 내용·정보·순서·흐름은 그대로 둔다. 새 정보나 과장을 더하지 않는다.
- 줄 수와 줄바꿈 모양, 글 길이(±10%)를 원문과 비슷하게 맞춘다. (레시피 칸은 예외: 나열 모양을 바꾼다)
- 첫 줄(후킹 문장)은 같은 뜻으로 표현을 바꾼다.
- 나머지 줄은 절반쯤만 단어·어순·어미를 바꾼다. 말투(반말/존댓말), ㅋㅋ·ㅠㅠ·이모지 같은 버릇은 그대로 살린다.
- 숫자, 가격, 제품·브랜드 이름, 링크(URL), "프로필링크 N번" 같은 안내, "쿠팡 파트너스 활동…" 고지 문구는 한 글자도 바꾸지 않는다.
- 레시피(재료 목록·계량·만드는 법)가 들어 있는 칸은 재료 나열 모양과 문장을 원문과 다르게 새로 쓴다 ([레시피 칸 쓰는 법]을 따른다). 단, 들어가는 재료 이름과 분량·단위(2개, 50g, 3T 등)는 원문과 똑같이 쓴다. 재료를 바꾸거나(예: 햄→베이컨) 빼거나 더하지 않는다.
- 본문과 타래 각각 500자를 넘기지 않는다.
- 타래 개수는 원문과 똑같이 맞춘다. 타래도 같은 방식으로 살짝 바꾼다.

반드시 아래 JSON 하나로만 답한다. 다른 말은 쓰지 않는다.
{"body": "바꾼 본문", "thread": ["바꾼 타래 1", "바꾼 타래 2"]}`;

  function userPrompt(text, thread) {
    const t = thread.filter((x) => x.trim());
    const recipe = [{ name: "본문", x: text }, ...t.map((x, i) => ({ name: `타래 ${i + 1}`, x }))]
      .filter((p) => isRecipeLike(p.x) && quantities(p.x).length >= 2)
      .map((p) => `- ${p.name}: ${recipeLayoutRule(p.x)}`);
    return [
      `[원문 본문]\n${text}`,
      t.length ? `[원문 타래 ${t.length}개]\n${t.map((x, i) => `(${i + 1}) ${x}`).join("\n\n")}` : "[원문 타래 없음] thread는 빈 배열로.",
      recipe.length ? `[레시피 칸 쓰는 법]\n${recipe.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  // ── AI 부르기 (llm.ts) ──
  async function errorText(res) {
    const t = await res.text();
    try { return (JSON.parse(t).error || {}).message || t; } catch { return t; }
  }
  async function post(url, headers, body, ms = 120000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new Error(e && e.name === "AbortError" ? "AI 답이 너무 오래 걸려요. 다시 눌러 주세요." : "인터넷 연결을 확인하고 다시 눌러 주세요.");
    } finally {
      clearTimeout(timer);
    }
  }
  async function gemini(system, user, s) {
    const models = [...new Set([s.model || DEFAULT_MODELS.gemini, ...GEMINI_FALLBACKS])];
    let last = "";
    for (const model of models) {
      const res = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": s.apiKey }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.9, responseMimeType: "application/json", maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: model.includes("lite") ? 0 : 1024 } },
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const c = (j.candidates || [])[0];
        const text = ((c && c.content && c.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (c && c.finishReason === "MAX_TOKENS") throw new Error("AI 답이 너무 길어져서 끊겼어요. 다시 한 번 눌러 주세요.");
        if (text.trim()) return text;
        last = j.promptFeedback && j.promptFeedback.blockReason ? "Gemini가 이 글은 답할 수 없대요." : "Gemini 답이 비어 있어요.";
        continue;
      }
      const msg = await errorText(res);
      if (res.status === 400 && /API key|API_KEY/i.test(msg)) throw new Error("Gemini 키가 틀렸어요. [AI 키]에서 다시 확인해 주세요.");
      if (res.status === 400 && /thinking/i.test(msg)) { last = `모델(${model})이 생각 길이 설정을 받지 않아요.`; continue; }
      if (res.status === 403 && /free tier/i.test(msg)) throw new Error("이 Gemini 키의 프로젝트에 결제가 연결돼 있지 않아요. AI Studio에서 결제를 연결해 주세요.");
      if (res.status === 403) throw new Error("이 Gemini 키로는 쓸 수 없어요. AI Studio에서 키를 새로 만들어 주세요.");
      if (res.status === 429) { last = "Gemini 사용 한도에 걸렸어요. 1분 뒤 다시 눌러 보고, 계속 그러면 AI Studio에서 잔액을 확인해 주세요."; continue; }
      if (res.status === 404) { last = `모델(${model})을 못 찾았어요.`; continue; }
      if (res.status >= 500) { last = "Gemini 서버가 잠시 바빠요. 조금 뒤에 다시 눌러 주세요."; continue; }
      throw new Error(`Gemini 오류: ${msg}`);
    }
    throw new Error(last || "Gemini에서 답을 받지 못했어요.");
  }
  async function complete(system, user, s = load()) {
    if (!s.apiKey) throw new Error("AI 키를 먼저 넣어 주세요.");
    if (s.provider === "gemini") return gemini(system, user, s);
    if (s.provider === "anthropic") {
      const res = await post("https://api.anthropic.com/v1/messages", {
        "x-api-key": s.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
      }, { model: s.model || DEFAULT_MODELS.anthropic, max_tokens: 4000, system, messages: [{ role: "user", content: user }] });
      if (!res.ok) throw new Error(`Claude 오류: ${await errorText(res)}`);
      const j = await res.json();
      return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    }
    const res = await post("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${s.apiKey}` }, {
      model: s.model || DEFAULT_MODELS.openai, messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    if (!res.ok) throw new Error(`OpenAI 오류: ${await errorText(res)}`);
    const j = await res.json();
    return ((j.choices || [])[0] || {}).message?.content || "";
  }

  function escapeControlInStrings(s) {
    let out = "";
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr && c === "\\") { out += c + (s[i + 1] || ""); i++; continue; }
      if (c === '"') inStr = !inStr;
      if (inStr && c === "\n") out += "\\n";
      else if (inStr && c === "\r") continue;
      else if (inStr && c === "\t") out += "\\t";
      else out += c;
    }
    return out;
  }
  function extractJson(text) {
    const fenced = (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1];
    const src = fenced || text;
    const start = src.search(/[[{]/);
    const end = Math.max(src.lastIndexOf("}"), src.lastIndexOf("]"));
    if (start < 0 || end < start) throw new Error("AI 답을 읽지 못했어요. 다시 눌러 주세요.");
    const raw = src.slice(start, end + 1);
    try { return JSON.parse(raw); } catch { return JSON.parse(escapeControlInStrings(raw)); }
  }

  async function guardOrRetry(orig, next) {
    const g = guardRewrite(orig, next);
    if (!g.kept) return g;
    try {
      const keepList = (isRecipeLike(orig) ? quantities(orig) : digitAmounts(orig)).join(", ");
      const r = extractJson(await complete(
        `${SYSTEM.split("반드시 아래 JSON")[0]}이번에는 한 칸만 바꿔 쓴다. 반드시 JSON {"text": "바꾼 글"} 하나로만 답한다.`,
        `[원문]\n${orig}\n\n[꼭 그대로 둘 숫자·분량] ${keepList || "없음"} — 숫자 표기(아라비아 숫자/한글)도 원문과 똑같이 쓴다.${isRecipeLike(orig) ? "\n재료 이름도 하나도 바꾸거나 빼지 않는다." : ""}`,
      ));
      const t = String(r.text || "").trim();
      if (t) {
        const g2 = guardRewrite(orig, t);
        if (!g2.kept) return g2;
      }
    } catch {}
    return g;
  }

  /** 본문·타래를 살짝 바꾼다 (remixReupload). maxLen 을 넘는 칸은 원래 글로 */
  async function remix(text, thread, tlen, maxLen) {
    const want = thread.filter((t) => t.trim());
    const r = extractJson(await complete(SYSTEM, userPrompt(text, want)));
    const raw = String(r.body || "").trim();
    if (!raw) throw new Error("AI 답이 비어 있어요. 다시 눌러 주세요.");
    let nt = Array.isArray(r.thread) ? r.thread.map((t) => String(t).trim()).filter(Boolean) : [];
    if (nt.length < want.length) nt = [...nt, ...want.slice(nt.length)];
    nt = nt.slice(0, want.length || nt.length);
    const kept = [];
    const b = await guardOrRetry(text, raw);
    if (b.kept) kept.push("본문");
    const out = [];
    for (let i = 0; i < nt.length; i++) {
      const g = await guardOrRetry(want[i] || "", nt[i]);
      if (g.kept) kept.push(`타래 ${i + 1}`);
      out.push(tlen(g.text) > maxLen ? want[i] || g.text.slice(0, maxLen) : g.text);
    }
    return { body: tlen(b.text) > maxLen ? text.trim() : b.text, thread: out, kept };
  }

  window.OttovAI = { load, save, remix, DEFAULT_MODELS, has: () => !!load().apiKey };
})();
