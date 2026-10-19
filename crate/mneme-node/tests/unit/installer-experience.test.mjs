import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = new URL('../../../../', import.meta.url);
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'icarus-install-experience-'));
  const lib=join(dir,'installer.sh');
  writeFileSync(lib,readFileSync(new URL('install.sh',root),'utf8').replace(/\nmain "\$@"\s*$/,'\n'));
  return {dir,lib};
};
const run = (script, options={}) => new Promise(resolve => {
  const child=spawn('bash',['-c',script],options);let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  child.on('exit',code=>resolve({code,stdout,stderr}));
});
test('real HTTP downloads count actual bytes with known and unknown lengths; failures stay failures', {skip:process.platform==='win32'}, async()=>{
  const f=fixture();const bytes=Buffer.alloc(16384,'x');
  const server=http.createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{'content-length':'0',location:'/known'});res.end();return;}
    if(req.url==='/fail'){res.writeHead(503);res.end();return;}
    if(req.url==='/known')res.setHeader('content-length',bytes.length);
    res.write(bytes.subarray(0,4096));setTimeout(()=>res.end(bytes.subarray(4096)),250);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    for(const path of ['/redirect','/unknown']){
      const out=join(f.dir,'download');
      const result=await run('set -e; source "$LIB"; download_with_progress "$URL" "$OUT" Binary',{env:{...process.env,HOME:f.dir,ICARUS_HOME:join(f.dir,'.icarus'),LIB:f.lib,URL:`http://127.0.0.1:${server.address().port}${path}`,OUT:out}});
      assert.equal(result.code,0,result.stderr);assert.deepEqual(readFileSync(out),bytes);
      assert.match(result.stderr,/downloaded 16384 bytes/);assert.doesNotMatch(result.stderr,/\x1b|\r/);
    }
    const failed=await run('source "$LIB"; download_with_progress "$URL" "$OUT" Binary',{env:{...process.env,HOME:f.dir,ICARUS_HOME:join(f.dir,'.icarus'),LIB:f.lib,URL:`http://127.0.0.1:${server.address().port}/fail`,OUT:join(f.dir,'failed')}});
    assert.notEqual(failed.code,0);assert.doesNotMatch(failed.stderr,/downloaded/);
    const meter=await run('source "$LIB"; download_progress_line 524288 1048576 2 Binary; echo; download_progress_line 524288 0 2 Binary',{env:{...process.env,HOME:f.dir,LIB:f.lib}});
    assert.match(meter.stdout,/50% \|##########----------\| 0.5\/1.0 MiB/);
    assert.match(meter.stdout,/ETA 00:02/);assert.match(meter.stdout,/total unknown/);
  }finally{server.close();server.closeAllConnections();rmSync(f.dir,{recursive:true,force:true});}
});
test('end-of-install choices invoke only user-wide setup; old binaries and skip cannot create repo state', {skip:process.platform==='win32'}, async()=>{
  const f=fixture();mkdirSync(join(f.dir,'bin'));
  const cli=join(f.dir,'bin','icarus');
  writeFileSync(cli,'#!/bin/sh\nif [ "$1" = --help ]; then echo "user-wide setup"; else printf "%s\\n" "$*" >> "$CALLS"; fi\n',{mode:0o700});
  try{
    for(const [choice,args] of [['auto','mcp install --global'],['codex','mcp install codex --global'],['claude','mcp install claude --global'],['cursor','mcp install cursor --global']]){
      const calls=join(f.dir,choice);const result=await run('source "$LIB"; connect_coding_agents',{env:{...process.env,HOME:f.dir,ICARUS_HOME:f.dir,ICARUS_INSTALL_AGENTS:choice,LIB:f.lib,CALLS:calls}});
      assert.equal(result.code,0,result.stderr);assert.equal(readFileSync(calls,'utf8').trim(),args);
    }
    const skipped=await run('source "$LIB"; connect_coding_agents',{env:{...process.env,HOME:f.dir,ICARUS_HOME:f.dir,ICARUS_INSTALL_AGENTS:'skip',LIB:f.lib}});
    assert.match(skipped.stdout,/Skipped/);
    writeFileSync(cli,'#!/bin/sh\nif [ "$1" = --help ]; then echo "old CLI"; else exit 91; fi\n',{mode:0o700});
    const old=await run('source "$LIB"; connect_coding_agents',{env:{...process.env,HOME:f.dir,ICARUS_HOME:f.dir,ICARUS_INSTALL_AGENTS:'codex',LIB:f.lib}});
    assert.equal(old.code,0);assert.match(old.stdout,/needs an update/);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
