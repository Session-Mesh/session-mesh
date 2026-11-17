// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDom } from './project-catalog-view.ts';
export function workLayout(dom:ProjectDom,chart:HTMLElement):HTMLElement {
  const layout=dom.element('div');layout.className='project-work-layout';layout.append(chart);return layout;
}
export function workInspector(dom:ProjectDom,close:()=>void):HTMLElement {
  const aside=dom.element('aside');aside.className='project-work-inspector';aside.setAttribute('aria-label',dom.t('projects.work.details'));
  const header=dom.element('header');header.append(dom.element('strong',dom.t('projects.work.details')));
  const button=dom.element('button',dom.t('projects.work.close'));button.type='button';button.className='btn';button.dataset.followupKey='close-detail';
  button.addEventListener('click',close);header.append(button);aside.append(header);return aside;
}
export function focusWorkCard(root:HTMLElement,key:string):void {
  const target=Array.from(root.querySelectorAll<HTMLElement>('[data-followup-key]')).find(node=>node.dataset.followupKey===`row-${key}`);
  target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});
}
