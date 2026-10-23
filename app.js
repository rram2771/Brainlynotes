"use strict";
const {
  useState,
  useEffect,
  useRef,
  useMemo
} = React;
// ---------- Palette & constants ----------

const SUBJECT_COLORS = [{
  name: "Steel",
  hex: "#3E7CAB"
}, {
  name: "Aqua",
  hex: "#3F9A8C"
}, {
  name: "Clay",
  hex: "#D98F78"
}, {
  name: "Mustard",
  hex: "#B48D2B"
}, {
  name: "Sage",
  hex: "#8B9A63"
}, {
  name: "Cornflower",
  hex: "#7E9ED8"
}, {
  name: "Periwinkle",
  hex: "#A5A8E3"
}, {
  name: "Rose",
  hex: "#C0569A"
}];
const NOTE_COLORS = [{
  name: "Default",
  hex: null
}, {
  name: "Clay",
  hex: "#EFD0C4"
}, {
  name: "Butter",
  hex: "#F6EDC4"
}, {
  name: "Mint",
  hex: "#D5E7E1"
}, {
  name: "Cornflower",
  hex: "#C6D4EF"
}, {
  name: "Periwinkle",
  hex: "#CED0F7"
}, {
  name: "Rose",
  hex: "#F2D7E7"
}, {
  name: "Sand",
  hex: "#F3EAE3"
}];
const STORAGE_KEY = "brainly-data";
const THEME_KEY = "brainly-theme";
const REMINDERS_KEY = "brainly-reminders";
const BOX_INTERVAL_DAYS = {
  1: 0,
  2: 1,
  3: 3,
  4: 7,
  5: 14
};
const POINTS_PER_CORRECT = 10;
const FILES_VIEW = "__files__"; // pseudo-subject id meaning "the Files page is open"

// Uses Claude's window.storage when running inside a Claude artifact; falls back
// to plain localStorage when running standalone (e.g. installed as a PWA).
// Nothing else in this app depends on being inside Claude anymore, so both
// environments behave identically.
// In a regular browser the data lives in IndexedDB: localStorage is capped at roughly 5 MB per
// site in Chrome, Firefox and Safari, and a library with image notes and occlusion cards (each
// card keeps its own copies of the image) outgrows that — after which every save fails.
// IndexedDB's limit is a large share of free disk space instead. Anything an older version left
// in localStorage is still read as a fallback until a key's first save here, so existing
// libraries carry over by themselves; the old copy is left untouched.
let idbPromise = null;
function openIdb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
      const req = indexedDB.open("brainly", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    idbPromise.catch(() => {
      idbPromise = null;
    });
  }
  return idbPromise;
}
function idbGet(key) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
function idbSet(key, value) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
  }));
}
// Asks the browser not to evict this site's data under storage pressure (it can otherwise
// clear IndexedDB for sites it considers low-priority). Best effort; browsers may decline.
if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist && typeof window !== "undefined" && !window.storage && !window.AndroidBridge) {
  navigator.storage.persist().catch(() => {});
}
const storage = {
  async get(key) {
    if (typeof window !== "undefined" && window.storage) {
      return window.storage.get(key, false);
    }
    // Android app: data lives in native files (no ~5.2M-character localStorage cap). A key
    // that's never been written there yet falls back to what an older version left in
    // localStorage, so existing libraries carry over on the first save after an update.
    if (typeof window !== "undefined" && window.AndroidBridge && window.AndroidBridge.storageGet) {
      const native = window.AndroidBridge.storageGet(key);
      if (native !== null && native !== undefined) return {
        key,
        value: native
      };
    } else {
      try {
        const v = await idbGet(key);
        if (v !== undefined && v !== null) return {
          key,
          value: v
        };
      } catch (e) {
        // IndexedDB unavailable (some private-browsing modes): fall through to localStorage
      }
    }
    const v = localStorage.getItem(key);
    return v !== null ? {
      key,
      value: v
    } : null;
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.storage) {
      return window.storage.set(key, value, false);
    }
    if (typeof window !== "undefined" && window.AndroidBridge && window.AndroidBridge.storageSet) {
      if (!window.AndroidBridge.storageSet(key, value)) throw new Error("Couldn't write to device storage");
      return {
        key,
        value
      };
    }
    let idbAvailable = true;
    try {
      await openIdb();
    } catch (e) {
      idbAvailable = false; // e.g. some private-browsing modes: keep working on localStorage
    }
    if (idbAvailable) {
      // A real write failure (disk full, etc.) is deliberately NOT swallowed into localStorage:
      // reads prefer IndexedDB, so a silent fallback there would later serve the stale copy.
      await idbSet(key, value);
      return {
        key,
        value
      };
    }
    localStorage.setItem(key, value);
    return {
      key,
      value
    };
  }
};

// ---------- Passcode lock ----------
// A UI-level gate, not encryption: it stops someone who picks up the device
// from casually opening the app, but the underlying data (in local storage
// or in a backup file) is never actually encrypted, so it isn't real
// protection against someone deliberately digging into browser storage.
// Only the hash is ever stored, never the passcode itself. If crypto.subtle
// isn't available (very old browser, or a non-secure context), the whole
// feature quietly stays hidden rather than breaking anything.

