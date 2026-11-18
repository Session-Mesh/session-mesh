// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The layout of the Configuration dialog: a list of sections and the cards of the chosen one.
// On a wide window the list is a sidebar next to the cards; on a phone (the same 760 px
// breakpoint as the rest of the page, decided in CSS) it is a first screen that opens one section
// at a time, with a back button. Bundled into pane-actions.js, so it adds no served file.
//
// The list is a <nav> of buttons: the open one carries aria-current, Up/Down/Home/End move
// between them (one tab stop), Enter and Space open one. Titles reach the DOM as textContent.

// A short window (a phone held sideways) gets the same drill-down: its cards area would otherwise be a few lines high.
export const PHONE_QUERY = "(max-width: 760px), (max-height: 500px)";

export type ShellSection = Readonly<{ id: string; title: string; cards: readonly HTMLElement[] }>;
export type ShellLabels = Readonly<{ nav: string; back: string }>;

let counter = 0;

export class SettingsShell {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly media: MediaQueryList;
  private readonly sections: readonly ShellSection[];
  private readonly nav: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private current: string | null;
  // The breakpoint is crossed while the window is open (rotation, resize): the control that had the
  // focus may be hidden by it, so the focus is moved to its counterpart in the new layout.
  // The browser may already have dropped the focus of a hidden control (activeElement is then the
  // body) when this runs, so the last focused control of the shell is remembered.
  private lastFocus: Node | null = null;
  private readonly onMedia = (): void => {
    const active = this.doc.activeElement;
    const lost = active === null || active === this.doc.body;
    const held = (zone: HTMLElement): boolean =>
      active !== null && (zone.contains(active) || (lost && this.lastFocus !== null && zone.contains(this.lastFocus)));
    if (this.media.matches) {
      if (held(this.nav)) this.title.focus();
      return;
    }
    if (this.current === null) this.select(this.sections[0]?.id ?? null, false);
    if (held(this.back)) this.buttons.get(this.current ?? "")?.focus();
  };

  constructor(doc: Document, labels: ShellLabels, sections: readonly ShellSection[], selected: string | null) {
    this.doc = doc; this.sections = sections;
    this.media = doc.defaultView!.matchMedia(PHONE_QUERY);
    const known = selected !== null && sections.some((section) => section.id === selected);
    this.current = known ? selected : this.media.matches ? null : sections[0]?.id ?? null;
    const prefix = `config-shell-${++counter}`;
    this.element = this.make("div", "config-shell");
    const nav = this.nav = this.make("nav", "config-nav");
    nav.setAttribute("aria-label", labels.nav);
    const list = this.make("ul", "config-nav-list");
    for (const section of sections) list.append(this.item(section));
    nav.append(list);
    const panel = this.make("section", "config-panel");
    panel.setAttribute("aria-labelledby", `${prefix}-title`);
    this.title = this.make("h3", "config-panel-title");
    this.title.id = `${prefix}-title`; this.title.tabIndex = -1;
    const back = this.back = this.make("button", "btn ghost sm config-back");
    const glyph = this.make("span", "", "‹");
    glyph.setAttribute("aria-hidden", "true");
    back.append(glyph, ` ${labels.back}`);
    back.type = "button"; back.addEventListener("click", () => this.select(null, true));
    const head = this.make("div", "config-panel-head");
    head.append(back, this.title);
    this.cards = this.make("div", "config-cards");
    panel.append(head, this.cards);
    this.element.append(nav, panel);
    this.element.addEventListener("focusin", (event) => { this.lastFocus = event.target as Node; });
    this.media.addEventListener("change", this.onMedia);
    this.select(this.current, false);
  }

  get selected(): string | null { return this.current; }

  dispose(): void { this.media.removeEventListener("change", this.onMedia); }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  private item(section: ShellSection): HTMLElement {
    const entry = this.make("li", "config-nav-item");
    const button = this.make("button", "config-nav-button", section.title);
    button.type = "button"; button.dataset.sectionId = section.id;
    button.addEventListener("click", () => this.select(section.id, true));
    button.addEventListener("keydown", (event) => this.onKey(event, section.id));
    this.buttons.set(section.id, button);
    entry.append(button);
    return entry;
  }

  private onKey(event: KeyboardEvent, id: string): void {
    const ids = this.sections.map((section) => section.id);
    const at = ids.indexOf(id), last = ids.length - 1;
    const next = event.key === "ArrowDown" ? (at + 1) % ids.length : event.key === "ArrowUp" ? (at + last) % ids.length
      : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    this.buttons.get(ids[next]!)?.focus();
    this.tabStop(ids[next]!);
  }

  private tabStop(id: string): void {
    for (const [key, button] of this.buttons) button.tabIndex = key === id ? 0 : -1;
  }

  // `move` is true after a user action: the focus follows the view (the section title on a phone,
  // the list entry when going back), so a keyboard or screen reader user is never left on a
  // control that has just been hidden.
  select(id: string | null, move: boolean): void {
    const previous = this.current;
    this.current = id;
    const section = this.sections.find((candidate) => candidate.id === id) ?? null;
    this.element.dataset.view = section === null ? "list" : "section";
    for (const [key, button] of this.buttons) {
      if (key === id) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
    }
    this.tabStop(id ?? previous ?? this.sections[0]?.id ?? "");
    this.title.textContent = section?.title ?? "";
    this.cards.replaceChildren(...(section?.cards ?? []));
    if (!move) return;
    if (section !== null && this.media.matches) this.title.focus();
    if (section === null) this.buttons.get(previous ?? "")?.focus();
  }
}
