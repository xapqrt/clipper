const query_input = document.getElementById("query");
const search_btn = document.getElementById("search_btn");
const clip_btn = document.getElementById("clip_btn");
const clear_btn = document.getElementById("clear_btn");
const export_btn = document.getElementById("export_btn");
const import_btn = document.getElementById("import_btn");
const import_file = document.getElementById("import_file");
const stats_div = document.getElementById("stats");
const recent_div = document.getElementById("recent");
const domains_div = document.getElementById("domains");
const domain_filter_input = document.getElementById("domain_filter");
const min_score_input = document.getElementById("min_score");
const results_div = document.getElementById("results");
let last_hits = [];

function escape_html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function refresh_stats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_STATS" });
    const stats = res?.stats || { total_chunks: 0, unique_urls: 0 };
    stats_div.textContent = `chunks: ${stats.total_chunks} | pages: ${stats.unique_urls}`;
  } catch {
    stats_div.textContent = "chunks: ? | pages: ?";
  }
}

async function get_active_tab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh_recent() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_RECENT" });
    const items = res?.items || [];
    if (!items.length) {
      recent_div.textContent = "recent clips will show here...";
      return;
    }

    recent_div.innerHTML = items
      .map((x) => {
        const label = escape_html(x.title || "untitled");
        const url = escape_html(x.url || "");
        return `<div style="margin-bottom:5px;"><a href="${url}" target="_blank">${label}</a></div>`;
      })
      .join("");
  } catch {
    recent_div.textContent = "failed to load recent clips";
  }
}

async function refresh_domains() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_DOMAIN_COUNTS" });
    const items = res?.items || [];
    if (!items.length) {
      domains_div.textContent = "top domains will show here...";
      return;
    }

    domains_div.innerHTML = items
      .map((x) => `<div style="margin-bottom:4px;">${escape_html(x.domain)} <span style="opacity:.7">(${Number(x.chunks || 0)})</span></div>`)
      .join("");
  } catch {
    domains_div.textContent = "failed to load domain counts";
  }
}

async function trigger_clip() {
  const tab = await get_active_tab();
  if (!tab?.id) return;

  results_div.textContent = "Clipping page now...";
  clip_btn.disabled = true;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
    results_div.textContent = "Clip message sent.";
  } catch {
    // fallback if content script was not attached yet
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
    results_div.textContent = "Injected content script, clipping now.";
  } finally {
    clip_btn.disabled = false;
  }
}

function render_hits(hits) {
  last_hits = hits || [];
  if (!hits?.length) {
    results_div.textContent = "No matches yet.";
    return;
  }

  const q_words = query_input.value
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mark = (txt) => {
    let out = escape_html(txt);
    for (const w of q_words) {
      const re = new RegExp(`(${esc(w)})`, "ig");
      out = out.replace(re, "<mark>$1</mark>");
    }
    return out;
  };

  const html = hits
    .map((item) => {
      const text = String(item.text_chunk || "");
      const snip = text.slice(0, 140).replace(/\s+/g, " ");
      const score = Number(item.sim_score || 0).toFixed(3);
      const safe_title = escape_html(item.title || "untitled");
      const safe_url = escape_html(item.url || "");
      return `
        <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed #999;">
          <div><strong>${safe_title}</strong> <span style="opacity:.7">score ${score}</span></div>
          <div style="margin:4px 0;">${mark(snip)}...</div>
          <a href="${safe_url}" target="_blank">open source</a>
        </div>
      `;
    })
    .join("");

  results_div.innerHTML = html;
}

search_btn.addEventListener("click", async () => {
  const raw_q = query_input.value.trim();
  if (!raw_q) return;

  search_btn.disabled = true;
  results_div.textContent = "Searching local vectors...";

  try {
    const domain_filter = domain_filter_input.value.trim();
    const min_score = min_score_input.value.trim();
    const res = await chrome.runtime.sendMessage({
      type: "BRAINSYNC_SEARCH",
      query: raw_q,
      domain_filter,
      min_score: min_score ? Number(min_score) : -1
    });

    render_hits(res?.hits || []);
    refresh_stats().catch(() => {});
    refresh_recent().catch(() => {});
    refresh_domains().catch(() => {});
  } finally {
    search_btn.disabled = false;
  }
});

query_input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    if (last_hits[0]?.url) {
      chrome.tabs.create({ url: last_hits[0].url });
      return;
    }
  }

  if (ev.key === "Enter") search_btn.click();
});

clip_btn.addEventListener("click", () => {
  trigger_clip().catch((e) => {
    const msg = String(e);
    if (msg.includes("Receiving end does not exist") || msg.includes("Cannot access")) {
      results_div.textContent = "Clip blocked on this page type (like chrome:// or web store).";
      return;
    }
    results_div.textContent = `Clip failed: ${msg}`;
  });
});

clear_btn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_CLEAR_ALL" });
  results_div.textContent = res?.ok ? "Local vault cleared." : "Clear failed.";
  await refresh_stats();
  await refresh_recent();
  await refresh_domains();
});

export_btn.addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_EXPORT_ALL" });
    if (!res?.ok || !res.payload) {
      results_div.textContent = "Export failed.";
      return;
    }

    const blob = new Blob([JSON.stringify(res.payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const obj_url = URL.createObjectURL(blob);
    a.href = obj_url;
    a.download = `brainsync-backup-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(obj_url), 500);
    results_div.textContent = `Exported ${res.payload.count} chunks.`;
  } catch {
    results_div.textContent = "Export failed.";
  }
});

import_btn.addEventListener("click", () => import_file.click());

import_file.addEventListener("change", async () => {
  const file = import_file.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_IMPORT_ALL", payload });
    if (!res?.ok) {
      results_div.textContent = "Import failed.";
      return;
    }
    results_div.textContent = "Import complete.";
    await refresh_stats();
    await refresh_recent();
    await refresh_domains();
  } catch (e) {
    results_div.textContent = `Import parse failed: ${String(e)}`;
  } finally {
    import_file.value = "";
  }
});

refresh_stats().catch((e) => {
  results_div.textContent = `Stats failed: ${String(e)}`;
});

refresh_recent().catch(() => {});
refresh_domains().catch(() => {});