function pinLockAvailable() {
  return typeof window !== "undefined" && !!(window.crypto && window.crypto.subtle);
}
async function hashPin(pin) {
  const enc = new TextEncoder().encode("brainly-pin-salt-v1:" + pin);
  const buf = await window.crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Generic helpers ----------

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowISO() {
  return new Date().toISOString();
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function slug(s) {
  return (s || "untitled").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "untitled";
}
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
function htmlToPlainText(html) {
  if (!html) return "";
  // Insert newline/bullet markers at block boundaries before stripping tags,
  // so headings, paragraphs, and list items don't run together in exports/search.
  const withMarkers = html.replace(/<li([^>]*)>/gi, "<li$1>- ").replace(/<\/(div|p|h1|h2|h3|h4|h5|h6|li)>/gi, "$&\n").replace(/<br\s*\/?>/gi, "<br/>\n");
  const div = document.createElement("div");
  div.innerHTML = withMarkers;
  const text = div.textContent || div.innerText || "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// Highlighting was removed from the app. This takes any old <mark> highlights off a note
// body and keeps their text.
function stripHighlights(html) {
  let out = html || "";
  for (let i = 0; i < 4 && /<mark\b/i.test(out); i++) {
    out = out.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, "$1");
  }
  return out;
}

// Whether a note has anything worth saving. Checking typed text alone (as every save path
// used to) treats a note that's only a title plus pasted/inserted images — e.g. an EKG strip
// titled "PVC" — as empty, so it was silently discarded on Add with no message at all.
function noteHasContent(title, bodyHTML, images) {
  if ((title || "").trim()) return true;
  if ((images || []).length) return true;
  if (/<img\b/i.test(bodyHTML || "")) return true;
  return !!htmlToPlainText(bodyHTML).trim();
}

// Pulls a short window of text around the first match, like search-engine
// result snippets ("...text before MATCH text after..."), instead of always
// starting from the beginning of the note.
function extractSnippet(text, query, contextChars) {
  const ctx = contextChars || 60;
  const flat = text.replace(/\s+/g, " ").trim();
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return flat.slice(0, ctx * 2);
  const start = Math.max(0, idx - ctx);
  const end = Math.min(flat.length, idx + query.length + ctx);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}
function download(filename, text, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], {
    type: mime
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      return false;
    }
  }
}
async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({
        title,
        text
      });
      return "shared";
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
    }
  }
  const ok = await copyText(text);
  return ok ? "copied" : "failed";
}
function printHTML(title, bodyHTML) {
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      body { font-family: 'Inter', -apple-system, sans-serif; color: #241C3D; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
      h1 { font-family: 'Baloo 2', sans-serif; }
      .meta { color: #8B87A6; font-size: 13px; margin-bottom: 20px; }
      .card { border: 1px solid #EAE6F7; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; break-inside: avoid; }
      .card .front { font-weight: 600; margin-bottom: 6px; }
      .card .back { color: #444; }
      mark.note-highlight { background: #FFF3C4; padding: 0 2px; border-radius: 3px; }
      mark.note-highlight-red { background: #FFCDD2; }
      mark.note-highlight-green { background: #C8F4DE; }
      hr { border: none; border-top: 1px solid #EAE6F7; margin: 24px 0; }
    </style>
    </head><body>${bodyHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
  return true;
}
function compressImage(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read image"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't load image"));
      img.onload = () => {
        let {
          width,
          height
        } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round(height * maxDim / width);
            width = maxDim;
          } else {
            width = Math.round(width * maxDim / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function imageFilesFromPasteOrDrop(items) {
  const files = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
      const f = item.getAsFile ? item.getAsFile() : item;
      if (f) files.push(f);
    }
  }
  return files;
}

// ============================================================
// Markdown-paste rendering — the actual fix for "pasting from Captura
// (or this app's own Copy as Markdown) shows a raw wall of text
// instead of the image." This editor previously only handled two
// paste cases: an actual image FILE from the clipboard, or plain text
// (which just falls through to the browser's default verbatim
// insert — including any markdown syntax, shown as literal
// characters, never interpreted). This adds a third case: pasted TEXT
// that itself contains markdown worth rendering — specifically the
// bounded subset this app's own noteToMarkdown produces, and what
// Captura's equivalent export produces, which happen to be close
// enough to interoperate. Not a general markdown parser; a bounded
// converter for the two known real shapes of input this needs to
// handle, matching this editor's own inline-image convention exactly
// (the same <img class="rte-inline-image"> insertImageAtCursor
// already produces) rather than inventing a new one.
// ============================================================

// Requires an actual markdown image reference, OR at least two
// structural markdown lines (heading/quote/bold-label) — a single
// stray '#' or '>' character in an otherwise ordinary pasted sentence
// should NOT silently trigger a full markdown re-render of plain text
// someone just meant to paste as-is.
function looksLikeMarkdownWorthParsing(text) {
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) return true;
  const structuralLines = text.split("\n").filter(l => /^#{1,4}\s|^>\s?\S|^\*\*[^*]+\*\*/.test(l.trim()));
  return structuralLines.length >= 2;
}
function escapeAttr(str) {
  return escapeHTML(str).replace(/"/g, "&quot;");
}

// **bold** and *italic* — the one inline pattern both apps' exports
// actually use (Captura's color label renders as *(Subject)*).
function applyInlineMarkdown(escapedText) {
  return escapedText.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// Fallback ONLY — used when marked (loaded via CDN in index.html)
// isn't available for some reason (offline on a first visit before the
// service worker has cached it, the CDN blocked, etc.). A narrow,
// hand-rolled converter for the specific bounded subset of markdown
// this app's own export and Captura's produce — kept as a safety net,
// not the primary path anymore.
function parsePastedMarkdownToHTMLFallback(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const htmlParts = [];
  let paragraphBuffer = [];
  const flushParagraph = () => {
    if (paragraphBuffer.length) {
      const joined = paragraphBuffer.join(" ").trim();
      if (joined) htmlParts.push(`<p>${applyInlineMarkdown(escapeHTML(joined))}</p>`);
      paragraphBuffer = [];
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      flushParagraph();
      htmlParts.push(`<img src="${escapeAttr(imageMatch[2])}" class="rte-inline-image" alt="${escapeAttr(imageMatch[1])}" />`);
      continue;
    }
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      // Markdown h1 becomes a visual h2 — the note's OWN title already
      // occupies the visual h1 slot; a pasted "# Title" line shouldn't
      // compete with it for the same size.
      const tag = "h" + Math.min(headingMatch[1].length + 1, 4);
      htmlParts.push(`<${tag}>${applyInlineMarkdown(escapeHTML(headingMatch[2]))}</${tag}>`);
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      flushParagraph();
      htmlParts.push("<hr />");
      continue;
    }
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      if (quoteMatch[1]) htmlParts.push(`<p class="rte-pasted-quote">${applyInlineMarkdown(escapeHTML(quoteMatch[1]))}</p>`);
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushParagraph();
  return htmlParts.join("");
}

// Primary path — a real, mature markdown parser (loaded via CDN in
// index.html, the same way React itself loads), the same category of
// tool Obsidian's own comprehensive rendering is built on. Replaces
// the earlier hand-rolled, narrow converter as the actual conversion
// step: that one only ever handled the specific bounded subset of
// markdown this app's own export and Captura's produce, where marked
// correctly handles the full markdown spec — nested lists, code
// blocks, links, multiple images, anything Obsidian itself would
// render — not just the cases anticipated in advance. Only the class
// on <img> tags needs a manual patch afterward, since marked has no
// built-in option for that without a full custom renderer.
function parsePastedMarkdownToHTML(text) {
  if (typeof marked === "undefined" || !marked || typeof marked.parse !== "function") {
    return parsePastedMarkdownToHTMLFallback(text);
  }
  try {
    const html = marked.parse(text, {
      breaks: true
    });
    return html.replace(/<img /g, '<img class="rte-inline-image" ');
  } catch (e) {
    return parsePastedMarkdownToHTMLFallback(text);
  }
}
function parseKindleClippings(text) {
  const entries = text.split(/\r?\n={5,}\r?\n?/).map(e => e.trim()).filter(Boolean);
  const results = [];
  entries.forEach(entry => {
    const lines = entry.split(/\r?\n/);
    if (lines.length < 2) return;
    const titleLine = lines[0].trim();
    const metaLine = lines[1].trim();
    // Content is everything after the first blank line following the
    // metadata line — Kindle always inserts exactly one blank line there.
    const blankIdx = lines.findIndex((l, i) => i >= 2 && l.trim() === "");
    const content = blankIdx === -1 ? "" : lines.slice(blankIdx + 1).join("\n").trim();
    if (/Your Bookmark/i.test(metaLine)) return; // no real content to capture
    if (!content) return; // a highlight/note with no actual text isn't useful to import

    // Author is the LAST parenthetical group on the title line — the
    // standard Kindle convention, though not unambiguous if a title
    // itself contains parentheses (an inherent limitation of the format
    // itself, not something a parser can fully resolve).
    const authorMatch = titleLine.match(/^(.*)\(([^()]+)\)\s*$/);
    const title = authorMatch ? authorMatch[1].trim() : titleLine;
    const author = authorMatch ? authorMatch[2].trim() : null;
    const isNote = /Your Note/i.test(metaLine);
    const pageMatch = metaLine.match(/page (\d+)/i);
    const locationMatch = metaLine.match(/[Ll]ocation ([\d-]+)/);
    const dateMatch = metaLine.match(/Added on (.+)$/i);
    let sourceCapturedAt = null;
    if (dateMatch) {
      const parsed = new Date(dateMatch[1].trim());
      if (!isNaN(parsed.getTime())) sourceCapturedAt = parsed.toISOString();
    }
    results.push({
      title,
      author,
      type: isNote ? "NOTE" : "BOOK_HIGHLIGHT",
      content,
      page: pageMatch ? pageMatch[1] : null,
      location: locationMatch ? locationMatch[1] : null,
      sourceCapturedAt
    });
  });
  return results;
}

// Converts parsed Kindle entries into real captures — grouping by book
// title isn't done here (each clipping becomes its own capture, since
// that matches how the rest of this app treats one highlight as one
// unit), but every clipping does carry its book's title/author as
// source metadata.
// ============================================================
// Kindle web Notebook export (read.amazon.com/notebook) — a genuinely
// different, richer format than My Clippings.txt: real HTML with
// explicit highlight colors, chapter/section headings, and — this is
// the valuable part — a user's own typed note appearing immediately
// after the highlight it was written on, on the same page. That's
// close enough to a direct match for this app's own highlight+linked-
// note structure that it's worth preserving, not just importing as
// disconnected text. The export's structure is Amazon's own fixed
// template (not arbitrary third-party HTML), so this is parsed with
// straightforward string processing rather than needing DOMParser —
// which also means, unlike the article-extraction feature, this can
// actually be tested thoroughly against the real file format.
// ============================================================

function stripHtmlTagsKindle(html) {
  return html.replace(/<[^>]+>/g, "");
}
function decodeHtmlEntitiesKindle(str) {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// Kindle's 8 highlight colors mapped onto this app's 4 content-type
// colors — necessarily a lossy, somewhat arbitrary default (8 doesn't
// divide evenly into 4), but a reasonable starting point: yellow (by
// far Kindle's most common/default color) maps to Subject, green to
// Facts (a common convention elsewhere too), blue-family colors to
// Supporting, and the remaining warm colors to Question.
// Kindle exposes 8 highlight colors; this editor supports 3
// (yellow/red/green, its own "general/important/supporting"
// convention). yellow and green map directly since both sides use
// them for essentially the same meaning; the remaining Kindle colors
// map to whichever of red or green they're conceptually closer to,
// same reasoning Captura used for its own (different) 4-color system.
// ============================================================
// PDF import — ported from Captura's implementation. Same honest
// caveat carries over: PDF.js is a mature library on a stable CDN, and
// this app already loads its own dependencies (React, marked) the
// same way — a script tag the user's browser fetches at runtime,
// which has real network access my own sandbox does not, so this is
// written carefully but genuinely untested against a live PDF here.
// Adapted for Brainly specifically: page images are produced as data
// URLs directly via canvas.toDataURL, matching how compressImage
// already produces every other image in this app, rather than the
// Blob format Captura's own separate annotation-image storage needed.
// ============================================================

function isPdfJsReady(win) {
  return !!(win && win.pdfjsLib && typeof win.pdfjsLib.getDocument === "function");
}
const PDFJS_VERSION = "2.16.105"; // pre-ESM-split — v4+ doesn't expose window.pdfjsLib via a plain <script> tag
const PDFJS_SCRIPT_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
let pdfJsLoadPromise = null;
function loadPdfJs() {
  if (isPdfJsReady(window)) return Promise.resolve(window.pdfjsLib);
  if (pdfJsLoadPromise) return pdfJsLoadPromise;
  pdfJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PDFJS_SCRIPT_URL;
    const timeoutId = setTimeout(() => {
      pdfJsLoadPromise = null;
      reject(new Error("The PDF reader took too long to load — check your connection and try again."));
    }, 20000);
    script.onload = () => {
      clearTimeout(timeoutId);
      if (!isPdfJsReady(window)) {
        pdfJsLoadPromise = null;
        reject(new Error("The PDF reader library loaded but isn't available in the expected form — please try again."));
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      resolve(window.pdfjsLib);
    };
    script.onerror = () => {
      clearTimeout(timeoutId);
      pdfJsLoadPromise = null;
      reject(new Error("Couldn't load the PDF reader — check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return pdfJsLoadPromise;
}

// Extracts plain text page by page with a heading per page break — an
// honest text-extraction import, not a layout-preserving one (columns
// and tables aren't reconstructed). includeImages renders each page
// to a real raster image too (PDF.js's standard render-to-canvas),
// kept opt-in since every page is real extra time and storage.
async function extractTextFromPdfFile(file, includeImages) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({
    data: arrayBuffer
  }).promise;
  const parts = [];
  const pageImages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(" ").trim();
    if (pageText) {
      parts.push(`<h4>Page ${i}</h4>`);
      parts.push(`<p>${escapeHTML(pageText)}</p>`);
    }
    if (includeImages) {
      const viewport = page.getViewport({
        scale: 1.5
      });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport
      }).promise;
      pageImages.push({
        pageNum: i,
        dataUrl: canvas.toDataURL("image/png")
      });
    }
  }
  return {
    pageCount: pdf.numPages,
    contentHTML: parts.join("\n"),
    pageImages
  };
}

// Wraps the raw extraction into a real Brainly note: page images are
// embedded inline as <img> tags (this editor's own convention) AND
// added to the note's separate images[] array, matching how
// insertImageAtCursor already populates both — the images[] array is
// what drives the note-card thumbnail preview in the library list, so
// skipping it would mean a PDF import never shows a thumbnail there.
function buildBrainlyNoteFromPdf(extracted, filename) {
  const title = (filename || "Untitled PDF").replace(/\.pdf$/i, "");
  const images = extracted.pageImages.map(p => ({
    id: uid(),
    dataUrl: p.dataUrl
  }));
  const imageHTML = images.map(img => `<img src="${escapeAttr(img.dataUrl)}" class="rte-inline-image" alt="Page image" />`).join("\n");
  return {
    title,
    bodyHTML: [extracted.contentHTML, imageHTML].filter(Boolean).join("\n") || "<p></p>",
    images,
    tagNames: ["pdf"]
  };
}

// .md file import (Obsidian/Notion exports) — the real conversion work
// is already done by parsePastedMarkdownToHTML (marked, loaded via
// CDN, the same real parser the paste-fix uses), so this is mostly
// about extracting a title: a leading "# Heading" line is the
// near-universal convention both Obsidian and Notion actually export
// with, so that's used when present, falling back to the filename
// only when it's genuinely absent. Any embedded base64 images in the
// source markdown (rare for a real vault export, common for a file
// re-exported from Captura or this app's own Copy as Markdown) are
// pulled out into the separate images[] array too, matching how PDF
// import already populates it, so the note-card thumbnail preview
// works consistently regardless of which import path produced a note.
const ARTICLE_PROXIES = [url => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url), url => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), url => "https://corsproxy.io/?url=" + encodeURIComponent(url)];

// A handful of telltale signs the proxy actually returned a bot-
// challenge or block page instead of the real article — not a
// substitute for a real check, but enough to give an honest "this site
// is blocking automated access" message instead of silently treating
// challenge-page boilerplate as if it were the article itself.
function looksLikeBlockPage(html) {
  if (html.length < 500) return true;
  const lower = html.slice(0, 3000).toLowerCase();
  return ["captcha", "cf-browser-verification", "access denied", "checking your browser", "attention required"].some(s => lower.includes(s));
}
async function fetchArticleHTMLWithFallbacks(url) {
  let lastError = "Couldn't reach any proxy";
  for (const buildProxyUrl of ARTICLE_PROXIES) {
    try {
      const response = await fetch(buildProxyUrl(url));
      if (!response.ok) {
        lastError = "Proxy returned an error (status " + response.status + ")";
        continue;
      }
      const html = await response.text();
      if (looksLikeBlockPage(html)) {
        lastError = "This site appears to be blocking automated access";
        continue;
      }
      return html;
    } catch (e) {
      lastError = "Network error reaching the proxy";
    }
  }
  throw new Error(lastError);
}

// Tags kept in the extracted content — everything else is unwrapped
// (its children promoted up, text preserved) rather than deleted, so
// stray formatting inside a disallowed wrapper doesn't just vanish.
const ARTICLE_ALLOWED_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "BR", "A"]);
const ARTICLE_STRIP_SELECTORS = "script, style, nav, header, footer, aside, noscript, iframe, form, svg";
const ARTICLE_SEMANTIC_SELECTORS = ["article", "[role='main']", "main", ".post-content", ".article-content", ".entry-content", "#content"];
function cleanExtractedElement(contentEl) {
  Array.from(contentEl.querySelectorAll("*")).forEach(el => {
    if (!ARTICLE_ALLOWED_TAGS.has(el.tagName)) {
      el.replaceWith(...el.childNodes);
    } else {
      Array.from(el.attributes).forEach(attr => {
        if (!(el.tagName === "A" && attr.name === "href")) el.removeAttribute(attr.name);
      });
    }
  });
}
function extractArticleContent(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(ARTICLE_STRIP_SELECTORS).forEach(el => el.remove());
  const titleEl = doc.querySelector("h1") || doc.querySelector("title");
  const title = titleEl ? titleEl.textContent.trim() : "";
  let contentEl = null;
  for (const sel of ARTICLE_SEMANTIC_SELECTORS) {
    const found = doc.querySelector(sel);
    if (found && found.textContent.trim().length > 200) {
      contentEl = found;
      break;
    }
  }

  // No semantic container found — fall back to scoring every div/section
  // by how much actual paragraph text it contains, and taking the best.
  if (!contentEl) {
    let bestScore = 0;
    doc.querySelectorAll("div, section").forEach(el => {
      const textLen = Array.from(el.querySelectorAll("p")).reduce((sum, p) => sum + p.textContent.length, 0);
      if (textLen > bestScore) {
        bestScore = textLen;
        contentEl = el;
      }
    });
  }

  // Last resort — neither a semantic container nor a clear "best" div
  // was found. Rather than give up, grab every <p> on the whole page in
  // document order and treat that as the article. More permissive and
  // less precise than the two paths above, but a real result beats an
  // empty one when the page's structure doesn't match common patterns.
  if (!contentEl || contentEl.textContent.trim().length < 100) {
    const allParagraphs = Array.from(doc.querySelectorAll("p")).filter(p => p.textContent.trim().length > 40);
    if (allParagraphs.length >= 3) {
      const wrapper = doc.createElement("div");
      allParagraphs.forEach(p => wrapper.appendChild(p.cloneNode(true)));
      contentEl = wrapper;
    }
  }
  if (!contentEl || contentEl.textContent.trim().length < 100) return null;
  cleanExtractedElement(contentEl);
  return {
    title,
    contentHTML: contentEl.innerHTML
  };
}

// Orchestrates fetch + extraction, returning an explicit
// { status: "success" | "failed", ... } result rather than silently
// succeeding or failing — the caller uses this to actually show
// something (a clear failure message with a retry option, not nothing
// at all, which is what shipped before this).
async function tryExtractFullArticle(url) {
  let html;
  try {
    html = await fetchArticleHTMLWithFallbacks(url);
  } catch (e) {
    return {
      status: "failed",
      reason: e.message || "Couldn't fetch that page"
    };
  }
  const extracted = extractArticleContent(html);
  if (!extracted) {
    return {
      status: "failed",
      reason: "Fetched the page, but couldn't find article content in it"
    };
  }
  return {
    status: "success",
    title: extracted.title,
    contentHTML: extracted.contentHTML
  };
}

// Wraps a successful extraction into a real Brainly note. Brainly's
// note schema has no dedicated "source URL" field (unlike Captura's
// capture.source) — rather than add one and touch the schema
// everything else depends on, the source link becomes the note's own
// first line, a plain, permanent part of the body content itself.
function buildBrainlyNoteFromArticle(url, extracted) {
  const title = extracted.title || url;
  const sourceLine = `<p><a href="${escapeAttr(url)}">${escapeHTML(url)}</a></p>`;
  return {
    title,
    bodyHTML: [sourceLine, extracted.contentHTML].filter(Boolean).join("\n"),
    images: [],
    tagNames: ["article"]
  };
}

// Handles the manual "share fields" shape (title/text/url) that both
// a share-target handoff and a manual "paste a link" entry ultimately
// reduce to. If text is itself just a bare URL, treat it as the URL
// (the common case when sharing a link with no extra comment) rather
// than saving a note whose only content is a URL string sitting where
// body text would go.
function resolveShareFields(title, text, url) {
  const trimmedText = (text || "").trim();
  const textIsJustAUrl = /^https?:\/\/\S+$/i.test(trimmedText);
  const resolvedUrl = url || (textIsJustAUrl ? trimmedText : "");
  const resolvedText = textIsJustAUrl ? "" : trimmedText;
  return {
    title: title || "",
    text: resolvedText,
    url: resolvedUrl
  };
}
function buildBrainlyNoteFromMarkdownFile(text, filename) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let title = (filename || "Untitled").replace(/\.md$/i, "");
  let bodyText = text;
  const firstNonEmpty = lines.find(l => l.trim());
  if (firstNonEmpty && /^#\s+\S/.test(firstNonEmpty.trim())) {
    title = firstNonEmpty.trim().replace(/^#\s+/, "");
    bodyText = lines.slice(lines.indexOf(firstNonEmpty) + 1).join("\n");
  }
  const bodyHTML = parsePastedMarkdownToHTML(bodyText);
  const images = [];
  const imgRegex = /<img[^>]*src="(data:[^"]+)"[^>]*>/g;
  let m;
  while (m = imgRegex.exec(bodyHTML)) images.push({
    id: uid(),
    dataUrl: m[1]
  });
  return {
    title,
    bodyHTML,
    images,
    tagNames: ["imported"]
  };
}
const KINDLE_TO_NOTE_HIGHLIGHT_COLOR = {
  yellow: "yellow",
  green: "green",
  blue: "green",
  aqua: "green",
  orange: "red",
  red: "red",
  pink: "red",
  purple: "red"
};
function parseKindleNotebookHTML(html) {
  const titleMatch = html.match(/<div class="bookTitle">\s*([\s\S]*?)\s*<\/div>/);
  const title = titleMatch ? decodeHtmlEntitiesKindle(stripHtmlTagsKindle(titleMatch[1]).trim()) : null;
  const authorMatch = html.match(/<div class="authors">\s*([\s\S]*?)\s*<\/div>/);
  const author = authorMatch ? decodeHtmlEntitiesKindle(stripHtmlTagsKindle(authorMatch[1]).trim()) : null;
  const blockRegex = /<div class="(sectionHeading|noteHeading|noteText)">([\s\S]*?)<\/div>/g;
  const blocks = [];
  let m;
  while (m = blockRegex.exec(html)) {
    blocks.push({
      type: m[1],
      raw: m[2]
    });
  }
  const entries = [];
  let currentSection = null;
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "sectionHeading") {
      currentSection = decodeHtmlEntitiesKindle(stripHtmlTagsKindle(block.raw).trim());
      i += 1;
      continue;
    }
    if (block.type === "noteHeading") {
      const headingText = stripHtmlTagsKindle(block.raw);
      const isNote = /^\s*Note\b/i.test(headingText);
      const colorMatch = headingText.match(/\(([a-z]+)\)/i);
      const color = colorMatch ? colorMatch[1].toLowerCase() : null;
      const pageMatch = headingText.match(/Page\s+(\d+)/i);
      const page = pageMatch ? pageMatch[1] : null;
      const textBlock = blocks[i + 1];
      const text = textBlock && textBlock.type === "noteText" ? decodeHtmlEntitiesKindle(stripHtmlTagsKindle(textBlock.raw).trim()) : "";
      entries.push({
        isNote,
        color,
        page,
        text,
        section: currentSection
      });
      i += textBlock && textBlock.type === "noteText" ? 2 : 1;
      continue;
    }
    i += 1; // an unpaired/unexpected block — skip rather than loop forever
  }

  // A "Note" entry immediately following a "Highlight" entry on the
  // SAME page is attached to it as a linked note, matching this app's
  // own highlight+note structure — rather than kept as a disconnected
  // standalone entry. Anything that doesn't fit that pattern (a note
  // with no preceding highlight, or on a different page) stays
  // standalone, same as a genuinely freestanding margin note.
  const merged = [];
  for (const e of entries) {
    if (e.isNote) {
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && !prev.isNote && prev.page === e.page && !prev.linkedNote && e.text) {
        prev.linkedNote = e.text;
        continue;
      }
    }
    merged.push(e);
  }
  return {
    title,
    author,
    entries: merged
  };
}

// Turns a parsed Notebook into one Brainly note: chapter/section
// headings become <h3> markers within the note body, each highlighted
// passage becomes an inline <mark class="note-highlight-*"> — this
// editor's own native per-passage highlight mechanism (the same one
// its toolbar's color swatches produce), not a separate annotation
// record, since Brainly notes don't have one. A linked note becomes a
// plain paragraph immediately following its highlight. A standalone
// Kindle note (no preceding highlight) becomes its own plain
// paragraph too.
function buildBrainlyNoteFromKindleNotebook(parsed) {
  const bodyParts = [];
  let lastSection = null;
  parsed.entries.forEach(e => {
    if (e.section && e.section !== lastSection) {
      bodyParts.push(`<h3>${escapeHTML(e.section)}</h3>`);
      lastSection = e.section;
    }
    if (e.isNote) {
      bodyParts.push(`<p>${escapeHTML(e.text)}</p>`);
      return;
    }
    const noteColor = e.color && KINDLE_TO_NOTE_HIGHLIGHT_COLOR[e.color] ? KINDLE_TO_NOTE_HIGHLIGHT_COLOR[e.color] : "yellow";
    bodyParts.push(`<p>${escapeHTML(e.text)}</p>`);
    if (e.linkedNote) bodyParts.push(`<p>${escapeHTML(e.linkedNote)}</p>`);
  });
  return {
    title: parsed.title || "Untitled",
    bodyHTML: bodyParts.join("\n") || "<p></p>",
    images: [],
    tagNames: ["kindle"]
  };
}

// The plain-text My Clippings.txt path — no color information exists
// in that format at all (Kindle's own device export doesn't record
// it), so every highlight uses the default "yellow" (general) color
// rather than guessing. Entries are grouped by book title, since one
// device clippings file commonly holds highlights from many books —
// one Brainly note per book, matching the Notebook import's own
// "one book, one note" shape, not one note per individual highlight.
function buildBrainlyNotesFromKindleClippings(entries) {
  const byTitle = new Map();
  entries.forEach(e => {
    const key = e.title || "Untitled";
    if (!byTitle.has(key)) byTitle.set(key, {
      title: key,
      author: e.author,
      items: []
    });
    byTitle.get(key).items.push(e);
  });
  return Array.from(byTitle.values()).map(book => {
    const bodyParts = book.items.map(e => {
      if (e.type === "NOTE") return `<p>${escapeHTML(e.content || "")}</p>`;
      return `<p>${escapeHTML(e.content || "")}</p>`;
    });
    return {
      title: book.title,
      bodyHTML: bodyParts.join("\n") || "<p></p>",
      images: [],
      tagNames: ["kindle"]
    };
  });
}

// ---------- Note <-> export helpers ----------

function noteToMarkdown(note, subjectName, tagNames) {
  const lines = [`# ${note.title || "Untitled"}`, "", `**Subject:** ${subjectName || "—"}`, tagNames.length ? `**Tags:** ${tagNames.map(t => `#${slug(t)}`).join(" ")}` : null, `**Saved:** ${formatDate(note.createdAt)}`, "", "---", "", htmlToPlainText(note.bodyHTML)].filter(l => l !== null);
  if (note.images && note.images.length) {
    lines.push("");
    note.images.forEach((img, i) => lines.push(`![image ${i + 1}](${img.dataUrl})`));
  }
  return lines.join("\n");
}
function cardsToSeparatorText(cards, termSep, cardSep) {
  return cards.map(c => `${c.frontImage ? "[image]" : c.front}${termSep}${c.back}`).join(cardSep);
}
function parseSeparatorText(text, termSep, cardSep) {
  const normalized = text.replace(/\r\n/g, "\n");
  const rows = normalized.split(cardSep);
  return rows.map(row => row.trim()).filter(Boolean).map(row => {
    const idx = row.indexOf(termSep);
    if (idx === -1) return null;
    const front = row.slice(0, idx).trim();
    const back = row.slice(idx + termSep.length).trim();
    if (!front || !back) return null;
    return {
      front,
      back
    };
  }).filter(Boolean);
}

// Auto-links flashcards embedded directly in a note. Any line containing
// " > " (spaces required on both sides) becomes "front > back". Re-syncs
// on every save: matching fronts keep their box/review history and only
// update if the back text changed; lines removed from the note remove
// their card; new lines add a new card. Only ever touches cards this
// mechanism created (autoFromNote), never a highlighted or imported card
// that happens to share a source note.
function syncAutoCardsFromNote(allCards, noteId, subjectId, bodyHTML, htmlToPlainTextFn, nowFn, uidFn) {
  const plainText = htmlToPlainTextFn(bodyHTML);
  const parsed = parseSeparatorText(plainText, "::", "\n");
  const now = nowFn();
  const existingAuto = allCards.filter(c => c.autoFromNote && (c.sourceNoteIds || []).includes(noteId));
  const keptIds = new Set();
  let cards = allCards.map(c => {
    if (!c.autoFromNote || !(c.sourceNoteIds || []).includes(noteId)) return c;
    const match = parsed.find(p => p.front === c.front);
    if (!match) return c; // filtered out below
    keptIds.add(c.id);
    if (match.back !== c.back) return {
      ...c,
      back: match.back
    };
    return c;
  });
  cards = cards.filter(c => {
    if (!c.autoFromNote || !(c.sourceNoteIds || []).includes(noteId)) return true;
    return keptIds.has(c.id);
  });
  const newCards = parsed.filter(p => !existingAuto.some(c => c.front === p.front)).map(p => ({
    id: uidFn(),
    subjectId,
    front: p.front,
    back: p.back,
    sourceNoteIds: [noteId],
    autoFromNote: true,
    box: 1,
    dueDate: now,
    starred: false,
    timesCorrect: 0,
    timesWrong: 0,
    createdAt: now
  }));
  return {
    cards: [...cards, ...newCards],
    addedCount: newCards.length,
    removedCount: existingAuto.length - keptIds.size
  };
}

// ---------- Main App ----------

function Brainly() {
  const [data, setData] = useState({
    subjects: [],
    tags: [],
    notes: [],
    cards: []
  });
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [selectedSubjectId, setSelectedSubjectId] = useState(null);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("notes"); // "notes" | "study"

  const [showNewSubject, setShowNewSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [newSubjectColor, setNewSubjectColor] = useState(SUBJECT_COLORS[0].hex);
  const [newSubjectParentId, setNewSubjectParentId] = useState(null);
  const [editingNote, setEditingNote] = useState(null); // null closed, {} new, note = editing
  const [editingCard, setEditingCard] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [toast, setToast] = useState(null);
  const [showImportCards, setShowImportCards] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showMatch, setShowMatch] = useState(false);
  const [showOcclusion, setShowOcclusion] = useState(false);
  const [occlusionSeedImage, setOcclusionSeedImage] = useState(null); // dataUrl | null — prefills from a note image
  const [occlusionSourceNoteId, setOcclusionSourceNoteId] = useState(null); // link resulting cards back to a note
  const [studyScope, setStudyScope] = useState("due"); // "due" | "starred" | "all" | "selected"
  const [selectedNoteFilter, setSelectedNoteFilter] = useState(null); // note id | null
  const [manualSelectedCardIds, setManualSelectedCardIds] = useState(() => new Set());
  const [crossTagSession, setCrossTagSession] = useState(null); // { tagName, cards } | null — overrides studyCards when set

  const [noteSelectMode, setNoteSelectMode] = useState(false);
  const [selectedNoteIdsForBulk, setSelectedNoteIdsForBulk] = useState(() => new Set());
  const [showBulkTag, setShowBulkTag] = useState(false);
  const [showBulkMove, setShowBulkMove] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(null); // dataUrl | null

  const [deviceExportBusy, setDeviceExportBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [kindleImportBusy, setKindleImportBusy] = useState(false);
  const [pdfImportFile, setPdfImportFile] = useState(null); // picked file, pending the include-images choice
  const [pdfImportBusy, setPdfImportBusy] = useState(false);
  const [pdfImportError, setPdfImportError] = useState("");
  const [mdImportBusy, setMdImportBusy] = useState(false);
  const [showAddArticle, setShowAddArticle] = useState(false);
  const [articleImportBusy, setArticleImportBusy] = useState(false);
  const [articleImportError, setArticleImportError] = useState("");
  const [subjectImportBusy, setSubjectImportBusy] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [showPinModal, setShowPinModal] = useState(null); // "set" | "change" | "remove" | null
  const [splitPane, setSplitPane] = useState(null); // null | { type: "note", note } | { type: "cards", noteId, subjectId, scope: "note"|"subject" }

  const [theme, setTheme] = useState("light"); // "light" | "dark"
  const [remindersOn, setRemindersOn] = useState(false);
  const askConfirm = (message, onConfirm, confirmLabel) => setConfirmDialog({
    message,
    onConfirm,
    confirmLabel
  });

  // Load
  useEffect(() => {
    (async () => {
      let loaded = {
        subjects: [],
        tags: [],
        notes: [],
        cards: []
      };
      try {
        const res = await storage.get(STORAGE_KEY);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          loaded = {
            subjects: parsed.subjects || [],
            tags: parsed.tags || [],
            notes: parsed.notes || [],
            cards: parsed.cards || []
          };
        }
      } catch (e) {
        // no existing data yet
      }
      // Take old highlights off existing notes (the text stays) and save the cleaned copy once.
      if (loaded.notes.some(n => /<mark\b/i.test(n.bodyHTML || ""))) {
        loaded = {
          ...loaded,
          notes: loaded.notes.map(n => ({
            ...n,
            bodyHTML: stripHighlights(n.bodyHTML)
          }))
        };
        try {
          await storage.set(STORAGE_KEY, JSON.stringify(loaded));
        } catch (e) {
          // the cleaned copy is still shown; it will be saved with the next change
        }
      }
      setData(loaded);
      try {
        const themeRes = await storage.get(THEME_KEY);
        if (themeRes && themeRes.value === "dark") setTheme("dark");
      } catch (e) {
        // default to light
      }
      try {
        const remindersRes = await storage.get(REMINDERS_KEY);
        if (remindersRes && remindersRes.value === "on" && typeof Notification !== "undefined" && Notification.permission === "granted") {
          setRemindersOn(true);
        }
      } catch (e) {
        // default to off
      }
      // The app is fully usable from here. The incoming-share block below can take a few seconds
      // (it may fetch a web page), so it must not hold up first render.
      setReady(true);

      // Incoming share (Web Share Target): index.html?title=...&text=...&url=...
      // If a real URL came through, try extracting the full article
      // first (the actual point of "share like Readwise Reader" — a
      // readable note, not just a bare link) before falling back to
      // the plain link/text note this already did. A toast marks the
      // start since extraction is a real network round-trip and the
      // rest of the app is already interactive by this point — it
      // shouldn't look like nothing is happening.
      let hadIncomingShare = false; // set below, before the query string gets cleared — the
      // catch needs this since it can no longer read location.search itself by then.
      try {
        const params = new URLSearchParams(window.location.search);
        const sharedTitle = params.get("title");
        const sharedText = params.get("text");
        const sharedUrl = params.get("url");
        if (sharedTitle || sharedText || sharedUrl) {
          hadIncomingShare = true;
          window.history.replaceState(null, "", window.location.pathname);
          const fields = resolveShareFields(sharedTitle, sharedText, sharedUrl);
          let articleResult = null;
          if (fields.url) {
            setTimeout(() => showToast("Saving shared article…"), 50);
            articleResult = await tryExtractFullArticle(fields.url);
          }
          let targetSubject, subjectsNext, noteTitle, noteBodyHTML, toastMessage;
          if (articleResult && articleResult.status === "success") {
            const noteData = buildBrainlyNoteFromArticle(fields.url, articleResult);
            targetSubject = loaded.subjects.find(s => s.name === "Saved Articles");
            subjectsNext = loaded.subjects;
            if (!targetSubject) {
              targetSubject = {
                id: uid(),
                name: "Saved Articles",
                color: "#2F80ED",
                parentId: null,
                createdAt: nowISO()
              };
              subjectsNext = [...loaded.subjects, targetSubject];
            }
            noteTitle = noteData.title;
            noteBodyHTML = noteData.bodyHTML;
            toastMessage = `Saved "${noteData.title}"`;
          } else {
            // No URL at all (a plain text/title share), or extraction
            // failed — same fallback this already had: a "Review"
            // note with whatever text/link came through, so a share
            // is never just silently lost.
            targetSubject = loaded.subjects.find(s => !s.parentId && s.name.toLowerCase() === "review");
            subjectsNext = loaded.subjects;
            if (!targetSubject) {
              targetSubject = {
                id: uid(),
                name: "Review",
                color: "#F5A623",
                parentId: null,
                createdAt: nowISO()
              };
              subjectsNext = [...loaded.subjects, targetSubject];
            }
            const bodyParts = [];
            if (fields.text) bodyParts.push(`<p>${escapeHTML(fields.text)}</p>`);
            if (fields.url) bodyParts.push(`<p><a href="${escapeHTML(fields.url)}" target="_blank" rel="noopener">${escapeHTML(fields.url)}</a></p>`);
            noteTitle = fields.title || fields.url || "Shared note";
            noteBodyHTML = bodyParts.join("") || "<p></p>";
            toastMessage = fields.url ? "Couldn't extract that article — saved the link instead" : "Saved shared note to Review";
          }
          const now = nowISO();
          const newNote = {
            id: uid(),
            subjectId: targetSubject.id,
            title: noteTitle,
            bodyHTML: noteBodyHTML,
            tagIds: [],
            images: [],
            color: null,
            linkedNoteIds: [],
            createdAt: now,
            updatedAt: now
          };
          const withShare = {
            ...loaded,
            subjects: subjectsNext,
            notes: [...loaded.notes, newNote]
          };
          // persist() so the shared note is saved like any other change.
          await persist(withShare);
          setSelectedSubjectId(targetSubject.id);
          setTab("notes");
          setTimeout(() => showToast(toastMessage), 50);
        }
      } catch (e) {
        // A real incoming share whose processing threw (as opposed to there being no share
        // at all) used to be silently discarded here — surface it instead so a share never
        // just vanishes with no explanation.
        if (hadIncomingShare) {
          setTimeout(() => showToast(`Couldn't save that share: ${e && e.message ? e.message : e}`), 50);
        }
      }
    })();
  }, []);

  // Leaving a subject clears any in-progress bulk note selection.
  useEffect(() => {
    setNoteSelectMode(false);
    setSelectedNoteIdsForBulk(new Set());
  }, [selectedSubjectId]);

  // On narrow screens (the layout stacks at 720px) the sidebar sits above the content, so
  // choosing Home / Files / a subject changed something out of sight below it. Bring the
  // content into view when the choice changes. Skipped on first load and on wide screens.
  const selectionScrollReady = useRef(false);
  useEffect(() => {
    if (!selectionScrollReady.current) {
      selectionScrollReady.current = true;
      return;
    }
    if (window.matchMedia && window.matchMedia("(max-width: 720px)").matches) {
      const main = document.querySelector(".main");
      if (main) main.scrollIntoView({
        block: "start",
        behavior: "smooth"
      });
    }
  }, [selectedSubjectId]);
  const persist = async next => {
    setData(next);
    try {
      const res = await storage.set(STORAGE_KEY, JSON.stringify(next));
      if (!res) throw new Error("no result");
      setSaveError(false);
    } catch (e) {
      setSaveError(true);
      return;
    }
  };
  const exportEverythingToDevice = async () => {
    const payload = JSON.stringify(data, null, 2);
    const filename = `brainly-export-${nowISO().replace(/[:.]/g, "-")}.json`;
    setDeviceExportBusy(true);
    try {
      if (window.showSaveFilePicker) {
        // Supported browsers (desktop Chrome/Edge): opens a real save dialog
        // where a plugged-in USB/thumb drive shows up as a destination.
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{
              description: "Brainly export",
              accept: {
                "application/json": [".json"]
              }
            }]
          });
          const writable = await handle.createWritable();
          await writable.write(payload);
          await writable.close();
          showToast("Saved — safe to unplug the drive");
          return;
        } catch (e) {
          if (e && e.name === "AbortError") return; // person cancelled the picker, not an error
          // fall through to the plain download below
        }
      }
      // Universal fallback (works on every browser, including mobile):
      // downloads to the normal Downloads folder; move it to the drive yourself.
      download(filename, payload, "application/json;charset=utf-8");
      showToast("Downloaded — move the file to your drive, then unplug");
    } finally {
      setDeviceExportBusy(false);
    }
  };
  const isValidBrainlyExport = parsed => !!parsed && typeof parsed === "object" && Array.isArray(parsed.subjects) && Array.isArray(parsed.tags) && Array.isArray(parsed.notes) && Array.isArray(parsed.cards);
  const handleImportFile = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // reset so picking the same file again still fires this handler
    if (!file) return;
    setImportBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      setImportBusy(false);
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        showToast("That file isn't valid JSON — couldn't read it as a backup.");
        return;
      }
      if (!isValidBrainlyExport(parsed)) {
        showToast("That file doesn't look like a Brainly export.");
        return;
      }
      const noteCount = parsed.notes.length;
      const cardCount = parsed.cards.length;
      askConfirm(`Import this file? It has ${noteCount} note${noteCount === 1 ? "" : "s"} and ${cardCount} card${cardCount === 1 ? "" : "s"}. This REPLACES everything currently in the app on this device — if you want to keep what's here now, export a backup first.`, async () => {
        setImportBusy(true);
        try {
          await persist(parsed);
          showToast("Import complete");
        } finally {
          setImportBusy(false);
        }
      }, "Import and replace");
    };
    reader.onerror = () => {
      setImportBusy(false);
      showToast("Couldn't read that file — try again.");
    };
    reader.readAsText(file);
  };

  // Imports a subject-scoped file — the counterpart to
  // exportSubjectAsDataFile — and MERGES it in rather than replacing
  // everything, unlike the full-database import above.
  const handleImportSubjectFile = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setSubjectImportBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      setSubjectImportBusy(false);
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        showToast("That file isn't valid JSON — couldn't read it as a subject export.");
        return;
      }
      if (!isValidBrainlyExport(parsed)) {
        showToast("That file doesn't look like a Brainly export.");
        return;
      }
      const subjectNames = parsed.subjects.map(s => s.name).join(", ") || "(no subjects)";
      askConfirm(`Bring in "${subjectNames}" — ${parsed.notes.length} note${parsed.notes.length === 1 ? "" : "s"}, ${parsed.cards.length} card${parsed.cards.length === 1 ? "" : "s"}? This adds to what's already here — it won't touch your other subjects. If a subject/note in this file already exists here, the version from this file replaces it.`, async () => {
        setSubjectImportBusy(true);
        try {
          await mergeImportedData(parsed);
          showToast("Subject imported");
        } finally {
          setSubjectImportBusy(false);
        }
      }, "Bring in subject");
    };
    reader.onerror = () => {
      setSubjectImportBusy(false);
      showToast("Couldn't read that file — try again.");
    };
    reader.readAsText(file);
  };

  // Kindle import — accepts either the web Notebook export (real HTML,
  // richer: chapter structure, highlight colors, linked notes) or the
  // on-device My Clippings.txt (plain text, no color data, commonly
  // holds many books in one file). Detected by content, not just file
  // extension, since a renamed .txt could still be either. Builds real
  // note(s) using this editor's own native per-passage highlight
  // mechanism, not a separate annotation concept Brainly doesn't have.
  // All Kindle notes land in one auto-created "Kindle Highlights"
  // subject (reusing it if it already exists) rather than requiring a
  // subject picker up front — movable afterward with the existing
  // bulk-move feature if that's not where they should end up.
  const handleKindleImportFile = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setKindleImportBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      setKindleImportBusy(false);
      const text = reader.result;
      let newNotes;
      try {
        if (/<html[\s>]/i.test(text) || /<!DOCTYPE html/i.test(text)) {
          const parsed = parseKindleNotebookHTML(text);
          if (!parsed.entries.length) {
            showToast("Couldn't find any highlights in that Notebook export.");
            return;
          }
          newNotes = [buildBrainlyNoteFromKindleNotebook(parsed)];
        } else {
          const entries = parseKindleClippings(text);
          if (!entries.length) {
            showToast("Couldn't find any clippings in that file.");
            return;
          }
          newNotes = buildBrainlyNotesFromKindleClippings(entries);
        }
      } catch (err) {
        showToast("Couldn't read that as a Kindle export — check it's the right file.");
        return;
      }
      const bookWord = newNotes.length === 1 ? "book" : "books";
      askConfirm(`Import highlights from ${newNotes.length} ${bookWord}? These go into a "Kindle Highlights" subject — you can move them afterward if you'd rather they live elsewhere.`, async () => {
        setKindleImportBusy(true);
        try {
          let subject = data.subjects.find(s => s.name === "Kindle Highlights");
          let subjects = data.subjects;
          if (!subject) {
            subject = {
              id: uid(),
              name: "Kindle Highlights",
              color: "#C9A96A",
              parentId: null,
              createdAt: nowISO()
            };
            subjects = [...subjects, subject];
          }
          const {
            tags,
            ids: kindleTagIds
          } = resolveTagIds(["kindle"], data.tags);
          const now = nowISO();
          const notesToAdd = newNotes.map(n => ({
            id: uid(),
            subjectId: subject.id,
            title: n.title,
            bodyHTML: n.bodyHTML,
            tagIds: kindleTagIds,
            images: n.images,
            color: null,
            linkedNoteIds: [],
            createdAt: now,
            updatedAt: now
          }));
          await persist({
            ...data,
            subjects,
            tags,
            notes: [...data.notes, ...notesToAdd]
          });
          showToast(`Imported ${notesToAdd.length} note${notesToAdd.length === 1 ? "" : "s"}`);
        } finally {
          setKindleImportBusy(false);
        }
      }, "Import");
    };
    reader.onerror = () => {
      setKindleImportBusy(false);
      showToast("Couldn't read that file — try again.");
    };
    reader.readAsText(file);
  };

  // PDF import is a two-step flow rather than a single file-pick like
  // Kindle: whether to render page images is a real time/storage
  // trade-off worth asking about explicitly, not silently defaulting.
  // Picking a file just stores it and shows that choice; the actual
  // extraction only starts once confirmed.
  const handlePdfFilePicked = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setPdfImportError("");
    setPdfImportFile(file);
  };
  const confirmPdfImport = async includeImages => {
    const file = pdfImportFile;
    if (!file) return;
    setPdfImportBusy(true);
    setPdfImportError("");
    try {
      const extracted = await extractTextFromPdfFile(file, includeImages);
      const noteData = buildBrainlyNoteFromPdf(extracted, file.name);
      let subject = data.subjects.find(s => s.name === "PDF Imports");
      let subjects = data.subjects;
      if (!subject) {
        subject = {
          id: uid(),
          name: "PDF Imports",
          color: "#3E7CAB",
          parentId: null,
          createdAt: nowISO()
        };
        subjects = [...subjects, subject];
      }
      const {
        tags,
        ids: pdfTagIds
      } = resolveTagIds(["pdf"], data.tags);
      const now = nowISO();
      const note = {
        id: uid(),
        subjectId: subject.id,
        title: noteData.title,
        bodyHTML: noteData.bodyHTML,
        tagIds: pdfTagIds,
        images: noteData.images,
        color: null,
        linkedNoteIds: [],
        createdAt: now,
        updatedAt: now
      };
      await persist({
        ...data,
        subjects,
        tags,
        notes: [...data.notes, note]
      });
      showToast(`Imported "${noteData.title}" (${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"})`);
      setPdfImportFile(null);
    } catch (err) {
      setPdfImportError(err.message || "Couldn't read that PDF — try again.");
    } finally {
      setPdfImportBusy(false);
    }
  };

  // .md file import (Obsidian/Notion exports) — single-step, unlike
  // PDF's two-step flow, since there's no meaningful choice to ask
  // about first (no images-vs-not trade-off here; any embedded images
  // are just part of the source text). Lands in an "Imported Notes"
  // subject, auto-created/reused the same way Kindle and PDF imports
  // each get their own.
  const handleMarkdownImportFile = e => {
    // Accepts several files at once (e.g. a whole folder of notes picked from Drive).
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setMdImportBusy(true);
    const readText = file => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        file,
        text: reader.result
      });
      reader.onerror = () => resolve({
        file,
        text: null
      });
      reader.readAsText(file);
    });
    Promise.all(files.map(readText)).then(async results => {
      try {
        let subject = data.subjects.find(s => s.name === "Imported Notes");
        let subjects = data.subjects;
        let tags = data.tags;
        const newNotes = [];
        let skipped = 0;
        for (const {
          file,
          text
        } of results) {
          if (!text || !text.trim()) {
            skipped++;
            continue;
          }
          const noteData = buildBrainlyNoteFromMarkdownFile(text, file.name);
          if (!subject) {
            subject = {
              id: uid(),
              name: "Imported Notes",
              color: "#00A187",
              parentId: null,
              createdAt: nowISO()
            };
            subjects = [...subjects, subject];
          }
          const resolved = resolveTagIds(noteData.tagNames, tags);
          tags = resolved.tags;
          const now = nowISO();
          newNotes.push({
            id: uid(),
            subjectId: subject.id,
            title: noteData.title,
            bodyHTML: noteData.bodyHTML,
            tagIds: resolved.ids,
            images: noteData.images,
            color: null,
            linkedNoteIds: [],
            createdAt: now,
            updatedAt: now
          });
        }
        if (!newNotes.length) {
          showToast(files.length === 1 ? "That file looks empty." : "Those files look empty or couldn't be read.");
          return;
        }
        await persist({
          ...data,
          subjects,
          tags,
          notes: [...data.notes, ...newNotes]
        });
        const skipNote = skipped ? ` (${skipped} empty or unreadable skipped)` : "";
        showToast(newNotes.length === 1 ? `Imported "${newNotes[0].title}"` : `Imported ${newNotes.length} notes${skipNote}`);
      } finally {
        setMdImportBusy(false);
      }
    });
  };

  // Shared by both the manual "Add article by URL" flow and the
  // share-target handoff below — one real save path rather than two
  // that could quietly drift apart. Lands in a "Saved Articles"
  // subject, auto-created/reused the same way every other import type
  // gets its own.
  const saveArticleAsNote = async url => {
    const result = await tryExtractFullArticle(url);
    if (result.status !== "success") return {
      ok: false,
      reason: result.reason
    };
    const noteData = buildBrainlyNoteFromArticle(url, result);
    let subject = data.subjects.find(s => s.name === "Saved Articles");
    let subjects = data.subjects;
    if (!subject) {
      subject = {
        id: uid(),
        name: "Saved Articles",
        color: "#2F80ED",
        parentId: null,
        createdAt: nowISO()
      };
      subjects = [...subjects, subject];
    }
    const {
      tags,
      ids: articleTagIds
    } = resolveTagIds(noteData.tagNames, data.tags);
    const now = nowISO();
    const note = {
      id: uid(),
      subjectId: subject.id,
      title: noteData.title,
      bodyHTML: noteData.bodyHTML,
      tagIds: articleTagIds,
      images: noteData.images,
      color: null,
      linkedNoteIds: [],
      createdAt: now,
      updatedAt: now
    };
    await persist({
      ...data,
      subjects,
      tags,
      notes: [...data.notes, note]
    });
    return {
      ok: true,
      title: noteData.title
    };
  };
  const handleAddArticleConfirm = async url => {
    setArticleImportBusy(true);
    setArticleImportError("");
    const result = await saveArticleAsNote(url);
    setArticleImportBusy(false);
    if (result.ok) {
      showToast(`Saved "${result.title}"`);
      setShowAddArticle(false);
    } else {
      setArticleImportError(result.reason || "Couldn't save that article.");
    }
  };
  const verifyPin = async pin => {
    if (!data.security || !data.security.pinHash) return false;
    const hash = await hashPin(pin);
    return hash === data.security.pinHash;
  };
  const savePin = async newPinOrNull => {
    if (newPinOrNull === null) {
      await persist({
        ...data,
        security: {
          enabled: false,
          pinHash: null
        }
      });
      showToast("Passcode removed");
    } else {
      const hash = await hashPin(newPinOrNull);
      await persist({
        ...data,
        security: {
          enabled: true,
          pinHash: hash
        }
      });
      setUnlocked(true); // setting/changing the code shouldn't immediately re-lock you out
      showToast(showPinModal === "change" ? "Passcode changed" : "Passcode set");
    }
    setShowPinModal(null);
  };
  const showToast = msg => {
    setToast(msg);
    const duration = Math.min(6000, Math.max(2200, (msg || "").length * 60));
    setTimeout(() => setToast(null), duration);
  };
  const subjects = data.subjects;
  const topSubjects = useMemo(() => subjects.filter(s => !s.parentId), [subjects]);
  const [expandedSubjects, setExpandedSubjects] = useState(new Set());
  const toggleSubjectExpanded = id => {
    setExpandedSubjects(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);else next.add(id);
      return next;
    });
  };
  const childSubjects = parentId => subjects.filter(s => s.parentId === parentId);
  const flatSubjectOptions = useMemo(() => {
    const opts = [];
    topSubjects.forEach(s => {
      opts.push({
        id: s.id,
        label: s.name
      });
      childSubjects(s.id).forEach(c => opts.push({
        id: c.id,
        label: "— " + c.name
      }));
    });
    return opts;
  }, [subjects]);
  const selectedSubject = subjects.find(s => s.id === selectedSubjectId) || null;
  const showFilesPage = selectedSubjectId === FILES_VIEW; // the Files page is a pseudo-subject, so picking Home or any real subject leaves it automatically

  const subjectTags = useMemo(() => {
    if (!selectedSubjectId) return [];
    const tagIdSet = new Set();
    data.notes.filter(n => n.subjectId === selectedSubjectId).forEach(n => n.tagIds.forEach(t => tagIdSet.add(t)));
    return data.tags.filter(t => tagIdSet.has(t.id));
  }, [data, selectedSubjectId]);
  const visibleNotes = useMemo(() => {
    let list = data.notes.filter(n => n.subjectId === selectedSubjectId);
    if (selectedTagIds.length) {
      list = list.filter(n => selectedTagIds.every(tid => n.tagIds.includes(tid)));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(n => n.title.toLowerCase().includes(q) || htmlToPlainText(n.bodyHTML).toLowerCase().includes(q));
    }
    return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }, [data.notes, selectedSubjectId, selectedTagIds, query]);
  const tagName = id => data.tags.find(t => t.id === id)?.name || "";
  const cardTagIds = card => {
    const set = new Set();
    data.notes.filter(n => (card.sourceNoteIds || []).includes(n.id)).forEach(n => n.tagIds.forEach(t => set.add(t)));
    return [...set];
  };
  const subjectCardsByTag = useMemo(() => {
    let list = data.cards.filter(c => c.subjectId === selectedSubjectId);
    if (selectedTagIds.length) {
      list = list.filter(c => {
        const ct = cardTagIds(c);
        return selectedTagIds.every(tid => ct.includes(tid));
      });
    }
    return list;
  }, [data.cards, data.notes, selectedSubjectId, selectedTagIds]);

  // Notes that actually have at least one card under the current tag filter —
  // powers the "study one note at a time" picker.
  const notesWithCards = useMemo(() => {
    const ids = new Set();
    subjectCardsByTag.forEach(c => (c.sourceNoteIds || []).forEach(id => ids.add(id)));
    return data.notes.filter(n => ids.has(n.id));
  }, [subjectCardsByTag, data.notes]);
  const subjectCards = useMemo(() => {
    if (!selectedNoteFilter) return subjectCardsByTag;
    return subjectCardsByTag.filter(c => (c.sourceNoteIds || []).includes(selectedNoteFilter));
  }, [subjectCardsByTag, selectedNoteFilter]);
  const dueCards = useMemo(() => {
    const now = Date.now();
    return subjectCards.filter(c => new Date(c.dueDate).getTime() <= now || c.starred);
  }, [subjectCards]);
  const starredCards = useMemo(() => subjectCards.filter(c => c.starred), [subjectCards]);
  const manuallySelectedCards = useMemo(() => subjectCards.filter(c => manualSelectedCardIds.has(c.id)), [subjectCards, manualSelectedCardIds]);
  const studyCards = useMemo(() => {
    if (studyScope === "starred") return starredCards;
    if (studyScope === "all") return subjectCards;
    if (studyScope === "selected") return manuallySelectedCards;
    return dueCards;
  }, [studyScope, dueCards, starredCards, subjectCards, manuallySelectedCards]);
  const missedCards = useMemo(() => subjectCards.filter(c => c.box === 1 && c.timesWrong > 0), [subjectCards]);
  const totalPoints = useMemo(() => data.cards.reduce((sum, c) => sum + c.timesCorrect * POINTS_PER_CORRECT, 0), [data.cards]);

  // Overdue across every subject, for the top banner — independent of which subject is open.
  const allDueCards = useMemo(() => {
    const now = Date.now();
    return data.cards.filter(c => new Date(c.dueDate).getTime() <= now);
  }, [data.cards]);

  // Next 7 days of card load, for the Dashboard forecast. "Today" covers
  // everything overdue plus anything due before midnight tonight — not just
  // cards whose due-timestamp has already passed this exact moment.
  const dueForecast = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const todayCount = data.cards.filter(c => new Date(c.dueDate) < tomorrowStart).length;
    const days = [{
      label: "Today",
      count: todayCount
    }];
    for (let i = 1; i <= 6; i++) {
      const dayStart = new Date(todayStart);
      dayStart.setDate(dayStart.getDate() + i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const count = data.cards.filter(c => {
        const d = new Date(c.dueDate);
        return d >= dayStart && d < dayEnd;
      }).length;
      const label = i === 1 ? "Tmrw" : dayStart.toLocaleDateString(undefined, {
        weekday: "short"
      });
      days.push({
        label,
        count
      });
    }
    return days;
  }, [data.cards]);
  const weakSpots = useMemo(() => {
    const map = {};
    data.cards.forEach(c => {
      const attempts = c.timesCorrect + c.timesWrong;
      if (attempts === 0) return;
      const tagIds = cardTagIds(c);
      tagIds.forEach(tagId => {
        const key = c.subjectId + "|" + tagId;
        if (!map[key]) map[key] = {
          subjectId: c.subjectId,
          tagId,
          correct: 0,
          wrong: 0
        };
        map[key].correct += c.timesCorrect;
        map[key].wrong += c.timesWrong;
      });
    });
    return Object.values(map).map(e => ({
      ...e,
      attempts: e.correct + e.wrong,
      accuracy: e.correct / (e.correct + e.wrong)
    })).filter(e => e.attempts >= 2).sort((a, b) => a.accuracy - b.accuracy).slice(0, 8);
  }, [data.cards, data.notes]);

  // Cross-subject: cards under a given tag regardless of which subject they live in.
  const cardsByTagAcrossSubjects = tagId => data.cards.filter(c => cardTagIds(c).includes(tagId));
  const globalTagStats = useMemo(() => {
    return data.tags.map(t => ({
      id: t.id,
      name: t.name,
      count: cardsByTagAcrossSubjects(t.id).length
    })).filter(t => t.count > 0).sort((a, b) => b.count - a.count);
  }, [data.tags, data.cards, data.notes]);

  // ---- Subject handlers ----

  const createSubject = async () => {
    const name = newSubjectName.trim();
    if (!name) return;
    const subj = {
      id: uid(),
      name,
      color: newSubjectColor,
      parentId: newSubjectParentId || null,
      createdAt: nowISO()
    };
    const next = {
      ...data,
      subjects: [...data.subjects, subj]
    };
    await persist(next);
    setSelectedSubjectId(subj.id);
    setSelectedTagIds([]);
    setStudyScope("due");
    setSelectedNoteFilter(null);
    setManualSelectedCardIds(new Set());
    setNewSubjectName("");
    setNewSubjectParentId(null);
    setShowNewSubject(false);
  };
  const deleteSubject = id => {
    const children = childSubjects(id);
    const warnExtra = children.length ? ` and ${children.length} sub-subject${children.length === 1 ? "" : "s"}` : "";
    askConfirm(`Delete this subject${warnExtra}, along with all its notes and cards? This can't be undone.`, async () => {
      const idsToRemove = new Set([id, ...children.map(c => c.id)]);
      const next = {
        ...data,
        subjects: data.subjects.filter(s => !idsToRemove.has(s.id)),
        notes: data.notes.filter(n => !idsToRemove.has(n.subjectId)),
        cards: data.cards.filter(c => !idsToRemove.has(c.subjectId))
      };
      await persist(next);
      if (idsToRemove.has(selectedSubjectId)) {
        setSelectedSubjectId(null);
        setSelectedTagIds([]);
      }
      showToast("Subject deleted");
    });
  };

  // ---- Note handlers ----

  const resolveTagIds = (names, currentTags) => {
    const tags = [...currentTags];
    const ids = [];
    names.forEach(rawName => {
      const name = rawName.trim();
      if (!name) return;
      let existing = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!existing) {
        existing = {
          id: uid(),
          name
        };
        tags.push(existing);
      }
      ids.push(existing.id);
    });
    return {
      tags,
      ids: [...new Set(ids)]
    };
  };
  const toggleNoteSelection = id => {
    setSelectedNoteIdsForBulk(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);else next.add(id);
      return next;
    });
  };
  const applyBulkTag = async tagNamesToAdd => {
    if (selectedNoteIdsForBulk.size === 0 || tagNamesToAdd.length === 0) return;
    const {
      tags,
      ids: newTagIds
    } = resolveTagIds(tagNamesToAdd, data.tags);
    const notes = data.notes.map(n => selectedNoteIdsForBulk.has(n.id) ? {
      ...n,
      tagIds: [...new Set([...n.tagIds, ...newTagIds])],
      updatedAt: nowISO()
    } : n);
    await persist({
      ...data,
      tags,
      notes
    });
    showToast(`Added tag${tagNamesToAdd.length === 1 ? "" : "s"} to ${selectedNoteIdsForBulk.size} note${selectedNoteIdsForBulk.size === 1 ? "" : "s"}`);
    setShowBulkTag(false);
    setSelectedNoteIdsForBulk(new Set());
    setNoteSelectMode(false);
  };

  // Moves a batch of selected notes (and any cards created from them) to a
  // different subject in one operation — how splitting an over-large
  // subject into smaller sub-subjects actually happens: select the notes
  // that belong together, move them into a freshly-created sub-subject,
  // then archive that sub-subject on its own once it's not being studied.
  const applyBulkMove = async (mode, value) => {
    if (selectedNoteIdsForBulk.size === 0 || !value) return;
    let targetSubjectId = value;
    let subjects = data.subjects;
    if (mode === "new") {
      const parentId = selectedSubject.parentId || selectedSubject.id; // nest as a SIBLING of the current view, never a grandchild
      const newSubject = {
        id: uid(),
        name: value,
        color: selectedSubject.color,
        parentId,
        createdAt: nowISO()
      };
      subjects = [...data.subjects, newSubject];
      targetSubjectId = newSubject.id;
    }
    const notes = data.notes.map(n => selectedNoteIdsForBulk.has(n.id) ? {
      ...n,
      subjectId: targetSubjectId,
      updatedAt: nowISO()
    } : n);
    const cards = data.cards.map(c => (c.sourceNoteIds || []).some(nid => selectedNoteIdsForBulk.has(nid)) ? {
      ...c,
      subjectId: targetSubjectId
    } : c);
    const count = selectedNoteIdsForBulk.size;
    await persist({
      ...data,
      subjects,
      notes,
      cards
    });
    showToast(`Moved ${count} note${count === 1 ? "" : "s"}`);
    setShowBulkMove(false);
    setSelectedNoteIdsForBulk(new Set());
    setNoteSelectMode(false);
  };
  const saveNote = async (targetNote, {
    title,
    bodyHTML,
    tagNames,
    images,
    color,
    subjectId,
    linkedNoteIds
  }, opts = {}) => {
    const targetSubjectId = subjectId || targetNote && targetNote.subjectId || selectedSubjectId;
    if (!targetSubjectId) return;
    const {
      tags,
      ids
    } = resolveTagIds(tagNames, data.tags);
    let notes;
    let cards = data.cards;
    let savedNoteId;
    if (targetNote && targetNote.id) {
      savedNoteId = targetNote.id;
      const moved = targetSubjectId !== targetNote.subjectId;
      notes = data.notes.map(n => n.id === targetNote.id ? {
        ...n,
        title,
        bodyHTML,
        tagIds: ids,
        images,
        color,
        subjectId: targetSubjectId,
        linkedNoteIds: linkedNoteIds || [],
        updatedAt: nowISO()
      } : n);
      if (moved) {
        cards = data.cards.map(c => (c.sourceNoteIds || []).includes(targetNote.id) ? {
          ...c,
          subjectId: targetSubjectId
        } : c);
      }
    } else {
      savedNoteId = uid();
      const note = {
        id: savedNoteId,
        subjectId: targetSubjectId,
        title: title || "Untitled",
        bodyHTML,
        tagIds: ids,
        images: images || [],
        color: color || null,
        linkedNoteIds: linkedNoteIds || [],
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      notes = [...data.notes, note];
    }
    const sync = syncAutoCardsFromNote(cards, savedNoteId, targetSubjectId, bodyHTML, htmlToPlainText, nowISO, uid);
    cards = sync.cards;
    await persist({
      ...data,
      tags,
      notes,
      cards
    });
    const bits = [];
    if (sync.addedCount) bits.push(`${sync.addedCount} card${sync.addedCount === 1 ? "" : "s"} linked`);
    if (sync.removedCount) bits.push(`${sync.removedCount} removed`);
    if (!opts.silent) showToast("Note saved" + (bits.length ? " — " + bits.join(", ") : ""));
    return savedNoteId;
  };
  const quickAddNote = async (title, bodyHTML, tagNames, color, images, savedId) => {
    if (!selectedSubjectId) throw new Error("Pick a subject first");
    if (!noteHasContent(title, bodyHTML, images)) return;
    if (savedId) {
      // An autosave already created this note; finishing updates it instead of adding a second.
      await saveNote({
        id: savedId,
        subjectId: selectedSubjectId
      }, {
        title,
        bodyHTML,
        tagNames,
        images: images || [],
        color: color || null,
        subjectId: selectedSubjectId
      });
      return;
    }
    const {
      tags,
      ids
    } = resolveTagIds(tagNames, data.tags);
    const now = nowISO();
    const noteId = uid();
    const note = {
      id: noteId,
      subjectId: selectedSubjectId,
      title: (title || "").trim(),
      bodyHTML,
      tagIds: ids,
      images: images || [],
      color: color || null,
      linkedNoteIds: [],
      createdAt: now,
      updatedAt: now
    };
    const sync = syncAutoCardsFromNote(data.cards, noteId, selectedSubjectId, bodyHTML, htmlToPlainText, nowISO, uid);
    await persist({
      ...data,
      tags,
      notes: [...data.notes, note],
      cards: sync.cards
    });
    showToast(sync.addedCount ? `Note added — ${sync.addedCount} card${sync.addedCount === 1 ? "" : "s"} linked` : "Note added");
  };
  const deleteNote = id => {
    askConfirm("Delete this note?", async () => {
      const notes = data.notes.filter(n => n.id !== id).map(n => (n.linkedNoteIds || []).includes(id) ? {
        ...n,
        linkedNoteIds: n.linkedNoteIds.filter(lid => lid !== id)
      } : n);
      await persist({
        ...data,
        notes
      });
      showToast("Note deleted");
    });
  };
  const navigateToNote = noteId => {
    const target = data.notes.find(n => n.id === noteId);
    if (!target) return;
    setSelectedSubjectId(target.subjectId);
    setSelectedTagIds([]);
    setTab("notes");
    setEditingNote(target);
    setSplitPane(null);
  };
  const openSplitNote = noteId => {
    const target = data.notes.find(n => n.id === noteId);
    if (!target) return;
    setSplitPane({
      type: "note",
      note: target
    });
  };
  const openSplitCards = (noteId, subjectId) => {
    setSplitPane({
      type: "cards",
      noteId,
      subjectId,
      scope: "note"
    });
  };
  const splitPaneCards = useMemo(() => {
    if (!splitPane || splitPane.type !== "cards") return [];
    if (splitPane.scope === "subject") {
      return data.cards.filter(c => c.subjectId === splitPane.subjectId);
    }
    return data.cards.filter(c => (c.sourceNoteIds || []).includes(splitPane.noteId));
  }, [splitPane, data.cards]);
  const createCardFromHighlight = async (noteId, front, back) => {
    if (!noteId || !selectedSubjectId) return;
    const now = nowISO();
    const card = {
      id: uid(),
      subjectId: selectedSubjectId,
      front,
      back,
      sourceNoteIds: [noteId],
      box: 1,
      dueDate: now,
      starred: false,
      timesCorrect: 0,
      timesWrong: 0,
      createdAt: now
    };
    await persist({
      ...data,
      cards: [...data.cards, card]
    });
    showToast("Card created from highlight");
  };

  // ---- Export / share ----

  const exportNote = (note, mode) => {
    const tagNames = note.tagIds.map(tagName);
    if (mode === "copy") {
      copyText(noteToMarkdown(note, selectedSubject?.name, tagNames)).then(ok => showToast(ok ? "Copied as Markdown" : "Couldn't copy"));
    } else if (mode === "download") {
      download(`${slug(note.title)}.md`, noteToMarkdown(note, selectedSubject?.name, tagNames));
      showToast("Downloaded .md");
    } else if (mode === "pdf") {
      const imgHTML = (note.images || []).map(img => `<img src="${img.dataUrl}" style="max-width:100%;border-radius:8px;margin-top:10px;" />`).join("");
      printHTML(note.title, `<h1>${note.title}</h1><div class="meta">${selectedSubject?.name || ""} ${tagNames.length ? "· " + tagNames.map(t => "#" + t).join(" ") : ""}</div>${note.bodyHTML || ""}${imgHTML}`);
    } else if (mode === "share") {
      shareText(note.title, noteToMarkdown(note, selectedSubject?.name, tagNames)).then(result => {
        if (result === "shared") showToast("Shared");else if (result === "copied") showToast("Couldn't open share sheet — copied instead");else if (result === "failed") showToast("Couldn't share or copy");
      });
    }
  };
  const exportSubjectNotes = mode => {
    if (!selectedSubject) return;
    const subjNotes = data.notes.filter(n => n.subjectId === selectedSubject.id);
    if (mode === "md") {
      const md = subjNotes.map(n => noteToMarkdown(n, selectedSubject.name, n.tagIds.map(tagName))).join("\n\n---\n\n");
      download(`${slug(selectedSubject.name)}-all-notes.md`, md || `# ${selectedSubject.name}\n\n(no notes yet)`);
      showToast(`Exported ${subjNotes.length} note${subjNotes.length === 1 ? "" : "s"}`);
    } else if (mode === "pdf") {
      const bodyHTML = subjNotes.map(n => `<h1>${n.title}</h1><div class="meta">${n.tagIds.map(t => "#" + tagName(t)).join(" ")}</div>${n.bodyHTML || ""}<hr/>`).join("");
      printHTML(selectedSubject.name, bodyHTML || `<p>No notes yet in ${selectedSubject.name}.</p>`);
    }
  };
  const exportSubjectCards = mode => {
    if (!selectedSubject) return;
    const cards = data.cards.filter(c => c.subjectId === selectedSubject.id);
    if (mode === "md") {
      download(`${slug(selectedSubject.name)}-cards.txt`, cardsToSeparatorText(cards, "\t", "\n"), "text/plain");
      showToast(`Exported ${cards.length} card${cards.length === 1 ? "" : "s"} (tab-separated, Quizlet-ready)`);
    } else if (mode === "pdf") {
      const bodyHTML = `<h1>${selectedSubject.name} — flashcards</h1>` + cards.map(c => c.frontImage ? `<div class="card"><img src="${c.frontImage}" style="max-width:100%;border-radius:8px;margin-bottom:8px;" /><div class="back">${c.back}</div></div>` : `<div class="card"><div class="front">${c.front}</div><div class="back">${c.back}</div></div>`).join("");
      printHTML(selectedSubject.name + " cards", bodyHTML || "<p>No cards yet.</p>");
    } else if (mode === "share") {
      shareText(selectedSubject.name + " flashcards", cardsToSeparatorText(cards, " — ", "\n")).then(result => {
        if (result === "shared") showToast("Shared");else if (result === "copied") showToast("Couldn't open share sheet — copied instead");else if (result === "failed") showToast("Couldn't share or copy");
      });
    }
  };

  // Exports one subject (plus its sub-subjects) as a standalone,
  // re-importable data file — the "archive to free up space, bring back
  // later" workflow. Distinct from the full-database export/import pair:
  // this one is scoped, and importing it merges in rather than replacing
  // everything.
  const exportSubjectAsDataFile = subjectId => {
    const subject = data.subjects.find(s => s.id === subjectId);
    if (!subject) return;
    const subjectIds = [subjectId, ...data.subjects.filter(s => s.parentId === subjectId).map(s => s.id)];
    const subjectsToExport = data.subjects.filter(s => subjectIds.includes(s.id));
    const notesToExport = data.notes.filter(n => subjectIds.includes(n.subjectId));
    const cardsToExport = data.cards.filter(c => subjectIds.includes(c.subjectId));
    const usedTagIds = new Set();
    notesToExport.forEach(n => (n.tagIds || []).forEach(id => usedTagIds.add(id)));
    const tagsToExport = data.tags.filter(t => usedTagIds.has(t.id));
    const payload = {
      subjects: subjectsToExport,
      tags: tagsToExport,
      notes: notesToExport,
      cards: cardsToExport
    };
    const filename = `brainly-subject-${slug(subject.name)}-${nowISO().replace(/[:.]/g, "-")}.json`;
    download(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    showToast(`Exported "${subject.name}" — ${notesToExport.length} note${notesToExport.length === 1 ? "" : "s"}, ${cardsToExport.length} card${cardsToExport.length === 1 ? "" : "s"}`);
  };

  // Merges an imported file into the existing notebook rather than
  // replacing it — the counterpart to exportSubjectAsDataFile. Upserts by
  // ID (so re-importing an updated version of a subject you archived
  // correctly updates it, not duplicates it), dedupes tags by name so
  // re-importing doesn't create a second "labs" tag under a different ID,
  // and promotes any sub-subject whose parent isn't present in the merged
  // result to top-level, so it's never silently hidden.
  const mergeImportedData = async parsed => {
    const tagIdRemap = {};
    const tagsToAdd = [];
    parsed.tags.forEach(incomingTag => {
      const existingMatch = data.tags.find(t => t.name.toLowerCase() === incomingTag.name.toLowerCase());
      if (existingMatch) {
        tagIdRemap[incomingTag.id] = existingMatch.id;
      } else {
        const alreadyQueued = tagsToAdd.find(t => t.name.toLowerCase() === incomingTag.name.toLowerCase());
        if (alreadyQueued) {
          tagIdRemap[incomingTag.id] = alreadyQueued.id;
        } else {
          tagIdRemap[incomingTag.id] = incomingTag.id;
          tagsToAdd.push(incomingTag);
        }
      }
    });
    const remapTagIds = tagIds => [...new Set((tagIds || []).map(id => tagIdRemap[id] || id))];
    const mergeArrayById = (existing, incoming) => {
      const incomingIds = new Set(incoming.map(item => item.id));
      const kept = existing.filter(item => !incomingIds.has(item.id));
      return [...kept, ...incoming];
    };
    const remappedNotes = parsed.notes.map(n => ({
      ...n,
      tagIds: remapTagIds(n.tagIds)
    }));
    let mergedSubjects = mergeArrayById(data.subjects, parsed.subjects);
    const mergedSubjectIds = new Set(mergedSubjects.map(s => s.id));
    mergedSubjects = mergedSubjects.map(s => s.parentId && !mergedSubjectIds.has(s.parentId) ? {
      ...s,
      parentId: null
    } : s);
    let mergedCards = mergeArrayById(data.cards, parsed.cards);
    // Any "question :: answer" line in an imported note becomes a card in that subject's deck,
    // exactly as if the note had been saved here (so clipped pages arrive with their cards).
    remappedNotes.forEach(n => {
      mergedCards = syncAutoCardsFromNote(mergedCards, n.id, n.subjectId, n.bodyHTML, htmlToPlainText, nowISO, uid).cards;
    });
    const merged = {
      ...data,
      subjects: mergedSubjects,
      tags: [...data.tags, ...tagsToAdd],
      notes: mergeArrayById(data.notes, remappedNotes),
      cards: mergedCards
    };
    await persist(merged);
  };

  // ---- Card handlers ----

  const addCardsToDeck = async candidates => {
    if (!selectedSubjectId) return;
    const now = nowISO();
    const newCards = candidates.map(c => ({
      id: uid(),
      subjectId: selectedSubjectId,
      front: c.front,
      back: c.back,
      sourceNoteIds: [],
      box: 1,
      dueDate: now,
      starred: false,
      timesCorrect: 0,
      timesWrong: 0,
      createdAt: now
    }));
    await persist({
      ...data,
      cards: [...data.cards, ...newCards]
    });
    showToast(`Added ${newCards.length} card${newCards.length === 1 ? "" : "s"} to deck`);
  };
  const addOcclusionCards = async (partials, linkedNoteId) => {
    if (!selectedSubjectId) return;
    const now = nowISO();
    const noteId = linkedNoteId || occlusionSourceNoteId;
    const newCards = partials.map(p => ({
      id: uid(),
      subjectId: selectedSubjectId,
      front: "",
      back: p.back,
      frontImage: p.frontImage,
      backImage: p.backImage,
      sourceNoteIds: noteId ? [noteId] : [],
      box: 1,
      dueDate: now,
      starred: false,
      timesCorrect: 0,
      timesWrong: 0,
      createdAt: now
    }));
    await persist({
      ...data,
      cards: [...data.cards, ...newCards]
    });
    setShowOcclusion(false);
    setOcclusionSeedImage(null);
    setOcclusionSourceNoteId(null);
    showToast(`Created ${newCards.length} occlusion card${newCards.length === 1 ? "" : "s"}`);
  };
  const answerCard = async (cardId, correct) => {
    const next = {
      ...data,
      cards: data.cards.map(c => {
        if (c.id !== cardId) return c;
        if (correct) {
          const box = Math.min(c.box + 1, 5);
          return {
            ...c,
            box,
            dueDate: addDays(BOX_INTERVAL_DAYS[box]),
            timesCorrect: c.timesCorrect + 1
          };
        }
        return {
          ...c,
          box: 1,
          dueDate: addDays(BOX_INTERVAL_DAYS[1]),
          timesWrong: c.timesWrong + 1
        };
      })
    };
    await persist(next);
  };
  const toggleStar = async cardId => {
    await persist({
      ...data,
      cards: data.cards.map(c => c.id === cardId ? {
        ...c,
        starred: !c.starred
      } : c)
    });
  };
  const updateCard = async (cardId, front, back) => {
    await persist({
      ...data,
      cards: data.cards.map(c => c.id === cardId ? {
        ...c,
        front,
        back
      } : c)
    });
    setEditingCard(null);
    showToast("Card updated");
  };
  const deleteCard = cardId => {
    askConfirm("Delete this card?", async () => {
      await persist({
        ...data,
        cards: data.cards.filter(c => c.id !== cardId)
      });
      showToast("Card deleted");
    });
  };
  const toggleTagFilter = id => {
    setSelectedTagIds(cur => cur.includes(id) ? cur.filter(t => t !== id) : [...cur, id]);
  };
  const toggleCardSelection = id => {
    setManualSelectedCardIds(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);else next.add(id);
      return next;
    });
  };
  const clearCardSelection = () => setManualSelectedCardIds(new Set());
  const toggleTheme = async () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try {
      await storage.set(THEME_KEY, next);
    } catch (e) {
      // theme still applies for this session even if it doesn't persist
    }
  };
  const toggleReminders = async () => {
    if (remindersOn) {
      setRemindersOn(false);
      try {
        await storage.set(REMINDERS_KEY, "off");
      } catch (e) {}
      return;
    }
    if (typeof Notification === "undefined") {
      showToast("This browser doesn't support notifications.");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      showToast("Notifications are blocked — enable them in your browser/site settings to use this.");
      return;
    }
    setRemindersOn(true);
    try {
      await storage.set(REMINDERS_KEY, "on");
    } catch (e) {}
    showToast("Study reminders on — you'll get a nudge while Brainly is open and cards are due.");
  };

  // Lets a native wrapper (the Android app) schedule background reminders; no-op on the web.
  useEffect(() => {
    if (window.brainlyOnDueChange) window.brainlyOnDueChange(remindersOn, allDueCards.length);
  }, [remindersOn, allDueCards.length]);

  // Fires a local notification when cards are overdue. Only works while this
  // tab/app is actually open and running — a static site with no backend
  // can't send a true push notification while the app is fully closed.
  useEffect(() => {
    if (!remindersOn || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notifyIfDue = () => {
      if (allDueCards.length > 0 && document.visibilityState !== "visible") {
        try {
          new Notification("Brainly", {
            body: `${allDueCards.length} card${allDueCards.length === 1 ? "" : "s"} due for review`
          });
        } catch (e) {
          // notification construction can fail in some contexts; fail silently
        }
      }
    };
    const interval = setInterval(notifyIfDue, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [remindersOn, allDueCards.length]);
  if (!ready) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Inter', sans-serif",
        padding: 40,
        color: "#8B87A6"
      }
    }, "loading brainly\u2026");
  }
  if (pinLockAvailable() && data.security && data.security.enabled && !unlocked) {
    return /*#__PURE__*/React.createElement("div", {
      className: "brainly-root" + (theme === "dark" ? " dark" : "")
    }, /*#__PURE__*/React.createElement(Styles, null), /*#__PURE__*/React.createElement(LockScreen, {
      pinHash: data.security.pinHash,
      onUnlock: () => setUnlocked(true)
    }));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "brainly-root" + (theme === "dark" ? " dark" : "")
  }, /*#__PURE__*/React.createElement(Styles, null), /*#__PURE__*/React.createElement("aside", {
    className: "sidebar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand"
  }, /*#__PURE__*/React.createElement("span", {
    className: "brand-mark"
  }, "\u2726"), /*#__PURE__*/React.createElement("span", {
    className: "brand-name"
  }, "Brainly")), /*#__PURE__*/React.createElement("div", {
    className: "brand-sub"
  }, "notes, tags & cards that stick"), /*#__PURE__*/React.createElement("button", {
    className: "home-nav-btn" + (!selectedSubjectId ? " active" : ""),
    onClick: () => {
      setSelectedSubjectId(null);
      setSelectedTagIds([]);
    }
  }, /*#__PURE__*/React.createElement(NavIcon, {
    name: "home"
  }), " Home"), /*#__PURE__*/React.createElement("button", {
    className: "home-nav-btn" + (showFilesPage ? " active" : ""),
    onClick: () => {
      setSelectedSubjectId(FILES_VIEW);
      setSelectedTagIds([]);
    }
  }, /*#__PURE__*/React.createElement(NavIcon, {
    name: "files"
  }), " Files"), /*#__PURE__*/React.createElement("div", {
    className: "subject-list"
  }, topSubjects.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "empty-hint"
  }, "No subjects yet. Start one below."), topSubjects.map(s => {
    const children = childSubjects(s.id);
    const hasChildren = children.length > 0;
    const childIsSelected = children.some(c => c.id === selectedSubjectId);
    const isExpanded = expandedSubjects.has(s.id) || childIsSelected;
    return /*#__PURE__*/React.createElement("div", {
      key: s.id
    }, /*#__PURE__*/React.createElement("button", {
      className: "subject-item" + (s.id === selectedSubjectId ? " active" : ""),
      style: {
        "--accent": s.color
      },
      onClick: () => {
        setSelectedSubjectId(s.id);
        setSelectedTagIds([]);
        setQuery("");
        setStudyScope("due");
        setSelectedNoteFilter(null);
        setManualSelectedCardIds(new Set());
      }
    }, hasChildren && /*#__PURE__*/React.createElement("span", {
      className: "subject-expand-toggle" + (isExpanded ? " expanded" : ""),
      onClick: e => {
        e.stopPropagation();
        toggleSubjectExpanded(s.id);
      }
    }, "\u25B8"), /*#__PURE__*/React.createElement("span", {
      className: "dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "subject-label"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "subject-count"
    }, data.notes.filter(n => n.subjectId === s.id).length)), hasChildren && isExpanded && /*#__PURE__*/React.createElement("div", {
      className: "subject-children"
    }, children.map(c => /*#__PURE__*/React.createElement("button", {
      key: c.id,
      className: "subject-item child" + (c.id === selectedSubjectId ? " active" : ""),
      style: {
        "--accent": c.color
      },
      onClick: () => {
        setSelectedSubjectId(c.id);
        setSelectedTagIds([]);
        setQuery("");
        setStudyScope("due");
        setSelectedNoteFilter(null);
        setManualSelectedCardIds(new Set());
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "subject-label"
    }, c.name), /*#__PURE__*/React.createElement("span", {
      className: "subject-count"
    }, data.notes.filter(n => n.subjectId === c.id).length)))));
  })), showNewSubject ? /*#__PURE__*/React.createElement("div", {
    className: "new-subject-form"
  }, /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    placeholder: "Subject name",
    value: newSubjectName,
    onChange: e => setNewSubjectName(e.target.value),
    onKeyDown: e => e.key === "Enter" && createSubject()
  }), topSubjects.length > 0 && /*#__PURE__*/React.createElement("select", {
    className: "parent-select",
    value: newSubjectParentId || "",
    onChange: e => setNewSubjectParentId(e.target.value || null)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "No parent (top-level)"), topSubjects.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.id,
    value: s.id
  }, "Sub-subject of ", s.name))), /*#__PURE__*/React.createElement("div", {
    className: "color-row"
  }, SUBJECT_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.hex,
    className: "swatch" + (newSubjectColor === c.hex ? " selected" : ""),
    style: {
      background: c.hex
    },
    title: c.name,
    onClick: () => setNewSubjectColor(c.hex)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "form-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: () => setShowNewSubject(false)
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: createSubject
  }, "Add"))) : /*#__PURE__*/React.createElement("button", {
    className: "add-subject-btn",
    onClick: () => setShowNewSubject(true)
  }, "+ New subject"), saveError && /*#__PURE__*/React.createElement("div", {
    className: "save-error"
  }, "Couldn't save \u2014 check storage/connection."), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "icon-toggle-btn",
    onClick: toggleTheme,
    title: theme === "dark" ? "Switch to light" : "Switch to dark"
  }, /*#__PURE__*/React.createElement(NavIcon, {
    name: theme === "dark" ? "sun" : "moon"
  }), " ", theme === "dark" ? "Light mode" : "Dark mode"), /*#__PURE__*/React.createElement("button", {
    className: "icon-toggle-btn" + (remindersOn ? " on" : ""),
    onClick: toggleReminders,
    title: "Notify me about overdue cards while Brainly is open"
  }, /*#__PURE__*/React.createElement(NavIcon, {
    name: remindersOn ? "bell" : "bell-off"
  }), " ", remindersOn ? "Reminders on" : "Reminders off"), pinLockAvailable() && /*#__PURE__*/React.createElement("div", {
    className: "pin-lock-section"
  }, !(data.security && data.security.enabled) ? /*#__PURE__*/React.createElement("button", {
    className: "icon-toggle-btn",
    onClick: () => setShowPinModal("set")
  }, /*#__PURE__*/React.createElement(NavIcon, {
    name: "lock"
  }), " Set a passcode") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    className: "icon-toggle-btn on",
    disabled: true
  }, /*#__PURE__*/React.createElement(NavIcon, {
    name: "lock"
  }), " Passcode enabled"), /*#__PURE__*/React.createElement("div", {
    className: "pin-lock-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setShowPinModal("change")
  }, "Change"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setShowPinModal("remove")
  }, "Remove")))))), /*#__PURE__*/React.createElement("main", {
    className: "main"
  }, allDueCards.length > 0 && /*#__PURE__*/React.createElement("button", {
    className: "overdue-banner",
    onClick: () => {
      setCrossTagSession({
        tagName: "Overdue across all subjects",
        cards: allDueCards
      });
      setShowReview(true);
    }
  }, /*#__PURE__*/React.createElement("span", null, "\u23F0 ", allDueCards.length, " card", allDueCards.length === 1 ? "" : "s", " overdue across your subjects"), /*#__PURE__*/React.createElement("span", {
    className: "overdue-banner-cta"
  }, "Review now \u2192")), showFilesPage ? /*#__PURE__*/React.createElement(FilesPage, {
    exportBusy: deviceExportBusy,
    onExport: exportEverythingToDevice,
    importBusy: importBusy,
    onImportFile: handleImportFile,
    subjectImportBusy: subjectImportBusy,
    onImportSubjectFile: handleImportSubjectFile,
    kindleImportBusy: kindleImportBusy,
    onKindleFile: handleKindleImportFile,
    onPdfFile: handlePdfFilePicked,
    mdImportBusy: mdImportBusy,
    onMarkdownFile: handleMarkdownImportFile,
    onAddArticle: () => setShowAddArticle(true)
  }) : !selectedSubject ? /*#__PURE__*/React.createElement(Dashboard, {
    subjects: data.subjects,
    notes: data.notes,
    weakSpots: weakSpots,
    tagName: tagName,
    onNavigate: (subjectId, tagId) => {
      setSelectedSubjectId(subjectId);
      setSelectedTagIds([tagId]);
      setTab("study");
    },
    onNewSubject: () => setShowNewSubject(true),
    globalTagStats: globalTagStats,
    onStudyTag: (tagId, tagName2, mode) => {
      const cards = cardsByTagAcrossSubjects(tagId);
      if (cards.length === 0) return;
      setCrossTagSession({
        tagName: tagName2,
        cards
      });
      if (mode === "match") setShowMatch(true);else setShowReview(true);
    },
    dueForecast: dueForecast,
    onOpenNote: navigateToNote
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("header", {
    className: "main-header"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "eyebrow",
    style: {
      color: selectedSubject.color
    }
  }, "Subject"), /*#__PURE__*/React.createElement("h1", null, selectedSubject.name)), /*#__PURE__*/React.createElement("div", {
    className: "header-actions"
  }, tab === "notes" ? /*#__PURE__*/React.createElement(ExportMenu, {
    label: "Export subject",
    onCopy: null,
    onDownload: () => exportSubjectNotes("md"),
    onPdf: () => exportSubjectNotes("pdf"),
    onShare: null
  }) : /*#__PURE__*/React.createElement(ExportMenu, {
    label: "Export cards",
    onCopy: null,
    onDownload: () => exportSubjectCards("md"),
    onPdf: () => exportSubjectCards("pdf"),
    onShare: () => exportSubjectCards("share")
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => exportSubjectAsDataFile(selectedSubject.id),
    title: "Save this subject (and its notes/cards) as a file you can bring back in later \u2014 frees up space without losing anything"
  }, "\uD83D\uDCBE Archive to file"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small danger",
    onClick: () => deleteSubject(selectedSubject.id)
  }, "Delete subject"))), /*#__PURE__*/React.createElement("div", {
    className: "section-divider",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("div", {
    className: "tab-bar"
  }, /*#__PURE__*/React.createElement("button", {
    className: "tab-btn" + (tab === "notes" ? " active" : ""),
    onClick: () => setTab("notes")
  }, "Notes"), /*#__PURE__*/React.createElement("button", {
    className: "tab-btn" + (tab === "study" ? " active" : ""),
    onClick: () => setTab("study")
  }, "Study ", dueCards.length > 0 && /*#__PURE__*/React.createElement("span", {
    className: "tab-badge"
  }, dueCards.length))), tab === "notes" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(QuickAddNote, {
    key: selectedSubject.id,
    onAdd: quickAddNote,
    onAutoSave: (p, savedId) => saveNote(savedId ? {
      id: savedId,
      subjectId: selectedSubject.id
    } : null, {
      ...p,
      subjectId: selectedSubject.id
    }, {
      silent: true
    }),
    onViewImage: setLightboxImage,
    onImageError: () => showToast("Couldn't load that image — try saving it to your device first, then use + Add image."),
    onSaveError: showToast
  }), /*#__PURE__*/React.createElement("div", {
    className: "filters"
  }, /*#__PURE__*/React.createElement("input", {
    className: "search",
    placeholder: "Search this subject\u2026",
    value: query,
    onChange: e => setQuery(e.target.value)
  }), subjectTags.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "tag-filters"
  }, subjectTags.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    className: "tag-chip" + (selectedTagIds.includes(t.id) ? " active" : ""),
    onClick: () => toggleTagFilter(t.id)
  }, "#", t.name)))), /*#__PURE__*/React.createElement("div", {
    className: "bulk-select-row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (noteSelectMode ? " active-toggle" : ""),
    onClick: () => {
      setNoteSelectMode(m => !m);
      setSelectedNoteIdsForBulk(new Set());
    }
  }, noteSelectMode ? "Cancel" : "Select"), noteSelectMode && selectedNoteIdsForBulk.size > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "bulk-select-count"
  }, selectedNoteIdsForBulk.size, " selected"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary small",
    onClick: () => setShowBulkTag(true)
  }, "+ Add tag"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setShowBulkMove(true)
  }, "Move to subject"))), visibleNotes.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "empty-state small"
  }, /*#__PURE__*/React.createElement("p", null, data.notes.some(n => n.subjectId === selectedSubject.id) ? "No notes match this filter." : "No notes in this subject yet. Add one above.")) : /*#__PURE__*/React.createElement("div", {
    className: "note-grid"
  }, visibleNotes.map(n => /*#__PURE__*/React.createElement("article", {
    key: n.id,
    className: "note-card" + (noteSelectMode && selectedNoteIdsForBulk.has(n.id) ? " select-active" : ""),
    style: {
      background: n.color || "var(--surface)",
      "--note-ink": n.color ? "#241C3D" : undefined,
      "--note-muted": n.color ? "rgba(36,28,61,0.65)" : undefined
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "note-card-top",
    onClick: () => noteSelectMode ? toggleNoteSelection(n.id) : setEditingNote(n)
  }, noteSelectMode && /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    className: "note-select-checkbox",
    checked: selectedNoteIdsForBulk.has(n.id),
    onChange: () => toggleNoteSelection(n.id),
    onClick: e => e.stopPropagation()
  }), /*#__PURE__*/React.createElement("span", {
    className: "note-card-subject-dot",
    style: {
      background: selectedSubject.color
    }
  }), /*#__PURE__*/React.createElement("h3", null, n.title), /*#__PURE__*/React.createElement("div", {
    className: "note-card-preview",
    dangerouslySetInnerHTML: {
      __html: n.bodyHTML || ""
    }
  }), n.images && n.images.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "note-thumb-strip"
  }, n.images.slice(0, 3).map(img => /*#__PURE__*/React.createElement("img", {
    key: img.id,
    src: img.dataUrl,
    alt: "",
    className: "note-thumb",
    onClick: e => {
      e.stopPropagation();
      setLightboxImage(img.dataUrl);
    }
  })), n.images.length > 3 && /*#__PURE__*/React.createElement("span", {
    className: "note-thumb-more"
  }, "+", n.images.length - 3))), n.tagIds.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "note-card-tags"
  }, n.tagIds.map(tid => /*#__PURE__*/React.createElement("span", {
    key: tid,
    className: "tag-pill"
  }, "#", tagName(tid)))), /*#__PURE__*/React.createElement("div", {
    className: "note-card-footer"
  }, /*#__PURE__*/React.createElement("span", {
    className: "note-date"
  }, formatDate(n.updatedAt), ((n.linkedNoteIds || []).length > 0 || data.notes.some(o => o.id !== n.id && (o.linkedNoteIds || []).includes(n.id))) && /*#__PURE__*/React.createElement("span", {
    className: "note-link-badge",
    title: "This note has links"
  }, "\uD83D\uDD17")), /*#__PURE__*/React.createElement("div", {
    className: "note-card-actions"
  }, /*#__PURE__*/React.createElement(ExportMenu, {
    compact: true,
    onCopy: () => exportNote(n, "copy"),
    onDownload: () => exportNote(n, "download"),
    onPdf: () => exportNote(n, "pdf"),
    onShare: () => exportNote(n, "share")
  }), /*#__PURE__*/React.createElement("button", {
    title: "Edit",
    onClick: () => setEditingNote(n)
  }, "\u270E"), /*#__PURE__*/React.createElement("button", {
    title: "Delete",
    onClick: () => deleteNote(n.id)
  }, "\u2715"))))))) : /*#__PURE__*/React.createElement(React.Fragment, null, subjectTags.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "tag-filters study-tag-filters"
  }, subjectTags.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    className: "tag-chip" + (selectedTagIds.includes(t.id) ? " active" : ""),
    onClick: () => toggleTagFilter(t.id)
  }, "#", t.name))), /*#__PURE__*/React.createElement(StudyPanel, {
    subject: selectedSubject,
    notes: data.notes.filter(n => n.subjectId === selectedSubject.id),
    cards: subjectCards,
    dueCount: dueCards.length,
    missedCount: missedCards.length,
    points: totalPoints,
    onImport: () => setShowImportCards(true),
    onReview: () => setShowReview(true),
    onMatch: () => setShowMatch(true),
    onOcclusion: () => {
      setOcclusionSeedImage(null);
      setOcclusionSourceNoteId(null);
      setShowOcclusion(true);
    },
    onToggleStar: toggleStar,
    onDelete: deleteCard,
    onEdit: c => setEditingCard(c),
    scope: studyScope,
    onScopeChange: setStudyScope,
    notesWithCards: notesWithCards,
    noteFilter: selectedNoteFilter,
    onNoteFilterChange: setSelectedNoteFilter,
    selectedCardIds: manualSelectedCardIds,
    onToggleCardSelect: toggleCardSelection,
    onClearSelection: clearCardSelection
  })))), editingNote !== null && /*#__PURE__*/React.createElement("div", {
    className: "note-editor-fullscreen-wrap"
  }, /*#__PURE__*/React.createElement(NoteEditor, {
    key: editingNote.id || "new",
    note: editingNote,
    allTags: data.tags,
    existingTagIds: editingNote.tagIds || [],
    tagName: tagName,
    subjectOptions: flatSubjectOptions,
    currentSubjectId: editingNote.subjectId || selectedSubjectId,
    allNotes: data.notes,
    subjects: data.subjects,
    onCancel: () => {
      setEditingNote(null);
      setSplitPane(null);
    },
    onAutoSave: (payload, savedId) => saveNote(savedId ? {
      ...editingNote,
      id: savedId
    } : editingNote, payload, {
      silent: true
    }),
    onSave: async (payload, savedId) => {
      await saveNote(savedId ? {
        ...editingNote,
        id: savedId
      } : editingNote, payload);
      setEditingNote(null);
      setSplitPane(null);
    },
    onCreateCard: (noteId, front, back) => createCardFromHighlight(noteId, front, back),
    onOccludeImage: (dataUrl, noteId) => {
      setOcclusionSeedImage(dataUrl);
      setOcclusionSourceNoteId(noteId);
      setEditingNote(null);
      setSplitPane(null);
      setShowOcclusion(true);
    },
    onViewImage: setLightboxImage,
    onNavigateToNote: navigateToNote,
    onSplitWithNote: openSplitNote,
    onSplitWithCards: openSplitCards,
    isSplitPane: false,
    onImageError: () => showToast("Couldn't load that image — try saving it to your device first, then use + Add image.")
  }), splitPane && splitPane.type === "note" && /*#__PURE__*/React.createElement(NoteEditor, {
    key: "split-" + splitPane.note.id,
    note: splitPane.note,
    allTags: data.tags,
    existingTagIds: splitPane.note.tagIds || [],
    tagName: tagName,
    subjectOptions: flatSubjectOptions,
    currentSubjectId: splitPane.note.subjectId,
    allNotes: data.notes,
    subjects: data.subjects,
    onCancel: () => setSplitPane(null),
    onAutoSave: (payload, savedId) => saveNote(savedId ? {
      ...splitPane.note,
      id: savedId
    } : splitPane.note, payload, {
      silent: true
    }),
    onSave: async (payload, savedId) => {
      await saveNote(savedId ? {
        ...splitPane.note,
        id: savedId
      } : splitPane.note, payload);
      setSplitPane(null);
    },
    onCreateCard: (noteId, front, back) => createCardFromHighlight(noteId, front, back),
    onOccludeImage: (dataUrl, noteId) => {
      setOcclusionSeedImage(dataUrl);
      setOcclusionSourceNoteId(noteId);
      setEditingNote(null);
      setSplitPane(null);
      setShowOcclusion(true);
    },
    onViewImage: setLightboxImage,
    onNavigateToNote: navigateToNote,
    isSplitPane: true,
    onImageError: () => showToast("Couldn't load that image — try saving it to your device first, then use + Add image.")
  }), splitPane && splitPane.type === "cards" && /*#__PURE__*/React.createElement(SplitCardsPanel, {
    cards: splitPaneCards,
    scope: splitPane.scope,
    onScopeChange: scope => setSplitPane(p => ({
      ...p,
      scope
    })),
    noteTitle: (data.notes.find(n => n.id === splitPane.noteId) || {}).title || "",
    subjectTitle: (data.subjects.find(s => s.id === splitPane.subjectId) || {}).name || "",
    onClose: () => setSplitPane(null),
    onEditCard: c => setEditingCard(c),
    onToggleStar: toggleStar,
    onDeleteCard: deleteCard,
    onStudy: () => {
      if (splitPaneCards.length === 0) return;
      setCrossTagSession({
        tagName: splitPane.scope === "subject" ? (data.subjects.find(s => s.id === splitPane.subjectId) || {}).name : "this note",
        cards: splitPaneCards
      });
      setShowReview(true);
    }
  })), editingCard !== null && /*#__PURE__*/React.createElement(CardEditor, {
    card: editingCard,
    onCancel: () => setEditingCard(null),
    onSave: updateCard
  }), confirmDialog && /*#__PURE__*/React.createElement(ConfirmDialog, {
    message: confirmDialog.message,
    confirmLabel: confirmDialog.confirmLabel,
    onCancel: () => setConfirmDialog(null),
    onConfirm: () => {
      confirmDialog.onConfirm();
      setConfirmDialog(null);
    }
  }), pdfImportFile && /*#__PURE__*/React.createElement(PdfImportModal, {
    filename: pdfImportFile.name,
    busy: pdfImportBusy,
    error: pdfImportError,
    onCancel: () => {
      setPdfImportFile(null);
      setPdfImportError("");
    },
    onConfirm: confirmPdfImport
  }), showAddArticle && /*#__PURE__*/React.createElement(AddArticleModal, {
    busy: articleImportBusy,
    error: articleImportError,
    onCancel: () => {
      setShowAddArticle(false);
      setArticleImportError("");
    },
    onConfirm: handleAddArticleConfirm
  }), showPinModal && /*#__PURE__*/React.createElement(PinModal, {
    mode: showPinModal,
    onVerify: verifyPin,
    onSetNew: savePin,
    onCancel: () => setShowPinModal(null)
  }), showBulkTag && /*#__PURE__*/React.createElement(BulkTagModal, {
    count: selectedNoteIdsForBulk.size,
    allTags: data.tags,
    onCancel: () => setShowBulkTag(false),
    onApply: applyBulkTag
  }), showBulkMove && selectedSubject && /*#__PURE__*/React.createElement(BulkMoveModal, {
    count: selectedNoteIdsForBulk.size,
    subjectOptions: flatSubjectOptions.filter(s => s.id !== selectedSubject.id),
    onCancel: () => setShowBulkMove(false),
    onApply: applyBulkMove
  }), lightboxImage && /*#__PURE__*/React.createElement(ImageLightbox, {
    src: lightboxImage,
    onClose: () => setLightboxImage(null)
  }), showImportCards && selectedSubject && /*#__PURE__*/React.createElement(ImportCardsModal, {
    onCancel: () => setShowImportCards(false),
    onConfirm: async cards => {
      await addCardsToDeck(cards);
      setShowImportCards(false);
    }
  }), showOcclusion && selectedSubject && /*#__PURE__*/React.createElement(OcclusionCreator, {
    initialImage: occlusionSeedImage,
    initialNoteId: occlusionSourceNoteId,
    notes: data.notes.filter(n => n.subjectId === selectedSubject.id),
    onCancel: () => {
      setShowOcclusion(false);
      setOcclusionSeedImage(null);
      setOcclusionSourceNoteId(null);
    },
    onCreate: addOcclusionCards
  }), showReview && (selectedSubject || crossTagSession) && /*#__PURE__*/React.createElement(ReviewSession, {
    cards: crossTagSession ? crossTagSession.cards : studyCards,
    onAnswer: answerCard,
    onToggleStar: toggleStar,
    onClose: () => {
      setShowReview(false);
      setCrossTagSession(null);
    }
  }), showMatch && (selectedSubject || crossTagSession) && /*#__PURE__*/React.createElement(MatchGame, {
    cards: crossTagSession ? crossTagSession.cards : studyCards,
    onClose: () => {
      setShowMatch(false);
      setCrossTagSession(null);
    }
  }), toast && /*#__PURE__*/React.createElement("div", {
    className: "toast"
  }, toast));
}

