import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const modulePath=require.resolve('../../mcp-install.js');
const cli=require('../../mneme-cli.js');
test('--global is a boolean flag that preserves the named agent',()=>{
  assert.deepEqual(cli.parseFlags(['--global','codex']),{_:['codex'],global:true});
});
test('global Auto preserves other MCP entries and repository files; reruns are idempotent',()=>{
  const home=mkdtempSync(join(tmpdir(),'icarus-global-'));
  try{
    for(const d of ['.codex','.cursor','repo','mock-bin'])mkdirSync(join(home,d));
    writeFileSync(join(home,'.claude.json'),JSON.stringify({mcpServers:{other:{command:'other-server'}},userValue:'keep'}));
    writeFileSync(join(home,'.codex/config.toml'),'# keep me\n[mcp_servers.other]\ncommand = "other"\n');
    writeFileSync(join(home,'.cursor/mcp.json'),JSON.stringify({mcpServers:{other:{command:'other'}}}));
    writeFileSync(join(home,'repo/AGENTS.md'),'User instructions\n');
    writeFileSync(join(home,'mock-bin/launchctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
    const env={...process.env,HOME:home,USERPROFILE:home,ICARUS_HOME:join(home,'.icarus'),PATH:join(home,'mock-bin')+':'+process.env.PATH};
    const script='require(process.argv[1]).run({_:[],global:true},{telemetry:{enabled:false}})';
    for(let i=0;i<2;i++){const output=execFileSync(process.execPath,['-e',script,modulePath],{env,cwd:join(home,'repo'),encoding:'utf8'});assert.doesNotMatch(output,/undefined/);for(const agent of ['codex','claude','cursor'])assert.match(output,new RegExp(agent+': '+(i?'already registered':'registered')+' in '));}
    const claude=JSON.parse(readFileSync(join(home,'.claude.json')));assert.equal(claude.userValue,'keep');assert.ok(claude.mcpServers.other);assert.ok(claude.mcpServers.icarus);
    const codex=readFileSync(join(home,'.codex/config.toml'),'utf8');assert.equal((codex.match(/\[mcp_servers.icarus\]/g)||[]).length,1);assert.ok(codex.includes('[mcp_servers.other]'));
    assert.ok(JSON.parse(readFileSync(join(home,'.cursor/mcp.json'))).mcpServers.other);
    assert.equal(readFileSync(join(home,'repo/AGENTS.md'),'utf8'),'User instructions\n');assert.equal(existsSync(join(home,'repo/.icarus')),false);
    assert.ok(existsSync(join(home,'.codex/skills/icarus-agent-memory/SKILL.md')));
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('Auto skips absent clients instead of creating their directories',()=>{
  const home=mkdtempSync(join(tmpdir(),'icarus-global-absent-'));
  try{
    execFileSync(process.execPath,['-e','require(process.argv[1]).run({_:[],global:true},{telemetry:{enabled:false}})',modulePath],{env:{...process.env,HOME:home,USERPROFILE:home,ICARUS_HOME:join(home,'.icarus')},cwd:home,stdio:'pipe'});
    for(const d of ['.codex','.claude','.claude.json','.cursor','.icarus'])assert.equal(existsSync(join(home,d)),false,d);
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('named user-wide setup connects only that agent and refuses global Harness activation',()=>{
  const home=mkdtempSync(join(tmpdir(),'icarus-global-named-'));
  try{
    for(const d of ['.codex','repo','mock-bin'])mkdirSync(join(home,d));
    const original=JSON.stringify({mcpServers:{other:{command:'other'}}});
    writeFileSync(join(home,'.claude.json'),original);
    writeFileSync(join(home,'mock-bin/launchctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
    const env={...process.env,HOME:home,USERPROFILE:home,ICARUS_HOME:join(home,'.icarus'),PATH:join(home,'mock-bin')+':'+process.env.PATH};
    execFileSync(process.execPath,['-e','require(process.argv[1]).run({_: ["codex"],global:true},{telemetry:{enabled:false}})',modulePath],{env,cwd:join(home,'repo'),stdio:'pipe'});
    assert.match(readFileSync(join(home,'.codex/config.toml'),'utf8'),/mcp_servers.icarus/);
    assert.equal(readFileSync(join(home,'.claude.json'),'utf8'),original);
    assert.equal(existsSync(join(home,'repo/AGENTS.md')),false);
    const rejected=execFileSync(process.execPath,['-e','require(process.argv[1]).run({_: ["codex"],global:true,harness:true},{}).then(()=>process.exit(9),e=>console.log(e.message))',modulePath],{env,cwd:join(home,'repo'),encoding:'utf8'});
    assert.match(rejected,/cannot enable repository Harness/);
  }finally{rmSync(home,{recursive:true,force:true});}
});
