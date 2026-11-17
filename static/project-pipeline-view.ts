// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { PipelineDetail, PipelineReport, PipelineComponent } from './project-catalog.ts';
import type { ProjectDom } from './project-catalog-view.ts';
export class ProjectPipelineView {
  private dom: ProjectDom;
  constructor(dom: ProjectDom) { this.dom = dom; }
  availability(value: string): string { return this.dom.t(`projects.pipeline.availability.${value}`); }
  currentReport(parent: HTMLElement, title: string, report: PipelineReport | null, component: PipelineComponent, key: string) {
    const section = this.dom.disclosure(parent, `${title} · ${this.availability(component.availability)}${report ? ` · ${report.status}` : ""}`, key);
    if (component.truncated) section.append(this.dom.element("p", this.dom.t("projects.pipeline.componentPartial")));
    if (component.reason !== null) this.dom.paragraph(section, "projects.pipeline.reason", component.reason);
    if (!report) return;
    this.dom.paragraph(section, "projects.pipeline.round", this.dom.known(report.round));
    this.dom.paragraph(section, "projects.pipeline.cycle", this.dom.known(report.cycle));
    this.dom.paragraph(section, "projects.pipeline.reportDate", this.dom.known(report.date));
    if (report.qa_no_go_round !== undefined) this.dom.paragraph(section, "projects.pipeline.qaRound", this.dom.known(report.qa_no_go_round));
    this.dom.paragraph(section, "projects.pipeline.findings", this.dom.known(report.findings.total));
    if (report.findings.truncated) section.append(this.dom.element("p", this.dom.t("projects.pipeline.listPartial")));
    const findings = this.dom.element("ul");
    for (const finding of report.findings.items) {
      const row = this.dom.element("li"); row.append(this.dom.element("strong", String(this.dom.known(finding.severity))), this.dom.element("p", String(this.dom.known(finding.description))));
      this.dom.paragraph(row, "projects.pipeline.findingState", this.dom.known(finding.status));
      this.dom.paragraph(row, "projects.pipeline.specialist", this.dom.known(finding.specialist)); findings.append(row);
    }
    section.append(findings);
    this.dom.paragraph(section, "projects.pipeline.rounds", this.dom.known(report.rounds_audit.total));
    if (report.rounds_audit.truncated) section.append(this.dom.element("p", this.dom.t("projects.pipeline.listPartial")));
    const rounds = this.dom.element("ul");
    for (const round of report.rounds_audit.items) {
      const row = this.dom.element("li");
      this.dom.paragraph(row, "projects.pipeline.round", this.dom.known(round.round)); this.dom.paragraph(row, "projects.pipeline.reportDate", this.dom.known(round.date));
      this.dom.paragraph(row, "projects.pipeline.verdict", this.dom.known(round.verdict));
      this.dom.paragraph(row, "projects.pipeline.qualifying", round.qualifying === null ? this.dom.t("projects.unknown") : this.dom.t(round.qualifying ? "projects.pipeline.yes" : "projects.pipeline.no"));
      this.dom.paragraph(row, "projects.pipeline.reason", this.dom.known(round.causes)); rounds.append(row);
    }
    section.append(rounds);
    if (report.no_go_reason) {
      this.dom.paragraph(section, "projects.pipeline.reasonType", this.dom.known(report.no_go_reason.type));
      this.dom.paragraph(section, "projects.pipeline.reason", this.dom.known(report.no_go_reason.cause));
      this.dom.paragraph(section, "projects.pipeline.failedACs", this.dom.known(report.no_go_reason.failed_acs));
    }
  }
  render(parent: HTMLElement, value: PipelineDetail, scope?: string) {
    const key = (name: string) => `pipeline-${name}`;
    const section = this.dom.element("section"); section.className = "projects-pipeline";
    section.dataset.projectsFocusScope = scope ?? value.task;
    section.append(this.dom.element("h4", this.dom.t("projects.pipeline.task", { value: value.task })), this.dom.element("p", this.dom.t("projects.pipeline.recordedOnly")));
    this.dom.paragraph(section, "projects.pipeline.state", this.availability(value.availability));
    this.dom.paragraph(section, "projects.pipeline.mode", this.dom.known(value.mode));
    this.dom.paragraph(section, "projects.pipeline.latest", value.latest_completed ? `${value.latest_completed.phase} · ${value.latest_completed.outcome}` : this.dom.t("projects.unknown"));
    this.dom.paragraph(section, "projects.pipeline.disagreement", value.verdict_disagreement === null ? this.dom.t("projects.unknown") : this.dom.t(value.verdict_disagreement ? "projects.pipeline.disagree" : "projects.pipeline.agree"));
    const history = this.dom.disclosure(section, this.dom.t("projects.pipeline.history", { value: this.dom.known(value.history.total) }), key('history'));
    if (value.history.total === null) history.append(this.dom.element("p", this.dom.t("projects.pipeline.historyUnknown")));
    if (value.history.truncated) history.append(this.dom.element("p", this.dom.t("projects.pipeline.historyPartial")));
    const events = this.dom.element("ol");
    for (const event of value.history.items) {
      const row = this.dom.element("li"); row.append(this.dom.element("strong", `${event.phase} · ${event.outcome}`));
      this.dom.paragraph(row, "projects.pipeline.index", event.source_index);
      this.dom.paragraph(row, "projects.pipeline.actor", this.dom.known(event.actor.value));
      this.dom.paragraph(row, "projects.pipeline.eventTime", this.dom.known(event.time.value));
      if (event.reason !== null) this.dom.paragraph(row, "projects.pipeline.reason", event.reason);
      if (event.reason_truncated || event.actor.truncated) row.append(this.dom.element("p", this.dom.t("projects.pipeline.listPartial")));
      events.append(row);
    }
    history.append(events);
    this.currentReport(section, this.dom.t("projects.pipeline.review"), value.review, value.components.review, key('review'));
    this.currentReport(section, this.dom.t("projects.pipeline.qa"), value.qa, value.components.qa_state, key('qa'));
    this.dom.paragraph(section, "projects.pipeline.qaMarkdown", `${this.availability(value.components.qa.availability)} · ${this.dom.known(value.qa_markdown_status)}`);
    const components = this.dom.disclosure(section, this.dom.t("projects.pipeline.components"), key('components'));
    for (const [name, component] of Object.entries(value.components)) {
      const row = this.dom.element("p", `${name} · ${this.availability(component.availability)}`); components.append(row);
      if (component.reason !== null) this.dom.paragraph(components, "projects.pipeline.reason", component.reason);
      if (component.truncated) components.append(this.dom.element("p", this.dom.t("projects.pipeline.componentPartial")));
    }
    const coverage = this.dom.disclosure(section, this.dom.t("projects.pipeline.coverage"), key('coverage'));
    coverage.append(this.dom.element("p", this.dom.t("projects.pipeline.coverageNote")));
    const entries = this.dom.element("ul");
    for (const entry of value.coverage) {
      const row = this.dom.element("li", `${entry.id} · ${this.dom.t(`projects.pipeline.coverage.${entry.availability}`)}`);
      row.append(this.dom.element("p", entry.limitations)); entries.append(row);
    }
    coverage.append(entries); parent.append(section);
  }

}
