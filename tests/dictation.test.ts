// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:http';
import {Dictation, configuration, Fault, transcribe, normalizeText, PREPARATION_MS} from '../backend/dictation.ts';

const config = (extra = {}) => configuration({MESH_WHISPER_URL: 'http://127.0.0.1:1/transcribe', ...extra})!;
const meta = (session = 'alpha', extra = {}) => ({principal: 'owner', client: randomUUID(), request: randomUUID(), session, created: 1, mime: 'audio/webm;codecs=opus', ...extra});
async function* audio(...parts: string[]) { for (const part of parts) yield Buffer.from(part); }
async function until(check: () => boolean) { for (let i = 0; i < 600; i++) { if (check()) return; await delay(5); } assert.fail('condition timeout'); }
const code = (value: string) => (error: unknown) => error instanceof Fault && error.code === value;
function receivingJob(d:Dictation,m:ReturnType<typeof meta>){
  // White-box cancellation tests need the worker's private ID before upload
  // EOF; the public request lookup deliberately cannot reveal it.
  const records=(d as unknown as {records:Map<string,{meta:{request:string};job:{job_id:string}}>}).records;
  const record=[...records.values()].find(item=>item.meta.request===m.request);assert.ok(record);
  return d.read(m,record.job.job_id);
}

test('standalone dictation worker is part of the application closure', () => {
  assert.ok(existsSync('backend/dictation-service.cjs'), 'missing standalone dictation worker');
});

test('configuration is exact, disabled independently of invalid limits; enabled configuration fails closed', () => {
  assert.equal(configuration({MESH_WHISPER_WORKERS: 'bad'}), null);
  const c = config();
  assert.deepEqual(c.public, {enabled:true, language:'fr', max_bytes:8388608, aggregate_bytes:67108864, queue_size:16, workers:1, active_timeout_seconds:60, queue_wait_seconds:600, result_ttl_seconds:1800, capture_seconds:120});
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '']) assert.throws(() => config({MESH_WHISPER_WORKERS:value}));
  for (const value of ['file:///tmp/a', 'http://user:secret@localhost/', 'http://localhost/#x']) assert.throws(() => config({MESH_WHISPER_URL:value}));
});

test('plaintext upstreams are loopback only after URL hostname normalization', () => {
  for(const host of ['localhost','LOCALHOST','localhost.','127.0.0.1','127.20.30.40','127.1','0x7f000001','[::1]','[0:0:0:0:0:0:0:1]'])
    assert.equal(config({MESH_WHISPER_URL:`http://${host}:8910/fixed`}).url.protocol,'http:');
  for(const host of ['example.test','localhost.example.test','127.0.0.1.example.test','192.0.2.1','0.0.0.0','[::]','[2001:db8::1]'])
    assert.throws(()=>config({MESH_WHISPER_URL:`http://${host}/fixed`}));
  assert.equal(config({MESH_WHISPER_URL:'https://example.test/fixed'}).url.protocol,'https:');
});

for(const mode of ['deadline','sweep','close'] as const)test(`audio EOF cannot acknowledge an unavailable preparation: ${mode}`,async()=>{
  let now=0,resume!:()=>void,entered!:()=>void;
  const seen=new Promise<void>(resolve=>entered=resolve);
  async function* slow(){yield Buffer.from('a');entered();await new Promise<void>(resolve=>resume=resolve);}
  const d=new Dictation(config(),{now:()=>now});
  const pending=d.prepare(meta(),slow());void pending.catch(()=>{});
  try{
    await seen;
    if(mode==='close')await d.close();
    else {now=PREPARATION_MS;if(mode==='sweep')d.sweep();}
    resume();await assert.rejects(pending,code('unavailable'));
    assert.deepEqual(d.stats(),{records:0,bytes:0,active:0,waiting:0});
  }finally{resume?.();await d.close();}
});

