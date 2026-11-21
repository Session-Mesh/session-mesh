// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The product's view shown by the Projects view (static/work-view.ts), if any, and the filters of the products'
 * Board and Timeline that the view keeps with the place (static/work-view-state.ts): one set per product, the newest
 * kept, whatever product is shown.
 */

import type { WorkApi } from './work-api.ts';
import type { EntryProduct } from './work-derive.ts';
import type { ViewContext } from './work-dom.ts';
import type { EntryHandlers } from './work-entry-view.ts';
import { filtersOf, withFilters } from './work-product-filters.ts';
import type { ProductFilters } from './work-product-filters.ts';
import { productTab, renderProductPage } from './work-product-page.ts';
import type { ProductView } from './work-product-page.ts';
import type { TaskSheet } from './work-task-sheet.ts';

export type ProductPlaceHost = Readonly<{
  api: WorkApi;
  ctx: ViewContext;
  sheet: TaskSheet;
  /** The place changed: note it. */
  note: () => void;
}>;

/** A request series of the view: `live` is false once the view moved on. */
export type Series = Readonly<{ live: () => boolean; signal: AbortSignal }>;

export class ProductPlace {
  /** The product's view shown, or null. */
  view: ProductView | null = null;

  constructor(private readonly host: ProductPlaceHost, public filters: ProductFilters) {}

  /** Draw the view of `node` on `tab` (the overview when null or unknown), reading its tasks within `series`. */
  open(node: EntryProduct, tab: string | null, handlers: EntryHandlers & Readonly<{ back: () => void }>, series: Series): ProductView {
    const { host } = this, id = node.product.id;
    this.view = renderProductPage({ ctx: host.ctx, node, tab: productTab(tab), filters: filtersOf(this.filters, id), handlers,
      onFilters: filters => { this.filters = withFilters(this.filters, id, filters); host.note(); },
      onTab: () => { if (series.live() && this.view) { host.sheet.tabShown(this.view); host.note(); } },
      load: async () => { const result = await host.api.product(id, series.signal); return series.live() ? result : null; } });
    return this.view;
  }

  /** After the view is drawn: the sheet of `task` put back (the place the owner left), on Board or Timeline only. */
  async reopen(view: ProductView, task: string | null, series: Series): Promise<void> {
    await view.ready;
    if (task && series.live() && view.current() !== 'overview') await this.host.sheet.select(task, undefined, true);
  }
}
