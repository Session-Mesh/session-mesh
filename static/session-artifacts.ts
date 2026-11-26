// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export interface SessionReference {
  connector: string; id: string; kind: string; title: string;
  url: string | null; availability: "observed-present" | "pending-target" | "revoked";
}
export function parseSessionReferences(value: unknown): SessionReference[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { references?: unknown }).references)) throw new Error("references");
  const rows = (value as { references: unknown[] }).references;
  if (rows.length > 128) throw new Error("bounds");
  const seen = new Set<string>();
  return rows.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("reference");
    const r = raw as Record<string, unknown>;
    for (const [key, max] of [["connector",80],["id",256],["kind",80],["title",512]] as const) {
      if (typeof r[key] !== "string" || !r[key] || r[key].length > max || /[\x00-\x1f\x7f]/.test(r[key])) throw new Error("metadata");
    }
    if (!["observed-present","pending-target","revoked"].includes(String(r.availability))) throw new Error("availability");
    if (r.availability === "revoked") { if (r.url !== null) throw new Error("revoked"); }
    else {
      if (typeof r.url !== "string" || r.url.length > 8192 || /[\x00-\x20\\]/.test(r.url)) throw new Error("link");
      const url = new URL(r.url);
      if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname)))) throw new Error("scheme");
    }
    const key = JSON.stringify([r.connector,r.id]);
    if (seen.has(key)) throw new Error("duplicate"); seen.add(key);
    return r as unknown as SessionReference;
  });
}

export function openSessionArtifacts(ports: {
  document: Document; name: string; created: number; current: () => boolean;
  translate: (key: string) => string; fetch?: typeof fetch;
}): void {
  const { document: doc, translate: t } = ports;
  const dialog = doc.createElement("dialog");
  dialog.className = "session-artifacts";
  const title = doc.createElement("h2"); title.textContent = t("artifacts.title");
  const close = doc.createElement("button"); close.type = "button"; close.textContent = t("common.close");
  const status = doc.createElement("p"); status.setAttribute("role","status"); status.textContent = t("artifacts.loading");
  const hint = doc.createElement("p"); hint.textContent = t("artifacts.observedHint");
  const list = doc.createElement("ul");
  dialog.setAttribute("aria-label", t("artifacts.title"));
  dialog.append(title,close,hint,status,list); doc.body.append(dialog);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  const opener = doc.activeElement;
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    abort.abort(); clearTimeout(timer); dialog.remove();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, { once: true });
  dialog.showModal(); close.focus();
  const current = () => dialog.open && ports.current();
  void (async () => {
    try {
      const response = await (ports.fetch ?? fetch)(`/api/session-artifacts/${encodeURIComponent(ports.name)}?created=${encodeURIComponent(ports.created)}`, { signal: abort.signal, cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("unavailable");
      const rows = parseSessionReferences(await response.json());
      if (!current()) { if (dialog.open) status.textContent = t("artifacts.stale"); return; }
      status.textContent = rows.length ? "" : t("artifacts.empty");
      for (const r of rows) {
        const row = doc.createElement("li"), text = doc.createElement("span");
        text.textContent = `${r.title} — ${r.connector} / ${r.kind} — ${t(`artifacts.state.${r.availability}`)}`;
        row.append(text);
        if (r.url) {
          const link = doc.createElement("a"); link.href = r.url; link.target = "_blank";
          link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
          link.textContent = t("artifacts.open");
          link.onclick = (event) => { if (!ports.current()) { event.preventDefault(); list.replaceChildren(); status.textContent = t("artifacts.stale"); } };
          row.append(" ",link);
        }
        list.append(row);
      }
    } catch { if (dialog.open) status.textContent = t("artifacts.unavailable"); }
    finally { clearTimeout(timer); }
  })();
}