for(const state of ['cancelled','settled'] as const)test(`late EOF still acknowledges a retained ${state} tombstone`,async()=>{
  let now=0,resume!:()=>void,entered!:()=>void;
  const seen=new Promise<void>(resolve=>entered=resolve);
  async function* slow(){yield Buffer.from('a');entered();await new Promise<void>(resolve=>resume=resolve);}
  const d=new Dictation(config(),{now:()=>now});const m=meta();const pending=d.prepare(m,slow());
  try{
    await seen;const job=receivingJob(d,m);
    if(state==='cancelled')d.cancel(m,job.job_id);else d.settle(m,job.job_id,'discarded');
    now=PREPARATION_MS+1;d.sweep();resume();
    const result=await pending;assert.equal(result.job.state,state);
    assert.equal(d.commit(m,job.job_id,result.preparation).state,state);
    assert.equal(d.stats().bytes,0);
  }finally{resume?.();await d.close();}
});

test('uncommitted shared preparation expires without inference and releases its session slot',async()=>{
  let now=0,calls=0;
  const d=new Dictation(config(),{now:()=>now,infer:async()=>{calls++;return 'ok';}});
  try{
    const m=meta(),one=await d.prepare(m,audio('a')),two=await d.prepare(m,audio('ignored'));
    assert.equal(one.job.job_id,two.job.job_id);assert.equal(calls,0);
    now=PREPARATION_MS;d.sweep();assert.equal(calls,0);
    assert.deepEqual(d.stats(),{records:0,bytes:0,active:0,waiting:0});
    const next=await d.prepare(meta(),audio('b'));assert.notEqual(next.job.job_id,one.job.job_id);
  }finally{await d.close();}
});

test('a matching preparation waiter rechecks expiry and current record after its await',async()=>{
  let now=0;
  const d=new Dictation(config(),{now:()=>now});
  try{
    const m=meta(),original=await d.prepare(m,audio('a'));
    const duplicate=d.prepare(m,audio('ignored'));void duplicate.catch(()=>{});
    now=PREPARATION_MS;d.sweep();
    const replacement=d.prepare(m,audio('replacement'));
    await assert.rejects(duplicate,code('unavailable'));
    const next=await replacement;assert.notEqual(next.job.job_id,original.job.job_id);
    assert.equal((await d.prepare(m,audio('repeat'))).job.job_id,next.job.job_id);
    assert.equal(d.stats().bytes,Buffer.byteLength('replacement'));
  }finally{await d.close();}
});

test('two-phase global slots, ownership, dedupe and settled outcome are atomic', async () => {
  let calls = 0;
  const d = new Dictation(config(), {infer:async () => { calls++; return ' bonjour\r\nmonde '; }});
  try {
    const m = meta();
    const p = await d.prepare(m, audio('clip'));
    assert.equal(calls, 0);
    assert.throws(()=>d.lookup(m,m.request),code('not_found'));
    await assert.rejects(d.prepare(meta(), audio('clip')), code('session_busy'));
    await assert.rejects(d.prepare({...m, session:'beta'}, audio('clip')), code('request_conflict'));
    assert.throws(() => d.read({...m, principal:'other'}, p.job.job_id), code('not_found'));
    assert.throws(() => d.read({...m, client:randomUUID()}, p.job.job_id), code('not_found'));
    const duplicate = await d.prepare(m, audio('different bytes'));
    assert.equal(duplicate.job.job_id, p.job.job_id);
    d.commit(m, p.job.job_id, p.preparation);
    d.commit(m, p.job.job_id, p.preparation);
    await until(() => d.read(m, p.job.job_id).state === 'ready');
    assert.equal(d.lookup(m,m.request).job_id,p.job.job_id);
    assert.equal(calls, 1);
    assert.equal(d.read(m, p.job.job_id).text, 'bonjour\nmonde');
    await assert.rejects(d.prepare(meta(), audio('clip')), code('session_busy'));
    assert.equal(d.settle(m, p.job.job_id, 'submitted').state, 'settled');
    assert.equal(d.settle(m, p.job.job_id, 'submitted').outcome, 'submitted');
    assert.throws(() => d.settle(m, p.job.job_id, 'discarded'), code('invalid_state'));
    assert.equal(d.cancel(m, p.job.job_id).state, 'settled');
    await d.prepare(meta(), audio('new'));
  } finally { await d.close(); }
});

