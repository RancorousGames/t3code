import assert from "node:assert/strict";
import test from "node:test";
import { batchTranslationPrompt, nextDraftCandidates, parseBatchReply } from "./ai-batch.ts";
import type { MoriProject } from "./model.ts";

const project=():MoriProject=>({
  id:"demo",name:"Example",lastModified:"2026-10-20",
  context:{global:"Keep tokens unchanged.",project:"Fantasy adventure."},
  characters:[{id:"a",name:"Merchant",role:"NPC",tone:"friendly",description:"Casual Japanese."}],
  glossary:[{id:"g",en:"guild",jp:"ギルド",explanation:"canonical"}],
  rows:[
    {id:"first",source:"Welcome to the guild, {PLAYER}.",final:"",status:"pending",characterId:"a"},
    {id:"second",source:"Rest well.",final:"",status:"pending"},
    {id:"locked",source:"Already approved",final:"承認済み",status:"translated",isLocked:true},
  ],
});
test("batch candidates exclude protected and curated text",()=>{
  const rows=nextDraftCandidates(project());
  assert.deepEqual(rows.map(row=>row.id),["first","second"]);
  const prompt=batchTranslationPrompt(project(),rows);
  assert.match(prompt,/ギルド/);
  assert.match(prompt,/Merchant/);
  assert.match(prompt,/first/);
  assert.ok(!prompt.includes("Already approved"));
});
test("structured ChatGPT draft response accepts only expected unique IDs",()=>{
  const reply='\x60\x60\x60json\n{"translations":[{"id":"first","japanese":"こんにちは、{PLAYER}。"},{"id":"second","japanese":"ゆっくり休んで。"}]}\n\x60\x60\x60';
  const got=parseBatchReply(reply,["first","second"]);
  assert.equal(got[0]?.japanese,"こんにちは、{PLAYER}。");
  assert.equal(got.length,2);
  assert.throws(()=>parseBatchReply(reply,["first"]),/missing/);
  assert.throws(()=>parseBatchReply('{"translations":[{"id":"foreign","japanese":"huh"}]}',["first"]),/unexpected/);
  assert.throws(()=>parseBatchReply('{"translations":[{"id":"first","japanese":""}]}',["first"]),/unexpected/);
});
