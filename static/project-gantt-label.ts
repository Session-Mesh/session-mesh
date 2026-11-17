// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
import type { GanttSegment } from './project-gantt-model.ts';

/** A claim lifetime includes waiting; it never measures actual agent work. */
export function ganttSegmentLabel(dom: ProjectDom, segment: GanttSegment): string {
  if (segment.kind === 'completion') return '◆';
  const elapsed = Math.max(0, (segment.end - segment.start) / 60000);
  const value = new Intl.NumberFormat(dom.doc.documentElement.lang || 'en', { maximumFractionDigits: 0 }).format(elapsed);
  if (segment.kind === 'forecast') return dom.t('projects.followup.gantt.forecastSpan', { value });
  return dom.t(segment.outcome === 'active' ? 'projects.followup.gantt.openClaim' : 'projects.followup.gantt.closedClaim', { value });
}
export function ganttLegend(dom: ProjectDom): HTMLElement {
  const legend = dom.element('div'); legend.className = 'project-gantt-legend';
  for (const kind of ['closed', 'open', 'projected']) {
    const item = dom.element('span', dom.t(`projects.followup.gantt.legend.${kind}`));
    item.dataset.kind = kind; legend.append(item);
  }
  return legend;
}