test('FIFO, running cancellation retains actual worker/audio, queued cancellation releases bytes', async () => {
  const started: string[] = [], releases: (() => void)[] = [];
  const d = new Dictation(config({MESH_WHISPER_QUEUE_SIZE:'2'}), {infer: async (_chunks, m) => { started.push(m.session); await new Promise<void>(r => releases.push(r)); return 'ok'; }});
  try {
    const a=meta('a'), b=meta('b'), c=meta('c');
    const pa=await d.prepare(a,audio('aaaa')); d.commit(a,pa.job.job_id,pa.preparation);
    await until(()=>started.length===1);
    const pb=await d.prepare(b,audio('bbb')); d.commit(b,pb.job.job_id,pb.preparation);
    const pc=await d.prepare(c,audio('cc')); d.commit(c,pc.job.job_id,pc.preparation);
    await assert.rejects(d.prepare(meta('d'),audio('d')),code('queue_full'));
    d.cancel(a,pa.job.job_id);
    assert.equal(d.stats().active,1); assert.equal(d.stats().bytes,9);
    d.cancel(c,pc.job.job_id); assert.equal(d.stats().bytes,7);
    await delay(20); assert.deepEqual(started,['a']);
    releases.shift()!(); await until(()=>started.length===2);
    assert.deepEqual(started,['a','b']); assert.equal(d.read(a,pa.job.job_id).text,null);
    releases.shift()!(); await until(()=>d.stats().active===0);
    assert.equal(d.stats().bytes,0);
  } finally { for(const release of releases) release(); await d.close(); }
});

test('bounded streaming rolls back oversize, aggregate, disconnect, and short preparation expiry', async () => {
  let now=0;
  const d=new Dictation(config({MESH_WHISPER_MAX_BYTES:'4',MESH_WHISPER_AGGREGATE_BYTES:'5'}),{now:()=>now});
  try {
    await assert.rejects(d.prepare(meta(),audio('123','45')),code('audio_too_large'));
    assert.equal(d.stats().bytes,0); assert.equal(d.stats().records,0);
    const a=meta(); await d.prepare(a,audio('1234'));
    await assert.rejects(d.prepare(meta('b'),audio('12')),code('capacity_full'));
    assert.equal(d.stats().bytes,4);
    now=15001; d.sweep(); assert.equal(d.stats().records,0); assert.equal(d.stats().bytes,0);
    async function* broken(){yield Buffer.from('a');throw Error('disconnect');}
    await assert.rejects(d.prepare(meta(),broken())); assert.equal(d.stats().records,0);
    await assert.rejects(d.prepare(meta(),audio()),code('invalid_request'));
  }finally{await d.close();}
});

test('cancel before commit latches; separate queue and result clocks never renew on polls', async () => {
  let now=0, finish!:()=>void;
  const d=new Dictation(config({MESH_WHISPER_QUEUE_TTL:'1',MESH_WHISPER_RESULT_TTL:'2'}),{now:()=>now,infer:async()=>{await new Promise<void>(r=>finish=r);return 'ok';}});
  try{
    const a=meta('a'),b=meta('b'),c=meta('c');
    const pc=await d.prepare(c,audio('c')); d.cancel(c,pc.job.job_id); d.commit(c,pc.job.job_id,pc.preparation);
    assert.equal(d.read(c,pc.job.job_id).state,'cancelled');
    const pa=await d.prepare(a,audio('a'));d.commit(a,pa.job.job_id,pa.preparation);await until(()=>!!finish);
    const pb=await d.prepare(b,audio('b'));d.commit(b,pb.job.job_id,pb.preparation);
    now=1001;d.sweep();assert.equal(d.read(b,pb.job.job_id).error?.code,'queue_expired');
    await assert.rejects(d.prepare(meta('b'),audio('b')),code('session_busy'));
    now=2500; d.read(b,pb.job.job_id); now=3002;d.sweep();assert.throws(()=>d.lookup(b,b.request),code('not_found'));
    finish(); await until(()=>d.stats().active===0);
  }finally{finish?.();await d.close();}
});