// ---------- Dashboard ----------

function Dashboard({
  subjects,
  notes,
  weakSpots,
  tagName,
  onNavigate,
  onNewSubject,
  globalTagStats,
  onStudyTag,
  dueForecast,
  onOpenNote
}) {
  const [homeSearch, setHomeSearch] = useState("");
  const subjectName = id => subjects.find(s => s.id === id)?.name || "—";
  const subjectColor = id => subjects.find(s => s.id === id)?.color || "#3E7CAB";
  const subjectPath = id => {
    const s = subjects.find(s => s.id === id);
    if (!s) return "—";
    if (!s.parentId) return s.name;
    const parent = subjects.find(p => p.id === s.parentId);
    return parent ? `${parent.name} › ${s.name}` : s.name;
  };
  const forecastMax = dueForecast ? Math.max(1, ...dueForecast.map(d => d.count)) : 1;
  const searchResults = useMemo(() => {
    const q = homeSearch.trim().toLowerCase();
    if (!q || !notes) return [];
    return notes.map(n => {
      const bodyText = htmlToPlainText(n.bodyHTML || "");
      const titleHit = n.title.toLowerCase().includes(q);
      const bodyHit = bodyText.toLowerCase().includes(q);
      const tagHit = (n.tagIds || []).some(tid => tagName(tid).toLowerCase().includes(q));
      if (!titleHit && !bodyHit && !tagHit) return null;
      return {
        note: n,
        snippet: bodyHit ? extractSnippet(bodyText, q) : ""
      };
    }).filter(Boolean).slice(0, 30);
  }, [homeSearch, notes, tagName]);
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard"
  }, /*#__PURE__*/React.createElement("div", {
    className: "eyebrow",
    style: {
      color: "#3E7CAB"
    }
  }, "Home"), /*#__PURE__*/React.createElement("h1", null, "Your chart at a glance"), /*#__PURE__*/React.createElement("input", {
    className: "home-search-input",
    placeholder: "Search notes, tags, anything\u2026",
    value: homeSearch,
    onChange: e => setHomeSearch(e.target.value)
  }), homeSearch.trim() ? /*#__PURE__*/React.createElement("div", {
    className: "home-search-results"
  }, searchResults.length === 0 ? /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, "No matches for \"", homeSearch.trim(), "\".") : searchResults.map(({
    note,
    snippet
  }) => /*#__PURE__*/React.createElement("button", {
    key: note.id,
    className: "home-search-result",
    onClick: () => onOpenNote(note.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "home-search-result-top"
  }, /*#__PURE__*/React.createElement("span", {
    className: "home-search-result-title"
  }, note.title), /*#__PURE__*/React.createElement("span", {
    className: "home-search-result-location"
  }, subjectPath(note.subjectId))), snippet && /*#__PURE__*/React.createElement("p", {
    className: "home-search-result-snippet"
  }, snippet), note.tagIds && note.tagIds.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "home-search-result-tags"
  }, note.tagIds.map(tid => /*#__PURE__*/React.createElement("span", {
    key: tid,
    className: "tag-pill"
  }, "#", tagName(tid))))))) : subjects.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "empty-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "empty-mark"
  }, "\u2726"), /*#__PURE__*/React.createElement("h2", null, "Nothing here yet"), /*#__PURE__*/React.createElement("p", null, "Create a subject on the left, then start adding notes."), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: onNewSubject,
    style: {
      marginTop: 12
    }
  }, "+ New subject")) : /*#__PURE__*/React.createElement(React.Fragment, null, dueForecast && dueForecast.some(d => d.count > 0) && /*#__PURE__*/React.createElement("div", {
    className: "forecast-section"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "dashboard-subheading"
  }, "Coming up"), /*#__PURE__*/React.createElement("div", {
    className: "forecast-row"
  }, dueForecast.map(d => /*#__PURE__*/React.createElement("div", {
    key: d.label,
    className: "forecast-day"
  }, /*#__PURE__*/React.createElement("div", {
    className: "forecast-bar-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "forecast-bar" + (d.count === 0 ? " zero" : ""),
    style: {
      height: `${Math.max(4, d.count / forecastMax * 100)}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "forecast-count"
  }, d.count), /*#__PURE__*/React.createElement("span", {
    className: "forecast-label"
  }, d.label))))), globalTagStats.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "tag-study-section"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "dashboard-subheading"
  }, "Study by tag"), /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, "Every card with this tag, no matter which subject it's filed under."), /*#__PURE__*/React.createElement("div", {
    className: "tag-study-list"
  }, globalTagStats.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    className: "tag-study-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "tag-pill"
  }, "#", t.name), /*#__PURE__*/React.createElement("span", {
    className: "tag-study-count"
  }, t.count, " card", t.count === 1 ? "" : "s"), /*#__PURE__*/React.createElement("div", {
    className: "tag-study-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => onStudyTag(t.id, t.name, "review")
  }, "Cards"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    disabled: t.count < 4,
    onClick: () => onStudyTag(t.id, t.name, "match")
  }, "Match")))))), weakSpots.length === 0 ? /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, "Once you've reviewed some cards, this will show which tags you're weakest on so you know what to cram.") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h2", {
    className: "dashboard-subheading"
  }, "Weakest tags"), /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, "Based on your review accuracy \u2014 lowest first."), /*#__PURE__*/React.createElement("table", {
    className: "weak-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Subject"), /*#__PURE__*/React.createElement("th", null, "Tag"), /*#__PURE__*/React.createElement("th", null, "Accuracy"), /*#__PURE__*/React.createElement("th", null, "Attempts"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, weakSpots.map(w => /*#__PURE__*/React.createElement("tr", {
    key: w.subjectId + w.tagId
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "weak-subject-dot",
    style: {
      background: subjectColor(w.subjectId)
    }
  }), subjectName(w.subjectId)), /*#__PURE__*/React.createElement("td", null, "#", tagName(w.tagId)), /*#__PURE__*/React.createElement("td", {
    className: w.accuracy < 0.6 ? "weak-accuracy-low" : ""
  }, Math.round(w.accuracy * 100), "%"), /*#__PURE__*/React.createElement("td", null, w.attempts), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => onNavigate(w.subjectId, w.tagId)
  }, "Review")))))))));
}

// ---------- Export menu ----------

// The one place for getting files in and out: download a backup, upload one, move a single
// subject, and import from other apps — with the steps spelled out, since moving a library
// between devices (via a backup file kept in Google Drive) is how Brainly stays portable.
function FilesPage({
  exportBusy,
  onExport,
  importBusy,
  onImportFile,
  subjectImportBusy,
  onImportSubjectFile,
  kindleImportBusy,
  onKindleFile,
  onPdfFile,
  mdImportBusy,
  onMarkdownFile,
  onAddArticle
}) {
  const [aiSettings, setAiSettings] = useState({
    apiKey: "",
    model: AI_MODELS[0].id
  });
  useEffect(() => {
    loadAiSettings().then(setAiSettings);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "files-page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "eyebrow",
    style: {
      color: "#3E7CAB"
    }
  }, "Files"), /*#__PURE__*/React.createElement("h1", null, "Download & upload"), /*#__PURE__*/React.createElement("p", {
    className: "files-lede"
  }, "Brainly keeps your notes on this device. To carry them with you, download a backup file, keep it in your Google Drive, and upload it on any other device."), /*#__PURE__*/React.createElement("p", {
    className: "files-tip"
  }, /*#__PURE__*/React.createElement("b", null, "Tip:"), " on your phone, every upload button opens Android's file picker \u2014 tap ", /*#__PURE__*/React.createElement("b", null, "Drive"), " there to browse your folders and pick a file. On a computer, Drive for desktop shows your Drive as a drive letter you can browse from the picker."), /*#__PURE__*/React.createElement("section", {
    className: "files-card"
  }, /*#__PURE__*/React.createElement("h2", null, "1 \xB7 Download a backup"), /*#__PURE__*/React.createElement("p", null, "Saves all your subjects, notes, images and flashcards as one file."), /*#__PURE__*/React.createElement("div", {
    className: "files-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: onExport,
    disabled: exportBusy
  }, exportBusy ? "Preparing…" : "⬇ Download backup")), /*#__PURE__*/React.createElement("ol", {
    className: "files-steps"
  }, /*#__PURE__*/React.createElement("li", null, "Tap ", /*#__PURE__*/React.createElement("b", null, "Download backup"), ". A file named ", /*#__PURE__*/React.createElement("code", null, "brainly-export-\u2026json"), " is saved to your Downloads folder (or wherever you choose)."), /*#__PURE__*/React.createElement("li", null, "Open Google Drive (the app, or drive.google.com) \u2192 ", /*#__PURE__*/React.createElement("b", null, "New \u2192 File upload"), " \u2192 pick that file."), /*#__PURE__*/React.createElement("li", null, "Repeat whenever you want a fresh copy. Every file is a complete snapshot, so you only need to keep the newest one."))), /*#__PURE__*/React.createElement("section", {
    className: "files-card"
  }, /*#__PURE__*/React.createElement("h2", null, "2 \xB7 Upload a backup"), /*#__PURE__*/React.createElement("p", null, "Loads a backup file onto this device \u2014 to restore, or to set up a new device."), /*#__PURE__*/React.createElement("div", {
    className: "files-actions"
  }, /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost file-label"
  }, importBusy ? "Reading file…" : "⬆ Upload backup", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "application/json,.json",
    className: "visually-hidden-file",
    onChange: onImportFile,
    disabled: importBusy
  }))), /*#__PURE__*/React.createElement("ol", {
    className: "files-steps"
  }, /*#__PURE__*/React.createElement("li", null, "On the device you want to fill, tap ", /*#__PURE__*/React.createElement("b", null, "Upload backup"), "."), /*#__PURE__*/React.createElement("li", null, "Choose your file. On a phone, pick ", /*#__PURE__*/React.createElement("b", null, "Drive"), " in the file picker and select it. On a computer, download it from Drive first, then choose it here."), /*#__PURE__*/React.createElement("li", null, "Confirm when asked. ", /*#__PURE__*/React.createElement("b", null, "This replaces everything currently on this device"), ", so download a backup first if it has newer notes."))), /*#__PURE__*/React.createElement("section", {
    className: "files-card"
  }, /*#__PURE__*/React.createElement("h2", null, "3 \xB7 Move just one subject"), /*#__PURE__*/React.createElement("p", null, "Save or load a single subject (with its notes and cards) without touching anything else."), /*#__PURE__*/React.createElement("div", {
    className: "files-actions"
  }, /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost file-label"
  }, subjectImportBusy ? "Reading file…" : "⬆ Upload a subject file", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "application/json,.json",
    className: "visually-hidden-file",
    onChange: onImportSubjectFile,
    disabled: subjectImportBusy
  }))), /*#__PURE__*/React.createElement("ol", {
    className: "files-steps"
  }, /*#__PURE__*/React.createElement("li", null, "To save one: open the subject and tap ", /*#__PURE__*/React.createElement("b", null, "Archive to file"), " at the top. Keep that file in Drive like a backup."), /*#__PURE__*/React.createElement("li", null, "To load one: tap ", /*#__PURE__*/React.createElement("b", null, "Upload a subject file"), " and choose it. It is ", /*#__PURE__*/React.createElement("b", null, "added"), " \u2014 nothing else changes. Uploading a newer copy of the same subject updates it instead of duplicating it."))), /*#__PURE__*/React.createElement("section", {
    className: "files-card"
  }, /*#__PURE__*/React.createElement("h2", null, "4 \xB7 Bring in notes from elsewhere"), /*#__PURE__*/React.createElement("div", {
    className: "files-actions"
  }, /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost file-label"
  }, kindleImportBusy ? "Reading file…" : "📖 Kindle highlights", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: ".html,.htm,text/html,.txt,text/plain",
    className: "visually-hidden-file",
    onChange: onKindleFile,
    disabled: kindleImportBusy
  })), /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost file-label"
  }, "\uD83D\uDCC4 PDF", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "application/pdf,.pdf",
    className: "visually-hidden-file",
    onChange: onPdfFile
  })), /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost file-label"
  }, mdImportBusy ? "Reading file…" : "📝 Markdown (.md)", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: ".md,text/markdown,text/plain",
    multiple: true,
    className: "visually-hidden-file",
    onChange: onMarkdownFile,
    disabled: mdImportBusy
  })), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onAddArticle
  }, "\uD83D\uDD17 Web article")), /*#__PURE__*/React.createElement("ul", {
    className: "files-steps"
  }, /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Kindle highlights"), " \u2014 a Kindle Notebook export (.html) or ", /*#__PURE__*/React.createElement("i", null, "My Clippings.txt"), ". Lands in a \u201CKindle Highlights\u201D subject."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "PDF"), " \u2014 pulls out the text (and, if you like, page images). Lands in \u201CPDF Imports\u201D."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Markdown"), " \u2014 .md files from Obsidian, Notion or anywhere else. You can pick several at once (for example a whole folder of notes). Lands in \u201CImported Notes\u201D."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Web article"), " \u2014 paste a link and Brainly saves a readable copy. Lands in \u201CSaved Articles\u201D."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Clip any web page"), " \u2014 open ", /*#__PURE__*/React.createElement("a", {
    href: "https://rram2771.github.io/Brainlynotes/clip.html",
    target: "_blank",
    rel: "noopener"
  }, "the clipper page"), " in your computer\u2019s browser, drag its button to your bookmarks bar, then click it on any article. It saves a small file; load it here with ", /*#__PURE__*/React.createElement("b", null, "Upload a subject file"), " (section 3). It lands in \u201CWeb clippings\u201D, and any ", /*#__PURE__*/React.createElement("i", null, "question :: answer"), " lines become cards."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Share from other apps"), " \u2014 on Android, use ", /*#__PURE__*/React.createElement("b", null, "Share \u2192 Brainly"), " in any app to drop text or a link into your \u201CReview\u201D subject."))), /*#__PURE__*/React.createElement("section", {
    className: "files-card"
  }, /*#__PURE__*/React.createElement("h2", null, "5 \xB7 AI helper (Claude)"), /*#__PURE__*/React.createElement("p", null, "Optional. With your own Claude API key, the ", /*#__PURE__*/React.createElement("b", null, "\u2726 AI"), " button inside a note can format it, answer questions about it, make flashcards, a mind map or slides, and turn a drawing into typed notes."), /*#__PURE__*/React.createElement(AiKeyForm, {
    key: aiSettings.apiKey ? "k" : "n",
    settings: aiSettings,
    onSaved: setAiSettings
  }), /*#__PURE__*/React.createElement("ul", {
    className: "files-steps"
  }, /*#__PURE__*/React.createElement("li", null, "Get a key at ", /*#__PURE__*/React.createElement("b", null, "console.anthropic.com"), " \u2192 API keys. Usage is billed by Anthropic, separately from a Claude chat subscription."), /*#__PURE__*/React.createElement("li", null, "The key is stored only on this device and is never part of a backup file."), /*#__PURE__*/React.createElement("li", null, "A note's text (and any picture you ask it to read) is sent to Claude only when you press an AI button. Leave out patient names and other identifying details."))), /*#__PURE__*/React.createElement("p", {
    className: "files-note"
  }, "Everything stays on this device unless you download it. Clearing this site's data, or uninstalling the app, deletes your notes \u2014 so keep a backup file in Drive."));
}
function ExportMenu({
  label,
  compact,
  onCopy,
  onDownload,
  onPdf,
  onShare
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handleOutside = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);
  const run = fn => {
    setOpen(false);
    if (fn) fn();
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "export-menu-wrap",
    ref: wrapRef
  }, /*#__PURE__*/React.createElement("button", {
    className: compact ? "" : "btn-ghost small",
    title: "Export & share",
    onClick: () => setOpen(o => !o)
  }, compact ? "⤴" : `⤴ ${label || "Export"}`), open && /*#__PURE__*/React.createElement("div", {
    className: "export-menu"
  }, onCopy && /*#__PURE__*/React.createElement("button", {
    onClick: () => run(onCopy)
  }, "\u29C9 Copy as Markdown"), onDownload && /*#__PURE__*/React.createElement("button", {
    onClick: () => run(onDownload)
  }, "\u21E9 Download .md"), onPdf && /*#__PURE__*/React.createElement("button", {
    onClick: () => run(onPdf)
  }, "\uD83D\uDDB6 Download PDF"), onShare && /*#__PURE__*/React.createElement("button", {
    onClick: () => run(onShare)
  }, "\u2197 Share\u2026")));
}

// ---------- Confirm dialog ----------

// ---------- Passcode lock screen ----------

function LockScreen({
  pinHash,
  onUnlock
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pin || busy) return;
    setBusy(true);
    const hash = await hashPin(pin);
    setBusy(false);
    if (hash === pinHash) {
      onUnlock();
    } else {
      setError("Incorrect passcode");
      setPin("");
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "lock-screen"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lock-screen-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lock-screen-icon"
  }, "\uD83D\uDD12"), /*#__PURE__*/React.createElement("h2", null, "Enter your passcode"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    className: "pin-input",
    value: pin,
    onChange: e => setPin(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter") submit();
    },
    autoFocus: true
  }), error && /*#__PURE__*/React.createElement("p", {
    className: "lock-screen-error"
  }, error), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: submit,
    disabled: busy || !pin
  }, "Unlock")));
}
function AddArticleModal({
  busy,
  error,
  onCancel,
  onConfirm
}) {
  const [url, setUrl] = useState("");
  const isValidUrl = /^https?:\/\/\S+$/i.test(url.trim());
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: busy ? undefined : onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal confirm-modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Save article by URL"), !busy && /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Paste a web article's link \u2014 this lands in a \"Saved Articles\" subject."), /*#__PURE__*/React.createElement("input", {
    type: "url",
    className: "url-input",
    placeholder: "https://example.com/article",
    value: url,
    onChange: e => setUrl(e.target.value),
    disabled: busy,
    autoFocus: true
  }), error && /*#__PURE__*/React.createElement("p", {
    className: "lock-screen-error"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel,
    disabled: busy
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: () => onConfirm(url.trim()),
    disabled: busy || !isValidUrl
  }, busy ? "Fetching…" : "Save"))));
}
function PdfImportModal({
  filename,
  busy,
  error,
  onCancel,
  onConfirm
}) {
  const [includeImages, setIncludeImages] = useState(false);
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: busy ? undefined : onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal confirm-modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Import PDF"), !busy && /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Import \"", filename, "\"? This lands in a \"PDF Imports\" subject."), /*#__PURE__*/React.createElement("label", {
    className: "checkbox-row"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: includeImages,
    onChange: e => setIncludeImages(e.target.checked),
    disabled: busy
  }), "Include page images (slower, uses more storage)"), error && /*#__PURE__*/React.createElement("p", {
    className: "lock-screen-error"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel,
    disabled: busy
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: () => onConfirm(includeImages),
    disabled: busy
  }, busy ? "Reading PDF…" : "Import"))));
}
function PinModal({
  mode,
  onVerify,
  onSetNew,
  onCancel
}) {
  // mode: "set" (no current pin needed) | "change" | "remove" (both verify first)
  const [phase, setPhase] = useState(mode === "set" ? "new" : "verify");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitVerify = async () => {
    setBusy(true);
    const ok = await onVerify(currentPin);
    setBusy(false);
    if (!ok) {
      setError("Incorrect passcode");
      setCurrentPin("");
      return;
    }
    setError("");
    if (mode === "remove") {
      setBusy(true);
      await onSetNew(null);
      setBusy(false);
    } else {
      setPhase("new");
    }
  };
  const submitNew = () => {
    if (!/^\d{4,12}$/.test(newPin)) {
      setError("Use 4 to 12 digits");
      return;
    }
    setError("");
    setPhase("confirm");
  };
  const submitConfirm = async () => {
    if (confirmPin !== newPin) {
      setError("Passcodes don't match");
      setConfirmPin("");
      return;
    }
    setBusy(true);
    await onSetNew(newPin);
    setBusy(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal confirm-modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, mode === "remove" ? "Remove passcode" : mode === "change" ? "Change passcode" : "Set a passcode"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), phase === "verify" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Enter your current passcode to continue."), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    className: "pin-input",
    value: currentPin,
    onChange: e => setCurrentPin(e.target.value),
    autoFocus: true
  }), error && /*#__PURE__*/React.createElement("p", {
    className: "lock-screen-error"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: submitVerify,
    disabled: busy || !currentPin
  }, "Continue"))), phase === "new" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Choose a passcode (4 to 12 digits). This is a lock screen, not encryption \u2014 and if you forget it, there's no way to recover it. Write it down somewhere safe."), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    className: "pin-input",
    value: newPin,
    onChange: e => setNewPin(e.target.value),
    autoFocus: true
  }), error && /*#__PURE__*/React.createElement("p", {
    className: "lock-screen-error"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: submitNew,
    disabled: !newPin
  }, "Continue"))), phase === "confirm" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Enter it again to confirm."), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    className: "pin-input",
    value: confirmPin,
    onChange: e => setConfirmPin(e.target.value),
    autoFocus: true
  }), error && /*#__PURE__*/React.createElement("p", {
    className: "lock-screen-error"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: submitConfirm,
    disabled: busy || !confirmPin
  }, "Save passcode")))));
}
function ConfirmDialog({
  message,
  onCancel,
  onConfirm,
  confirmLabel
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal confirm-modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, message), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost danger",
    onClick: onConfirm
  }, confirmLabel || "Delete"))));
}

// ---------- Image lightbox (view + zoom) ----------

function ImageLightbox({
  src,
  onClose
}) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const handleKey = e => {
      if (e.key === "Escape") onClose();else if (e.key === "+" || e.key === "=") setZoom(z => Math.min(3, z + 0.25));else if (e.key === "-") setZoom(z => Math.max(0.5, z - 0.25));
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "lightbox-backdrop",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    className: "lightbox-toolbar",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setZoom(z => Math.max(0.5, z - 0.25)),
    title: "Zoom out"
  }, "\u2212"), /*#__PURE__*/React.createElement("span", {
    className: "lightbox-zoom-level"
  }, Math.round(zoom * 100), "%"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setZoom(z => Math.min(3, z + 0.25)),
    title: "Zoom in"
  }, "+"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setZoom(1),
    title: "Reset zoom"
  }, "Reset"), /*#__PURE__*/React.createElement("button", {
    className: "lightbox-close",
    onClick: onClose,
    title: "Close"
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "lightbox-scroll",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: "",
    className: "lightbox-image",
    style: {
      transform: `scale(${zoom})`
    },
    onDoubleClick: () => setZoom(z => z === 1 ? 2 : 1),
    draggable: false
  })));
}
function BulkTagModal({
  count,
  allTags,
  onCancel,
  onApply
}) {
  const [tagInput, setTagInput] = useState("");
  const [tagNames, setTagNames] = useState([]);
  const addTagFromInput = () => {
    const parts = tagInput.split(",").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    setTagNames(cur => [...new Set([...cur, ...parts])]);
    setTagInput("");
  };
  const removeTag = name => setTagNames(cur => cur.filter(t => t !== name));
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Add tag to ", count, " note", count === 1 ? "" : "s"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "tag-input-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tag-pills-edit"
  }, tagNames.map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    className: "tag-pill editable"
  }, "#", t, " ", /*#__PURE__*/React.createElement("button", {
    onClick: () => removeTag(t)
  }, "\u2715"))), /*#__PURE__*/React.createElement("input", {
    placeholder: "Add tag, comma or enter",
    value: tagInput,
    onChange: e => setTagInput(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addTagFromInput();
      }
    },
    onBlur: addTagFromInput,
    autoFocus: true
  })), allTags.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "existing-tags"
  }, allTags.filter(t => !tagNames.includes(t.name)).slice(0, 10).map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    className: "existing-tag-btn",
    onClick: () => setTagNames(cur => [...cur, t.name])
  }, "+", t.name)))), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    disabled: tagNames.length === 0,
    onClick: () => onApply(tagNames)
  }, "Apply to ", count, " note", count === 1 ? "" : "s"))));
}
function BulkMoveModal({
  count,
  subjectOptions,
  onCancel,
  onApply
}) {
  const [mode, setMode] = useState("existing"); // "existing" | "new"
  const [targetSubjectId, setTargetSubjectId] = useState("");
  const [newSubjectName, setNewSubjectName] = useState("");
  const canApply = mode === "existing" ? !!targetSubjectId : newSubjectName.trim().length > 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Move ", count, " note", count === 1 ? "" : "s"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "bulk-move-mode-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (mode === "existing" ? " active-toggle" : ""),
    onClick: () => setMode("existing")
  }, "To an existing subject"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (mode === "new" ? " active-toggle" : ""),
    onClick: () => setMode("new")
  }, "Create a new sub-subject")), mode === "existing" ? /*#__PURE__*/React.createElement("select", {
    className: "parent-select",
    value: targetSubjectId,
    onChange: e => setTargetSubjectId(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true
  }, "Choose a subject\u2026"), subjectOptions.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.id,
    value: s.id
  }, s.label))) : /*#__PURE__*/React.createElement("input", {
    className: "link-search-input",
    placeholder: "New sub-subject name",
    value: newSubjectName,
    onChange: e => setNewSubjectName(e.target.value),
    autoFocus: true
  }), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    disabled: !canApply,
    onClick: () => onApply(mode, mode === "existing" ? targetSubjectId : newSubjectName.trim())
  }, "Move"))));
}

// ---------- Rich text editor ----------
// contentEditable is kept "uncontrolled" from React's perspective on purpose:
// we set dangerouslySetInnerHTML once from a ref captured at mount, and never
// feed live keystroke state back into it. Feeding live state back in would
// make React reset the DOM (and the cursor position) on every keystroke.

const RTE_TEXT_COLORS = [{
  name: "Default",
  hex: null
}, {
  name: "White",
  hex: "#FFFFFF"
}, {
  name: "Yellow",
  hex: "#FFD84D"
}, {
  name: "Red",
  hex: "#E5484D"
}, {
  name: "Blue",
  hex: "#2F80ED"
}, {
  name: "Teal",
  hex: "#00A187"
}];
function RichTextEditor({
  initialHTML,
  onChange,
  placeholder,
  onImageError,
  onOccludeImage,
  tall
}) {
  const editorRef = useRef(null);
  const initialRef = useRef(initialHTML || "");
  const [selectionToolbar, setSelectionToolbar] = useState(null); // { top, left } | null
  const selectedImageElRef = useRef(null); // the actual <img> DOM node currently selected, or null
  const [imageToolbarPos, setImageToolbarPos] = useState(null); // { top, left, placement } | null

  const applyCmd = (cmd, value) => {
    if (editorRef.current) editorRef.current.focus();
    document.execCommand(cmd, false, value);
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  };

  // The heading dropdown takes focus away from the text, so remember where the cursor/selection was.
  const savedRangeRef = useRef(null);
  const rememberSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorRef.current && editorRef.current.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  };
  const applyHeading = tag => {
    if (!tag) return;
    if (editorRef.current) editorRef.current.focus();
    const r = savedRangeRef.current;
    if (r) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    document.execCommand("formatBlock", false, tag);
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  };

  // Bullet shapes: a normal bullet list whose marker is a square, circle or arrow.
  const applyBullet = kind => {
    if (editorRef.current) editorRef.current.focus();
    const sel = window.getSelection();
    const listAtCursor = () => {
      const n = sel && sel.anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      return el && el.closest ? el.closest("ul") : null;
    };
    let ul = listAtCursor();
    if (!ul) {
      document.execCommand("insertUnorderedList");
      ul = listAtCursor();
    }
    if (ul) {
      // The shape goes on each selected line, not the whole list, so one list can mix shapes.
      const marker = kind === "arrow" ? '"➤  "' : kind;
      const range = sel.rangeCount ? sel.getRangeAt(0) : null;
      let items = range ? Array.from(ul.querySelectorAll("li")).filter(li => range.intersectsNode(li)) : [];
      if (items.length === 0) {
        const n = sel.anchorNode;
        const el = n && (n.nodeType === 1 ? n : n.parentElement);
        const li = el && el.closest ? el.closest("li") : null;
        items = li ? [li] : [];
      }
      items.forEach(li => {
        li.style.listStyleType = marker;
      });
    }
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  };

  // White and yellow are for dark note backgrounds; "Default" matches the editor's own text color.
  const applyTextColor = hex => {
    const color = hex || (editorRef.current ? getComputedStyle(editorRef.current).color : "#241C3D");
    applyCmd("foreColor", color);
  };
  const deselectImage = () => {
    selectedImageElRef.current = null;
    setImageToolbarPos(null);
  };

  // The toolbar prefers to sit just above whatever it's attached to, but
  // that only works if there's room — a large image near the top of the
  // note (right under the fixed header) would push an "always above"
  // toolbar off-screen or behind the header, making it genuinely
  // invisible rather than just easy to miss. Below is the fallback.
  const TOOLBAR_CLEARANCE = 70;
  const computeToolbarPos = rect => {
    const placement = rect.top < TOOLBAR_CLEARANCE ? "below" : "above";
    return {
      top: placement === "above" ? rect.top : rect.bottom,
      left: rect.left + rect.width / 2,
      placement
    };
  };
  const selectImage = el => {
    selectedImageElRef.current = el;
    setImageToolbarPos(computeToolbarPos(el.getBoundingClientRect()));
  };
  const handleBodyClick = e => {
    if (e.target && e.target.tagName === "IMG" && e.target.classList.contains("rte-inline-image")) {
      selectImage(e.target);
    } else if (selectedImageElRef.current) {
      deselectImage();
    }
  };
  const resizeSelectedImage = percent => {
    const el = selectedImageElRef.current;
    if (!el) return;
    el.style.width = percent + "%";
    el.style.height = "auto";
    if (editorRef.current) onChange(editorRef.current.innerHTML);
    setImageToolbarPos(computeToolbarPos(el.getBoundingClientRect()));
  };
  const removeSelectedImage = () => {
    const el = selectedImageElRef.current;
    if (!el) return;
    el.remove();
    if (editorRef.current) onChange(editorRef.current.innerHTML);
    deselectImage();
  };
  const [annotatingImage, setAnnotatingImage] = useState(null); // the <img> DOM element currently being annotated, or null

  const openAnnotateImage = () => {
    if (selectedImageElRef.current) setAnnotatingImage(selectedImageElRef.current);
  };
  const saveAnnotatedImage = dataUrl => {
    if (annotatingImage) {
      annotatingImage.src = dataUrl;
      if (editorRef.current) onChange(editorRef.current.innerHTML);
    }
    setAnnotatingImage(null);
    deselectImage();
  };

  // Keeps the image toolbar correctly positioned while scrolling, and
  // dismisses it on a click anywhere outside the selected image or the
  // toolbar itself.
  useEffect(() => {
    const reposition = () => {
      const el = selectedImageElRef.current;
      if (!el || !document.body.contains(el)) {
        if (el) deselectImage();
        return;
      }
      setImageToolbarPos(computeToolbarPos(el.getBoundingClientRect()));
    };
    const handleOutsideClick = e => {
      const el = selectedImageElRef.current;
      if (!el) return;
      if (e.target === el) return; // handled by handleBodyClick
      if (e.target && e.target.closest && e.target.closest(".rte-floating-toolbar")) return;
      deselectImage();
    };
    document.addEventListener("scroll", reposition, true);
    document.addEventListener("click", handleOutsideClick, true);
    return () => {
      document.removeEventListener("scroll", reposition, true);
      document.removeEventListener("click", handleOutsideClick, true);
    };
  }, []);
  const handlePaste = e => {
    const files = imageFilesFromPasteOrDrop(e.clipboardData.items);
    if (files.length) {
      e.preventDefault();
      files.forEach(f => insertImageAtCursor(f));
      return;
    }

    // Third case, previously missing entirely: pasted TEXT that is
    // itself markdown worth rendering (this app's own Copy as
    // Markdown, or Captura's equivalent) — without this, it fell
    // through to the browser's default verbatim insert, showing the
    // raw markdown source (including a base64 image's full text) as
    // literal characters instead of an actual image.
    //
    // preventDefault() happens unconditionally now, for every text
    // paste, not just ones already confirmed to be markdown — reading
    // the actual pasted text is now async (see below), and
    // preventDefault() only has any effect if called synchronously,
    // before that read resolves, so there's no way to decide "is this
    // markdown" first and THEN choose whether to prevent the default.
    e.preventDefault();
    if (editorRef.current) editorRef.current.focus();
    const insertPastedText = text => {
      if (!text) return;
      if (looksLikeMarkdownWorthParsing(text)) {
        document.execCommand("insertHTML", false, parsePastedMarkdownToHTML(text));
      } else {
        // Plain insertText, not insertHTML — preserves the original
        // behavior for ordinary pasted text exactly (no formatting
        // interpreted, just the characters themselves).
        document.execCommand("insertText", false, text);
      }
      if (editorRef.current) onChange(editorRef.current.innerHTML);
    };

    // The synchronous paste-event clipboardData read used previously
    // has real, documented inconsistency on mobile browsers
    // specifically for LARGE text — and a full base64-encoded image
    // easily runs to tens of thousands of characters. It could return
    // empty or truncated data with no error at all, silently skipping
    // this entire code path and falling through to the raw insert —
    // which is exactly the symptom this exists to fix. The async
    // Clipboard API is read as the primary source instead, since it's
    // the more consistently reliable way to read back arbitrary-length
    // clipboard text; the synchronous read only serves as a fallback
    // if that either isn't available or is denied permission.
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(insertPastedText).catch(() => insertPastedText(e.clipboardData.getData("text/plain")));
    } else {
      insertPastedText(e.clipboardData.getData("text/plain"));
    }
  };
  const placeCaretAtPoint = (x, y) => {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };
  const handleDragOver = e => {
    e.preventDefault(); // required for onDrop to fire at all
  };
  const handleDrop = async e => {
    e.preventDefault();
    if (editorRef.current) editorRef.current.focus();
    placeCaretAtPoint(e.clientX, e.clientY);
    const files = imageFilesFromPasteOrDrop(e.dataTransfer.items);
    if (files.length) {
      for (const f of files) await insertImageAtCursor(f);
      return;
    }

    // Dragging an <img> straight off a webpage (rather than a local file)
    // usually only hands over a URL, not the actual bytes — most sites
    // don't allow cross-origin fetches of their images, so this will
    // often fail. When it does, say so plainly instead of doing nothing.
    const uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (uri && /^https?:\/\//i.test(uri)) {
      try {
        const res = await fetch(uri, {
          mode: "cors"
        });
        if (!res.ok) throw new Error("fetch failed");
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) throw new Error("not an image");
        await insertImageAtCursor(new File([blob], "dropped-image", {
          type: blob.type
        }));
      } catch (err) {
        if (onImageError) onImageError();
      }
    }
  };
  const insertImageAtCursor = async file => {
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      if (editorRef.current) editorRef.current.focus();
      document.execCommand("insertHTML", false, `<img src="${dataUrl}" class="rte-inline-image" alt="" />`);
      if (editorRef.current) onChange(editorRef.current.innerHTML);
    } catch (e) {
      // Same lightweight handling as paste-image elsewhere — a failed
      // compress/insert just does nothing rather than breaking the editor.
    }
  };

  // A small floating toolbar appears near whatever text you've selected, so
  // formatting doesn't require scrolling back up to the fixed toolbar.
  useEffect(() => {
    const updateFromSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !editorRef.current || sel.rangeCount === 0) {
        setSelectionToolbar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!editorRef.current.contains(range.commonAncestorContainer)) {
        setSelectionToolbar(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelectionToolbar(null);
        return;
      }
      setSelectionToolbar(computeToolbarPos(rect));
      if (selectedImageElRef.current) deselectImage();
    };
    document.addEventListener("selectionchange", updateFromSelection);
    document.addEventListener("scroll", updateFromSelection, true);
    return () => {
      document.removeEventListener("selectionchange", updateFromSelection);
      document.removeEventListener("scroll", updateFromSelection, true);
    };
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "rte-wrap" + (tall ? " rte-wrap-tall" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "rte-toolbar"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Bold",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("bold")
  }, /*#__PURE__*/React.createElement("b", null, "B")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Italic",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("italic")
  }, /*#__PURE__*/React.createElement("i", null, "I")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Underline",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("underline")
  }, /*#__PURE__*/React.createElement("u", null, "U")), /*#__PURE__*/React.createElement("select", {
    className: "rte-heading-select",
    title: "Heading type",
    value: "",
    onMouseDown: rememberSelection,
    onTouchStart: rememberSelection,
    onChange: e => applyHeading(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Heading\u2026"), /*#__PURE__*/React.createElement("option", {
    value: "H1"
  }, "Title"), /*#__PURE__*/React.createElement("option", {
    value: "H2"
  }, "Heading"), /*#__PURE__*/React.createElement("option", {
    value: "H3"
  }, "Subheading"), /*#__PURE__*/React.createElement("option", {
    value: "H4"
  }, "Small heading"), /*#__PURE__*/React.createElement("option", {
    value: "P"
  }, "Normal text")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Bullet list",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("insertUnorderedList")
  }, "\u2022\u2014"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Square bullets",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyBullet("square")
  }, "\u25A0"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Circle bullets",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyBullet("circle")
  }, "\u25CB"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Arrow bullets",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyBullet("arrow")
  }, "\u27A4"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Numbered list",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("insertOrderedList")
  }, "1."), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Plain paragraph",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("formatBlock", "P")
  }, "\xB6"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), RTE_TEXT_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.name,
    type: "button",
    className: "rte-color-swatch",
    style: {
      background: c.hex || "var(--ink)"
    },
    title: "Text color — " + c.name,
    "aria-label": "Text color " + c.name,
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyTextColor(c.hex)
  })), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Undo",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("undo")
  }, "\u21BA"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Redo",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("redo")
  }, "\u21BB"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("label", {
    className: "rte-toolbar-file-btn",
    title: "Insert an image right here in the text"
  }, "\uD83D\uDDBC", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    className: "visually-hidden-file",
    onChange: e => {
      insertImageAtCursor(e.target.files && e.target.files[0]);
      e.target.value = "";
    }
  }))), /*#__PURE__*/React.createElement("div", {
    ref: editorRef,
    className: "rte-body" + (tall ? " rte-body-tall" : ""),
    contentEditable: true,
    suppressContentEditableWarning: true,
    "data-placeholder": placeholder,
    dangerouslySetInnerHTML: {
      __html: initialRef.current
    },
    onInput: e => onChange(e.currentTarget.innerHTML),
    onPaste: handlePaste,
    onClick: handleBodyClick,
    onDragOver: handleDragOver,
    onDrop: handleDrop
  }), selectionToolbar && /*#__PURE__*/React.createElement("div", {
    className: "rte-floating-toolbar",
    style: {
      top: selectionToolbar.top,
      left: selectionToolbar.left,
      transform: selectionToolbar.placement === "below" ? "translate(-50%, 10px)" : "translate(-50%, calc(-100% - 10px))"
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Bold",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("bold")
  }, /*#__PURE__*/React.createElement("b", null, "B")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Italic",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("italic")
  }, /*#__PURE__*/React.createElement("i", null, "I")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Underline",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("underline")
  }, /*#__PURE__*/React.createElement("u", null, "U")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Heading",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("formatBlock", "H3")
  }, "H"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Bullet list",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("insertUnorderedList")
  }, "\u2022\u2014"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Numbered list",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("insertOrderedList")
  }, "1."), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Plain paragraph",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("formatBlock", "P")
  }, "\xB6"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), RTE_TEXT_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.name,
    type: "button",
    className: "rte-color-swatch",
    style: {
      background: c.hex || "#ccc"
    },
    title: "Text color — " + c.name,
    "aria-label": "Text color " + c.name,
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyTextColor(c.hex)
  })), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "rte-size-btn",
    title: "Small text",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("fontSize", "2")
  }, "S"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "rte-size-btn",
    title: "Normal text",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("fontSize", "3")
  }, "M"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "rte-size-btn",
    title: "Large text",
    onMouseDown: e => e.preventDefault(),
    onClick: () => applyCmd("fontSize", "5")
  }, "L")), imageToolbarPos && /*#__PURE__*/React.createElement("div", {
    className: "rte-floating-toolbar",
    style: {
      top: imageToolbarPos.top,
      left: imageToolbarPos.left,
      transform: imageToolbarPos.placement === "below" ? "translate(-50%, 10px)" : "translate(-50%, calc(-100% - 10px))"
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Annotate",
    onMouseDown: e => e.preventDefault(),
    onClick: openAnnotateImage
  }, "\u270E"), onOccludeImage && /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Make occlusion cards from this image",
    onMouseDown: e => e.preventDefault(),
    onClick: () => {
      if (selectedImageElRef.current) onOccludeImage(selectedImageElRef.current.src);
    }
  }, "\u25A7"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Small",
    onMouseDown: e => e.preventDefault(),
    onClick: () => resizeSelectedImage(25)
  }, "S"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Medium",
    onMouseDown: e => e.preventDefault(),
    onClick: () => resizeSelectedImage(50)
  }, "M"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Large",
    onMouseDown: e => e.preventDefault(),
    onClick: () => resizeSelectedImage(75)
  }, "L"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Full width",
    onMouseDown: e => e.preventDefault(),
    onClick: () => resizeSelectedImage(100)
  }, "Full"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Remove image",
    onMouseDown: e => e.preventDefault(),
    onClick: removeSelectedImage
  }, "\u2715")), annotatingImage && /*#__PURE__*/React.createElement(DrawingCanvas, {
    backgroundImageUrl: annotatingImage.src,
    onCancel: () => setAnnotatingImage(null),
    onSave: saveAnnotatedImage
  }));
}

// ---------- Drawing canvas (S Pen / touch / mouse) ----------

function DrawingCanvas({
  onCancel,
  onSave,
  backgroundImageUrl
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const shapeStartRef = useRef(null); // {x,y} | null — start point while dragging a shape
  const shapeSnapshotRef = useRef(null); // ImageData taken right before a shape drag starts
  const [color, setColor] = useState("#241C3D");
  const [tool, setTool] = useState("pen"); // "pen" | "eraser" | "rect" | "ellipse" | "line" | "arrow" | "lasso"
  const [hasInk, setHasInk] = useState(!!backgroundImageUrl);
  const [bgLoaded, setBgLoaded] = useState(!backgroundImageUrl);
  const DRAW_COLORS = ["#241C3D", "#3E7CAB", "#FF4D8D", "#00B39F", "#F5A623"];
  const SHAPE_TOOLS = ["rect", "ellipse", "line", "arrow"];

  // Lasso select+resize state — see the note above LassoOverlay for the
  // honest caveat on this specific tool.
  const [lassoPath, setLassoPath] = useState(null); // array of {x,y} while actively lassoing
  const [selection, setSelection] = useState(null); // { x, y, w, h, dataUrl } | null — the floating, resizable piece

  const drawBackground = (ctx, rect, onComplete) => {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, rect.width, rect.height);
    if (backgroundImageUrl) {
      const img = new Image();
      img.onload = () => {
        // "Contain" fit — the whole image visible, letterboxed if its
        // aspect ratio doesn't match the canvas, never cropped or
        // stretched out of shape.
        const scale = Math.min(rect.width / img.width, rect.height / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const dx = (rect.width - drawW) / 2;
        const dy = (rect.height - drawH) / 2;
        ctx.drawImage(img, dx, dy, drawW, drawH);
        if (onComplete) onComplete();
      };
      img.onerror = () => {
        if (onComplete) onComplete();
      }; // fall through to a blank canvas rather than get stuck
      img.src = backgroundImageUrl;
    } else if (onComplete) {
      onComplete();
    }
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawBackground(ctx, rect, () => setBgLoaded(true));
  }, []);
  const getPoint = e => {
    const rect = canvasRef.current.getBoundingClientRect();
    const pressure = typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : 0.5;
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure
    };
  };
  const drawShape = (ctx, shapeTool, start, end) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (shapeTool === "rect") {
      ctx.strokeRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    } else if (shapeTool === "ellipse") {
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      ctx.ellipse(cx, cy, Math.max(rx, 0.01), Math.max(ry, 0.01), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (shapeTool === "line" || shapeTool === "arrow") {
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      if (shapeTool === "arrow") {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLen = 12;
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
      }
    }
  };
  const historyRef = useRef([]); // stack of dataURL snapshots, oldest first — capped to bound memory
  const MAX_HISTORY = 8;
  const [canUndo, setCanUndo] = useState(false);

  // Snapshots as compressed PNG dataURLs rather than raw ImageData — a
  // full-resolution ImageData snapshot on a high-DPI phone screen can run
  // tens of MB each; a handful of those would risk exhausting memory on
  // the very device this needs to work reliably on.
  const pushHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    historyRef.current.push(canvas.toDataURL("image/png"));
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    setCanUndo(true);
  };
  const undo = () => {
    if (!historyRef.current.length) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const prevDataUrl = historyRef.current.pop();
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
      setCanUndo(historyRef.current.length > 0);
      if (historyRef.current.length === 0) setHasInk(!!backgroundImageUrl);
    };
    img.src = prevDataUrl;
  };
  const startDraw = e => {
    e.preventDefault();
    pushHistory();
    const p = getPoint(e);
    if (SHAPE_TOOLS.includes(tool)) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      shapeSnapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      shapeStartRef.current = p;
    } else if (tool === "lasso") {
      setLassoPath([p]);
    } else {
      drawingRef.current = true;
      lastPointRef.current = p;
    }
    setHasInk(true);
  };
  const moveDraw = e => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (SHAPE_TOOLS.includes(tool) && shapeStartRef.current) {
      e.preventDefault();
      const p = getPoint(e);
      ctx.putImageData(shapeSnapshotRef.current, 0, 0);
      drawShape(ctx, tool, shapeStartRef.current, p);
      return;
    }
    if (tool === "lasso" && lassoPath) {
      e.preventDefault();
      const p = getPoint(e);
      setLassoPath(cur => [...cur, p]);
      return;
    }
    if (!drawingRef.current) return;
    e.preventDefault();
    strokeTo(ctx, getPoint(e));
  };
  const strokeTo = (ctx, p) => {
    const last = lastPointRef.current;
    ctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : color;
    ctx.lineWidth = tool === "eraser" ? 18 : Math.max(1.5, p.pressure * 6);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPointRef.current = p;
  };

  // Finishes at the point where the finger actually lifted. On a phone the last pointermove
  // often lands well short of that (moves are batched per frame, the lift carries the final
  // position), so strokes and shapes used to end visibly short of where you drew them.
  const endDraw = e => {
    const p = e && typeof e.clientX === "number" && canvasRef.current ? getPoint(e) : null;
    if (SHAPE_TOOLS.includes(tool)) {
      if (p && shapeStartRef.current && shapeSnapshotRef.current) {
        const ctx = canvasRef.current.getContext("2d");
        ctx.putImageData(shapeSnapshotRef.current, 0, 0);
        drawShape(ctx, tool, shapeStartRef.current, p);
      }
      shapeStartRef.current = null;
      shapeSnapshotRef.current = null;
      return;
    }
    if (tool === "lasso" && lassoPath && lassoPath.length > 2) {
      commitLassoSelection(p ? [...lassoPath, p] : lassoPath);
      setLassoPath(null);
      return;
    }
    setLassoPath(null);
    // Pressure reads 0 on lift, so keep the stroke's own pressure for this last segment.
    if (drawingRef.current && p) strokeTo(canvasRef.current.getContext("2d"), {
      ...p,
      pressure: lastPointRef.current.pressure
    });
    drawingRef.current = false;
  };

  // Extracts everything inside the closed lasso loop onto its own floating,
  // draggable, resizable piece — and erases that region from the base
  // drawing so it isn't shown twice. Dragging the corner handle scales it;
  // tapping "Done" bakes it back onto the canvas at wherever it ended up.
  const commitLassoSelection = path => {
    const canvas = canvasRef.current;
    const ratio = window.devicePixelRatio || 1;
    const xs = path.map(p => p.x);
    const ys = path.map(p => p.y);
    const minX = Math.max(0, Math.min(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxX = Math.min(canvas.width / ratio, Math.max(...xs));
    const maxY = Math.min(canvas.height / ratio, Math.max(...ys));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w < 4 || h < 4) return; // ignore an accidental tap/tiny loop

    // Extract just the lassoed region onto its own small canvas, masked to
    // the exact loop shape (not just its rectangular bounding box).
    const cut = document.createElement("canvas");
    cut.width = w * ratio;
    cut.height = h * ratio;
    const cutCtx = cut.getContext("2d");
    cutCtx.scale(ratio, ratio);
    cutCtx.save();
    cutCtx.beginPath();
    path.forEach((p, i) => {
      const x = p.x - minX;
      const y = p.y - minY;
      if (i === 0) cutCtx.moveTo(x, y);else cutCtx.lineTo(x, y);
    });
    cutCtx.closePath();
    cutCtx.clip();
    cutCtx.drawImage(canvas, -minX, -minY, canvas.width / ratio, canvas.height / ratio);
    cutCtx.restore();

    // Erase the same masked region from the base drawing so it doesn't
    // appear both there AND in the floating selection.
    const mainCtx = canvas.getContext("2d");
    mainCtx.save();
    mainCtx.beginPath();
    path.forEach((p, i) => {
      if (i === 0) mainCtx.moveTo(p.x, p.y);else mainCtx.lineTo(p.x, p.y);
    });
    mainCtx.closePath();
    mainCtx.clip();
    mainCtx.fillStyle = "#FFFFFF";
    mainCtx.fillRect(minX, minY, w, h);
    mainCtx.restore();
    setSelection({
      x: minX,
      y: minY,
      w,
      h,
      dataUrl: cut.toDataURL("image/png")
    });
  };
  const commitSelectionToCanvas = () => {
    if (!selection) return;
    pushHistory();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, selection.x, selection.y, selection.w, selection.h);
      setSelection(null);
    };
    img.src = selection.dataUrl;
  };
  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    pushHistory();
    setSelection(null);
    // Clearing restores the original image (if annotating one) rather than
    // wiping to a blank canvas — "clear" here means "undo my markup," not
    // "throw away the photo." And since Clear is itself now a step in the
    // undo history, an accidental tap is recoverable too.
    drawBackground(ctx, rect, () => setHasInk(!!backgroundImageUrl));
  };
  const handleSave = () => {
    if (selection) commitSelectionToCanvas();
    if (!hasInk) {
      onCancel();
      return;
    }
    // Give the (rare) async commit a tick to land before reading the canvas out.
    setTimeout(() => {
      // An annotated photo as PNG came out ~9x the size of the original JPEG (measured: 16 KB
      // -> 149 KB), and every occlusion card made from it stores two more copies. JPEG keeps
      // annotated photos compact; plain drawings stay PNG so handwriting stays crisp.
      const dataUrl = backgroundImageUrl ? canvasRef.current.toDataURL("image/jpeg", 0.85) : canvasRef.current.toDataURL("image/png");
      onSave(dataUrl);
    }, 0);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop draw-fullscreen",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal wide draw-fullscreen",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, backgroundImageUrl ? "Annotate image" : "Draw / handwrite"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, backgroundImageUrl ? "Mark up the image below — same pen and tools as free drawing. \"Clear\" undoes your markup, not the photo." : "Works with your finger, mouse, or S Pen — pressure-sensitive on supported devices."), /*#__PURE__*/React.createElement("div", {
    className: "draw-canvas-wrap"
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    className: "draw-canvas",
    onPointerDown: bgLoaded ? startDraw : undefined,
    onPointerMove: bgLoaded ? moveDraw : undefined,
    onPointerUp: bgLoaded ? endDraw : undefined,
    onPointerLeave: bgLoaded ? endDraw : undefined,
    onPointerCancel: bgLoaded ? () => endDraw() : undefined,
    style: {
      touchAction: "none"
    }
  }), !bgLoaded && /*#__PURE__*/React.createElement("div", {
    className: "draw-canvas-loading"
  }, "Loading image\u2026"), lassoPath && lassoPath.length > 1 && /*#__PURE__*/React.createElement("svg", {
    className: "lasso-preview-svg"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: lassoPath.map(p => `${p.x},${p.y}`).join(" ")
  })), selection && /*#__PURE__*/React.createElement(SelectionOverlay, {
    selection: selection,
    onChange: setSelection,
    onCommit: commitSelectionToCanvas
  })), /*#__PURE__*/React.createElement("div", {
    className: "draw-toolbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "draw-tool-row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "pen" ? " active-toggle" : ""),
    onClick: () => setTool("pen"),
    title: "Pen"
  }, "\u270E"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "eraser" ? " active-toggle" : ""),
    onClick: () => setTool("eraser"),
    title: "Eraser"
  }, "\u232B"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "rect" ? " active-toggle" : ""),
    onClick: () => setTool("rect"),
    title: "Rectangle"
  }, "\u25AD"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "ellipse" ? " active-toggle" : ""),
    onClick: () => setTool("ellipse"),
    title: "Ellipse"
  }, "\u25EF"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "line" ? " active-toggle" : ""),
    onClick: () => setTool("line"),
    title: "Line"
  }, "\u2571"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "arrow" ? " active-toggle" : ""),
    onClick: () => setTool("arrow"),
    title: "Arrow"
  }, "\u2197"), /*#__PURE__*/React.createElement("span", {
    className: "rte-toolbar-divider"
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small" + (tool === "lasso" ? " active-toggle" : ""),
    onClick: () => setTool("lasso"),
    title: "Lasso select \u2014 draw a loop around ink to move or resize it"
  }, "\u25CC")), /*#__PURE__*/React.createElement("div", {
    className: "color-dot-row"
  }, DRAW_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    className: "color-dot" + (tool !== "eraser" && color === c ? " selected" : ""),
    style: {
      background: c
    },
    onClick: () => {
      setColor(c);
      if (tool === "eraser") setTool("pen");
    }
  }))), selection && /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: commitSelectionToCanvas
  }, "Done resizing"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: undo,
    disabled: !bgLoaded || !canUndo,
    title: "Undo the last stroke"
  }, "\u21BA Undo"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: clearCanvas,
    disabled: !bgLoaded
  }, "Clear")), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: handleSave,
    disabled: !bgLoaded
  }, backgroundImageUrl ? "Save annotation" : "Add to note"))));
}

// The lasso-select-and-resize piece above is the least testable part of
// this whole app — it depends entirely on real pointer-drag feel (finger,
// mouse, or S Pen) that can't be simulated here. Everything else in this
// file has been verified through rendering and logic tests; this overlay's
// actual on-screen feel has not, and is the one thing most worth trying
// directly (e.g. in the live Claude-artifact preview) before trusting it.
function SelectionOverlay({
  selection,
  onChange,
  onCommit
}) {
  const dragRef = useRef(null); // { mode: "move"|"resize", startX, startY, orig } | null

  const onPointerDownMove = e => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      orig: selection
    };
  };
  const onPointerDownResize = e => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      orig: selection
    };
  };
  useEffect(() => {
    const onMove = e => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "move") {
        onChange({
          ...d.orig,
          x: d.orig.x + dx,
          y: d.orig.y + dy
        });
      } else {
        const newW = Math.max(12, d.orig.w + dx);
        const newH = Math.max(12, d.orig.h + dy);
        onChange({
          ...d.orig,
          w: newW,
          h: newH
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [selection, onChange]);
  return /*#__PURE__*/React.createElement("div", {
    className: "selection-overlay",
    style: {
      left: selection.x,
      top: selection.y,
      width: selection.w,
      height: selection.h
    },
    onPointerDown: onPointerDownMove,
    onDoubleClick: onCommit
  }, /*#__PURE__*/React.createElement("img", {
    src: selection.dataUrl,
    alt: "",
    draggable: false,
    className: "selection-overlay-img"
  }), /*#__PURE__*/React.createElement("div", {
    className: "selection-handle",
    onPointerDown: onPointerDownResize
  }));
}

// ---------- Image occlusion card creator ----------
// Upload (or reuse) an image, draw boxes over the parts to be tested on, label
// each one, and get back one card per box: front = image with just that region
// masked, back = the full image plus the label. Boxes are stored normalized
// (0-1) so the masking math is independent of how large the editor is on screen.

function OcclusionCreator({
  initialImage,
  initialNoteId,
  notes,
  onCancel,
  onCreate
}) {
  const [imageSrc, setImageSrc] = useState(initialImage || null);
  const [boxes, setBoxes] = useState([]); // { id, x, y, w, h, label }
  const [drawing, setDrawing] = useState(null); // { startX, startY, curX, curY } | null
  const [linkedNoteId, setLinkedNoteId] = useState(initialNoteId || "");
  const [imgError, setImgError] = useState("");
  const [busy, setBusy] = useState(false);
  const containerRef = useRef(null);
  const handleFile = async file => {
    if (!file) return;
    setImgError("");
    try {
      // Occlusion needs more resolution than the 900px cap used for plain note images,
      // so small labels in a diagram stay legible.
      const dataUrl = await compressImage(file, 1400, 0.85);
      setImageSrc(dataUrl);
      setBoxes([]);
    } catch (e) {
      setImgError("Couldn't load that image — try a different file.");
    }
  };
  const getRelativePoint = e => {
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1)
    };
  };
  const startDraw = e => {
    if (!imageSrc) return;
    e.preventDefault();
    // Keep receiving this finger's moves even past the image edge — boxing a label that sits
    // near the border naturally drags slightly outside it, which used to end the box early.
    if (e.currentTarget.setPointerCapture) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (err) {/* not capturable; fine */}
    }
    const p = getRelativePoint(e);
    setDrawing({
      startX: p.x,
      startY: p.y,
      curX: p.x,
      curY: p.y
    });
  };
  const moveDraw = e => {
    if (!drawing) return;
    e.preventDefault();
    const p = getRelativePoint(e);
    setDrawing(d => ({
      ...d,
      curX: p.x,
      curY: p.y
    }));
  };
  // Uses the lift position itself as the box's far corner. The last pointermove often lands
  // well short of it on a phone (moves are batched per frame), and `drawing` here can also be
  // a render behind the latest move — together that drew boxes visibly smaller than the drag.
  const endDraw = e => {
    if (!drawing) return;
    const end = e && typeof e.clientX === "number" ? getRelativePoint(e) : {
      x: drawing.curX,
      y: drawing.curY
    };
    const x = Math.min(drawing.startX, end.x);
    const y = Math.min(drawing.startY, end.y);
    const w = Math.abs(end.x - drawing.startX);
    const h = Math.abs(end.y - drawing.startY);
    setDrawing(null);
    if (w < 0.02 || h < 0.02) return; // ignore accidental taps
    setBoxes(cur => [...cur, {
      id: uid(),
      x,
      y,
      w,
      h,
      label: `Region ${cur.length + 1}`
    }]);
  };
  const updateLabel = (id, label) => setBoxes(cur => cur.map(b => b.id === id ? {
    ...b,
    label
  } : b));
  const removeBox = id => setBoxes(cur => cur.filter(b => b.id !== id));
  const undoLastBox = () => setBoxes(cur => cur.slice(0, -1));
  const buildMaskedImage = box => new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Couldn't render the masked image"));
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = "#1B2A4A";
      ctx.fillRect(box.x * img.naturalWidth, box.y * img.naturalHeight, box.w * img.naturalWidth, box.h * img.naturalHeight);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.src = imageSrc;
  });
  const handleCreate = async () => {
    if (!imageSrc || boxes.length === 0) return;
    setBusy(true);
    setImgError("");
    try {
      const cards = [];
      for (const box of boxes) {
        const frontImage = await buildMaskedImage(box);
        cards.push({
          frontImage,
          backImage: imageSrc,
          back: box.label.trim() || "Region"
        });
      }
      onCreate(cards, linkedNoteId || null);
    } catch (e) {
      setImgError("Couldn't generate occlusion cards — try again.");
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal wide",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Image occlusion"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), !imageSrc ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Upload a diagram, then draw boxes over the parts you want to be quizzed on \u2014 each box becomes its own flashcard."), /*#__PURE__*/React.createElement("label", {
    className: "btn-primary file-label",
    style: {
      width: "fit-content"
    }
  }, "+ Upload image", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    className: "visually-hidden-file",
    onChange: e => handleFile(e.target.files && e.target.files[0])
  })), imgError && /*#__PURE__*/React.createElement("div", {
    className: "gen-error"
  }, imgError), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Drag on the image to draw a box over a region, then label it below. Add as many as you like."), /*#__PURE__*/React.createElement("div", {
    className: "occlusion-canvas-wrap",
    ref: containerRef,
    onPointerDown: startDraw,
    onPointerMove: moveDraw,
    onPointerUp: endDraw,
    onPointerLeave: endDraw,
    onPointerCancel: () => setDrawing(null)
  }, /*#__PURE__*/React.createElement("img", {
    src: imageSrc,
    alt: "",
    className: "occlusion-base-image",
    draggable: false
  }), boxes.map(b => /*#__PURE__*/React.createElement("div", {
    key: b.id,
    className: "occlusion-box",
    style: {
      left: `${b.x * 100}%`,
      top: `${b.y * 100}%`,
      width: `${b.w * 100}%`,
      height: `${b.h * 100}%`
    }
  })), drawing && /*#__PURE__*/React.createElement("div", {
    className: "occlusion-box drawing",
    style: {
      left: `${Math.min(drawing.startX, drawing.curX) * 100}%`,
      top: `${Math.min(drawing.startY, drawing.curY) * 100}%`,
      width: `${Math.abs(drawing.curX - drawing.startX) * 100}%`,
      height: `${Math.abs(drawing.curY - drawing.startY) * 100}%`
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "occlusion-toolbar-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "occlusion-box-count"
  }, boxes.length, " box", boxes.length === 1 ? "" : "es"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: undoLastBox,
    disabled: boxes.length === 0
  }, "\u21BA Undo last box")), boxes.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "occlusion-label-list"
  }, boxes.map((b, i) => /*#__PURE__*/React.createElement("div", {
    key: b.id,
    className: "occlusion-label-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "occlusion-label-index"
  }, i + 1), /*#__PURE__*/React.createElement("input", {
    value: b.label,
    onChange: e => updateLabel(b.id, e.target.value),
    placeholder: "Label this region\u2026"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => removeBox(b.id)
  }, "\u2715")))), notes && notes.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "study-filter-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Link these cards to a note (optional)"), /*#__PURE__*/React.createElement("select", {
    className: "parent-select",
    value: linkedNoteId,
    onChange: e => setLinkedNoteId(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Don't link to a note"), notes.map(n => /*#__PURE__*/React.createElement("option", {
    key: n.id,
    value: n.id
  }, n.title)))), imgError && /*#__PURE__*/React.createElement("div", {
    className: "gen-error"
  }, imgError), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: () => setImageSrc(initialImage || null)
  }, initialImage ? "Reset boxes" : "Change image"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: handleCreate,
    disabled: boxes.length === 0 || busy
  }, busy ? "Creating…" : `Create ${boxes.length} card${boxes.length === 1 ? "" : "s"}`)))));
}

// ---------- Quick add (Keep-style) ----------

function QuickAddNote({
  onAdd,
  onAutoSave,
  onViewImage,
  onImageError,
  onSaveError
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [bodyHTML, setBodyHTML] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tagNames, setTagNames] = useState([]);
  const [color, setColor] = useState(null);
  const [images, setImages] = useState([]);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState("");
  const [showDraw, setShowDraw] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const reset = () => {
    // Flush first so anything typed but not yet autosaved is kept, then forget this note so the
    // next one starts fresh. (Closing the box therefore keeps what you wrote — it's a saved note.)
    flushAutoSave();
    savedIdRef.current = null;
    lastSavedJsonRef.current = "";
    setAutoSaved(false);
    setTitle("");
    setBodyHTML("");
    setTagInput("");
    setTagNames([]);
    setColor(null);
    setImages([]);
    setImgError("");
    setOpen(false);
    setResetKey(k => k + 1); // remounts RichTextEditor so its internal ref clears
  };
  const addTagFromInput = () => {
    const parts = tagInput.split(",").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    setTagNames(cur => [...new Set([...cur, ...parts])]);
    setTagInput("");
  };
  const addImageFiles = async files => {
    if (!files.length) return;
    setImgBusy(true);
    setImgError("");
    try {
      const compressed = await Promise.all(files.map(f => compressImage(f)));
      setImages(cur => [...cur, ...compressed.map(dataUrl => ({
        id: uid(),
        dataUrl
      }))]);
    } catch (e) {
      setImgError("Couldn't add that image — try a different file.");
    } finally {
      setImgBusy(false);
    }
  };
  const removeImage = id => setImages(cur => cur.filter(img => img.id !== id));
  const updateImage = (id, dataUrl) => setImages(cur => cur.map(img => img.id === id ? {
    ...img,
    dataUrl
  } : img));
  const [annotatingThumb, setAnnotatingThumb] = useState(null); // { id, dataUrl } | null

  // ---- Autosave (same idea as the full note editor) ----
  // The note is created ~1s after you stop typing, and again when you leave the subject, close
  // the box, or the app goes to the background — so nothing typed here is lost. Adding then
  // updates that same note instead of creating a second one.
  const savedIdRef = useRef(null);
  const saveChainRef = useRef(Promise.resolve());
  const lastSavedJsonRef = useRef("");
  const latestRef = useRef(null);
  const onAutoSaveRef = useRef(onAutoSave);
  onAutoSaveRef.current = onAutoSave;
  const [autoSaved, setAutoSaved] = useState(false);
  latestRef.current = {
    title: title.trim(),
    bodyHTML,
    tagNames,
    images,
    color
  };
  const flushAutoSave = () => {
    const p = latestRef.current;
    if (!p || !onAutoSaveRef.current || !noteHasContent(p.title, p.bodyHTML, p.images)) return;
    const json = JSON.stringify(p);
    if (json === lastSavedJsonRef.current) return;
    lastSavedJsonRef.current = json;
    saveChainRef.current = saveChainRef.current.then(() => onAutoSaveRef.current(p, savedIdRef.current)).then(id => {
      if (id && !savedIdRef.current) savedIdRef.current = id;
      setAutoSaved(true);
    }).catch(() => {
      lastSavedJsonRef.current = "";
      if (onSaveError) onSaveError("Couldn't autosave your note — it isn't saved yet.");
    });
  };
  useEffect(() => {
    const t = setTimeout(flushAutoSave, 1000);
    return () => clearTimeout(t);
  }, [title, bodyHTML, tagNames, images, color]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushAutoSave();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushAutoSave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushAutoSave);
      flushAutoSave();
    };
  }, []);
  const handleSubmit = async () => {
    if (!noteHasContent(title, bodyHTML, images)) {
      reset();
      return;
    }
    // Await + only reset() on success — otherwise a failed save (onAdd rejects) still
    // cleared the form, silently losing what was typed with no visible sign anything went wrong.
    try {
      await saveChainRef.current; // reuse the note an in-flight autosave is creating
      await onAdd(title, bodyHTML, tagNames, color, images, savedIdRef.current);
      lastSavedJsonRef.current = JSON.stringify(latestRef.current); // reset() below flushes; this marks the content as already saved
      reset();
    } catch (e) {
      if (onSaveError) onSaveError(`Couldn't save note: ${e && e.message ? e.message : e}`);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "quick-add-wrap",
    style: {
      background: color || "var(--surface)",
      "--note-ink": color ? "#241C3D" : undefined,
      "--note-muted": color ? "rgba(36,28,61,0.65)" : undefined
    }
  }, !open ? /*#__PURE__*/React.createElement("button", {
    className: "quick-add-collapsed",
    onClick: () => setOpen(true)
  }, "Take a note\u2026") : /*#__PURE__*/React.createElement("div", {
    className: "quick-add-expanded"
  }, /*#__PURE__*/React.createElement("input", {
    className: "title-input",
    placeholder: "Title (optional)",
    value: title,
    onChange: e => setTitle(e.target.value)
  }), /*#__PURE__*/React.createElement(RichTextEditor, {
    key: resetKey,
    initialHTML: "",
    placeholder: "Write or paste a note\u2026",
    onChange: setBodyHTML,
    onImageError: onImageError
  }), /*#__PURE__*/React.createElement("p", {
    className: "hint-line"
  }, "Tip: a line like ", /*#__PURE__*/React.createElement("b", null, "question :: answer"), " auto-creates a linked flashcard on save."), /*#__PURE__*/React.createElement("div", {
    className: "image-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost small file-label"
  }, imgBusy ? "Adding…" : "+ Image", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    className: "visually-hidden-file",
    onChange: e => {
      addImageFiles(Array.from(e.target.files || []));
      e.target.value = "";
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setShowDraw(true)
  }, "\u270E Draw"), imgError && /*#__PURE__*/React.createElement("span", {
    className: "gen-error"
  }, imgError)), images.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "image-thumbs"
  }, images.map(img => /*#__PURE__*/React.createElement("div", {
    key: img.id,
    className: "image-thumb-wrap"
  }, /*#__PURE__*/React.createElement("img", {
    src: img.dataUrl,
    alt: "",
    className: "image-thumb-full",
    onClick: () => onViewImage && onViewImage(img.dataUrl),
    style: {
      cursor: "zoom-in"
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "image-thumb-annotate",
    title: "Annotate",
    onClick: () => setAnnotatingThumb(img)
  }, "\u270E"), /*#__PURE__*/React.createElement("button", {
    className: "image-thumb-remove",
    onClick: () => removeImage(img.id)
  }, "\u2715")))), annotatingThumb && /*#__PURE__*/React.createElement(DrawingCanvas, {
    backgroundImageUrl: annotatingThumb.dataUrl,
    onCancel: () => setAnnotatingThumb(null),
    onSave: dataUrl => {
      updateImage(annotatingThumb.id, dataUrl);
      setAnnotatingThumb(null);
    }
  }), tagNames.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "quick-add-tags"
  }, tagNames.map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    className: "tag-pill editable"
  }, "#", t, " ", /*#__PURE__*/React.createElement("button", {
    onClick: () => setTagNames(cur => cur.filter(x => x !== t))
  }, "\u2715")))), /*#__PURE__*/React.createElement("input", {
    className: "quick-add-tag-input",
    placeholder: "Add tag, comma or enter",
    value: tagInput,
    onChange: e => setTagInput(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addTagFromInput();
      }
    },
    onBlur: addTagFromInput
  }), /*#__PURE__*/React.createElement("div", {
    className: "quick-add-footer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "color-dot-row"
  }, NOTE_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.name,
    className: "color-dot" + (color === c.hex ? " selected" : ""),
    style: {
      background: c.hex || "var(--surface)"
    },
    title: c.name,
    onClick: () => setColor(c.hex)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "quick-add-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: reset
  }, "Close"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: handleSubmit
  }, "Add")))), showDraw && /*#__PURE__*/React.createElement(Whiteboard, {
    onCancel: () => setShowDraw(false),
    onSave: (dataUrl, board) => {
      setImages(cur => [...cur, {
        id: uid(),
        dataUrl,
        board
      }]);
      setShowDraw(false);
    }
  }));
}

