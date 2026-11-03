#!/usr/bin/env node
"use strict";
// Generate an editable native .mori project from Mori's English UI strings.
// --install: add/update it in Mori's own project library, preserving translations.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {createRequire}=require("node:module");
const root=path.resolve(__dirname,"..");
const repo=path.resolve(root,"../..");
const plugin=require.resolve("@vitejs/plugin-react",{paths:[root]});
const {parse}=createRequire(plugin)("@babel/parser");
const seed=JSON.parse(fs.readFileSync(path.join(root,"localization","seed.ja.json"),"utf8"));
const projectId="mori_self_ui_ja";
const catalog=new Map();
const propNames=new Set(["title","description","placeholder","aria-label","alt","label","emptyText","tooltip","helpText"]);
const normalize=s=>String(s).replace(/\s+/g," ").trim();
function add(source,file,line,context){
 source=normalize(source);
 if(source.length<2||source.length>420||!/[A-Za-z]/.test(source))return;
 if(/^(https?:|file:|\.\/|\.{2}\/|--|data-|aria-|<)/.test(source))return;
 if(/^[a-z][\w./:-]*$/.test(source))return;
 const id="ui."+crypto.createHash("sha256").update(source).digest("hex").slice(0,14);
 const item=catalog.get(id)||{id,source,locations:new Set()};
 item.locations.add(file+":"+line+" ("+context+")");
 catalog.set(id,item);
}
function walk(node,file){
 if(!node||typeof node!=="object"||!node.type)return;
 const line=node.loc?.start.line||0;
 if(node.type==="JSXText")add(node.value,file,line,"text");
 if(node.type==="JSXAttribute"){
  const name=node.name?.name;
  const val=node.value?.type==="StringLiteral"?node.value:node.value?.expression;
  if(propNames.has(name)&&val?.type==="StringLiteral")add(val.value,file,line,name);
 }
 if(node.type==="CallExpression"&&node.arguments?.[0]?.type==="StringLiteral"){
  const c=node.callee?.property?.name||node.callee?.name;
  if(["toast","confirm","prompt","alert"].includes(c))add(node.arguments[0].value,file,line,c);
 }
 if(node.type==="ObjectProperty"&&propNames.has(node.key?.name||node.key?.value)&&node.value?.type==="StringLiteral")
  add(node.value.value,file,line,node.key?.name||node.key?.value);
 for(const [key,child] of Object.entries(node)){
  if(["loc","start","end","tokens","comments","leadingComments","trailingComments","extra","errors"].includes(key))continue;
  if(Array.isArray(child)){for(const x of child)if(x?.type)walk(x,file);}
  else if(child?.type)walk(child,file);
 }
}
for(const file of fs.readdirSync(path.join(root,"src")).filter(x=>x.endsWith(".tsx")&&!x.endsWith(".test.tsx")).sort()){
 const code=fs.readFileSync(path.join(root,"src",file),"utf8");
 try{walk(parse(code,{sourceType:"module",plugins:["typescript","jsx"]}),"src/"+file);}
 catch(e){throw Error("Could not scan "+file+": "+e.message);}
}
for(const key of Object.keys(seed))add(key,"localization/seed.ja.json",1,"seed");
const rows=[...catalog.values()].sort((a,b)=>a.source.localeCompare(b.source,"en")).map(item=>({
 id:item.id,source:item.source,ai:"",final:seed[item.source]||"",
 status:seed[item.source]?"translated":"pending",
 sourceFile:[...item.locations][0].split(":")[0],
 note:[...item.locations].slice(0,8).join("; ")
}));
const glossary=[
 ["Matrix","マトリクス"],["AI Chats","AIチャット"],["Characters","キャラクター"],
 ["Glossary","用語集"],["Settings","設定"],["Draft","下書き"],["Project","プロジェクト"]
].map(([en,jp],i)=>({id:"self-glossary-"+i,en,jp,explanation:"UI terminology; remain consistent."}));
const project={id:projectId,name:"Monku no Mori · Interface (EN → JA)",rows,characters:[],glossary,
 context:{
  global:"Translate concise, natural Japanese UI strings. Preserve variables, placeholders, keyboard shortcuts, product names and punctuation. Prefer standard Japanese desktop application terminology. Do not translate code identifiers or HTML markup.",
  project:"You are localizing Monku no Mori itself: an EN→JA desktop translation editor with a Matrix, AI Chats, glossary, characters, project imports and exports. These strings are button labels, tooltips, instructions, menus and status text, not story dialogue. Source locations are in each row's notes."
 },sourceFiles:[...new Set(rows.map(r=>r.sourceFile))],lastModified:new Date().toISOString()};
const out=path.join(root,"localization","MonkuNoMoriUI.mori");
fs.writeFileSync(out,JSON.stringify(project,null,2)+"\n","utf8");
console.log("Catalog "+rows.length+" UI strings; "+rows.filter(r=>r.final).length+" initial Japanese; "+out);
if(process.argv.includes("--install")){
 (async()=>{
  if(!process.env.APPDATA)throw Error("APPDATA missing");
  const {createProjectStore}=require(path.join(repo,"apps/mori-desktop/project-store.cjs"));
  const store=createProjectStore(path.join(process.env.APPDATA,"MonkuNoMori"));
  const old=await store.load(projectId);
  if(old){
   const previous=new Map(old.rows.map(row=>[row.id,row]));
   for(const row of project.rows){
    const saved=previous.get(row.id);
    if(saved&&saved.source===row.source){
     row.ai=saved.ai||row.ai;
     row.final=saved.final||row.final;
     row.status=saved.final?"translated":saved.ai?"draft":"pending";
     row.history=saved.history||row.history;
     row.isLocked=saved.isLocked||row.isLocked;
    }
   }
   const existing=new Set(project.rows.map(r=>r.id));
   project.rows.push(...old.rows.filter(r=>!existing.has(r.id)));
   project.glossary=old.glossary?.length?old.glossary:project.glossary;
   project.context=old.context||project.context;
  }
  await store.save(project);
  console.log((old?"Updated":"Installed")+" native project: "+projectId);
 })().catch(error=>{console.error(error);process.exitCode=1;});
}