test('late expired receiver cannot remove a replacement same-request mapping or slot',async()=>{
  let now=0,resume!:()=>void,entered!:()=>void;
  const seen=new Promise<void>(resolve=>entered=resolve);
  async function* slow(){yield Buffer.from('a');entered();await new Promise<void>(resolve=>resume=resolve);yield Buffer.from('b');}
  const d=new Dictation(config(),{now:()=>now});
  try{
    const m=meta();const pending=d.prepare(m,slow());void pending.catch(()=>{});await seen;
    const original=receivingJob(d,m);
    now=15001;d.sweep();assert.throws(()=>d.lookup(m,m.request),code('not_found'));
    const replacement=await d.prepare(m,audio('new'));
    assert.notEqual(replacement.job.job_id,original.job_id);
    resume();await assert.rejects(pending,code('unavailable'));
    assert.throws(()=>d.lookup(m,m.request),code('not_found'));
    assert.equal((await d.prepare(m,audio('repeat'))).job.job_id,replacement.job.job_id);
    await assert.rejects(d.prepare(meta(),audio('other')),code('session_busy'));
    assert.deepEqual(d.stats(),{records:1,bytes:3,active:0,waiting:0});
  }finally{resume?.();await d.close();}
});

test('stale queued incarnation never runs; errors retain slot; total records capped at 256', async () => {
  const d=new Dictation(config(),{isLive:async()=>false,infer:async()=>{assert.fail('stale inference');}});
  try{
    const m=meta(); const p=await d.prepare(m,audio('x'));d.commit(m,p.job.job_id,p.preparation);
    await until(()=>d.read(m,p.job.job_id).state==='error');assert.equal(d.read(m,p.job.job_id).error?.code,'stale_session');
    d.settle(m,p.job.job_id,'discarded');
    for(let i=1;i<256;i++){const a=meta();const p=await d.prepare(a,audio('x'));d.cancel(a,p.job.job_id);}
    await assert.rejects(d.prepare(meta(),audio('x')),code('capacity_full'));
  }finally{await d.close();}
});

test('text normalization rejects control sequences, invalid/empty and oversized text',()=>{
  assert.equal(normalizeText(' a\r\nb\rc\t '),'a\nb\nc');
  assert.equal(normalizeText(' '.repeat(40000)+'ok'),'ok');
  for(const value of ['\0','\x1b[31m','\x7f','\x85','x'.repeat(32769)])assert.throws(()=>normalizeText(value),code('upstream_invalid'));
  assert.throws(()=>normalizeText('  '),code('empty_transcript'));
});

test('receiving cancel cannot resurrect retained bytes or lose its request tombstone',async()=>{
  let next!:()=>void,first!:()=>void;
  const seen=new Promise<void>(r=>first=r);
  async function* slow(){yield Buffer.from('aaa');first();await new Promise<void>(r=>next=r);yield Buffer.from('b');}
  const d=new Dictation(config());
  try{
    const m=meta();const pending=d.prepare(m,slow());await seen;
    const job=receivingJob(d,m);d.cancel(m,job.job_id);assert.equal(d.stats().bytes,0);
    next();const p=await pending;assert.equal(p.job.state,'cancelled');assert.equal(d.stats().bytes,0);
    d.commit(m,job.job_id,p.preparation);assert.equal(d.lookup(m,m.request).state,'cancelled');
  }finally{next?.();await d.close();}
});

test('FIFO checks queue deadline at dispatch, not only on the sweep timer',async()=>{
  let now=0,release!:()=>void,calls=0;
  const d=new Dictation(config({MESH_WHISPER_QUEUE_TTL:'1'}),{now:()=>now,infer:async()=>{calls++;await new Promise<void>(r=>release=r);return 'ok';}});
  try{
    const a=meta('a'),b=meta('b');const pa=await d.prepare(a,audio('a'));d.commit(a,pa.job.job_id,pa.preparation);await until(()=>!!release);
    const pb=await d.prepare(b,audio('b'));d.commit(b,pb.job.job_id,pb.preparation);
    now=1001;release();await delay(10);assert.equal(calls,1);assert.equal(d.read(b,pb.job.job_id).error?.code,'queue_expired');
  }finally{release?.();await d.close();}
});