// ---------- Full note editor ----------

function NoteEditor({
  note,
  allTags,
  existingTagIds,
  tagName,
  subjectOptions,
  currentSubjectId,
  allNotes,
  subjects,
  onCancel,
  onSave,
  onAutoSave,
  onCreateCard,
  onOccludeImage,
  onViewImage,
  onNavigateToNote,
  onSplitWithNote,
  onSplitWithCards,
  isSplitPane,
  onImageError
}) {
  const [title, setTitle] = useState(note.title || "");
  const [bodyHTML, setBodyHTML] = useState(note.bodyHTML || "");
  const [tagInput, setTagInput] = useState("");
  const [tagNames, setTagNames] = useState(existingTagIds.map(tagName).filter(Boolean));
  const [images, setImages] = useState(note.images || []);
  const [color, setColor] = useState(note.color || null);
  const [subjectId, setSubjectId] = useState(note.subjectId || currentSubjectId || "");
  const [linkedNoteIds, setLinkedNoteIds] = useState(note.linkedNoteIds || []);
  const [noteSearch, setNoteSearch] = useState("");
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const scrollRegionRef = useRef(null);
  const scrollContentRef = useRef(null);
  const [scrollFade, setScrollFade] = useState({
    top: false,
    bottom: false
  });
  const [scrollThumb, setScrollThumb] = useState({
    visible: false,
    top: 0,
    height: 20
  });
  const [saveMessage, setSaveMessage] = useState(""); // shown when a save fails, so a failed Save is never silent

  const checkScrollFade = () => {
    const el = scrollRegionRef.current;
    if (!el) return;
    const {
      scrollTop,
      scrollHeight,
      clientHeight
    } = el;
    setScrollFade({
      top: scrollTop > 2,
      bottom: scrollTop + clientHeight < scrollHeight - 2
    });
    // A real, always-visible scrollbar thumb — built from a plain DOM
    // element we position ourselves, not the browser's native scrollbar.
    // Mobile browsers won't let a page force their native scrollbar to
    // stay visible, but there's nothing stopping a page from drawing its
    // own — this is that.
    if (scrollHeight <= clientHeight + 2) {
      setScrollThumb({
        visible: false,
        top: 0,
        height: 20
      });
    } else {
      const thumbHeightPct = Math.max(10, clientHeight / scrollHeight * 100);
      const maxScroll = scrollHeight - clientHeight;
      const scrollRatio = maxScroll > 0 ? scrollTop / maxScroll : 0;
      const thumbTopPct = scrollRatio * (100 - thumbHeightPct);
      setScrollThumb({
        visible: true,
        top: thumbTopPct,
        height: thumbHeightPct
      });
    }
  };

  // Belt-and-suspenders: regardless of where focus/cursor placement might
  // otherwise leave the scroll position, opening a note always starts by
  // showing its top — title, subject, and the beginning of the text.
  useEffect(() => {
    if (scrollRegionRef.current) scrollRegionRef.current.scrollTop = 0;
    checkScrollFade();
    window.addEventListener("resize", checkScrollFade);
    return () => window.removeEventListener("resize", checkScrollFade);
  }, []);

  // The scroll-fade/scrollbar state above only gets recomputed when
  // something explicitly asks it to. That misses real cases — an image
  // finishing an async load, a drawing added via the separate `images`
  // state, a font loading — anything that changes the note's actual
  // rendered height without touching bodyHTML. A ResizeObserver on the
  // actual content (not the scroll container, which is a fixed height by
  // the flex layout and wouldn't report this) catches all of these
  // uniformly, regardless of what caused the growth.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !scrollContentRef.current) return;
    const observer = new ResizeObserver(() => checkScrollFade());
    observer.observe(scrollContentRef.current);
    return () => observer.disconnect();
  }, []);

  // Content grows as you type or insert images — keep the "more below" hint
  // honest even without an actual scroll event happening.
  useEffect(() => {
    checkScrollFade();
  }, [bodyHTML]);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const [splitPickerQuery, setSplitPickerQuery] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState("");
  const [showDraw, setShowDraw] = useState(false);
  const [pendingHighlight, setPendingHighlight] = useState(null); // { front, back } | null
  const [showAi, setShowAi] = useState(false);
  const [aiSettings, setAiSettings] = useState({
    apiKey: "",
    model: AI_MODELS[0].id
  });
  useEffect(() => {
    loadAiSettings().then(setAiSettings);
  }, []);
  // The text editor only reads its starting text once, so replacing the note's text from the AI
  // panel restarts it with the new text.
  const [seed, setSeed] = useState({
    v: 0,
    html: note.bodyHTML || ""
  });
  const replaceBody = html => {
    setBodyHTML(html);
    setSeed(s => ({
      v: s.v + 1,
      html
    }));
  };
  const addTagFromInput = () => {
    const parts = tagInput.split(",").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    setTagNames(cur => [...new Set([...cur, ...parts])]);
    setTagInput("");
  };
  const removeTag = name => setTagNames(cur => cur.filter(t => t !== name));
  const addImageFiles = async files => {
    if (!files.length) return;
    setImgBusy(true);
    setImgError("");
    try {
      const compressed = await Promise.all(files.map(f => compressImage(f)));
      setImages(cur => [...cur, ...compressed.map(dataUrl => ({
        id: uid(),
        dataUrl
      }))]);
    } catch (e) {
      setImgError("Couldn't add that image — try a different file.");
    } finally {
      setImgBusy(false);
    }
  };
  const removeImage = id => setImages(cur => cur.filter(img => img.id !== id));
  const updateImage = (id, dataUrl) => setImages(cur => cur.map(img => img.id === id ? {
    ...img,
    dataUrl
  } : img));
  const [annotatingThumb, setAnnotatingThumb] = useState(null); // { id, dataUrl } | null

  const subjectNameFor = sid => (subjects || []).find(s => s.id === sid)?.name || "";
  const subjectColorFor = sid => (subjects || []).find(s => s.id === sid)?.color || "#3E7CAB";
  const noteSearchResults = useMemo(() => {
    const q = noteSearch.trim().toLowerCase();
    if (!q) return [];
    return (allNotes || []).filter(n => n.id !== note.id && !linkedNoteIds.includes(n.id) && n.title.toLowerCase().includes(q)).slice(0, 8);
  }, [noteSearch, allNotes, note.id, linkedNoteIds]);
  const splitPickerResults = useMemo(() => {
    const q = splitPickerQuery.trim().toLowerCase();
    const base = allNotes || [];
    if (!q) return base.slice(0, 8);
    return base.filter(n => n.title.toLowerCase().includes(q)).slice(0, 8);
  }, [splitPickerQuery, allNotes]);
  const linkedNotes = linkedNoteIds.map(id => (allNotes || []).find(n => n.id === id)).filter(Boolean); // silently drops dangling references (e.g. the linked note was deleted)

  const backlinkNotes = note.id ? (allNotes || []).filter(n => n.id !== note.id && (n.linkedNoteIds || []).includes(note.id)) : [];
  const addLink = noteId => {
    setLinkedNoteIds(cur => [...new Set([...cur, noteId])]);
    setNoteSearch("");
  };
  const removeLink = noteId => setLinkedNoteIds(cur => cur.filter(id => id !== noteId));

  // ---- Autosave ----
  // Nothing used to be saved until "Save note" was pressed, so closing the editor, opening a
  // split pane, or the app being backgrounded and killed lost everything typed. Now the note is
  // saved quietly ~1s after you stop typing, when the editor closes, and when the app goes to
  // the background. A brand-new note is created on its first autosave, and later saves (and the
  // final Save button) update that same note instead of making a duplicate.
  const savedIdRef = useRef(note.id || null);
  const saveChainRef = useRef(Promise.resolve());
  const lastSavedJsonRef = useRef(null);
  const latestPayloadRef = useRef(null);
  const onAutoSaveRef = useRef(onAutoSave);
  onAutoSaveRef.current = onAutoSave;
  const [autoSaveStatus, setAutoSaveStatus] = useState("");
  const currentPayload = {
    title: title.trim(),
    bodyHTML,
    tagNames,
    images,
    color,
    subjectId,
    linkedNoteIds
  };
  latestPayloadRef.current = currentPayload;
  if (lastSavedJsonRef.current === null) {
    // What's already saved: an existing note as opened, or nothing for a brand-new one.
    lastSavedJsonRef.current = note.id ? JSON.stringify(currentPayload) : "";
  }
  const flushAutoSave = () => {
    const p = latestPayloadRef.current;
    if (!p || !onAutoSaveRef.current || !noteHasContent(p.title, p.bodyHTML, p.images)) return;
    const json = JSON.stringify(p);
    if (json === lastSavedJsonRef.current) return;
    lastSavedJsonRef.current = json;
    // Chained so two saves can never run at once (which could create a new note twice).
    saveChainRef.current = saveChainRef.current.then(() => onAutoSaveRef.current(p, savedIdRef.current)).then(id => {
      if (id && !savedIdRef.current) savedIdRef.current = id;
      setAutoSaveStatus("Saved");
    }).catch(() => {
      lastSavedJsonRef.current = null; // try again on the next change
      setSaveMessage("Couldn't autosave — your changes aren't saved yet.");
    });
  };
  useEffect(() => {
    const t = setTimeout(flushAutoSave, 1000);
    return () => clearTimeout(t);
  }, [title, bodyHTML, tagNames, images, color, subjectId, linkedNoteIds]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushAutoSave();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushAutoSave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushAutoSave);
      flushAutoSave(); // editor closing by any route (✕, Cancel, opening a split pane...)
    };
  }, []);
  const handleSave = async () => {
    if (!noteHasContent(title, bodyHTML, images)) return;
    // onSave is async; without this try/catch a failure here would be a silently
    // swallowed promise rejection — the tap would look like it did nothing at all.
    try {
      await saveChainRef.current; // let any in-flight autosave finish so we reuse its note
      lastSavedJsonRef.current = JSON.stringify(currentPayload);
      await onSave(currentPayload, savedIdRef.current);
    } catch (e) {
      setSaveMessage(`Couldn't save: ${e && e.message ? e.message : e}`);
    }
  };
  const confirmHighlightCard = () => {
    if (!pendingHighlight || !pendingHighlight.back.trim() || !note.id) return;
    onCreateCard(note.id, pendingHighlight.front, pendingHighlight.back.trim());
    setPendingHighlight(null);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "note-editor-pane" + (isSplitPane ? " split" : ""),
    style: {
      background: color || "var(--surface)",
      "--note-ink": color ? "#241C3D" : undefined,
      "--note-muted": color ? "rgba(36,28,61,0.65)" : undefined,
      "--note-bg": color || "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, note.id ? "Edit note" : "New note"), /*#__PURE__*/React.createElement("div", {
    className: "note-editor-header-actions"
  }, !isSplitPane && note.id && (onSplitWithCards || onSplitWithNote) && /*#__PURE__*/React.createElement("div", {
    className: "split-menu-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setSplitMenuOpen(v => !v)
  }, "+ Split view"), splitMenuOpen && /*#__PURE__*/React.createElement("div", {
    className: "split-menu"
  }, onSplitWithCards && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      onSplitWithCards(note.id, note.subjectId);
      setSplitMenuOpen(false);
    }
  }, "\u25A4 This note's flashcards", /*#__PURE__*/React.createElement("span", {
    className: "split-menu-desc"
  }, "See and study cards made from this note")), onSplitWithNote && note.id && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      onSplitWithNote(note.id);
      setSplitMenuOpen(false);
    }
  }, "\uD83D\uDCC4 This note (side by side)", /*#__PURE__*/React.createElement("span", {
    className: "split-menu-desc"
  }, "View or edit two places in the same note at once")), onSplitWithNote && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setSplitMenuOpen(false);
      setSplitPickerOpen(true);
    }
  }, "\uD83D\uDCDD Another note", /*#__PURE__*/React.createElement("span", {
    className: "split-menu-desc"
  }, "Open a different note side by side")))), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, isSplitPane ? "✕ Close pane" : "✕"))), saveMessage && /*#__PURE__*/React.createElement("p", {
    className: "note-error"
  }, saveMessage), !saveMessage && autoSaveStatus && /*#__PURE__*/React.createElement("p", {
    className: "note-autosave"
  }, "\u2713 ", autoSaveStatus, " automatically"), splitPickerOpen && /*#__PURE__*/React.createElement("div", {
    className: "split-picker-wrap"
  }, /*#__PURE__*/React.createElement("input", {
    className: "link-search-input",
    placeholder: "Open which note alongside this one?",
    value: splitPickerQuery,
    onChange: e => setSplitPickerQuery(e.target.value),
    autoFocus: true
  }), splitPickerResults.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "link-search-results"
  }, splitPickerResults.map(n => /*#__PURE__*/React.createElement("button", {
    key: n.id,
    className: "link-search-result",
    onClick: () => {
      onSplitWithNote(n.id);
      setSplitPickerOpen(false);
      setSplitPickerQuery("");
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "linked-note-chip-dot",
    style: {
      background: subjectColorFor(n.subjectId)
    }
  }), /*#__PURE__*/React.createElement("span", null, n.title), /*#__PURE__*/React.createElement("span", {
    className: "link-search-result-subject"
  }, subjectNameFor(n.subjectId)))))), /*#__PURE__*/React.createElement("div", {
    className: "note-editor-scroll-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "note-editor-scroll-region",
    ref: scrollRegionRef,
    onScroll: checkScrollFade
  }, /*#__PURE__*/React.createElement("div", {
    className: "note-editor-scroll-content",
    ref: scrollContentRef
  }, /*#__PURE__*/React.createElement("div", {
    className: "color-dot-row"
  }, NOTE_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.name,
    className: "color-dot" + (color === c.hex ? " selected" : ""),
    style: {
      background: c.hex || "var(--surface)"
    },
    title: c.name,
    onClick: () => setColor(c.hex)
  }))), /*#__PURE__*/React.createElement("input", {
    className: "title-input",
    placeholder: "Title (optional)",
    value: title,
    onChange: e => setTitle(e.target.value)
  }), subjectOptions && subjectOptions.length > 1 && /*#__PURE__*/React.createElement("div", {
    className: "subject-move-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Subject"), /*#__PURE__*/React.createElement("select", {
    className: "parent-select",
    value: subjectId,
    onChange: e => setSubjectId(e.target.value)
  }, subjectOptions.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.id,
    value: s.id
  }, s.label)))), /*#__PURE__*/React.createElement(RichTextEditor, {
    key: seed.v,
    initialHTML: seed.html,
    placeholder: "Write or paste your note here\u2026",
    onChange: setBodyHTML,
    onImageError: onImageError,
    onOccludeImage: note.id && onOccludeImage ? dataUrl => onOccludeImage(dataUrl, note.id) : null,
    tall: true
  }), /*#__PURE__*/React.createElement("p", {
    className: "hint-line"
  }, "Tip: a line like ", /*#__PURE__*/React.createElement("b", null, "question :: answer"), " auto-creates a linked flashcard on save."), pendingHighlight && /*#__PURE__*/React.createElement("div", {
    className: "highlight-capture"
  }, /*#__PURE__*/React.createElement("div", {
    className: "highlight-capture-front"
  }, "\"", pendingHighlight.front, "\""), /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    placeholder: "What's the answer?",
    value: pendingHighlight.back,
    onChange: e => setPendingHighlight(p => ({
      ...p,
      back: e.target.value
    })),
    onKeyDown: e => e.key === "Enter" && confirmHighlightCard()
  }), /*#__PURE__*/React.createElement("div", {
    className: "highlight-capture-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setPendingHighlight(null)
  }, "Dismiss"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary small",
    onClick: confirmHighlightCard,
    disabled: !pendingHighlight.back.trim()
  }, "Add card"))), /*#__PURE__*/React.createElement("div", {
    className: "image-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "btn-ghost small file-label"
  }, imgBusy ? "Adding…" : "+ Add image", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    className: "visually-hidden-file",
    onChange: e => {
      addImageFiles(Array.from(e.target.files || []));
      e.target.value = "";
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: () => setShowDraw(true)
  }, "\u270E Draw"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary small",
    onClick: () => setShowAi(true)
  }, "\u2726 AI"), imgError && /*#__PURE__*/React.createElement("span", {
    className: "gen-error"
  }, imgError)), images.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "image-thumbs"
  }, images.map(img => /*#__PURE__*/React.createElement("div", {
    key: img.id,
    className: "image-thumb-wrap"
  }, /*#__PURE__*/React.createElement("img", {
    src: img.dataUrl,
    alt: "",
    className: "image-thumb-full",
    onClick: () => onViewImage && onViewImage(img.dataUrl),
    style: {
      cursor: "zoom-in"
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "image-thumb-remove",
    onClick: () => removeImage(img.id)
  }, "\u2715"), /*#__PURE__*/React.createElement("button", {
    className: "image-thumb-annotate",
    title: "Annotate",
    onClick: () => setAnnotatingThumb(img)
  }, "\u270E"), note.id && onOccludeImage && /*#__PURE__*/React.createElement("button", {
    className: "image-thumb-occlude",
    title: "Make occlusion cards from this image",
    onClick: () => onOccludeImage(img.dataUrl, note.id)
  }, "\u25A7")))), annotatingThumb && annotatingThumb.board &&
  /*#__PURE__*/
  // A drawing made on the whiteboard reopens there, with every stroke still editable.
  React.createElement(Whiteboard, {
    initialBoard: annotatingThumb.board,
    onCancel: () => setAnnotatingThumb(null),
    onSave: (dataUrl, board) => {
      setImages(cur => cur.map(im => im.id === annotatingThumb.id ? {
        ...im,
        dataUrl,
        board
      } : im));
      setAnnotatingThumb(null);
    }
  }), annotatingThumb && !annotatingThumb.board && /*#__PURE__*/React.createElement(DrawingCanvas, {
    backgroundImageUrl: annotatingThumb.dataUrl,
    onCancel: () => setAnnotatingThumb(null),
    onSave: dataUrl => {
      updateImage(annotatingThumb.id, dataUrl);
      setAnnotatingThumb(null);
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "tag-input-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tag-pills-edit"
  }, tagNames.map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    className: "tag-pill editable"
  }, "#", t, " ", /*#__PURE__*/React.createElement("button", {
    onClick: () => removeTag(t)
  }, "\u2715"))), /*#__PURE__*/React.createElement("input", {
    placeholder: "Add tag, comma or enter",
    value: tagInput,
    onChange: e => setTagInput(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addTagFromInput();
      }
    },
    onBlur: addTagFromInput
  })), allTags.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "existing-tags"
  }, allTags.filter(t => !tagNames.includes(t.name)).slice(0, 8).map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    className: "existing-tag-btn",
    onClick: () => setTagNames(cur => [...cur, t.name])
  }, "+", t.name)))), /*#__PURE__*/React.createElement("div", {
    className: "link-notes-section"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Link to other notes"), linkedNotes.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "linked-note-chips"
  }, linkedNotes.map(n => /*#__PURE__*/React.createElement("span", {
    key: n.id,
    className: "linked-note-chip"
  }, /*#__PURE__*/React.createElement("span", {
    className: "linked-note-chip-dot",
    style: {
      background: subjectColorFor(n.subjectId)
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "linked-note-chip-label",
    onClick: () => onNavigateToNote(n.id)
  }, n.title), /*#__PURE__*/React.createElement("button", {
    className: "linked-note-chip-remove",
    onClick: () => removeLink(n.id),
    title: "Unlink"
  }, "\u2715")))), /*#__PURE__*/React.createElement("div", {
    className: "link-search-wrap"
  }, /*#__PURE__*/React.createElement("input", {
    className: "link-search-input",
    placeholder: "Search notes to link\u2026",
    value: noteSearch,
    onChange: e => setNoteSearch(e.target.value)
  }), noteSearchResults.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "link-search-results"
  }, noteSearchResults.map(n => /*#__PURE__*/React.createElement("button", {
    key: n.id,
    className: "link-search-result",
    onClick: () => addLink(n.id)
  }, /*#__PURE__*/React.createElement("span", {
    className: "linked-note-chip-dot",
    style: {
      background: subjectColorFor(n.subjectId)
    }
  }), /*#__PURE__*/React.createElement("span", null, n.title), /*#__PURE__*/React.createElement("span", {
    className: "link-search-result-subject"
  }, subjectNameFor(n.subjectId)))))), backlinkNotes.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "backlinks-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Linked from"), /*#__PURE__*/React.createElement("div", {
    className: "linked-note-chips"
  }, backlinkNotes.map(n => /*#__PURE__*/React.createElement("span", {
    key: n.id,
    className: "linked-note-chip readonly"
  }, /*#__PURE__*/React.createElement("span", {
    className: "linked-note-chip-dot",
    style: {
      background: subjectColorFor(n.subjectId)
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "linked-note-chip-label",
    onClick: () => onNavigateToNote(n.id)
  }, n.title)))))))), scrollFade.top && /*#__PURE__*/React.createElement("div", {
    className: "scroll-fade scroll-fade-top"
  }), scrollFade.bottom && /*#__PURE__*/React.createElement("div", {
    className: "scroll-fade scroll-fade-bottom"
  }), scrollThumb.visible && /*#__PURE__*/React.createElement("div", {
    className: "custom-scrollbar-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "custom-scrollbar-thumb",
    style: {
      top: scrollThumb.top + "%",
      height: scrollThumb.height + "%"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: handleSave,
    disabled: !noteHasContent(title, bodyHTML, images)
  }, "Save note")), showDraw && /*#__PURE__*/React.createElement(Whiteboard, {
    onCancel: () => setShowDraw(false),
    onSave: (dataUrl, board) => {
      setImages(cur => [...cur, {
        id: uid(),
        dataUrl,
        board
      }]);
      setShowDraw(false);
    }
  }), showAi && /*#__PURE__*/React.createElement(AiPanel, {
    title: title,
    bodyHTML: bodyHTML,
    images: images,
    settings: aiSettings,
    onSettingsChange: setAiSettings,
    onReplaceBody: replaceBody,
    onAppendHTML: html => replaceBody((bodyHTML || "") + html),
    onAddImage: dataUrl => setImages(cur => [...cur, {
      id: uid(),
      dataUrl
    }]),
    onClose: () => setShowAi(false)
  }));
}

