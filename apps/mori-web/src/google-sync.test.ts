import assert from "node:assert/strict";
import test from "node:test";
import { a1, planSheetLinks, plannedSyncUpdates, spreadsheetColumn, updateSyncBaseline } from "./google-sync.ts";
import type { MoriProject } from "./model.ts";

const project = (): MoriProject => ({
  id:"mori", name:"Dialogue", lastModified:"2026-10-20",
  rows:[{id:"r1",source:"Hello",legacy:"古い",final:"こんにちは",status:"translated"},
    {id:"r2",source:"Bye",legacy:"",final:"",status:"pending"}],
  context:{global:"",project:""}, characters:[], glossary:[],
});
test("Google import link respects filtered worksheet row numbers and mapped column", () => {
  const sources = [{
    headers:["ID","English","Japanese"], rows:[["r1","Hello","古い"],["r2","Bye",""]],
    name:"A / Dialogue", path:"Google Drive/A/Dialogue",kind:"sheet" as const,
    google:{sourceId:"original",copyId:"copy",sourceName:"A",sheetName:"Dialogue",rowNumbers:[4,9],headerRow:2},
  }];
  const mapped = planSheetLinks(sources, () => ({id:"ID",src:"English",tr:"Japanese",spk:"",note:""}));
  assert.equal(mapped.sheets.length,1);
  assert.equal(mapped.sheets[0]?.cells[0]?.rowNumber,4);
  assert.equal(mapped.sheets[0]?.cells[1]?.rowNumber,9);
  const updates=plannedSyncUpdates(project(),mapped.sheets[0]!);
  assert.deepEqual(updates,[{rowId:"r1",rowNumber:4,range:"'Dialogue'!C4",expected:"古い",next:"こんにちは"}]);
});
test("no translation column means read-only import without fabricated writable cells", () => {
  const noTranslation = planSheetLinks([{
    headers:["key","source"],rows:[["r1","Hello"]], name:"foo",path:"foo",kind:"sheet",
    google:{sourceId:"original",copyId:"copy",sourceName:"foo",sheetName:"UI",rowNumbers:[2],headerRow:1},
  }],()=>({id:"key",src:"source",tr:"",spk:"",note:""}));
  assert.equal(noTranslation.sheets.length,0);
});
test("baseline commits only selected copy rows; edited translation remains in local project", () => {
  const p=project();
  p.googleSync={version:1,sheets:[{
    sourceId:"source",copyId:"copy",sourceName:"A",sheetName:"UI",translationColumn:"D",
    cells:[{rowId:"r1",rowNumber:2,expected:"old"},{rowId:"r2",rowNumber:3,expected:"other"}],
  }]};
  const next=updateSyncBaseline(p,"copy",[{rowId:"r1",next:"こんにちは"}]);
  const sheet=(next.googleSync as {sheets:{cells:{expected:string}[]}[]}).sheets[0]!;
  assert.equal(sheet.cells[0]!.expected,"こんにちは");
  assert.equal(sheet.cells[1]!.expected,"other");
  assert.equal(next.rows[0]?.final,"こんにちは");
  assert.equal((p.googleSync as {sheets:{cells:{expected:string}[]}[]}).sheets[0]!.cells[0]!.expected,"old");
});
test("A1 columns and escaped sheets are deterministic; invalid cells fail",()=>{
  assert.equal(spreadsheetColumn(0),"A");
  assert.equal(spreadsheetColumn(26),"AA");
  assert.equal(spreadsheetColumn(52),"BA");
  assert.equal(a1({sourceId:"",copyId:"",sourceName:"",sheetName:"Hero's Notes",translationColumn:"C",cells:[]},24),"'Hero''s Notes'!C24");
  assert.throws(()=>spreadsheetColumn(-1),/Invalid/);
  assert.throws(()=>a1({sourceId:"",copyId:"",sourceName:"",sheetName:"UI",translationColumn:"C",cells:[]},0),/Invalid/);
});
