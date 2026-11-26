// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {configuration} from './dictation.ts';
import {startService} from './dictation-service.ts';

type Bootstrap = {
  secret: string;
  socket: string;
  inventory: string;
  parent: number;
  principal: string;
};

function parseBootstrap(line: string): Bootstrap {
  const value: Partial<Bootstrap> | null = JSON.parse(line);
  if (!value || typeof value.secret !== 'string' || !/^[a-f0-9]{64}$/.test(value.secret) ||
      typeof value.principal !== 'string' || !/^[a-f0-9]{64}$/.test(value.principal) ||
      typeof value.socket !== 'string' || !value.socket.startsWith('/') ||
      typeof value.inventory !== 'string' || !value.inventory.startsWith('/') ||
      value.parent !== process.ppid) {
    throw new Error('Bootstrap invalid');
  }
  return {secret: value.secret, socket: value.socket, inventory: value.inventory,
    parent: value.parent, principal: value.principal};
}

function readBootstrap(): Promise<Bootstrap> {
  return new Promise((resolve, reject) => {
    let input = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', receive);
      process.stdin.off('end', closed);
    };
    const fail = (reason: string) => {
      cleanup();
      reject(new Error(reason));
    };
    const closed = () => fail('Bootstrap closed');
    const receive = (part: Buffer) => {
      const newline = part.indexOf(10);
      const size = newline < 0 ? part.length : newline;
      if (input.length + size > 4096) {
        fail('Bootstrap limit');
        return;
      }
      input = Buffer.concat([input, part.subarray(0, size)]);
      if (newline < 0) return;
      cleanup();
      try {
        resolve(parseBootstrap(new TextDecoder('utf-8', {fatal: true}).decode(input)));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => fail('Bootstrap timeout'), 5000);
    process.stdin.on('data', receive);
    process.stdin.once('end', closed);
  });
}

async function main(){
   let config;
   try {config=configuration(process.env);}
   catch {process.stdout.write('invalid_configuration\n');process.exitCode=1;return;}
   if(!config)throw Error('Disabled worker');
  // Private inherited pipe: no secret in arguments, environment or output.
  const bootstrap=await readBootstrap();
  const service=await startService(config,bootstrap.secret,bootstrap.socket,bootstrap.inventory,bootstrap.principal);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;clearInterval(parentWatch);await service.close();process.exit(0);};
  const parentWatch=setInterval(()=>{if(process.ppid!==bootstrap.parent)void close();},250);
  process.stdin.on('end',()=>void close());process.stdin.resume();
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
  if(process.stdin.readableEnded || process.ppid !== bootstrap.parent){await close();return;}
  process.stdout.write('ready\n');
}
void main().catch(()=>{process.stderr.write('Dictation worker unavailable.\n');process.exit(1);});
