const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}
let sessionId = store("edge-nav-session");
if (!sessionId) { sessionId = crypto.randomUUID(); store("edge-nav-session", sessionId); }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : res;
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => showTab(btn.dataset.tab)));
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === name));
  store("edge-nav-tab", name);
  if (name === "library") loadLibrary();
  if (name === "crawl") loadCrawls();
}
showTab(store("edge-nav-tab") || "chat");

// ---------- chat ----------
const messages = $("#messages");
function addMsg(role, html, cls = "") {
  messages.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role} ${cls}`;
  el.innerHTML = html;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

function renderReply(el, data) {
  el.classList.remove("pending");
  const sources = (data.sources || [])
    .map((s) => {
      const label = `[${s.n}] ${esc(s.title || s.url || "Untitled")}`;
      const tip = esc(`${s.snippet}…\n\nsimilarity ${s.similarity} · learned weight ${s.weight}`);
      return s.url
        ? `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener" title="${tip}">${label}</a>`
        : `<span class="src" title="${tip}">${label}</span>`;
    })
    .join("");
  el.innerHTML = `${esc(data.model_reply)}
<div class="meta">
  ${sources}
  ${data.memoriesUsed ? `<span title="Reused answers you rated highly">🧠 ${data.memoriesUsed} memory</span>` : ""}
  <button class="vote up" title="Helpful">👍</button>
  <button class="vote down" title="Not helpful">👎</button>
</div>`;
  const [up, down] = el.querySelectorAll(".vote");
  const vote = async (rating, btn, other) => {
    try {
      await api("/api/feedback", { method: "POST", body: JSON.stringify({ messageId: data.messageId, rating }) });
      btn.classList.add("on"); other.classList.remove("on");
    } catch (e) { alert(e.message); }
  };
  up.onclick = () => vote(1, up, down);
  down.onclick = () => vote(-1, down, up);
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  $("#send").disabled = true;
  addMsg("user", esc(text));
  const pending = addMsg("bot", "Thinking at the edge…", "pending");
  try {
    const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text, sessionId }) });
    renderReply(pending, data);
    if ($("#speak").checked) speakText(data.model_reply);
  } catch (e) {
    pending.className = "msg bot error";
    pending.textContent = `Error: ${e.message}`;
  } finally {
    $("#send").disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  send(input.value);
  input.value = "";
});