// ---------- Separator-paste card import (Quizlet-style) ----------

const TERM_SEP_OPTIONS = [{
  label: "Tab",
  value: "\t"
}, {
  label: "Comma",
  value: ","
}, {
  label: "Dash ( - )",
  value: " - "
}, {
  label: "Custom…",
  value: "custom"
}];
const CARD_SEP_OPTIONS = [{
  label: "New line",
  value: "\n"
}, {
  label: "Semicolon",
  value: ";"
}, {
  label: "Custom…",
  value: "custom"
}];
function ImportCardsModal({
  onCancel,
  onConfirm
}) {
  const [text, setText] = useState("");
  const [termSepChoice, setTermSepChoice] = useState("\t");
  const [termSepCustom, setTermSepCustom] = useState("");
  const [cardSepChoice, setCardSepChoice] = useState("\n");
  const [cardSepCustom, setCardSepCustom] = useState("");
  const [candidates, setCandidates] = useState(null);
  const [parseError, setParseError] = useState("");
  const effectiveTermSep = termSepChoice === "custom" ? termSepCustom : termSepChoice;
  const effectiveCardSep = cardSepChoice === "custom" ? cardSepCustom : cardSepChoice;
  const handleParse = () => {
    setParseError("");
    if (!effectiveTermSep) {
      setParseError("Enter a custom separator between term and definition.");
      return;
    }
    if (!effectiveCardSep) {
      setParseError("Enter a custom separator between cards.");
      return;
    }
    const parsed = parseSeparatorText(text, effectiveTermSep, effectiveCardSep);
    if (!parsed.length) {
      setParseError("Couldn't find any term/definition pairs with those separators — check your text and separator choice.");
      return;
    }
    setCandidates(parsed.map(c => ({
      ...c,
      id: uid()
    })));
  };
  const updateCandidate = (idx, field, value) => {
    setCandidates(cur => cur.map((c, i) => i === idx ? {
      ...c,
      [field]: value
    } : c));
  };
  const removeCandidate = idx => setCandidates(cur => cur.filter((_, i) => i !== idx));
  const handleConfirm = () => {
    onConfirm(candidates.map(({
      front,
      back
    }) => ({
      front,
      back
    })));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal wide",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Import cards"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), candidates === null ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Paste term/definition pairs \u2014 copy straight out of a spreadsheet, doc, or a Quizlet set's export and this will split it into cards. Pick the separators that match your text."), /*#__PURE__*/React.createElement("textarea", {
    className: "import-textarea",
    placeholder: "heart failure\treduced ability of the heart to pump blood\nafterload\tresistance the heart pumps against",
    value: text,
    onChange: e => setText(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "sep-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sep-field"
  }, /*#__PURE__*/React.createElement("label", null, "Between term and definition"), /*#__PURE__*/React.createElement("select", {
    value: termSepChoice,
    onChange: e => setTermSepChoice(e.target.value)
  }, TERM_SEP_OPTIONS.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label))), termSepChoice === "custom" && /*#__PURE__*/React.createElement("input", {
    placeholder: "e.g. ::",
    value: termSepCustom,
    onChange: e => setTermSepCustom(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "sep-field"
  }, /*#__PURE__*/React.createElement("label", null, "Between cards"), /*#__PURE__*/React.createElement("select", {
    value: cardSepChoice,
    onChange: e => setCardSepChoice(e.target.value)
  }, CARD_SEP_OPTIONS.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label))), cardSepChoice === "custom" && /*#__PURE__*/React.createElement("input", {
    placeholder: "e.g. |||",
    value: cardSepCustom,
    onChange: e => setCardSepCustom(e.target.value)
  }))), parseError && /*#__PURE__*/React.createElement("div", {
    className: "gen-error"
  }, parseError), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: handleParse,
    disabled: !text.trim()
  }, "Split into cards"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "Found ", candidates.length, " card", candidates.length === 1 ? "" : "s", " \u2014 review, edit, or discard before adding."), /*#__PURE__*/React.createElement("div", {
    className: "candidate-list"
  }, candidates.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    className: "candidate-row"
  }, /*#__PURE__*/React.createElement("textarea", {
    className: "candidate-front",
    value: c.front,
    onChange: e => updateCandidate(i, "front", e.target.value)
  }), /*#__PURE__*/React.createElement("textarea", {
    className: "candidate-back",
    value: c.back,
    onChange: e => updateCandidate(i, "back", e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    className: "candidate-remove",
    onClick: () => removeCandidate(i)
  }, "\u2715"))), candidates.length === 0 && /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, "All cards discarded.")), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: () => setCandidates(null)
  }, "Back"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: handleConfirm,
    disabled: candidates.length === 0
  }, "Add ", candidates.length, " card", candidates.length === 1 ? "" : "s", " to deck")))));
}

