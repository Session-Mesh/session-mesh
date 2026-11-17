// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readIssue} from '../static/project-issue-client.ts';
const row={id:'7',title:'Same title',state:'open',column:'todo',labels:[],assignees:[]};
test('native issue identity retains full precision and stays separate from display number',()=>{
  const native_identity={host:'gitlab.com',issue_id:'9007199254740995',project_id:'9007199254740993',node_id:null};
  const issue=readIssue({...row,native_identity},'scope','gitlab','a/b')!;
  assert.equal(issue.id,'7');assert.deepEqual(issue.nativeIdentity,{host:'gitlab.com',issueId:'9007199254740995',projectId:'9007199254740993',nodeId:null});
  const other=readIssue({...row,native_identity:{...native_identity,issue_id:'9007199254740996'}},'scope','gitlab','a/b')!;
  assert.notDeepEqual(issue.nativeIdentity,other.nativeIdentity,'same local number/title is not a reconciliation link');
});
test('missing, cross-host and malformed identity never manufacture a link or hide the issue',()=>{
  for(const identity of [undefined,null,{host:'github.com',issue_id:'123'},{host:'gitlab.com',issue_id:123},{host:'gitlab.com',issue_id:'18446744073709551616'},{host:'gitlab.com',issue_id:'01'}]){
    const issue=readIssue({...row,native_identity:identity},'scope','gitlab','a/b')!;
    assert.equal(issue.title,'Same title');assert.equal(issue.nativeIdentity,null);
  }
});