test('receiving reservation is global and concurrent same-request recovery cannot create another inference',async()=>{
  let resume!:()=>void,entered!:()=>void,calls=0;
  const seen=new Promise<void>(r=>entered=r);
  async function* slow(){yield Buffer.from('a');entered();await new Promise<void>(r=>resume=r);yield Buffer.from('b');}
  const d=new Dictation(config(),{infer:async()=>{calls++;return 'ok';}});
  try{
    const m=meta();const p=d.prepare(m,slow());await seen;
    await assert.rejects(d.prepare(meta('alpha',{principal:'another'}),audio('x')),code('session_busy'));
    const duplicate=d.prepare(m,audio('x'));resume();const [one,two]=await Promise.all([p,duplicate]);assert.equal(one.job.job_id,two.job.job_id);
    d.commit(m,one.job.job_id,one.preparation);d.commit(m,two.job.job_id,two.preparation);
    await until(()=>d.read(m,one.job.job_id).state==='ready');assert.equal(calls,1);
  }finally{resume?.();await d.close();}
});

test('ready and cancelled tombstones expire once, not on polling or repeated cancel/settle',async()=>{
  let now=0;const d=new Dictation(config({MESH_WHISPER_RESULT_TTL:'1'}),{now:()=>now,infer:async()=> 'ok'});
  try{
    const a=meta();const p=await d.prepare(a,audio('a'));d.commit(a,p.job.job_id,p.preparation);await until(()=>d.read(a,p.job.job_id).state==='ready');
    now=999;d.lookup(a,a.request);now=1001;assert.throws(()=>d.read(a,p.job.job_id),code('not_found'));
    const b=meta();const pb=await d.prepare(b,audio('b'));d.cancel(b,pb.job.job_id);
    now=1500;d.cancel(b,pb.job.job_id);now=2002;assert.throws(()=>d.lookup(b,b.request),code('not_found'));
    assert.equal(d.stats().bytes,0);
  }finally{await d.close();}
});