// ---------- Card editor ----------

function CardEditor({
  card,
  onCancel,
  onSave
}) {
  const isOcclusion = !!card.frontImage;
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Edit card"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onCancel
  }, "\u2715")), isOcclusion ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Question (image)"), /*#__PURE__*/React.createElement("img", {
    src: card.frontImage,
    alt: "",
    className: "card-editor-thumb"
  })) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Question"), /*#__PURE__*/React.createElement("textarea", {
    className: "candidate-front",
    value: front,
    onChange: e => setFront(e.target.value)
  })), /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, isOcclusion ? "Label" : "Answer"), /*#__PURE__*/React.createElement("textarea", {
    className: "candidate-back",
    value: back,
    onChange: e => setBack(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    disabled: !isOcclusion && !front.trim() || !back.trim(),
    onClick: () => onSave(card.id, isOcclusion ? card.front : front.trim(), back.trim())
  }, "Save card"))));
}

// ---------- Study panel ----------

function StudyPanel({
  subject,
  notes,
  cards,
  dueCount,
  missedCount,
  points,
  onImport,
  onReview,
  onMatch,
  onOcclusion,
  onToggleStar,
  onDelete,
  onEdit,
  scope,
  onScopeChange,
  notesWithCards,
  noteFilter,
  onNoteFilterChange,
  selectedCardIds,
  onToggleCardSelect,
  onClearSelection
}) {
  const [sortBy, setSortBy] = useState("due"); // "due" | "box" | "newest" | "az"

  const starredCount = cards.filter(c => c.starred).length;
  const selectedVisibleCount = cards.filter(c => selectedCardIds.has(c.id)).length;
  const activeCount = scope === "starred" ? starredCount : scope === "all" ? cards.length : scope === "selected" ? selectedVisibleCount : dueCount;
  const sortedCards = useMemo(() => {
    const arr = [...cards];
    if (sortBy === "due") arr.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));else if (sortBy === "box") arr.sort((a, b) => a.box - b.box);else if (sortBy === "newest") arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));else if (sortBy === "az") arr.sort((a, b) => a.front.localeCompare(b.front));
    return arr;
  }, [cards, sortBy]);
  const allVisibleSelected = cards.length > 0 && cards.every(c => selectedCardIds.has(c.id));
  const selectAllVisible = () => cards.forEach(c => {
    if (!selectedCardIds.has(c.id)) onToggleCardSelect(c.id);
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "study-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "deck-meta-line"
  }, /*#__PURE__*/React.createElement("span", {
    className: "deck-count"
  }, cards.length, " card", cards.length === 1 ? "" : "s"), /*#__PURE__*/React.createElement("span", {
    className: "deck-dot"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", {
    className: "deck-subject-tag"
  }, subject.name)), /*#__PURE__*/React.createElement("div", {
    className: "study-stats"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-value"
  }, dueCount), /*#__PURE__*/React.createElement("span", {
    className: "stat-label"
  }, "due now")), /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-value"
  }, cards.length), /*#__PURE__*/React.createElement("span", {
    className: "stat-label"
  }, "total cards")), /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-value"
  }, missedCount), /*#__PURE__*/React.createElement("span", {
    className: "stat-label"
  }, "need review")), /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-value"
  }, points), /*#__PURE__*/React.createElement("span", {
    className: "stat-label"
  }, "points"))), /*#__PURE__*/React.createElement("div", {
    className: "study-mode-row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "mode-tile" + (activeCount === 0 ? " disabled" : ""),
    style: {
      "--mode-accent": subject.color
    },
    onClick: onReview,
    disabled: activeCount === 0
  }, /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-icon"
  }, "\u25A4"), /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-label"
  }, "Cards")), /*#__PURE__*/React.createElement("button", {
    className: "mode-tile" + (activeCount < 4 ? " disabled" : ""),
    style: {
      "--mode-accent": subject.color
    },
    onClick: onMatch,
    disabled: activeCount < 4
  }, /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-icon"
  }, "\u26AD"), /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-label"
  }, "Match")), "        ", /*#__PURE__*/React.createElement("button", {
    className: "mode-tile",
    style: {
      "--mode-accent": subject.color
    },
    onClick: onImport
  }, /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-icon"
  }, "+"), /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-label"
  }, "Import")), /*#__PURE__*/React.createElement("button", {
    className: "mode-tile",
    style: {
      "--mode-accent": subject.color
    },
    onClick: onOcclusion
  }, /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-icon"
  }, "\u25A7"), /*#__PURE__*/React.createElement("span", {
    className: "mode-tile-label"
  }, "Occlude"))), /*#__PURE__*/React.createElement("div", {
    className: "scope-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    className: "scope-btn" + (scope === "due" ? " active" : ""),
    onClick: () => onScopeChange("due")
  }, "Due (", dueCount, ")"), /*#__PURE__*/React.createElement("button", {
    className: "scope-btn" + (scope === "starred" ? " active" : ""),
    onClick: () => onScopeChange("starred")
  }, "Starred (", starredCount, ")"), /*#__PURE__*/React.createElement("button", {
    className: "scope-btn" + (scope === "all" ? " active" : ""),
    onClick: () => onScopeChange("all")
  }, "All (", cards.length, ")"), selectedCardIds.size > 0 && /*#__PURE__*/React.createElement("button", {
    className: "scope-btn" + (scope === "selected" ? " active" : ""),
    onClick: () => onScopeChange("selected")
  }, "Selected (", selectedVisibleCount, ")")), notesWithCards.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "study-filter-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Study one note"), /*#__PURE__*/React.createElement("select", {
    className: "parent-select",
    value: noteFilter || "",
    onChange: e => onNoteFilterChange(e.target.value || null)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "All notes in this subject"), notesWithCards.map(n => /*#__PURE__*/React.createElement("option", {
    key: n.id,
    value: n.id
  }, n.title)))), cards.length === 0 && /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, "No cards yet \u2014 tap Import to paste term/definition pairs, or write a \"question :: answer\" line in a note to create one."), cards.length > 0 && activeCount === 0 && /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, scope === "selected" ? "Nothing selected yet — check a few cards below." : `No cards in this scope yet — try "All", or star a few cards.`), cards.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "term-table-toolbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "term-select-controls"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost small",
    onClick: allVisibleSelected ? onClearSelection : selectAllVisible
  }, allVisibleSelected ? "Clear selection" : "Select all shown"), selectedCardIds.size > 0 && /*#__PURE__*/React.createElement("span", {
    className: "term-select-count"
  }, selectedCardIds.size, " selected")), /*#__PURE__*/React.createElement("div", {
    className: "sort-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Sort"), /*#__PURE__*/React.createElement("select", {
    value: sortBy,
    onChange: e => setSortBy(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "due"
  }, "Due soonest"), /*#__PURE__*/React.createElement("option", {
    value: "box"
  }, "Weakest first (box)"), /*#__PURE__*/React.createElement("option", {
    value: "newest"
  }, "Newest first"), /*#__PURE__*/React.createElement("option", {
    value: "az"
  }, "A\u2013Z")))), /*#__PURE__*/React.createElement("div", {
    className: "term-table"
  }, sortedCards.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    className: "term-row" + (selectedCardIds.has(c.id) ? " selected" : "")
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    className: "term-checkbox",
    checked: selectedCardIds.has(c.id),
    onChange: () => onToggleCardSelect(c.id)
  }), /*#__PURE__*/React.createElement("div", {
    className: "term-front",
    onClick: () => onEdit(c)
  }, c.frontImage ? /*#__PURE__*/React.createElement("img", {
    src: c.frontImage,
    alt: "",
    className: "term-thumb"
  }) : c.front), /*#__PURE__*/React.createElement("div", {
    className: "term-back",
    onClick: () => onEdit(c)
  }, c.back), /*#__PURE__*/React.createElement("div", {
    className: "term-actions"
  }, /*#__PURE__*/React.createElement("span", {
    className: "box-badge box-" + c.box
  }, "box ", c.box), /*#__PURE__*/React.createElement("button", {
    className: "star-btn" + (c.starred ? " starred" : ""),
    title: c.starred ? "Unstar" : "Star to always review",
    onClick: () => onToggleStar(c.id)
  }, c.starred ? "★" : "☆"), /*#__PURE__*/React.createElement("button", {
    title: "Edit card",
    onClick: () => onEdit(c)
  }, "\u270E"), /*#__PURE__*/React.createElement("button", {
    title: "Delete card",
    onClick: () => onDelete(c.id)
  }, "\u2715")))))));
}

// ---------- Review session (flip cards) ----------

function ReviewSessionInner({
  cards,
  onAnswer,
  onToggleStar,
  onClose,
  compact
}) {
  const [order] = useState(() => [...cards].sort(() => Math.random() - 0.5));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [missed, setMissed] = useState(0);
  const [starredIds, setStarredIds] = useState(() => new Set(cards.filter(c => c.starred).map(c => c.id)));
  const current = order[index];
  const done = index >= order.length;
  const handleAnswer = async isCorrect => {
    if (!current) return;
    await onAnswer(current.id, isCorrect);
    if (isCorrect) setCorrect(c => c + 1);else setMissed(m => m + 1);
    setFlipped(false);
    setIndex(i => i + 1);
  };
  const handleStar = () => {
    if (!current) return;
    onToggleStar(current.id);
    setStarredIds(cur => {
      const next = new Set(cur);
      if (next.has(current.id)) next.delete(current.id);else next.add(current.id);
      return next;
    });
  };
  useEffect(() => {
    // A compact review embedded in a split pane shouldn't hijack the whole
    // page's keyboard input — only the full-screen version gets shortcuts.
    if (compact) return;
    const handleKey = e => {
      if (done || !current) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!flipped) setFlipped(true);else handleAnswer(true);
      } else if (flipped && (e.key === "ArrowRight" || e.key === "2")) {
        e.preventDefault();
        handleAnswer(true);
      } else if (flipped && (e.key === "ArrowLeft" || e.key === "1")) {
        e.preventDefault();
        handleAnswer(false);
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        handleStar();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [flipped, done, current, compact]);
  if (order.length === 0) {
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, "No cards due right now."), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      onClick: onClose
    }, "Close")));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, done ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "eyebrow"
  }, "Session complete"), /*#__PURE__*/React.createElement("h2", {
    className: "review-summary-title"
  }, correct, " / ", order.length, " correct"), /*#__PURE__*/React.createElement("p", {
    className: "modal-copy"
  }, missed > 0 ? `${missed} card${missed === 1 ? "" : "s"} sent back to box 1 for another pass.` : "Clean sweep."), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: onClose
  }, "Done"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "review-progress"
  }, index + 1, " / ", order.length), /*#__PURE__*/React.createElement("div", {
    className: "flip-card" + (flipped ? " is-flipped" : "") + (compact ? " compact" : ""),
    onClick: () => setFlipped(f => !f)
  }, /*#__PURE__*/React.createElement("button", {
    className: "review-star" + (starredIds.has(current.id) ? " starred" : ""),
    onClick: e => {
      e.stopPropagation();
      handleStar();
    },
    title: starredIds.has(current.id) ? "Unstar" : "Star this card"
  }, starredIds.has(current.id) ? "★" : "☆"), /*#__PURE__*/React.createElement("div", {
    className: "flip-card-label"
  }, flipped ? "Answer" : "Question"), flipped ? /*#__PURE__*/React.createElement(React.Fragment, null, current.backImage && /*#__PURE__*/React.createElement("img", {
    src: current.backImage,
    alt: "",
    className: "flip-card-image"
  }), current.back && /*#__PURE__*/React.createElement("div", {
    className: "flip-card-text"
  }, current.back)) : current.frontImage ? /*#__PURE__*/React.createElement("img", {
    src: current.frontImage,
    alt: "",
    className: "flip-card-image"
  }) : /*#__PURE__*/React.createElement("div", {
    className: "flip-card-text"
  }, current.front), !flipped && /*#__PURE__*/React.createElement("div", {
    className: "flip-hint"
  }, "Tap to reveal")), flipped ? /*#__PURE__*/React.createElement("div", {
    className: "answer-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost danger",
    onClick: () => handleAnswer(false)
  }, "Missed it"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: () => handleAnswer(true)
  }, "Got it")) : /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost",
    onClick: onClose
  }, compact ? "Back to list" : "Stop for now")), !compact && /*#__PURE__*/React.createElement("p", {
    className: "keyboard-hint"
  }, "Space flip \xB7 \u2190 missed \xB7 \u2192 got it \xB7 S star")));
}
function ReviewSession({
  cards,
  onAnswer,
  onToggleStar,
  onClose
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal review-modal"
  }, /*#__PURE__*/React.createElement(ReviewSessionInner, {
    cards: cards,
    onAnswer: onAnswer,
    onToggleStar: onToggleStar,
    onClose: onClose
  })));
}

// ---------- Split-pane flashcards (view + study a note's cards alongside it) ----------

function SplitCardsPanel({
  cards,
  scope,
  onScopeChange,
  noteTitle,
  subjectTitle,
  onClose,
  onEditCard,
  onToggleStar,
  onDeleteCard,
  onStudy
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "note-editor-pane split cards-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Flashcards"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onClose
  }, "\u2715 Close pane")), /*#__PURE__*/React.createElement("div", {
    className: "note-editor-scroll-region"
  }, /*#__PURE__*/React.createElement("div", {
    className: "scope-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    className: "scope-btn" + (scope === "note" ? " active" : ""),
    onClick: () => onScopeChange("note")
  }, "This note", noteTitle ? `: ${noteTitle}` : ""), /*#__PURE__*/React.createElement("button", {
    className: "scope-btn" + (scope === "subject" ? " active" : ""),
    onClick: () => onScopeChange("subject")
  }, "Whole subject", subjectTitle ? `: ${subjectTitle}` : "")), /*#__PURE__*/React.createElement("div", {
    className: "deck-meta-line"
  }, /*#__PURE__*/React.createElement("span", {
    className: "deck-count"
  }, cards.length, " card", cards.length === 1 ? "" : "s")), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    disabled: cards.length === 0,
    onClick: onStudy
  }, "Study these"), /*#__PURE__*/React.createElement("div", {
    className: "split-cards-list"
  }, cards.length === 0 && /*#__PURE__*/React.createElement("p", {
    className: "study-hint"
  }, "No cards yet \u2014 write a \"question :: answer\" line in the note to create one."), cards.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    className: "term-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "term-front",
    onClick: () => onEditCard(c)
  }, c.frontImage ? /*#__PURE__*/React.createElement("img", {
    src: c.frontImage,
    alt: "",
    className: "term-thumb"
  }) : c.front), /*#__PURE__*/React.createElement("div", {
    className: "term-back",
    onClick: () => onEditCard(c)
  }, c.back), /*#__PURE__*/React.createElement("div", {
    className: "term-actions"
  }, /*#__PURE__*/React.createElement("span", {
    className: "box-badge box-" + c.box
  }, "box ", c.box), /*#__PURE__*/React.createElement("button", {
    className: "star-btn" + (c.starred ? " starred" : ""),
    onClick: () => onToggleStar(c.id)
  }, c.starred ? "★" : "☆"), /*#__PURE__*/React.createElement("button", {
    title: "Edit card",
    onClick: () => onEditCard(c)
  }, "\u270E"), /*#__PURE__*/React.createElement("button", {
    title: "Delete card",
    onClick: () => onDeleteCard(c.id)
  }, "\u2715")))))));
}

// ---------- Match game ----------

function MatchGame({
  cards,
  onClose
}) {
  // Image-occlusion cards don't have front text, so they don't fit the
  // text-tile matching format — leave them out of the round pool entirely.
  const matchableCards = useMemo(() => cards.filter(c => !c.frontImage), [cards]);
  const roundCards = useMemo(() => {
    const shuffled = [...matchableCards].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(8, shuffled.length));
  }, [matchableCards]);
  const [tiles] = useState(() => {
    const t = [];
    roundCards.forEach(c => {
      t.push({
        id: c.id + "-f",
        cardId: c.id,
        text: c.front
      });
      t.push({
        id: c.id + "-b",
        cardId: c.id,
        text: c.back
      });
    });
    return t.sort(() => Math.random() - 0.5);
  });
  const [selected, setSelected] = useState([]);
  const [matchedCardIds, setMatchedCardIds] = useState(() => new Set());
  const [wrongIds, setWrongIds] = useState([]);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const done = matchedCardIds.size === roundCards.length && roundCards.length > 0;
  useEffect(() => {
    if (done) setRunning(false);
  }, [done]);
  const handleTap = tile => {
    if (matchedCardIds.has(tile.cardId)) return;
    if (selected.some(s => s.id === tile.id)) return;
    if (selected.length === 0) {
      setSelected([tile]);
      return;
    }
    if (selected.length === 1) {
      const first = selected[0];
      if (first.cardId === tile.cardId) {
        setMatchedCardIds(cur => new Set([...cur, tile.cardId]));
        setSelected([]);
      } else {
        setWrongIds([first.id, tile.id]);
        setTimeout(() => {
          setWrongIds([]);
          setSelected([]);
        }, 600);
        setSelected([first, tile]);
      }
    }
  };
  if (roundCards.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "modal-backdrop",
      onClick: onClose
    }, /*#__PURE__*/React.createElement("div", {
      className: "modal",
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, cards.length > 0 && matchableCards.length === 0 ? "These cards are all image-occlusion cards, which don't fit the Match format — try Cards mode instead." : "No cards available to match right now."), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      onClick: onClose
    }, "Close"))));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal wide"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "Match"), /*#__PURE__*/React.createElement("span", {
    className: "match-timer"
  }, seconds, "s"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onClose
  }, "\u2715")), done ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h2", {
    className: "review-summary-title"
  }, "Matched in ", seconds, "s"), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    onClick: onClose
  }, "Done"))) : /*#__PURE__*/React.createElement("div", {
    className: "match-grid"
  }, tiles.map(tile => {
    const matched = matchedCardIds.has(tile.cardId);
    const isSelected = selected.some(s => s.id === tile.id);
    const isWrong = wrongIds.includes(tile.id);
    return /*#__PURE__*/React.createElement("div", {
      key: tile.id,
      className: "match-tile" + (matched ? " matched" : "") + (isSelected ? " selected" : "") + (isWrong ? " wrong" : ""),
      onClick: () => handleTap(tile)
    }, tile.text);
  }))));
}

// ---------- Claude AI helpers ----------
// The key is typed in by the person using the app and kept only on this device, in its own
// storage entry (never inside the notes data, so backups and exports don't carry it). Notes are
// sent to Anthropic only when one of the AI buttons is pressed.

const AI_SETTINGS_KEY = "brainly-ai-settings";
const AI_MODELS = [{
  id: "claude-sonnet-5-5",
  label: "Sonnet 5.5 — balanced (recommended)"
}, {
  id: "claude-haiku-5-5",
  label: "Haiku 5.5 — fastest and cheapest"
}, {
  id: "claude-opus-5-5",
  label: "Opus 5.5 — most capable, costs more"
}];
async function loadAiSettings() {
  try {
    const res = await storage.get(AI_SETTINGS_KEY);
    const s = res && res.value ? JSON.parse(res.value) : {};
    return {
      apiKey: s.apiKey || "",
      model: s.model || AI_MODELS[0].id
    };
  } catch (e) {
    return {
      apiKey: "",
      model: AI_MODELS[0].id
    };
  }
}
async function saveAiSettings(settings) {
  await storage.set(AI_SETTINGS_KEY, JSON.stringify({
    apiKey: settings.apiKey || "",
    model: settings.model || AI_MODELS[0].id
  }));
}

// One call to Claude. `content` is a string, or an array of blocks (for images). Returns the text.
async function callClaude(settings, {
  system,
  content,
  history,
  maxTokens = 4000
}) {
  if (!settings || !settings.apiKey) throw new Error("Add your Claude API key first (Files page → AI).");
  const messages = history && history.length ? history : [{
    role: "user",
    content
  }];
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: settings.model || AI_MODELS[0].id,
        max_tokens: maxTokens,
        system,
        messages
      })
    });
  } catch (e) {
    throw new Error("Couldn't reach Claude — check your internet connection and try again.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j && j.error && j.error.message ? j.error.message : "";
    } catch (e) {/* no body */}
    if (res.status === 401) throw new Error("Claude rejected that API key. Check it on the Files page → AI.");
    if (res.status === 429) throw new Error("Too many requests or your usage limit was reached. Wait a moment and try again.");
    if (res.status === 529 || res.status >= 500) throw new Error("Claude is busy right now. Try again in a minute.");
    throw new Error("Claude returned an error (" + res.status + ")" + (detail ? ": " + detail : "."));
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

// Models sometimes wrap JSON in prose or code fences; pull the JSON out either way.
function aiParseJSON(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;else if (firstArr === -1) start = firstObj;else start = Math.min(firstObj, firstArr);
  if (start === -1) throw new Error("Claude's answer wasn't in the expected format. Try again.");
  const open = t[start];
  const end = t.lastIndexOf(open === "{" ? "}" : "]");
  if (end <= start) throw new Error("Claude's answer was cut off. Try again.");
  return JSON.parse(t.slice(start, end + 1));
}

// Keeps only the tags the editor understands; drops scripts, styles, attributes and everything else.
function aiSanitizeHTML(html) {
  const doc = new DOMParser().parseFromString("<div>" + String(html || "") + "</div>", "text/html");
  const ALLOWED = new Set(["H1", "H2", "H3", "H4", "P", "UL", "OL", "LI", "B", "STRONG", "I", "EM", "U", "BR"]);
  const clean = node => {
    let out = "";
    node.childNodes.forEach(c => {
      if (c.nodeType === 3) out += escapeHTML(c.nodeValue);else if (c.nodeType === 1) {
        const tag = c.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") return;
        const inner = clean(c);
        if (ALLOWED.has(tag)) {
          const t = tag.toLowerCase();
          out += t === "br" ? "<br>" : "<" + t + ">" + inner + "</" + t + ">";
        } else out += inner;
      }
    });
    return out;
  };
  return clean(doc.body.firstChild);
}

// Inline pictures would bloat the request, so they're swapped for [[IMAGE n]] markers before
// sending and put back afterwards.
function aiNoteForPrompt(bodyHTML) {
  const doc = new DOMParser().parseFromString("<div>" + (bodyHTML || "") + "</div>", "text/html");
  const imgs = [];
  doc.body.querySelectorAll("img").forEach(img => {
    imgs.push(img.outerHTML);
    img.replaceWith(doc.createTextNode("[[IMAGE " + imgs.length + "]]"));
  });
  return {
    html: doc.body.firstChild.innerHTML,
    text: htmlToPlainText(doc.body.firstChild.innerHTML),
    imgs
  };
}
function aiRestoreImages(html, imgs) {
  return imgs.reduce((acc, tag, i) => acc.split("[[IMAGE " + (i + 1) + "]]").join(tag), html);
}
const AI_SYSTEM = "You are a careful study-notes assistant inside a notes app used by a cardiac stress-test nurse. " + "Never invent medical facts; if something is unclear or missing, say so instead of guessing. " + "Never add patient names or identifiers. Keep the user's meaning and wording where possible.";
function dataUrlToImageBlock(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl || "");
  if (!m) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: m[1],
      data: m[2]
    }
  };
}

// ---------- Mind map drawing (plain SVG, no library) ----------

const MINDMAP_COLORS = ["#3E7CAB", "#3F9A8C", "#D98F78", "#B48D2B", "#8B9A63", "#7E9ED8", "#A5A8E3", "#C0569A"];
function mindMapLayout(tree) {
  const NODE_H = 34,
    GAP_Y = 12,
    COL_GAP = 60;
  const clip = s => {
    const t = String(s || "").trim();
    return t.length > 34 ? t.slice(0, 33) + "…" : t;
  };
  const nodes = [];
  const edges = [];
  const widths = (label, size) => Math.max(70, Math.round(label.length * size * 0.56) + 28);
  let leafY = 0;
  const walk = (n, depth, color) => {
    const label = clip(n.label || n.center || "");
    const node = {
      label,
      depth,
      color,
      w: widths(label, depth === 0 ? 17 : 14)
    };
    node.children = (n.children || n.branches || []).map((c, i) => walk(c, depth + 1, depth === 0 ? MINDMAP_COLORS[i % MINDMAP_COLORS.length] : color));
    if (node.children.length === 0) {
      node.y = leafY;
      leafY += NODE_H + GAP_Y;
    } else {
      node.y = (node.children[0].y + node.children[node.children.length - 1].y) / 2;
    }
    nodes.push(node);
    return node;
  };
  const root = walk({
    label: tree.center || tree.label || "Mind map",
    children: tree.branches || tree.children || []
  }, 0, MINDMAP_COLORS[0]);
  const colW = [];
  nodes.forEach(n => {
    colW[n.depth] = Math.max(colW[n.depth] || 0, n.w);
  });
  const colX = [];
  let x = 20;
  colW.forEach((w, d) => {
    colX[d] = x;
    x += w + COL_GAP;
  });
  nodes.forEach(n => {
    n.x = colX[n.depth];
    n.y = n.y + 20;
  });
  nodes.forEach(n => n.children.forEach(c => edges.push({
    from: n,
    to: c
  })));
  return {
    nodes,
    edges,
    width: x - COL_GAP + 20,
    height: Math.max(leafY, NODE_H) + 40,
    root,
    NODE_H
  };
}
function mindMapSVG(tree) {
  const L = mindMapLayout(tree);
  const esc = escapeHTML;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" font-family="Urbanist, system-ui, sans-serif">`;
  svg += `<rect width="100%" height="100%" fill="#ffffff"/>`;
  L.edges.forEach(({
    from,
    to
  }) => {
    const x1 = from.x + from.w,
      y1 = from.y + L.NODE_H / 2,
      x2 = to.x,
      y2 = to.y + L.NODE_H / 2;
    const mx = (x1 + x2) / 2;
    svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${to.color}" stroke-width="2.2" opacity="0.8"/>`;
  });
  L.nodes.forEach(n => {
    const root = n.depth === 0;
    svg += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${L.NODE_H}" rx="17" fill="${root ? "#17171B" : n.color}" fill-opacity="${root ? 1 : n.depth === 1 ? 1 : 0.18}" stroke="${n.color}" stroke-width="${n.depth > 1 ? 1.5 : 0}"/>`;
    svg += `<text x="${n.x + n.w / 2}" y="${n.y + L.NODE_H / 2 + 5}" text-anchor="middle" font-size="${root ? 17 : 14}" font-weight="${n.depth <= 1 ? 700 : 500}" fill="${root || n.depth === 1 ? "#ffffff" : "#17171B"}">${esc(n.label)}</text>`;
  });
  return {
    svg: svg + "</svg>",
    width: L.width,
    height: L.height
  };
}

