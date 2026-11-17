// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { renderProjectMarkdown } from './project-markdown.ts';
type Translate = (key:string, values?:Record<string,string|number>)=>string;

/** Keep large documents readable without expanding megabytes into a Markdown DOM. */
export function artifactDocument(root:HTMLElement, text:string, format:string, t:Translate):void {
  const doc=root.ownerDocument;
  if (format === 'markdown' && text.length <= 262144) {
    const toolbar=doc.createElement('nav'),panel=doc.createElement('div');toolbar.className='project-artifact-pages';
    const rendered=doc.createElement('button'),source=doc.createElement('button');rendered.type=source.type='button';
    rendered.textContent=t('projects.artifacts.rendered');source.textContent=t('projects.artifacts.raw');
    const paint=()=>{
      rendered.setAttribute('aria-pressed','true');source.setAttribute('aria-pressed','false');panel.replaceChildren();
      const frontmatter=text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
      if(frontmatter){const metadata=doc.createElement('details'),label=doc.createElement('summary'),raw=doc.createElement('pre');
        label.textContent=t('projects.artifacts.metadata');raw.textContent=frontmatter;metadata.append(label,raw);panel.append(metadata);}
      const body=doc.createElement('article');body.className='project-artifact-markdown';const content=frontmatter?text.slice(frontmatter.length):text;
      body.textContent=content;panel.append(body);void renderProjectMarkdown(body,content,{preserveFrontmatter:true});
    };
    rendered.onclick=paint;source.onclick=()=>{rendered.setAttribute('aria-pressed','false');source.setAttribute('aria-pressed','true');sourceDocument(panel,text,t);};
    toolbar.append(rendered,source);root.replaceChildren(toolbar,panel);paint();return;
  }
  sourceDocument(root,text,t);
}
function sourceDocument(root:HTMLElement,text:string,t:Translate):void{
  const doc=root.ownerDocument;
  let page=0;
  const size=65536, total=Math.max(1,Math.ceil(text.length/size));
  const toolbar=doc.createElement('nav'), body=doc.createElement('pre');
  toolbar.className='project-artifact-pages'; body.className='project-artifact-source';
  const previous=doc.createElement('button'), next=doc.createElement('button'), label=doc.createElement('span');
  previous.type=next.type='button'; previous.textContent=t('projects.followup.previous'); next.textContent=t('projects.followup.next');
  const boundary=(at:number)=> at>0 && at<text.length && /[\uDC00-\uDFFF]/.test(text[at]!) ? at-1:at;
  const paint=()=>{
    body.textContent=text.slice(boundary(page*size),boundary(Math.min(text.length,(page+1)*size)));
    label.textContent=t('projects.followup.page',{value:page+1,total}); previous.disabled=page===0; next.disabled=page+1>=total;
    body.scrollTop=0;
  };
  previous.onclick=()=>{page--;paint();}; next.onclick=()=>{page++;paint();};
  toolbar.append(previous,label,next); root.replaceChildren(toolbar,body); paint();
}