test('actual upstream HTTP occupancy survives running cancellation until the original response ends',async()=>{
  const releases:(()=>void)[]=[];let calls=0,active=0,peak=0;
  const server=createServer(async(req,res)=>{
    for await(const _ of req){/* fake upstream consumes upload */}
    calls++;active++;peak=Math.max(peak,active);
    releases.push(()=>{active--;res.setHeader('Content-Type','application/json');res.end('{"text":"ok"}');});
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const d=new Dictation(config({MESH_WHISPER_URL:`http://127.0.0.1:${(server.address() as any).port}/fixed`}));
  try{
    const a=meta('a'),b=meta('b');const pa=await d.prepare(a,audio('a'));d.commit(a,pa.job.job_id,pa.preparation);await until(()=>calls===1);
    d.cancel(a,pa.job.job_id);const pb=await d.prepare(b,audio('b'));d.commit(b,pb.job.job_id,pb.preparation);
    await delay(20);assert.equal(calls,1);assert.equal(d.stats().bytes,2);
    releases.shift()!();await until(()=>calls===2);releases.shift()!();await until(()=>d.stats().active===0);
    assert.equal(peak,1);assert.equal(d.read(a,pa.job.job_id).text,null);
  }finally{for(const release of releases)release();await d.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('principal transitions retire all states but retain real running inference and audio until completion',async()=>{
  const releases:(()=>void)[]=[];let resume!:()=>void,entered!:()=>void,calls=0;
  const seen=new Promise<void>(resolve=>entered=resolve);
  async function* receiving(){yield Buffer.from('rr');entered();await new Promise<void>(resolve=>resume=resolve);yield Buffer.from('late');}
  const d=new Dictation(config({MESH_WHISPER_QUEUE_SIZE:'8'}),{principal:'old',infer:async(_chunks,m)=>{
    calls++;if(m.session!=='ready')await new Promise<void>(resolve=>releases.push(resolve));return 'secret old text';
  }});
  try{
    const ready=meta('ready',{principal:'old'}),running=meta('running',{principal:'old'}),queued=meta('queued',{principal:'old'}),slow=meta('receiving',{principal:'old'});
    const a=await d.prepare(ready,audio('a'));d.commit(ready,a.job.job_id,a.preparation);
    await until(()=>d.read(ready,a.job.job_id).state==='ready');
    const b=await d.prepare(running,audio('bbbb'));d.commit(running,b.job.job_id,b.preparation);await until(()=>releases.length===1);
    const c=await d.prepare(queued,audio('ccc'));d.commit(queued,c.job.job_id,c.preparation);
    const pending=d.prepare(slow,receiving());void pending.catch(()=>{});await seen;
    assert.deepEqual(d.stats(),{records:4,bytes:9,active:1,waiting:1});
    d.activate('new',1);
    assert.deepEqual(d.stats(),{records:0,bytes:4,active:1,waiting:0});
    for(const [m,id] of [[ready,a.job.job_id],[running,b.job.job_id],[queued,c.job.job_id]] as const)
      assert.throws(()=>d.read(m,id),code('not_found'));
    await assert.rejects(d.prepare(meta('late',{principal:'old'}),audio('late')),code('not_found'));
    assert.throws(()=>d.activate('old',0),code('not_found'),'delayed transition cannot reactivate an old principal');
    const next={...running,principal:'new',request:randomUUID()};
    const replacement=await d.prepare(next,audio('n'));d.commit(next,replacement.job.job_id,replacement.preparation);
    resume();await assert.rejects(pending);
    assert.equal(d.lookup(next,next.request).job_id,replacement.job.job_id);
    assert.deepEqual(d.stats(),{records:1,bytes:5,active:1,waiting:1});
    releases.shift()!();await until(()=>calls===3);
    assert.equal(d.stats().bytes,1);assert.equal(d.stats().active,1);
    releases.shift()!();await until(()=>d.stats().active===0);assert.equal(d.stats().bytes,0);
  }finally{resume?.();for(const release of releases)release();await d.close();}
});

for(const [type,body] of [
  ['Application/JSON; charset=utf-8','{"text":"bonjour"}'],
  ['Text/Plain; charset=UTF-8','bonjour'],
] as const)test(`upstream media type is case-insensitive: ${type}`,async()=>{
  const upstream=createServer(async(req,res)=>{
    for await(const _ of req){/* synthetic audio only */}
    res.setHeader('Content-Type',type);res.end(body);
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  try{
    const c=config({MESH_WHISPER_URL:`http://127.0.0.1:${(upstream.address() as any).port}/fixed`});
    assert.equal(await transcribe(c,[Buffer.from('audio')],meta(),new AbortController().signal),'bonjour');
  }finally{upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

test('fixed upstream multipart whitelist, no redirects, bounded JSON/status/timeout and shutdown',async()=>{
  let mode='ok',received='';
  const upstream=createServer(async(req,res)=>{
    for await(const part of req)received+=part;
    assert.equal(req.url,'/fixed'); assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
    if(mode==='hang')return;
    if(mode==='redirect'){res.writeHead(302,{Location:'/fixed'});res.end();return;}
    res.setHeader('Content-Type','application/json');
    res.end(mode==='large'?'x'.repeat(65537):mode==='bad'?'{':JSON.stringify({text:' bonjour '}));
  });
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const c=config({MESH_WHISPER_URL:`http://127.0.0.1:${(upstream.address() as any).port}/fixed`,MESH_WHISPER_TIMEOUT:'1'});
  try{
    assert.equal(await transcribe(c,[Buffer.from('audio')],meta(),new AbortController().signal),'bonjour');
    assert.equal((received.match(/; name="/g)||[]).length,3);assert.match(received,/name="language"\r\n\r\nfr/);assert.match(received,/name="response_format"\r\n\r\njson/);
    for(const [m,error] of [['redirect','upstream_unavailable'],['large','upstream_invalid'],['bad','upstream_invalid']]){mode=m;await assert.rejects(transcribe(c,[Buffer.from('x')],meta(),new AbortController().signal),code(error));}
    mode='hang';const d=new Dictation(c);const m=meta();const p=await d.prepare(m,audio('x'));d.commit(m,p.job.job_id,p.preparation);
    await until(()=>d.stats().active===1);await d.close();assert.deepEqual(d.stats(),{records:0,bytes:0,active:0,waiting:0});
    const timed=new Dictation(c);const t=meta();const pt=await timed.prepare(t,audio('x'));timed.commit(t,pt.job.job_id,pt.preparation);
    await until(()=>timed.read(t,pt.job.job_id).state==='error');assert.equal(timed.read(t,pt.job.job_id).error?.code,'upstream_timeout');await timed.close();
  }finally{upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));}
});