// SVG string -> PNG data URL, so a mind map can be attached to a note like any other picture.
function svgToPngDataUrl(svg, width, height) {
  return new Promise((resolve, reject) => {
    const scale = Math.min(2, 2400 / Math.max(width, height));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(width * scale);
      c.height = Math.round(height * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("Couldn't turn the mind map into a picture."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// ---------- API key form (Files page and the AI panel) ----------

function AiKeyForm({
  settings,
  onSaved
}) {
  const [key, setKey] = useState(settings.apiKey || "");
  const [model, setModel] = useState(settings.model);
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState("");
  const save = async () => {
    try {
      await saveAiSettings({
        apiKey: key.trim(),
        model
      });
      onSaved({
        apiKey: key.trim(),
        model
      });
      setMsg(key.trim() ? "Saved on this device." : "Key removed.");
    } catch (e) {
      setMsg("Couldn't save: " + e.message);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "ai-key-form"
  }, /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Claude API key"), /*#__PURE__*/React.createElement("div", {
    className: "ai-key-row"
  }, /*#__PURE__*/React.createElement("input", {
    className: "url-input",
    type: show ? "text" : "password",
    placeholder: "sk-ant-\u2026",
    value: key,
    onChange: e => setKey(e.target.value),
    autoComplete: "off",
    spellCheck: false
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn-ghost small",
    onClick: () => setShow(s => !s)
  }, show ? "Hide" : "Show")), /*#__PURE__*/React.createElement("label", {
    className: "field-label"
  }, "Model"), /*#__PURE__*/React.createElement("select", {
    className: "parent-select",
    value: model,
    onChange: e => setModel(e.target.value)
  }, AI_MODELS.map(m => /*#__PURE__*/React.createElement("option", {
    key: m.id,
    value: m.id
  }, m.label))), /*#__PURE__*/React.createElement("div", {
    className: "files-actions"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn-primary small",
    onClick: save
  }, "Save"), settings.apiKey && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn-ghost small danger",
    onClick: () => {
      setKey("");
      saveAiSettings({
        apiKey: "",
        model
      }).then(() => {
        onSaved({
          apiKey: "",
          model
        });
        setMsg("Key removed.");
      });
    }
  }, "Remove key"), msg && /*#__PURE__*/React.createElement("span", {
    className: "hint-line"
  }, msg)));
}

// ---------- AI panel for a note ----------

const AI_ACTIONS = [{
  id: "format",
  icon: "✦",
  label: "Format",
  hint: "Tidy the note into clear headings and bullets"
}, {
  id: "ask",
  icon: "?",
  label: "Ask",
  hint: "Ask questions about this note"
}, {
  id: "cards",
  icon: "▤",
  label: "Flashcards",
  hint: "Make question :: answer cards"
}, {
  id: "mindmap",
  icon: "◎",
  label: "Mind map",
  hint: "A simple map you can attach to the note"
}, {
  id: "slides",
  icon: "▭",
  label: "Slides",
  hint: "Turn the note into a short slide deck"
}, {
  id: "drawing",
  icon: "✎",
  label: "Read drawing",
  hint: "Turn a drawing or photo into typed notes"
}];
function AiPanel({
  title,
  bodyHTML,
  images,
  settings,
  onSettingsChange,
  onReplaceBody,
  onAppendHTML,
  onAddImage,
  onClose
}) {
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // shape depends on mode
  const [chat, setChat] = useState([]);
  const [question, setQuestion] = useState("");
  const [picked, setPicked] = useState({});
  const [slideIdx, setSlideIdx] = useState(0);
  const [imgIdx, setImgIdx] = useState(0);
  const note = useMemo(() => aiNoteForPrompt(bodyHTML), [bodyHTML]);
  const noteText = (title ? title + "\n\n" : "") + note.text;
  const hasKey = !!settings.apiKey;
  const run = async fn => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  const choose = id => {
    setMode(id);
    setResult(null);
    setError("");
    setPicked({});
    setSlideIdx(0);
  };
  const needText = () => {
    if (!note.text.trim() && !title.trim()) throw new Error("This note is empty — write something first.");
  };
  const doFormat = () => run(async () => {
    needText();
    const out = await callClaude(settings, {
      system: AI_SYSTEM + " Reformat the note the user sends. Return ONLY HTML using just these tags: h2, h3, p, ul, ol, li, b, i. Fix spelling and structure, group related points under short headings, keep every fact, and keep any [[IMAGE n]] markers exactly where they are. Lines written as 'question :: answer' must stay as separate <p> lines in that exact form.",
      content: note.html
    });
    setResult({
      html: aiRestoreImages(aiSanitizeHTML(out.replace(/^```(?:html)?/i, "").replace(/```$/, "")), note.imgs)
    });
  });
  const sendQuestion = () => run(async () => {
    const q = question.trim();
    if (!q) return;
    needText();
    const history = [...chat, {
      role: "user",
      content: q
    }];
    setChat(history);
    setQuestion("");
    const out = await callClaude(settings, {
      system: AI_SYSTEM + " Answer the user's questions using the note below. If the note doesn't cover something, say so, then add general knowledge clearly labelled as such. Be concise.\n\nNOTE:\n" + noteText,
      history,
      maxTokens: 1500
    });
    setChat([...history, {
      role: "assistant",
      content: out
    }]);
  });
  const doCards = () => run(async () => {
    needText();
    const out = await callClaude(settings, {
      system: AI_SYSTEM + " Make study flashcards from the note. Return ONLY JSON: an array of {\"q\": string, \"a\": string}. 6 to 14 cards, one fact per card, short answers. Use only what the note says.",
      content: noteText
    });
    const cards = aiParseJSON(out).filter(c => c && c.q && c.a);
    if (!cards.length) throw new Error("No cards came back. Try again.");
    setResult({
      cards
    });
    const all = {};
    cards.forEach((_, i) => {
      all[i] = true;
    });
    setPicked(all);
  });
  const doMindMap = () => run(async () => {
    needText();
    const out = await callClaude(settings, {
      system: AI_SYSTEM + " Build a simple mind map of the note. Return ONLY JSON: {\"center\": string, \"branches\": [{\"label\": string, \"children\": [{\"label\": string, \"children\": []}]}]}. 3 to 7 branches, at most 4 children each, labels under 6 words.",
      content: noteText
    });
    const tree = aiParseJSON(out);
    const built = mindMapSVG(tree);
    setResult({
      ...built,
      tree
    });
  });
  const doSlides = () => run(async () => {
    needText();
    const out = await callClaude(settings, {
      system: AI_SYSTEM + " Turn the note into a short slide deck. Return ONLY JSON: {\"title\": string, \"slides\": [{\"title\": string, \"bullets\": [string]}]}. 4 to 10 slides, 2 to 5 short bullets each, plus a first title slide with no bullets.",
      content: noteText
    });
    const deck = aiParseJSON(out);
    if (!deck.slides || !deck.slides.length) throw new Error("No slides came back. Try again.");
    setResult(deck);
    setSlideIdx(0);
  });
  const doDrawing = () => run(async () => {
    const img = images[imgIdx];
    if (!img) throw new Error("Add a drawing or photo to the note first.");
    const block = dataUrlToImageBlock(img.dataUrl);
    if (!block) throw new Error("That image type can't be read.");
    const out = await callClaude(settings, {
      system: AI_SYSTEM + " The user sends a handwritten or drawn page. Read it carefully and turn it into clean typed notes. Return ONLY HTML using h3, p, ul, li, b, i. Transcribe handwriting faithfully, group by headings, describe any diagram in one short line starting with 'Diagram:', and put '[unclear]' where text can't be read. Lines meant as flashcards ('question :: answer') should stay that way.",
      content: [block, {
        type: "text",
        text: "Turn this into clean notes."
      }]
    });
    setResult({
      html: aiSanitizeHTML(out.replace(/^```(?:html)?/i, "").replace(/```$/, ""))
    });
  });
  const addMindMap = () => run(async () => {
    const png = await svgToPngDataUrl(result.svg, result.width, result.height);
    onAddImage(png);
    onClose();
  });
  const addCards = () => {
    const lines = result.cards.filter((_, i) => picked[i]).map(c => "<p>" + escapeHTML(String(c.q).replace(/\s+/g, " ")) + " :: " + escapeHTML(String(c.a).replace(/\s+/g, " ")) + "</p>").join("");
    if (!lines) return;
    onAppendHTML("<h3>Flashcards</h3>" + lines);
    onClose();
  };
  const slidesToHTML = deck => deck.slides.map(s => "<h3>" + escapeHTML(s.title) + "</h3>" + ((s.bullets || []).length ? "<ul>" + s.bullets.map(b => "<li>" + escapeHTML(b) + "</li>").join("") + "</ul>" : "")).join("");
  const printSlides = () => {
    const html = result.slides.map(s => `<section style="page-break-after:always;min-height:90vh;padding:48px"><h1 style="font-size:40px">${escapeHTML(s.title)}</h1>${(s.bullets || []).length ? "<ul style='font-size:24px;line-height:1.6'>" + s.bullets.map(b => "<li>" + escapeHTML(b) + "</li>").join("") + "</ul>" : ""}</section>`).join("");
    printHTML(result.title || title || "Slides", html);
  };
  const body = () => {
    if (!hasKey) {
      return /*#__PURE__*/React.createElement("div", {
        className: "ai-body"
      }, /*#__PURE__*/React.createElement("p", {
        className: "modal-copy"
      }, "Paste your Claude API key to turn these tools on. It stays on this device. Notes are sent to Claude only when you press a button here, so leave out patient names and other identifying details."), /*#__PURE__*/React.createElement(AiKeyForm, {
        settings: settings,
        onSaved: onSettingsChange
      }));
    }
    if (!mode) {
      return /*#__PURE__*/React.createElement("div", {
        className: "ai-grid"
      }, AI_ACTIONS.map(a => /*#__PURE__*/React.createElement("button", {
        key: a.id,
        className: "ai-action",
        onClick: () => choose(a.id)
      }, /*#__PURE__*/React.createElement("span", {
        className: "ai-action-icon"
      }, a.icon), /*#__PURE__*/React.createElement("span", {
        className: "ai-action-label"
      }, a.label), /*#__PURE__*/React.createElement("span", {
        className: "ai-action-hint"
      }, a.hint))));
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "ai-body"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost small",
      onClick: () => setMode(null)
    }, "\u2190 All tools"), mode === "format" && /*#__PURE__*/React.createElement(React.Fragment, null, !result && /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      disabled: busy,
      onClick: doFormat
    }, busy ? "Formatting…" : "Format this note"), result && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, "Preview \u2014 nothing changes until you replace the note text."), /*#__PURE__*/React.createElement("div", {
      className: "ai-preview rte-body",
      dangerouslySetInnerHTML: {
        __html: result.html
      }
    }), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost",
      onClick: () => setResult(null)
    }, "Discard"), /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      onClick: () => {
        onReplaceBody(result.html);
        onClose();
      }
    }, "Replace note text")))), mode === "ask" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "ai-chat"
    }, chat.length === 0 && /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, "Ask anything about this note, for example \u201Cwhat are the key points?\u201D or \u201Cquiz me on this\u201D."), chat.map((m, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "ai-msg " + m.role
    }, /*#__PURE__*/React.createElement("div", {
      className: "ai-msg-text"
    }, m.content), m.role === "assistant" && /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost small",
      onClick: () => {
        onAppendHTML("<p>" + escapeHTML(m.content).replace(/\n+/g, "<br>") + "</p>");
        onClose();
      }
    }, "Add to note"))), busy && /*#__PURE__*/React.createElement("div", {
      className: "ai-msg assistant"
    }, /*#__PURE__*/React.createElement("div", {
      className: "ai-msg-text"
    }, "Thinking\u2026"))), /*#__PURE__*/React.createElement("div", {
      className: "ai-ask-row"
    }, /*#__PURE__*/React.createElement("input", {
      className: "url-input",
      placeholder: "Ask about this note\u2026",
      value: question,
      onChange: e => setQuestion(e.target.value),
      onKeyDown: e => e.key === "Enter" && !busy && sendQuestion()
    }), /*#__PURE__*/React.createElement("button", {
      className: "btn-primary small",
      disabled: busy || !question.trim(),
      onClick: sendQuestion
    }, "Ask"))), mode === "cards" && /*#__PURE__*/React.createElement(React.Fragment, null, !result && /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      disabled: busy,
      onClick: doCards
    }, busy ? "Making cards…" : "Make flashcards from this note"), result && result.cards && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, "Untick any you don't want. They're added to the note as ", /*#__PURE__*/React.createElement("i", null, "question :: answer"), " lines and become cards when the note saves, and you can edit them any time."), /*#__PURE__*/React.createElement("div", {
      className: "ai-cards"
    }, result.cards.map((c, i) => /*#__PURE__*/React.createElement("label", {
      key: i,
      className: "ai-card-row"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: !!picked[i],
      onChange: e => setPicked(p => ({
        ...p,
        [i]: e.target.checked
      }))
    }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, c.q), /*#__PURE__*/React.createElement("br", null), c.a)))), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost",
      onClick: () => setResult(null)
    }, "Redo"), /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      onClick: addCards
    }, "Add to note")))), mode === "mindmap" && /*#__PURE__*/React.createElement(React.Fragment, null, !result && /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      disabled: busy,
      onClick: doMindMap
    }, busy ? "Drawing map…" : "Make a mind map"), result && result.svg && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "ai-map",
      dangerouslySetInnerHTML: {
        __html: result.svg
      }
    }), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost",
      onClick: () => setResult(null)
    }, "Redo"), /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      disabled: busy,
      onClick: addMindMap
    }, "Attach to note")))), mode === "slides" && /*#__PURE__*/React.createElement(React.Fragment, null, !result && /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      disabled: busy,
      onClick: doSlides
    }, busy ? "Building slides…" : "Make slides from this note"), result && result.slides && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "ai-slide"
    }, /*#__PURE__*/React.createElement("h2", null, result.slides[slideIdx].title), /*#__PURE__*/React.createElement("ul", null, (result.slides[slideIdx].bullets || []).map((b, i) => /*#__PURE__*/React.createElement("li", {
      key: i
    }, b))), /*#__PURE__*/React.createElement("span", {
      className: "ai-slide-count"
    }, slideIdx + 1, " / ", result.slides.length)), /*#__PURE__*/React.createElement("div", {
      className: "ai-slide-nav"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost small",
      disabled: slideIdx === 0,
      onClick: () => setSlideIdx(i => i - 1)
    }, "\u25C0 Back"), /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost small",
      disabled: slideIdx >= result.slides.length - 1,
      onClick: () => setSlideIdx(i => i + 1)
    }, "Next \u25B6")), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost",
      onClick: () => setResult(null)
    }, "Redo"), /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost",
      onClick: printSlides
    }, "Print / save PDF"), /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      onClick: () => {
        onAppendHTML(slidesToHTML(result));
        onClose();
      }
    }, "Add outline to note")))), mode === "drawing" && /*#__PURE__*/React.createElement(React.Fragment, null, images.length === 0 ? /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, "This note has no drawings or pictures yet. Add one with \u270E Draw or + Add image, then come back.") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
      className: "modal-copy"
    }, "Pick the drawing or photo to read:"), /*#__PURE__*/React.createElement("div", {
      className: "ai-thumbs"
    }, images.map((im, i) => /*#__PURE__*/React.createElement("button", {
      key: im.id,
      className: "ai-thumb" + (i === imgIdx ? " selected" : ""),
      onClick: () => {
        setImgIdx(i);
        setResult(null);
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: im.dataUrl,
      alt: ""
    })))), !result && /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      disabled: busy,
      onClick: doDrawing
    }, busy ? "Reading…" : "Turn it into notes"), result && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "ai-preview rte-body",
      dangerouslySetInnerHTML: {
        __html: result.html
      }
    }), /*#__PURE__*/React.createElement("div", {
      className: "modal-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost",
      onClick: () => setResult(null)
    }, "Redo"), /*#__PURE__*/React.createElement("button", {
      className: "btn-primary",
      onClick: () => {
        onAppendHTML(result.html);
        onClose();
      }
    }, "Add to note"))))), error && /*#__PURE__*/React.createElement("p", {
      className: "gen-error"
    }, error));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal wide ai-modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "\u2726 AI tools"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onClose
  }, "\u2715")), body(), hasKey && mode === null && error && /*#__PURE__*/React.createElement("p", {
    className: "gen-error"
  }, error)));
}

// ---------- Infinite whiteboard (full screen, pan and zoom without limit) ----------
// Strokes are kept as vectors in "board" coordinates, so zooming in or out never loses sharpness
// and the board has no edge. Saving renders everything drawn so far to one picture for the note,
// and keeps the vectors with that picture so it can be reopened and edited.

const BOARD_COLORS = ["#241C3D", "#3E7CAB", "#C0569A", "#3F9A8C", "#D9A23B", "#E5484D", "#FFFFFF", "#FFD84D"];
const BOARD_MIN_K = 0.002;
const BOARD_MAX_K = 400;
function boardDrawStroke(ctx, s) {
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineWidth = s.w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const p = s.p;
  if (s.t === "pen") {
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], s.w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2;
      const my = (p[i][1] + p[i + 1][1]) / 2;
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
    }
    ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    ctx.stroke();
    return;
  }
  const [a, b] = [p[0], p[p.length - 1]];
  ctx.beginPath();
  if (s.t === "rect") ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));else if (s.t === "ellipse") {
    ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(Math.abs(b[0] - a[0]) / 2, 0.01), Math.max(Math.abs(b[1] - a[1]) / 2, 0.01), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    if (s.t === "arrow") {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = Math.max(s.w * 4, 10 / 1);
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - head * Math.cos(ang - Math.PI / 6), b[1] - head * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - head * Math.cos(ang + Math.PI / 6), b[1] - head * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
    }
  }
}
function boardBounds(strokes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  strokes.forEach(s => s.p.forEach(([x, y]) => {
    const r = s.w / 2;
    minX = Math.min(minX, x - r);
    minY = Math.min(minY, y - r);
    maxX = Math.max(maxX, x + r);
    maxY = Math.max(maxY, y + r);
  }));
  return strokes.length ? {
    minX,
    minY,
    maxX,
    maxY
  } : null;
}
function Whiteboard({
  initialBoard,
  onCancel,
  onSave
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const strokesRef = useRef(initialBoard && initialBoard.strokes ? initialBoard.strokes.map(s => ({
    ...s
  })) : []);
  const redoRef = useRef([]);
  const viewRef = useRef(initialBoard && initialBoard.view ? {
    ...initialBoard.view
  } : {
    x: 0,
    y: 0,
    k: 1
  });
  const currentRef = useRef(null); // the stroke being drawn
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null); // pinch/pan state
  const panRef = useRef(null);
  const rafRef = useRef(0);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(BOARD_COLORS[0]);
  const [size, setSize] = useState(3);
  const [dark, setDark] = useState(!!(initialBoard && initialBoard.dark));
  const [zoomPct, setZoomPct] = useState(100);
  const [counts, setCounts] = useState({
    undo: strokesRef.current.length,
    redo: 0
  });
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const colorRef = useRef(color);
  colorRef.current = color;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const bump = () => setCounts({
    undo: strokesRef.current.length,
    redo: redoRef.current.length
  });
  const draw = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const ratio = window.devicePixelRatio || 1;
      const v = viewRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = darkRef.current ? "#17171B" : "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // faint dots that scale with the board, so zooming and panning are easy to see
      let step = 40;
      while (step * v.k < 18) step *= 5;
      while (step * v.k > 110) step /= 5;
      const dot = darkRef.current ? "rgba(255,255,255,0.14)" : "rgba(23,23,27,0.13)";
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = dot;
      const w = canvas.width / ratio,
        h = canvas.height / ratio;
      const x0 = Math.floor(-v.x / v.k / step) * step,
        y0 = Math.floor(-v.y / v.k / step) * step;
      for (let gx = x0; gx < (w - v.x) / v.k; gx += step) {
        for (let gy = y0; gy < (h - v.y) / v.k; gy += step) {
          ctx.fillRect(gx * v.k + v.x - 1, gy * v.k + v.y - 1, 2, 2);
        }
      }
      ctx.setTransform(ratio * v.k, 0, 0, ratio * v.k, ratio * v.x, ratio * v.y);
      strokesRef.current.forEach(s => boardDrawStroke(ctx, s));
      if (currentRef.current) boardDrawStroke(ctx, currentRef.current);
    });
  };
  const resize = () => {
    const canvas = canvasRef.current,
      wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.clientWidth * ratio);
    canvas.height = Math.round(wrap.clientHeight * ratio);
    canvas.style.width = wrap.clientWidth + "px";
    canvas.style.height = wrap.clientHeight + "px";
    draw();
  };
  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    // The board is a full-screen layer: stop the page behind it from scrolling or zooming.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onWheel = e => {
      e.preventDefault();
      const rect = canvasRef.current.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    const el = canvasRef.current;
    el.addEventListener("wheel", onWheel, {
      passive: false
    });
    return () => {
      window.removeEventListener("resize", resize);
      el.removeEventListener("wheel", onWheel);
      document.body.style.overflow = prev;
      cancelAnimationFrame(rafRef.current);
    };
  }, []);
  useEffect(() => {
    draw();
  }, [dark]);
  const toBoard = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const v = viewRef.current;
    return [(clientX - rect.left - v.x) / v.k, (clientY - rect.top - v.y) / v.k];
  };
  const setView = v => {
    viewRef.current = {
      x: v.x,
      y: v.y,
      k: Math.min(BOARD_MAX_K, Math.max(BOARD_MIN_K, v.k))
    };
    setZoomPct(Math.round(viewRef.current.k * 100));
    draw();
  };
  const zoomAt = (sx, sy, factor) => {
    const v = viewRef.current;
    const k = Math.min(BOARD_MAX_K, Math.max(BOARD_MIN_K, v.k * factor));
    const f = k / v.k;
    setView({
      x: sx - (sx - v.x) * f,
      y: sy - (sy - v.y) * f,
      k
    });
  };
  const fitToContent = () => {
    const b = boardBounds(strokesRef.current);
    const wrap = wrapRef.current;
    if (!b || !wrap) {
      setView({
        x: wrap ? wrap.clientWidth / 2 : 0,
        y: wrap ? wrap.clientHeight / 2 : 0,
        k: 1
      });
      return;
    }
    const pad = 60;
    const k = Math.min((wrap.clientWidth - pad * 2) / Math.max(b.maxX - b.minX, 1), (wrap.clientHeight - pad * 2) / Math.max(b.maxY - b.minY, 1));
    const kk = Math.min(BOARD_MAX_K, Math.max(BOARD_MIN_K, k));
    setView({
      x: wrap.clientWidth / 2 - (b.minX + b.maxX) / 2 * kk,
      y: wrap.clientHeight / 2 - (b.minY + b.maxY) / 2 * kk,
      k: kk
    });
  };
  useEffect(() => {
    // start centred on the existing drawing, or on the origin for a fresh board
    if (initialBoard && initialBoard.view) {
      setZoomPct(Math.round(viewRef.current.k * 100));
      draw();
    } else setView({
      x: (wrapRef.current ? wrapRef.current.clientWidth : 0) / 2 - 200,
      y: (wrapRef.current ? wrapRef.current.clientHeight : 0) / 3,
      k: 1
    });
  }, []);
  const eraseAt = (bx, by) => {
    const v = viewRef.current;
    const r = 14 / v.k;
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter(s => {
      const pts = s.p;
      if (s.t === "pen") return !pts.some(([x, y]) => Math.abs(x - bx) < r + s.w && Math.abs(y - by) < r + s.w);
      const b = boardBounds([s]);
      return !(bx > b.minX - r && bx < b.maxX + r && by > b.minY - r && by < b.maxY + r);
    });
    if (strokesRef.current.length !== before) {
      redoRef.current = [];
      bump();
      draw();
    }
  };
  const startGesture = () => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const rect = canvasRef.current.getBoundingClientRect();
    gestureRef.current = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2 - rect.left,
      cy: (a.y + b.y) / 2 - rect.top
    };
  };
  const onPointerDown = e => {
    e.preventDefault();
    try {
      canvasRef.current.setPointerCapture(e.pointerId);
    } catch (err) {/* pointer already gone */}
    pointersRef.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType
    });
    if (pointersRef.current.size >= 2) {
      // a second finger means pan/zoom: drop the little mark the first finger started
      currentRef.current = null;
      startGesture();
      draw();
      return;
    }
    const isMiddle = e.button === 1;
    if (toolRef.current === "hand" || isMiddle || e.button === 0 && e.shiftKey && e.pointerType === "mouse") {
      panRef.current = {
        x: e.clientX,
        y: e.clientY,
        vx: viewRef.current.x,
        vy: viewRef.current.y
      };
      return;
    }
    const [bx, by] = toBoard(e.clientX, e.clientY);
    const v = viewRef.current;
    if (toolRef.current === "eraser") {
      currentRef.current = {
        erase: true
      };
      eraseAt(bx, by);
      return;
    }
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? 0.5 + e.pressure : 1;
    currentRef.current = {
      t: toolRef.current,
      c: colorRef.current,
      w: sizeRef.current * pressure / v.k,
      p: [[bx, by]]
    };
    draw();
  };
  const onPointerMove = e => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType
    });
    if (pointersRef.current.size >= 2 && gestureRef.current) {
      const pts = [...pointersRef.current.values()];
      const [a, b] = pts;
      const rect = canvasRef.current.getBoundingClientRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2 - rect.left,
        cy = (a.y + b.y) / 2 - rect.top;
      const g = gestureRef.current;
      const v = viewRef.current;
      const factor = g.dist > 0 ? dist / g.dist : 1;
      const k = Math.min(BOARD_MAX_K, Math.max(BOARD_MIN_K, v.k * factor));
      const f = k / v.k;
      // keep the point between the fingers fixed while zooming, and follow it while panning
      setView({
        x: cx - (g.cx - v.x) * f,
        y: cy - (g.cy - v.y) * f,
        k
      });
      gestureRef.current = {
        dist,
        cx,
        cy
      };
      return;
    }
    if (panRef.current) {
      setView({
        x: panRef.current.vx + (e.clientX - panRef.current.x),
        y: panRef.current.vy + (e.clientY - panRef.current.y),
        k: viewRef.current.k
      });
      return;
    }
    const cur = currentRef.current;
    if (!cur) return;
    e.preventDefault();
    const [bx, by] = toBoard(e.clientX, e.clientY);
    if (cur.erase) {
      eraseAt(bx, by);
      return;
    }
    if (cur.t === "pen") {
      const last = cur.p[cur.p.length - 1];
      if (Math.hypot(bx - last[0], by - last[1]) * viewRef.current.k < 1.2) return;
      cur.p.push([bx, by]);
    } else {
      cur.p = [cur.p[0], [bx, by]];
    }
    draw();
  };
  const finish = e => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) gestureRef.current = null;
    if (panRef.current && pointersRef.current.size === 0) panRef.current = null;
    const cur = currentRef.current;
    if (cur && pointersRef.current.size === 0) {
      currentRef.current = null;
      if (!cur.erase) {
        if (cur.t !== "pen") {
          const [bx, by] = toBoard(e.clientX, e.clientY);
          cur.p = [cur.p[0], [bx, by]];
        }
        cur.p = cur.p.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
        strokesRef.current = [...strokesRef.current, cur];
        redoRef.current = [];
        bump();
      }
      draw();
    }
  };
  const undo = () => {
    if (!strokesRef.current.length) return;
    redoRef.current = [...redoRef.current, strokesRef.current[strokesRef.current.length - 1]];
    strokesRef.current = strokesRef.current.slice(0, -1);
    bump();
    draw();
  };
  const redo = () => {
    if (!redoRef.current.length) return;
    strokesRef.current = [...strokesRef.current, redoRef.current[redoRef.current.length - 1]];
    redoRef.current = redoRef.current.slice(0, -1);
    bump();
    draw();
  };
  const clearAll = () => {
    if (!strokesRef.current.length) return;
    redoRef.current = [...strokesRef.current].reverse();
    strokesRef.current = [];
    bump();
    draw();
  };
  const handleSave = () => {
    const strokes = strokesRef.current;
    const b = boardBounds(strokes);
    if (!b) {
      onCancel();
      return;
    }
    const pad = 24;
    const w = b.maxX - b.minX + pad * 2,
      h = b.maxY - b.minY + pad * 2;
    const scale = Math.min(3, 2200 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d");
    ctx.fillStyle = darkRef.current ? "#17171B" : "#FFFFFF";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, (-b.minX + pad) * scale, (-b.minY + pad) * scale);
    strokes.forEach(s => boardDrawStroke(ctx, s));
    onSave(c.toDataURL("image/png"), {
      strokes,
      view: viewRef.current,
      dark: darkRef.current
    });
  };
  const zoomButton = factor => {
    const wrap = wrapRef.current;
    zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, factor);
  };
  const toolBtn = (id, label, title) => /*#__PURE__*/React.createElement("button", {
    key: id,
    className: "wb-btn" + (tool === id ? " active" : ""),
    onClick: () => setTool(id),
    title: title,
    "aria-label": title
  }, label);
  return /*#__PURE__*/React.createElement("div", {
    className: "whiteboard"
  }, /*#__PURE__*/React.createElement("div", {
    className: "wb-top"
  }, /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: onCancel,
    title: "Close without saving"
  }, "\u2715"), /*#__PURE__*/React.createElement("div", {
    className: "wb-tools"
  }, toolBtn("pen", "✎", "Pen"), toolBtn("eraser", "⌫", "Eraser (removes whole strokes)"), toolBtn("hand", "✋", "Move the board (or hold Shift and drag, or use two fingers)"), /*#__PURE__*/React.createElement("span", {
    className: "wb-sep"
  }), toolBtn("rect", "▭", "Rectangle"), toolBtn("ellipse", "◯", "Ellipse"), toolBtn("line", "╱", "Line"), toolBtn("arrow", "↗", "Arrow")), /*#__PURE__*/React.createElement("div", {
    className: "wb-colors"
  }, BOARD_COLORS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    className: "wb-dot" + (color === c && tool !== "eraser" ? " selected" : ""),
    style: {
      background: c
    },
    onClick: () => {
      setColor(c);
      if (tool === "eraser" || tool === "hand") setTool("pen");
    },
    "aria-label": "Color " + c
  }))), /*#__PURE__*/React.createElement("input", {
    className: "wb-size",
    type: "range",
    min: "1",
    max: "24",
    value: size,
    onChange: e => setSize(Number(e.target.value)),
    title: "Pen size",
    "aria-label": "Pen size"
  }), /*#__PURE__*/React.createElement("div", {
    className: "wb-spacer"
  }), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: undo,
    disabled: !counts.undo,
    title: "Undo"
  }, "\u21BA"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: redo,
    disabled: !counts.redo,
    title: "Redo"
  }, "\u21BB"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: clearAll,
    disabled: !counts.undo,
    title: "Clear everything (you can undo it)"
  }, "Clear"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: () => setDark(d => !d),
    title: "Switch board between light and dark"
  }, dark ? "☀" : "☾"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn wb-save",
    onClick: handleSave
  }, "Add to note")), /*#__PURE__*/React.createElement("div", {
    className: "wb-canvas-wrap",
    ref: wrapRef
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    className: "wb-canvas",
    style: {
      touchAction: "none",
      cursor: tool === "hand" ? "grab" : "crosshair"
    },
    onPointerDown: onPointerDown,
    onPointerMove: onPointerMove,
    onPointerUp: finish,
    onPointerCancel: finish
  }), /*#__PURE__*/React.createElement("div", {
    className: "wb-zoom"
  }, /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: () => zoomButton(1 / 1.5),
    title: "Zoom out"
  }, "\u2212"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn wb-zoom-pct",
    onClick: () => setView({
      x: viewRef.current.x,
      y: viewRef.current.y,
      k: 1
    }),
    title: "Back to 100%"
  }, zoomPct >= 1000 ? Math.round(zoomPct / 100) / 10 + "k%" : zoomPct + "%"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: () => zoomButton(1.5),
    title: "Zoom in"
  }, "+"), /*#__PURE__*/React.createElement("button", {
    className: "wb-btn",
    onClick: fitToContent,
    title: "Fit everything on screen"
  }, "\u2922")), /*#__PURE__*/React.createElement("div", {
    className: "wb-hint"
  }, "Two fingers or scroll wheel: zoom and move. \u270B or Shift-drag: move.")));
}

// ---------- Icons ----------