$("#clear-history").addEventListener("click", async () => {
  await api(`/api/history?session=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  messages.innerHTML = "";
  addMsg("bot", "Conversation cleared. Your knowledge base and memories are kept.");
});

async function loadHistory() {
  try {
    const { messages: hist } = await api(`/api/history?session=${encodeURIComponent(sessionId)}`);
    hist.forEach((m) => addMsg(m.role === "user" ? "user" : "bot", esc(m.content)));
  } catch { /* first load, nothing yet */ }
}
loadHistory();

// ---------- voice ----------
let recorder = null;
$("#mic").addEventListener("click", async () => {
  const mic = $("#mic");
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { alert("Microphone not available in this browser."); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert("Microphone permission denied."); return; }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    mic.classList.remove("recording");
    mic.textContent = "⏳";
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const { text } = await api("/api/voice/transcribe", { method: "POST", body: blob });
      if (text) { $("#speak").checked = true; await send(text); }
      else alert("Didn't catch that — try again.");
    } catch (e) { alert(`Transcription failed: ${e.message}`); }
    finally { mic.textContent = "🎙"; }
  };
  recorder.start();
  mic.classList.add("recording");
  mic.title = "Click to stop";
});

let audioEl = null;
async function speakText(text) {
  try {
    const res = await api("/api/voice/speak", { method: "POST", body: JSON.stringify({ text }) });
    const url = URL.createObjectURL(await res.blob());
    audioEl?.pause();
    audioEl = new Audio(url);
    await audioEl.play();
  } catch {
    // Fall back to the browser's built-in speech synthesis.
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text.replace(/\[\d+\]/g, "")));
    }
  }
}

// ---------- crawl ----------
const polling = new Set();
$("#crawl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const { crawlId } = await api("/api/crawl", {
      method: "POST",
      body: JSON.stringify({ url: $("#crawl-url").value, maxPages: Number($("#crawl-max").value) }),
    });
    $("#crawl-url").value = "";
    await loadCrawls();
    poll(crawlId);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; }
});

function crawlCard(c, docs) {
  const docHtml = docs?.length
    ? `<details><summary>${docs.length} page(s)</summary>${docs.map((d) =>
        `<div class="item"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a><div class="summary">${esc(d.summary)}</div></div>`).join("")}</details>`
    : "";
  return `<div class="item" id="crawl-${esc(c.id)}">
    <div class="item-head"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>
      <span class="badge ${esc(c.status)}">${esc(c.status)} · ${c.pages} page(s)</span></div>
    ${c.summary ? `<div class="summary">${esc(c.summary)}</div>` : ""}
    ${c.error ? `<div class="summary" style="color:var(--bad)">${esc(c.error)}</div>` : ""}
    ${docHtml}
  </div>`;
}

async function loadCrawls() {
  try {
    const { crawls } = await api("/api/crawl");
    $("#crawl-list").innerHTML = crawls.length ? crawls.map((c) => crawlCard(c)).join("") : `<p class="muted">No crawls yet.</p>`;
    crawls.filter((c) => c.status === "queued" || c.status === "crawling").forEach((c) => poll(c.id));
  } catch (e) { $("#crawl-list").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function poll(id) {
  if (polling.has(id)) return;
  polling.add(id);
  try {
    for (;;) {
      const { crawl, workflow, documents } = await api(`/api/crawl/${id}`);
      // If the workflow itself died, reflect that even if the DO row wasn't updated.
      if (workflow?.status === "errored" || workflow?.status === "terminated") {
        crawl.status = "failed";
        crawl.error = crawl.error || workflow.error?.message || "Workflow failed";
      }
      const el = document.getElementById(`crawl-${id}`);
      if (el) el.outerHTML = crawlCard(crawl, documents);
      if (crawl.status === "complete" || crawl.status === "failed") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch { /* stop polling on error */ }
  polling.delete(id);
}

// ---------- library ----------
async function loadLibrary() {
  try {
    const [{ documents, stats }, { memories }] = await Promise.all([api("/api/documents"), api("/api/memories")]);
    $("#stats").innerHTML = Object.entries(stats).map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
    $("#doc-list").innerHTML = documents.length
      ? documents.map((d) => `<div class="item">
          <div class="item-head">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : `<b>${esc(d.title)}</b>`}
            <span><span class="badge">${d.chunks} chunks</span> <button class="link" data-del-doc="${esc(d.id)}">Delete</button></span></div>
          ${d.summary ? `<div class="summary">${esc(d.summary)}</div>` : ""}</div>`).join("")
      : `<p class="muted">No documents yet — crawl a site or add text above.</p>`;
    $("#memory-list").innerHTML = memories.length
      ? memories.map((m) => `<div class="item"><div class="item-head"><b>${esc(m.question)}</b>
          <button class="link" data-del-mem="${esc(m.id)}">Forget</button></div><div class="summary">${esc(m.answer)}</div></div>`).join("")
      : `<p class="muted">Nothing learned yet.</p>`;
  } catch (e) { $("#doc-list").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

document.addEventListener("click", async (e) => {
  const doc = e.target.closest("[data-del-doc]");
  const mem = e.target.closest("[data-del-mem]");
  if (doc && confirm("Delete this document from the knowledge base?")) {
    await api(`/api/documents/${doc.dataset.delDoc}`, { method: "DELETE" });
    loadLibrary();
  }
  if (mem) {
    await api(`/api/memories/${mem.dataset.delMem}`, { method: "DELETE" });
    loadLibrary();
  }
});

$("#ingest-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "Ingesting…";
  try {
    await api("/api/ingest", {
      method: "POST",
      body: JSON.stringify({ title: $("#ingest-title").value, text: $("#ingest-text").value }),
    });
    $("#ingest-title").value = "";
    $("#ingest-text").value = "";
    loadLibrary();
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = "Ingest"; }
});