const NAV_ICON_PATHS = {
  home: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 11l9-8 9 8"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M5 10v10h14V10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 20v-6h4v6"
  })),
  files: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
  })),
  sun: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
  })),
  moon: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"
  })),
  bell: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 20a2 2 0 0 0 4 0"
  })),
  "bell-off": /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M6 8a6 6 0 0 1 9-5.2M18 8c0 3 .6 5 1.5 6.3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 16h12"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 20a2 2 0 0 0 4 0"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 3l18 18"
  })),
  lock: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "4",
    y: "11",
    width: "16",
    height: "10",
    rx: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 11V8a4 4 0 0 1 8 0v3"
  }))
};
function NavIcon({
  name
}) {
  return /*#__PURE__*/React.createElement("svg", {
    className: "nav-ico",
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, NAV_ICON_PATHS[name]);
}

// ---------- Styles ----------

function Styles() {
  return /*#__PURE__*/React.createElement("style", null, `
      @import url('https://fonts.googleapis.com/css2?family=Urbanist:wght@300;400;500;600;700;800&display=swap');

      .brainly-root {
        --bg: #EEF4F8;
        --surface: #FFFFFF;
        --ink: #17171B;
        --muted: #6C6C75;
        --border: #E5E4EA;
        --primary: #3E7CAB;
        --primary-dark: #2F6A96;
        --teal: #3F9A8C;
        --red: #CF6A55;
        --amber: #D9A23B;
        --soft: #EEF4F8;
        --soft-strong: #DCE9F2;
        --soft-red: #F8E6E1;
        --soft-red-strong: #F2D3CB;
        --scroll-thumb: #C8C8CF;
        --shadow: 0 8px 24px rgba(23,23,27,0.07);
        display: flex;
        min-height: 100vh;
        background: linear-gradient(180deg, #EAF2F7 0%, #FFFFFF 70%);
        background-attachment: fixed;
        color: var(--ink);
        font-family: 'Urbanist', 'Inter', -apple-system, sans-serif;
        font-size: 15px;
      }
      .brainly-root.dark {
        --bg: #17171B;
        --surface: #232327;
        --ink: #F8F7FA;
        --muted: #9797A0;
        --border: #3B3B42;
        --primary: #8FB5D1;
        --primary-dark: #C6D4EF;
        --teal: #8CCDC2;
        --red: #E8917F;
        --amber: #EFC66E;
        --soft: #2E2E35;
        --soft-strong: #3B3B42;
        --soft-red: #3D2A27;
        --soft-red-strong: #4C322E;
        --scroll-thumb: #4A4A52;
        --shadow: 0 8px 24px rgba(0,0,0,0.35);
        background: linear-gradient(180deg, #17171B 0%, #1C1C21 100%);
        background-attachment: fixed;
      }
      .brainly-root .sidebar, .brainly-root .main { background: transparent; }
      .brainly-root.dark .sidebar { background: rgba(35,35,39,0.85); }
      .brainly-root .sidebar { background: rgba(255,255,255,0.72); backdrop-filter: blur(10px); }
      .brainly-root.dark .sidebar { backdrop-filter: blur(10px); }
      .nav-ico { width: 18px; height: 18px; flex-shrink: 0; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .home-nav-btn, .icon-toggle-btn { display: flex; align-items: center; gap: 10px; }
      .brainly-root * { box-sizing: border-box; }
      .brainly-root button { font-family: 'Inter', sans-serif; cursor: pointer; }
      .brainly-root button:focus-visible,
      .brainly-root input:focus-visible,
      .brainly-root textarea:focus-visible,
      .brainly-root select:focus-visible {
        outline: 2px solid var(--primary);
        outline-offset: 2px;
      }
      .brainly-root * { scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent; }
      .brainly-root *::-webkit-scrollbar { width: 10px; height: 10px; }
      .brainly-root *::-webkit-scrollbar-track { background: transparent; }
      .brainly-root *::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 8px; border: 2px solid var(--surface); }
      .brainly-root *::-webkit-scrollbar-thumb:hover { background: var(--primary); }
      .brainly-root h1, .brainly-root h2 { font-family: 'Baloo 2', sans-serif; }

      .sidebar {
        width: 240px;
        min-width: 240px;
        background: var(--surface);
        border-right: 1px solid var(--border);
        padding: 24px 16px;
        display: flex;
        flex-direction: column;
      }
      .brand { display: flex; align-items: center; gap: 8px; }
      .brand-mark { color: var(--primary); font-size: 20px; }
      .brand-name { font-family: 'Baloo 2', sans-serif; font-weight: 700; font-size: 18px; }
      .brand-sub { font-size: 11.5px; color: var(--muted); margin: 4px 0 20px 0; }

      .home-nav-btn {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 8px 10px;
        text-align: left;
        color: var(--ink);
        font-size: 13.5px;
        margin-bottom: 10px;
      }
      .home-nav-btn:hover { background: var(--soft); }
      .home-nav-btn.active { background: var(--primary); color: #fff; font-weight: 600; }

      .subject-list { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }
      .empty-hint { font-size: 12px; color: var(--muted); padding: 8px 0; }
      .subject-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        background: transparent;
        border: none;
        text-align: left;
        padding: 8px 10px;
        border-radius: 8px;
        color: var(--ink);
        font-size: 13.5px;
      }
      .subject-item.child { padding-left: 26px; font-size: 13px; }
      .subject-item:hover { background: var(--soft); }
      .subject-item.active { background: var(--primary); color: #fff; font-weight: 600; }
      .subject-item.active .subject-count { color: rgba(255,255,255,0.75); }
      .subject-expand-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        font-size: 10px;
        color: var(--muted);
        transition: transform 0.15s ease;
        cursor: pointer;
      }
      .subject-expand-toggle.expanded { transform: rotate(90deg); }
      .subject-item.active .subject-expand-toggle { color: rgba(255,255,255,0.75); }
      .subject-item .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
      .subject-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .subject-count { font-size: 11px; color: var(--muted); }
      .subject-children { display: flex; flex-direction: column; gap: 2px; }

      .add-subject-btn {
        margin-top: 12px;
        background: transparent;
        border: 1.5px dashed var(--border);
        border-radius: 10px;
        padding: 10px;
        color: var(--muted);
        font-size: 12.5px;
      }
      .add-subject-btn:hover { border-color: var(--primary); color: var(--primary); }

      .new-subject-form { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
      .new-subject-form input, .parent-select {
        font-family: 'Inter', sans-serif;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        color: var(--ink);
        font-size: 13.5px;
      }
      .color-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; }
      .swatch.selected { border-color: var(--ink); }
      .form-actions { display: flex; gap: 8px; justify-content: flex-end; }

      .btn-primary {
        background: var(--primary);
        color: #fff;
        border: none;
        border-radius: 10px;
        padding: 9px 16px;
        font-size: 12.5px;
        font-weight: 600;
      }
      .btn-primary:hover { background: var(--primary-dark); }
      .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-primary.small { padding: 6px 12px; font-size: 11.5px; }
      .btn-ghost {
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 9px 16px;
        color: var(--ink);
        font-size: 12.5px;
      }
      .btn-ghost:hover { background: var(--soft); border-color: var(--primary); }
      .btn-ghost.small { padding: 7px 11px; font-size: 11.5px; }
      .btn-ghost.danger { color: var(--red); }
      .btn-ghost.danger:hover { background: var(--soft-red); border-color: var(--red); }
      .btn-ghost.active-toggle { background: var(--primary); color: #fff; border-color: var(--primary); }

      .save-error { margin-top: 12px; font-size: 11px; color: var(--red); }

      .sidebar-footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
      .icon-toggle-btn {
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 10px;
        text-align: left;
        color: var(--muted);
        font-size: 12px;
      }
      .icon-toggle-btn:hover { background: var(--soft); color: var(--ink); }
      .icon-toggle-btn.on { color: var(--primary-dark); border-color: var(--primary); background: var(--soft); }

      .note-error { font-size: 12px; color: #E8896B; margin: 0; padding: 0 16px; }
      .note-autosave { font-size: 11.5px; color: var(--muted); margin: 0; padding: 0 16px; }
      .files-page { max-width: 760px; display: flex; flex-direction: column; gap: 16px; }
      .files-page h1 { margin: 0; font-size: 28px; font-weight: 700; }
      .files-lede { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
      .files-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
      .files-card h2 { margin: 0; font-size: 16px; font-weight: 700; }
      .files-card p { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
      .files-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .files-steps { margin: 2px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; line-height: 1.55; color: var(--ink); }
      .files-steps code { font-size: 12px; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
      .files-tip { margin: 0; padding: 10px 14px; background: var(--soft); border-radius: 10px; color: var(--ink); font-size: 13px; line-height: 1.5; }
      .files-note { margin: 0 0 24px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
      .pin-lock-section { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
      .pin-lock-actions { display: flex; gap: 8px; }

      .lock-screen { flex: 1; display: flex; align-items: center; justify-content: center; height: 100%; background: var(--bg); }
      .lock-screen-card { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px; max-width: 320px; text-align: center; }
      .lock-screen-icon { font-size: 32px; }
      .lock-screen-card h2 { margin: 0; font-size: 18px; font-family: 'Baloo 2', sans-serif; }
      .lock-screen-error { color: var(--red); font-size: 12.5px; margin: 0; }
      .pin-input {
        width: 100%;
        text-align: center;
        letter-spacing: 6px;
        font-size: 22px;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface);
        color: var(--ink);
        font-family: 'Inter', sans-serif;
      }
      .url-input {
        width: 100%;
        font-size: 14px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface);
        color: var(--ink);
        font-family: 'Inter', sans-serif;
        box-sizing: border-box;
      }

      .overdue-banner {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        background: var(--soft-red);
        border: 1px solid var(--red);
        color: var(--ink);
        border-radius: 10px;
        padding: 10px 16px;
        margin-bottom: 20px;
        font-size: 13px;
        text-align: left;
      }
      .overdue-banner:hover { background: var(--soft-red-strong); }
      .overdue-banner-cta { color: var(--red); font-weight: 600; white-space: nowrap; }

      .main { flex: 1; padding: 32px 40px; overflow-y: auto; }
      .main-header { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
      .eyebrow { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
      .main-header h1 { margin: 0; font-size: 28px; font-weight: 700; }
      .header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

      .section-divider { height: 1px; background: var(--border); margin: 20px 0; }

      .tab-bar { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
      .tab-btn {
        background: transparent;
        border: none;
        padding: 10px 4px;
        margin-right: 24px;
        font-size: 13px;
        color: var(--muted);
        border-bottom: 3px solid transparent;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }
      .tab-badge { background: var(--red); color: #fff; font-size: 10px; padding: 1px 7px; border-radius: 999px; }

      .quick-add-wrap { border: 1px solid var(--border); border-radius: 14px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(108,92,231,0.06); color: var(--note-ink, var(--ink)); }
      .quick-add-collapsed { width: 100%; text-align: left; background: none; border: none; padding: 14px 18px; font-size: 14.5px; color: var(--muted); }
      .quick-add-expanded { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px; }
      .quick-add-tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .quick-add-tag-input { border: none; background: transparent; font-size: 12px; color: var(--muted); padding: 4px 0; }
      .quick-add-tag-input:focus { outline: none; }
      .quick-add-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
      .quick-add-actions { display: flex; gap: 8px; }

      .color-dot-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .color-dot { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); }
      .color-dot.selected { border: 2px solid var(--ink); }

      .filters { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
      .search {
        font-family: 'Inter', sans-serif;
        padding: 10px 14px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface);
        color: var(--ink);
        font-size: 14px;
        max-width: 360px;
      }
      .tag-filters { display: flex; flex-wrap: wrap; gap: 6px; }
      .tag-filters.study-tag-filters { margin-bottom: 16px; }
      .tag-chip { background: var(--soft); border: 1px solid transparent; border-radius: 999px; padding: 5px 12px; font-size: 12px; color: var(--primary-dark); font-weight: 500; }
      .tag-chip.active { background: var(--primary); color: #fff; }

      .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 80px 20px; color: var(--muted); }
      .empty-state.small { padding: 40px 20px; }
      .empty-mark { font-size: 32px; color: var(--primary); margin-bottom: 12px; }
      .empty-state h2 { margin: 0 0 8px 0; color: var(--ink); font-size: 20px; }
      .empty-state p { max-width: 360px; line-height: 1.5; }

      .note-grid { column-count: 1; column-gap: 16px; }
      @media (min-width: 560px) { .note-grid { column-count: 2; } }
      @media (min-width: 920px) { .note-grid { column-count: 3; } }
      @media (min-width: 1320px) { .note-grid { column-count: 4; } }
      .note-card {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        break-inside: avoid;
        margin-bottom: 16px;
        color: var(--note-ink, var(--ink));
        transition: box-shadow 0.15s ease, transform 0.15s ease;
      }
      .note-card:hover { box-shadow: 0 6px 18px rgba(108,92,231,0.14); transform: translateY(-2px); }
      .note-card.select-active { outline: 2px solid var(--primary); outline-offset: 2px; }
      .note-select-checkbox { width: 16px; height: 16px; margin-bottom: 6px; accent-color: var(--primary); }
      .bulk-select-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
      .bulk-move-mode-toggle { display: flex; gap: 8px; margin-bottom: 10px; }
      .bulk-select-count { font-size: 12px; color: var(--primary-dark); font-weight: 600; }
      .note-card-top { cursor: pointer; }
      .note-card-subject-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-bottom: 8px; }
      .note-card h3 { margin: 0 0 6px 0; font-size: 16px; font-weight: 700; }
      .note-card-preview { font-size: 13px; color: var(--note-muted, var(--muted)); line-height: 1.5; max-height: 120px; overflow: hidden; }
      .note-card-preview mark.note-highlight { background: #FFF3C4; color: #241C3D; padding: 0 2px; border-radius: 3px; }
      .note-card-preview mark.note-highlight-red { background: #FFCDD2; color: #241C3D; }
      .note-card-preview mark.note-highlight-green { background: #C8F4DE; color: #241C3D; }
      .note-card-preview h1, .note-card-preview h2 { font-size: 16px; margin: 4px 0; }
      .note-card-preview h3, .note-card-preview h4 { font-size: 14px; margin: 4px 0; }
      .note-card-preview ul { margin: 4px 0; padding-left: 18px; }
      .note-card-tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .note-thumb-strip { display: flex; gap: 4px; margin-top: 8px; align-items: center; }
      .note-thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
      .note-thumb-more { font-size: 10.5px; color: var(--muted); }
      .note-card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 10px; }
      .note-date { font-size: 10.5px; color: var(--muted); }
      .note-link-badge { margin-left: 5px; font-size: 10px; }
      .note-card-actions { display: flex; gap: 4px; align-items: center; }
      .note-card-actions button { background: transparent; border: none; font-size: 13px; padding: 4px 6px; color: var(--muted); border-radius: 6px; }
      .note-card-actions button:hover { color: var(--primary); background: var(--soft); }

      .tag-pill { font-size: 10.5px; background: var(--soft); color: var(--primary-dark); padding: 3px 9px; border-radius: 999px; font-weight: 500; }
      .tag-pill.editable { display: inline-flex; align-items: center; gap: 4px; }
      .tag-pill.editable button { background: none; border: none; font-size: 9px; color: var(--muted); }

      .export-menu-wrap { position: relative; display: inline-block; }
      .export-menu {
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 6px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(36,28,61,0.16);
        display: flex;
        flex-direction: column;
        min-width: 190px;
        z-index: 40;
        padding: 4px;
      }
      .export-menu button { text-align: left; background: none; border: none; padding: 9px 10px; font-size: 12.5px; color: var(--ink); border-radius: 7px; white-space: nowrap; }
      .export-menu button:hover { background: var(--soft); }

      .modal-backdrop { position: fixed; inset: 0; background: rgba(36,28,61,0.45); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 65; }
      .modal { background: var(--surface); color: var(--note-ink, var(--ink)); border-radius: 18px; width: 100%; max-width: 560px; max-height: 88vh; max-height: 88dvh; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
      .modal.wide { max-width: 640px; }
      .note-editor-fullscreen-wrap {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: flex;
        flex-direction: row;
        background: var(--bg);
      }
      .note-editor-pane {
        flex: 1;
        min-width: 0;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        position: relative;
        color: var(--note-ink, var(--ink));
      }
      .note-editor-pane .modal-header {
        flex-shrink: 0;
        padding: 20px 24px 8px;
        padding-top: max(20px, env(safe-area-inset-top));
      }
      .note-editor-scroll-wrap {
        position: relative;
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .note-editor-scroll-region {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }
      .note-editor-scroll-content {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 0 24px;
      }
      .scroll-fade {
        position: absolute;
        left: 0;
        right: 0;
        height: 28px;
        pointer-events: none;
        z-index: 1;
      }
      .scroll-fade-top { top: 0; background: linear-gradient(to bottom, var(--note-bg, var(--surface)), transparent); }
      .scroll-fade-bottom { bottom: 0; background: linear-gradient(to top, var(--note-bg, var(--surface)), transparent); }
      .custom-scrollbar-track {
        position: absolute;
        top: 4px;
        bottom: 4px;
        right: 3px;
        width: 6px;
        z-index: 2;
        pointer-events: none;
        background: rgba(128,128,128,0.15);
        border-radius: 4px;
      }
      .custom-scrollbar-thumb {
        position: absolute;
        left: 0;
        right: 0;
        min-height: 30px;
        border-radius: 4px;
        background: var(--primary);
        opacity: 0.55;
      }
      .note-editor-pane .modal-actions {
        flex-shrink: 0;
        padding: 8px 24px 20px;
        padding-bottom: max(20px, env(safe-area-inset-bottom));
      }
      .note-editor-pane.split { border-left: 1px solid var(--border); }
      .note-editor-header-actions { display: flex; align-items: center; gap: 8px; }
      .split-picker-wrap { position: relative; flex-shrink: 0; padding: 0 24px; }
      .split-menu-wrap { position: relative; }
      .split-menu {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(36,28,61,0.16);
        min-width: 240px;
        z-index: 10;
        overflow: hidden;
      }
      .split-menu button {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        padding: 12px 14px;
        color: var(--ink);
        border-bottom: 1px solid var(--border);
      }
      .split-menu button:last-child { border-bottom: none; }
      .split-menu button:hover { background: var(--soft); }
      .split-menu-desc { display: block; font-size: 10.5px; color: var(--muted); margin-top: 2px; font-weight: 400; }
      .modal-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .modal-close { background: none; border: none; font-size: 14px; color: var(--muted); }
      .modal-copy { font-size: 13px; color: var(--muted); margin: 0; line-height: 1.5; }
      .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); margin: 8px 0; }
      .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .confirm-modal { max-width: 380px; gap: 16px; }

      .lightbox-backdrop { position: fixed; inset: 0; background: rgba(10,8,20,0.92); z-index: 100; display: flex; flex-direction: column; }
      .lightbox-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
      .lightbox-toolbar button {
        background: rgba(255,255,255,0.12);
        border: none;
        color: #fff;
        border-radius: 8px;
        padding: 7px 14px;
        font-size: 14px;
      }
      .lightbox-toolbar button:hover { background: rgba(255,255,255,0.22); }
      .lightbox-zoom-level { color: #fff; font-size: 12px; min-width: 44px; text-align: center; }
      .lightbox-close { margin-left: auto; }
      .lightbox-scroll { flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 20px; touch-action: pan-x pan-y pinch-zoom; }
      .lightbox-image { max-width: 100%; max-height: 100%; transition: transform 0.15s ease; cursor: zoom-in; }

      .title-input { font-family: 'Inter', sans-serif; font-size: 17px; font-weight: 700; border: none; border-bottom: 1px solid var(--border); padding: 6px 0; background: transparent; color: var(--note-ink, var(--ink)); }
      .hint-line { font-size: 11.5px; color: var(--note-muted, var(--muted)); margin: 0; }

      .rte-wrap { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .rte-wrap-tall { display: flex; flex-direction: column; }
      .rte-toolbar { display: flex; align-items: center; gap: 2px; padding: 6px; border-bottom: 1px solid var(--border); background: var(--soft); flex-wrap: wrap; flex-shrink: 0; }
      .rte-toolbar button { background: transparent; border: none; border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--ink); }
      .rte-toolbar button:hover { background: var(--soft-strong); }
      .rte-toolbar-file-btn { display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; position: relative; overflow: hidden; }
      .rte-toolbar-file-btn:hover { background: var(--soft-strong); }
      .rte-inline-image { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; cursor: pointer; }
      .rte-pasted-quote { border-left: 3px solid currentColor; opacity: 0.85; padding-left: 12px; margin: 8px 0; font-style: italic; }
      .rte-toolbar-divider { width: 1px; align-self: stretch; background: var(--border); margin: 2px 4px; }
      .rte-highlight-group { display: flex; align-items: center; gap: 5px; padding: 0 4px; }
      .rte-highlight-swatch { width: 18px; height: 18px; border-radius: 5px; border: 1px solid rgba(36,28,61,0.15); padding: 0; }
      .rte-highlight-swatch:hover { transform: scale(1.12); }
      .rte-highlight-clear { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--border); background: transparent; color: var(--muted); font-size: 11px; line-height: 1; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
      .rte-highlight-clear:hover { color: var(--red); border-color: var(--red); }
      .rte-floating-toolbar .rte-highlight-clear { color: #fff; border-color: rgba(255,255,255,0.5); }
      .rte-highlight-swatch.yellow { background: #FFF3C4; }
      .rte-highlight-swatch.red { background: #FFCDD2; }
      .rte-highlight-swatch.green { background: #C8F4DE; }

      .rte-floating-toolbar {
        position: fixed;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        max-width: 92vw;
        gap: 2px;
        background: #241C3D;
        border-radius: 10px;
        padding: 5px;
        z-index: 62;
        box-shadow: 0 6px 20px rgba(0,0,0,0.3);
      }
      .rte-floating-toolbar button {
        background: none;
        border: none;
        color: #fff;
        padding: 6px 9px;
        border-radius: 6px;
        font-size: 13px;
      }
      .rte-floating-toolbar button:hover { background: rgba(255,255,255,0.18); }
      .rte-floating-toolbar .rte-toolbar-divider { width: 1px; height: 18px; align-self: center; background: rgba(255,255,255,0.25); margin: 0 3px; }
      .rte-floating-toolbar .rte-highlight-swatch { width: 18px; height: 18px; border: 1px solid rgba(255,255,255,0.3); }
      .rte-color-swatch { width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.4); padding: 0; }
      .rte-size-btn { font-weight: 700; }

      .rte-body {
        padding: 12px;
        min-height: 140px;
        max-height: 320px;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        font-size: 14.5px;
        line-height: 1.6;
        outline: none;
      }
      .rte-body-tall { min-height: 55vh; max-height: none; overflow-y: visible; }
      .rte-body h1 { font-size: 26px; font-weight: 700; margin: 12px 0 6px; }
      .rte-body h2 { font-size: 21px; font-weight: 700; margin: 10px 0 5px; }
      .rte-body h3 { font-size: 16px; margin: 8px 0 4px; }
      .rte-body h4 { font-size: 14px; font-weight: 700; margin: 6px 0 3px; text-transform: uppercase; letter-spacing: 0.04em; }
      .rte-heading-select { font-family: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--ink); margin-right: 2px; }
      .rte-toolbar .rte-color-swatch { width: 20px; height: 20px; padding: 0; border: 1px solid var(--border); border-radius: 50%; margin: 0 2px; }
      .rte-toolbar .rte-color-swatch:hover { transform: scale(1.12); background-color: inherit; }
      .rte-body ul { padding-left: 20px; margin: 6px 0; }
      .rte-body:empty:before { content: attr(data-placeholder); color: var(--muted); }
      mark.note-highlight { background: #FFF3C4; color: #241C3D; padding: 0 2px; border-radius: 3px; }
      mark.note-highlight-red { background: #FFCDD2; color: #241C3D; }
      mark.note-highlight-green { background: #C8F4DE; color: #241C3D; }

      .highlight-capture { border: 1.5px dashed var(--primary); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: var(--soft); }
      .highlight-capture-front { font-size: 13px; font-style: italic; color: var(--ink); }
      .highlight-capture input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font-family: 'Inter', sans-serif; font-size: 13px; }
      .highlight-capture-actions { display: flex; justify-content: flex-end; gap: 8px; }

      .image-row { display: flex; align-items: center; gap: 10px; }
      .file-label { display: inline-flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
      .icon-toggle-btn.file-label { justify-content: flex-start; }
      .visually-hidden-file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; left: 0; top: 0; cursor: pointer; }
      .image-thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
      .image-thumb-wrap { position: relative; width: 72px; height: 72px; }
      .image-thumb-full { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
      .image-thumb-remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; background: var(--ink); color: #fff; border: none; font-size: 9px; }
      .image-thumb-occlude { position: absolute; bottom: -6px; left: -6px; width: 20px; height: 20px; border-radius: 6px; background: var(--primary); color: #fff; border: none; font-size: 10px; }
      .image-thumb-annotate { position: absolute; bottom: -6px; right: -6px; width: 20px; height: 20px; border-radius: 6px; background: var(--teal); color: #fff; border: none; font-size: 10px; }

      .occlusion-canvas-wrap { position: relative; width: 100%; touch-action: none; cursor: crosshair; user-select: none; }
      .occlusion-base-image { width: 100%; display: block; border-radius: 8px; border: 1px solid var(--border); }
      .occlusion-box { position: absolute; background: rgba(27,42,74,0.7); border: 2px solid #1B2A4A; border-radius: 2px; pointer-events: none; }
      .occlusion-box.drawing { background: rgba(108,92,231,0.35); border: 2px dashed var(--primary); }
      .occlusion-toolbar-row { display: flex; align-items: center; justify-content: space-between; }
      .occlusion-box-count { font-size: 12px; color: var(--muted); }
      .occlusion-label-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
      .occlusion-label-row { display: flex; align-items: center; gap: 8px; }
      .occlusion-label-index {
        width: 22px; height: 22px; border-radius: 50%; background: var(--soft); color: var(--primary-dark);
        display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0;
      }
      .occlusion-label-row input { flex: 1; padding: 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 12.5px; font-family: 'Inter', sans-serif; }
      .occlusion-label-row button { background: none; border: none; color: var(--muted); font-size: 12px; }
      .occlusion-label-row button:hover { color: var(--red); }
      .term-thumb { width: 100%; max-width: 120px; height: 44px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }

      .draw-canvas-wrap { position: relative; width: 100%; }
      .draw-canvas-loading {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.85);
        border-radius: 10px;
        color: var(--muted);
        font-size: 13px;
        pointer-events: none;
      }
      .draw-canvas { width: 100%; height: 320px; border: 1px solid var(--border); border-radius: 10px; background: #fff; touch-action: none; display: block; }
      .draw-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .draw-tool-row { display: flex; align-items: center; gap: 4px; }
      .lasso-preview-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
      .lasso-preview-svg polyline { fill: none; stroke: #3E7CAB; stroke-width: 2; stroke-dasharray: 5 4; }
      .selection-overlay {
        position: absolute;
        border: 2px dashed #3E7CAB;
        cursor: move;
        touch-action: none;
      }
      .selection-overlay-img { width: 100%; height: 100%; display: block; pointer-events: none; }
      .selection-handle {
        position: absolute;
        right: -8px;
        bottom: -8px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #3E7CAB;
        border: 2px solid #fff;
        cursor: nwse-resize;
        touch-action: none;
      }

      .tag-input-row { display: flex; flex-direction: column; gap: 8px; }
      .tag-pills-edit { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid var(--border); border-radius: 10px; padding: 8px; }
      .tag-pills-edit input { border: none; outline: none; font-size: 12px; flex: 1; min-width: 140px; background: transparent; color: var(--note-ink, var(--ink)); }
      .existing-tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .existing-tag-btn { background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-size: 11px; color: var(--note-muted, var(--muted)); }
      .existing-tag-btn:hover { color: var(--primary); border-color: var(--primary); }

      .link-notes-section { display: flex; flex-direction: column; gap: 8px; }
      .linked-note-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .linked-note-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: var(--soft);
        border-radius: 999px;
        padding: 4px 6px 4px 10px;
        font-size: 12px;
      }
      .linked-note-chip.readonly { background: var(--bg); border: 1px solid var(--border); }
      .linked-note-chip-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
      .linked-note-chip-label { background: none; border: none; color: var(--primary-dark); font-weight: 500; padding: 0; text-decoration: underline; text-underline-offset: 2px; }
      .linked-note-chip-remove { background: none; border: none; color: var(--note-muted, var(--muted)); font-size: 9px; padding: 2px; }
      .linked-note-chip-remove:hover { color: var(--red); }
      .link-search-wrap { position: relative; }
      .link-search-input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 12.5px; font-family: 'Inter', sans-serif; }
      .link-search-results {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        margin-top: 4px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(36,28,61,0.16);
        max-height: 220px;
        overflow-y: auto;
        z-index: 20;
      }
      .link-search-result { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none; padding: 9px 10px; font-size: 12.5px; color: var(--ink); }
      .link-search-result:hover { background: var(--soft); }
      .link-search-result-subject { margin-left: auto; font-size: 10.5px; color: var(--note-muted, var(--muted)); }
      .backlinks-row { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--border); }

      .dashboard { display: flex; flex-direction: column; gap: 14px; max-width: 720px; }
      .dashboard h1 { margin: 0 0 4px 0; font-size: 28px; }
      .dashboard-subheading { font-size: 16px; margin: 8px 0 0 0; font-family: 'Baloo 2', sans-serif; }
      .home-search-input {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        color: var(--ink);
        font-size: 14px;
        font-family: 'Inter', sans-serif;
        margin: 4px 0 8px;
      }
      .home-search-results { display: flex; flex-direction: column; gap: 8px; }
      .home-search-result {
        display: block;
        width: 100%;
        text-align: left;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        cursor: pointer;
      }
      .home-search-result:hover { border-color: var(--primary); }
      .home-search-result-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .home-search-result-title { font-weight: 700; font-size: 14px; color: var(--ink); }
      .home-search-result-location { font-size: 11px; color: var(--muted); white-space: nowrap; }
      .home-search-result-snippet { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; line-height: 1.5; }
      .home-search-result-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
      .forecast-section { display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
      .forecast-row { display: flex; gap: 8px; align-items: flex-end; height: 100px; margin-top: 6px; }
      .forecast-day { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; height: 100%; justify-content: flex-end; }
      .forecast-bar-track { width: 100%; max-width: 28px; height: 60px; display: flex; align-items: flex-end; }
      .forecast-bar { width: 100%; background: var(--primary); border-radius: 4px 4px 0 0; min-height: 4px; }
      .forecast-bar.zero { background: var(--border); }
      .forecast-count { font-size: 12px; font-weight: 700; color: var(--ink); }
      .forecast-label { font-size: 10px; color: var(--muted); }

      .tag-study-section { display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
      .tag-study-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
      .tag-study-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
      .tag-study-count { font-size: 12px; color: var(--muted); }
      .tag-study-actions { display: flex; gap: 6px; margin-left: auto; }
      .weak-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
      .weak-table th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--border); }
      .weak-table td { padding: 10px; border-bottom: 1px solid var(--border); font-size: 13.5px; vertical-align: middle; }
      .weak-subject-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; }
      .weak-accuracy-low { color: var(--red); font-weight: 700; }

      .study-panel { display: flex; flex-direction: column; gap: 24px; }
      .deck-meta-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
      .deck-count { font-weight: 600; color: var(--ink); }
      .deck-subject-tag { color: var(--primary-dark); }
      .deck-dot { opacity: 0.6; }
      .study-stats { display: flex; gap: 28px; flex-wrap: wrap; }
      .stat { display: flex; flex-direction: column; }
      .stat-value { font-size: 26px; font-weight: 700; font-family: 'Baloo 2', sans-serif; }
      .stat-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
      .study-hint { color: var(--muted); font-size: 13px; }

      .study-mode-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .mode-tile {
        flex: 1;
        min-width: 96px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-bottom: 4px solid var(--mode-accent, var(--primary));
        border-radius: 14px;
        padding: 16px 8px 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        color: var(--ink);
      }
      .mode-tile:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(108,92,231,0.14); }
      .mode-tile.disabled { opacity: 0.4; cursor: not-allowed; }
      .mode-tile.disabled:hover { transform: none; box-shadow: none; }
      .mode-tile-icon { font-size: 20px; color: var(--mode-accent, var(--primary)); width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; border-radius: 10px; background: var(--bg); }
      .mode-tile-label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }

      .scope-toggle { display: flex; gap: 0; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; width: fit-content; }
      .scope-btn { background: var(--surface); border: none; padding: 8px 16px; font-size: 12px; color: var(--muted); }
      .scope-btn.active { background: var(--primary); color: #fff; font-weight: 600; }

      .study-filter-row { display: flex; flex-direction: column; gap: 4px; }
      .study-filter-row .parent-select { width: fit-content; max-width: 100%; }

      .term-table-toolbar { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
      .term-select-controls { display: flex; align-items: center; gap: 10px; }
      .term-select-count { font-size: 12px; color: var(--primary-dark); font-weight: 600; }
      .sort-field { display: flex; flex-direction: column; gap: 4px; }
      .sort-field select { padding: 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 12.5px; font-family: 'Inter', sans-serif; }

      .term-table { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
      .split-cards-list {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
        min-height: 200px;
      }
      .split-cards-list .term-row:last-child { border-bottom: none; }
      .term-row { display: grid; grid-template-columns: auto 1fr 1fr auto; gap: 12px; align-items: center; padding: 12px 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
      .term-row.selected { background: var(--soft); }
      .term-row:last-child { border-bottom: none; }
      .term-checkbox { width: 16px; height: 16px; accent-color: var(--primary); }
      .term-front { font-size: 14px; cursor: pointer; font-weight: 500; }
      .term-back { font-size: 13.5px; color: var(--muted); cursor: pointer; }
      .term-actions { display: flex; align-items: center; gap: 6px; }
      .box-badge { font-size: 10px; padding: 3px 9px; border-radius: 999px; background: var(--bg); color: var(--muted); }
      .box-badge.box-5 { background: var(--teal); color: #fff; }
      .star-btn { background: none; border: none; font-size: 15px; color: var(--muted); }
      .star-btn.starred { color: var(--amber); }

      .field-label { font-size: 10.5px; color: var(--note-muted, var(--muted)); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
      .subject-move-row { display: flex; flex-direction: column; gap: 4px; }
      .subject-move-row .parent-select { width: fit-content; }
      .candidate-list { display: flex; flex-direction: column; gap: 10px; max-height: 340px; overflow-y: auto; }
      .candidate-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: start; border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
      .candidate-front, .candidate-back { font-family: 'Inter', sans-serif; font-size: 13px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; resize: vertical; min-height: 60px; background: var(--bg); color: var(--ink); }
      .card-editor-thumb { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 8px; border: 1px solid var(--border); }
      .candidate-remove { background: none; border: none; color: var(--muted); font-size: 13px; align-self: center; }
      .candidate-remove:hover { color: var(--red); }

      .import-textarea { font-family: 'Inter', sans-serif; font-size: 13px; border: 1px solid var(--border); border-radius: 10px; padding: 12px; min-height: 140px; resize: vertical; background: var(--bg); color: var(--ink); }
      .sep-row { display: flex; gap: 16px; flex-wrap: wrap; }
      .sep-field { display: flex; flex-direction: column; gap: 6px; }
      .sep-field label { font-size: 11px; color: var(--muted); }
      .sep-field select, .sep-field input { padding: 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 12.5px; font-family: 'Inter', sans-serif; }
      .gen-error { color: var(--red); font-size: 12.5px; }

      .review-modal { max-width: 480px; align-items: stretch; }
      .review-progress { font-size: 11px; color: var(--muted); text-align: center; }
      .flip-card {
        position: relative;
        background: linear-gradient(135deg, #1B2A4A, #24365C);
        border: 1px solid #0F1930;
        border-radius: 16px;
        min-height: 200px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 28px 20px;
        cursor: pointer;
        gap: 10px;
        transition: transform 0.15s ease;
      }
      .flip-card:active { transform: scale(0.98); }
      .flip-card.is-flipped { background: linear-gradient(135deg, var(--primary), #8B7CF0); border-color: var(--primary); }
      .flip-card-label { font-size: 10.5px; color: rgba(255,255,255,0.7); text-transform: uppercase; letter-spacing: 1px; }
      .flip-card-text { font-size: 19px; line-height: 1.5; font-weight: 500; color: #fff; }
      .flip-card-image { max-width: 100%; max-height: 280px; object-fit: contain; border-radius: 8px; }
      .flip-hint { font-size: 10.5px; color: rgba(255,255,255,0.6); }
      .answer-actions { display: flex; gap: 10px; justify-content: center; }
      .keyboard-hint { text-align: center; font-size: 10.5px; color: var(--muted); margin: 6px 0 0 0; }
      .review-summary-title { text-align: center; margin: 4px 0; font-family: 'Baloo 2', sans-serif; }
      .review-star { position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 18px; color: rgba(255,255,255,0.65); }
      .review-star.starred { color: var(--amber); }

      .match-timer { font-size: 12px; color: var(--muted); }
      .match-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
      .match-tile {
        background: var(--soft);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 14px 10px;
        min-height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        font-size: 12.5px;
        cursor: pointer;
      }
      .match-tile.selected { border-color: var(--primary); background: var(--soft-strong); }
      .match-tile.matched { opacity: 0; pointer-events: none; }
      .match-tile.wrong { border-color: var(--red); background: var(--soft-red-strong); }

      .toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--ink);
        color: #fff;
        padding: 10px 20px;
        border-radius: 14px;
        font-size: 12px;
        z-index: 66;
        max-width: min(90vw, 420px);
        white-space: pre-wrap;
        line-height: 1.5;
      }

      /* ---- Soft pastel redesign (StudyFlow / Nixtio inspired) ---- */
      .brainly-root h1, .brainly-root h2, .brand-name, .lock-screen-card h2 { font-family: 'Urbanist', sans-serif; font-weight: 600; letter-spacing: -0.02em; }
      .brainly-root h1 { font-weight: 300; }
      .brainly-root button { font-family: 'Urbanist', sans-serif; }
      .brand-mark { display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; border-radius: 12px; background: var(--primary); color: #fff; font-size: 17px; }
      .brand-name { font-size: 22px; }
      .brand { gap: 10px; }
      .home-nav-btn, .subject-item { border-radius: 14px; padding: 10px 12px; }
      .home-nav-btn.active, .subject-item.active { background: var(--primary); color: #fff; box-shadow: 0 4px 12px rgba(62,124,171,0.28); }
      .subject-item .dot { width: 10px; height: 10px; }
      .add-subject-btn { border-radius: 14px; }
      .btn-primary { border-radius: 999px; min-height: 44px; padding: 10px 22px; box-shadow: 0 4px 12px rgba(62,124,171,0.25); }
      .btn-ghost { border-radius: 999px; background: var(--surface); }
      .icon-toggle-btn { border-radius: 14px; background: var(--surface); }
      .main { padding: 32px 40px; }
      .main-header h1 { font-size: 32px; }
      .quick-add-wrap, .note-card, .files-card, .modal { border-radius: 28px; border-color: transparent; box-shadow: var(--shadow); }
      .note-card { padding: 18px 20px; }
      .note-card:hover { box-shadow: 0 10px 26px rgba(62,124,171,0.18); }
      .modal { border-radius: 36px; }
      .search, .url-input, .new-subject-form input, .parent-select, .pin-input { border-radius: 999px; padding-left: 16px; }
      .search { box-shadow: var(--shadow); border-color: transparent; max-width: 420px; }
      .tag-chip, .tag-pill { border-radius: 999px; }
      .tag-chip.active, .tab-btn.active { background-color: var(--primary); }
      .tab-bar { gap: 6px; border-bottom: none; background: var(--surface); padding: 6px; border-radius: 999px; width: fit-content; box-shadow: var(--shadow); max-width: 100%; overflow-x: auto; }
      .tab-btn { margin-right: 0; padding: 9px 16px; border-radius: 999px; border-bottom: none; }
      .tab-btn.active { color: #fff; border-bottom: none; }
      .tab-btn.active .tab-badge { background: #fff; color: var(--primary); }
      .overdue-banner { border-radius: 20px; border-color: transparent; background: var(--soft-red); box-shadow: var(--shadow); }
      .files-tip { border-radius: 16px; }
      .brainly-root.dark .note-card, .brainly-root.dark .quick-add-wrap { border: 1px solid var(--border); }

      /* ---- Full-screen drawing (image markup) ---- */
      .modal-backdrop.draw-fullscreen { padding: 0; align-items: stretch; }
      .modal.draw-fullscreen { max-width: none; width: 100vw; height: 100vh; height: 100dvh; max-height: none; border-radius: 0; padding: 12px 14px; gap: 8px; box-shadow: none; }
      .modal.draw-fullscreen .modal-copy { display: none; }
      .modal.draw-fullscreen .draw-canvas-wrap { flex: 1; min-height: 0; }
      .modal.draw-fullscreen .draw-canvas { height: 100%; }

      /* ---- Infinite whiteboard ---- */
      .whiteboard { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; background: var(--bg); color: var(--ink); }
      .wb-top { display: flex; align-items: center; gap: 8px; padding: 8px 10px; padding-top: max(8px, env(safe-area-inset-top)); background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; flex-shrink: 0; }
      .wb-tools, .wb-colors { display: flex; align-items: center; gap: 4px; }
      .wb-spacer { flex: 1; }
      .wb-sep { width: 1px; height: 22px; background: var(--border); margin: 0 4px; }
      .wb-btn { min-width: 40px; min-height: 40px; padding: 0 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); font-size: 16px; display: inline-flex; align-items: center; justify-content: center; }
      .wb-btn:hover:not(:disabled) { background: var(--soft); }
      .wb-btn:disabled { opacity: 0.35; cursor: default; }
      .wb-btn.active { background: var(--primary); border-color: var(--primary); color: #fff; }
      .wb-save { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; font-size: 14px; }
      .wb-dot { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--border); padding: 0; }
      .wb-dot.selected { border-color: var(--primary); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--primary); }
      .wb-size { width: 90px; accent-color: var(--primary); }
      .wb-canvas-wrap { position: relative; flex: 1; min-height: 0; overflow: hidden; }
      .wb-canvas { display: block; }
      .wb-zoom { position: absolute; right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); display: flex; gap: 6px; background: var(--surface); padding: 6px; border-radius: 16px; box-shadow: var(--shadow); }
      .wb-zoom-pct { min-width: 64px; font-size: 13px; }
      .wb-hint { position: absolute; left: 12px; bottom: max(12px, env(safe-area-inset-bottom)); font-size: 12px; color: var(--muted); background: var(--surface); padding: 6px 12px; border-radius: 999px; opacity: 0.85; pointer-events: none; }
      @media (max-width: 720px) { .wb-hint { display: none; } .wb-size { width: 70px; } }

      /* ---- AI panel ---- */
      .ai-modal { gap: 14px; }
      .ai-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
      .ai-action { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; padding: 14px; border-radius: 20px; border: 1px solid var(--border); background: var(--soft); color: var(--ink); }
      .ai-action:hover { border-color: var(--primary); background: var(--soft-strong); }
      .ai-action-icon { font-size: 20px; color: var(--primary); }
      .ai-action-label { font-weight: 700; font-size: 15px; }
      .ai-action-hint { font-size: 12px; color: var(--muted); line-height: 1.35; }
      .ai-body { display: flex; flex-direction: column; gap: 12px; }
      .ai-key-form { display: flex; flex-direction: column; gap: 8px; }
      .ai-key-row { display: flex; gap: 8px; align-items: center; }
      .ai-preview { max-height: 45vh; overflow-y: auto; border: 1px solid var(--border); border-radius: 16px; padding: 12px 14px; background: var(--surface); }
      .ai-chat { display: flex; flex-direction: column; gap: 10px; max-height: 45vh; overflow-y: auto; }
      .ai-msg { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; max-width: 92%; }
      .ai-msg.user { align-self: flex-end; align-items: flex-end; }
      .ai-msg-text { white-space: pre-wrap; line-height: 1.5; padding: 10px 14px; border-radius: 18px; background: var(--soft); }
      .ai-msg.user .ai-msg-text { background: var(--primary); color: #fff; }
      .ai-ask-row { display: flex; gap: 8px; }
      .ai-ask-row .url-input { flex: 1; }
      .ai-cards { display: flex; flex-direction: column; gap: 8px; max-height: 45vh; overflow-y: auto; }
      .ai-card-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 14px; font-size: 14px; line-height: 1.45; }
      .ai-map { overflow: auto; max-height: 50vh; border: 1px solid var(--border); border-radius: 16px; background: #fff; }
      .ai-map svg { display: block; max-width: none; }
      .ai-slide { position: relative; min-height: 220px; background: var(--soft); border-radius: 24px; padding: 28px 32px; }
      .ai-slide h2 { margin: 0 0 12px; font-size: 26px; }
      .ai-slide ul { margin: 0; padding-left: 22px; font-size: 17px; line-height: 1.7; }
      .ai-slide-count { position: absolute; right: 18px; bottom: 12px; font-size: 12px; color: var(--muted); }
      .ai-slide-nav { display: flex; gap: 8px; justify-content: center; }
      .ai-thumbs { display: flex; gap: 8px; flex-wrap: wrap; }
      .ai-thumb { padding: 2px; border: 2px solid var(--border); border-radius: 12px; background: #fff; }
      .ai-thumb.selected { border-color: var(--primary); }
      .ai-thumb img { display: block; width: 90px; height: 64px; object-fit: cover; border-radius: 9px; }

      @media (max-width: 720px) {
        .brainly-root { flex-direction: column; }
        .sidebar { width: 100%; min-width: 0; border-right: none; border-bottom: 1px solid var(--border); }
        .main { padding: 20px; }
      }
    `);
}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(Brainly, null));
