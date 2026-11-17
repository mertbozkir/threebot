import assert from 'node:assert/strict';
import { test, after, beforeEach, afterEach } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow, entryChunk, isModule, writeBundle } from './support.mts';
const channels = []; globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'http://routines.test' }));
for (const key of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','localStorage','requestAnimationFrame','cancelAnimationFrame','IntersectionObserver']) Object.defineProperty(globalThis,key,{configurable:true,value:window[key]});
globalThis.getComputedStyle = window.getComputedStyle.bind(window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = fileURLToPath(new URL('../src/',import.meta.url));
const bundle = await buildOnce({ configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}, plugins:[{name:'routine-tests',resolveId:id=>id.endsWith('virtual:routines')?'\0routines':undefined,load:id=>id==='\0routines'?`export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export * from ${JSON.stringify(src+'lib/routines.ts')}; export {chatDraft} from ${JSON.stringify(src+'lib/chatDrafts.ts')}; export {Details, RoutineDetail, RoutineRow} from ${JSON.stringify(src+'components/Details.tsx')}; export {useApp} from ${JSON.stringify(src+'store.ts')}; export {t3, T3RpcError} from ${JSON.stringify(src+'lib/t3.ts')};`:undefined,transform:(code,id)=>isModule(id,src+'components/Details.tsx')?{code:code+'\nexport {RoutineDetail, RoutineRow};',map:null}:undefined}],ssr:{noExternal:true},build:{ssr:'virtual:routines',write:false}});
const temp = await mkdtemp(join(tmpdir(),'bot-routine-tests-')); const file=join(temp,'test.mjs'); await writeFile(file,entryChunk(bundle).code);
const {createElement:h,act,createRoot,chatDraft,Details,RoutineDetail,RoutineRow,useApp,t3,T3RpcError,...r} = await import(pathToFileURL(file).href);
after(async()=>{for(const c of channels){c.port1.close();c.port2.close();}await window.happyDOM.close();await rm(temp,{recursive:true,force:true});});
const model={instanceId:'provider',model:'example',options:[{id:'effort',value:'high'}]};
const bot={slug:'lab',name:'Lab',projectId:'project',mainThreadId:'thread',model};
const original={id:'routine-1',title:'Check example',prompt:'Read example data',enabled:false,schedule:{type:'fixed_time',timeOfDay:'09:00',weekdays:[1,2,3,4,5]},projectId:'project',threadId:null,workspaceStrategy:{type:'worktree',baseRef:'main',branch:'example',startFromOrigin:true},modelSelection:model,runtimeMode:'auto',interactionMode:'plan',runCount:4,lastRunAt:'2026-10-30T08:00:00Z',lastRunStatus:'succeeded',lastRunError:null,nextRunAt:null};
let root,host,calls,transport;
beforeEach(()=>{calls=[];transport=async(tag,payload)=>({task:{...original,...payload}});t3.call=async(tag,payload)=>{calls.push({tag,payload});return transport(tag,payload);};t3.dispatch=async command=>{calls.push({tag:'dispatch',payload:command});return {sequence:1};};chatDraft(bot,bot.mainThreadId).setText('');globalThis.fetch=async()=>new Response('{}',{status:404});useApp.setState({bots:{lab:bot},threads:{},tasks:[structuredClone(original)],detailsTab:'details',settings:{...useApp.getState().settings,timezone:'Europe/Madrid'}});host=document.createElement('main');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();});
const click=async(el)=>{assert.ok(el);await act(async()=>el.click());};
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const render=async(el)=>act(async()=>root.render(el));

test('edit keeps identity, paused state, runtime, model and workspace; history is never sent as an input',()=>{
 const result=r.routineInput({task:original,bot,title:'Changed',prompt:'Changed instruction',schedule:original.schedule,commandId:'save-1'});
 assert.equal(result.id,original.id);assert.equal(result.requireExisting,true);assert.equal(result.enabled,false);assert.equal(result.threadId,null);assert.deepEqual(result.workspaceStrategy,original.workspaceStrategy);assert.deepEqual(result.modelSelection,model);assert.equal(result.runtimeMode,'auto');assert.equal(result.interactionMode,'plan');assert.ok(!('runCount' in result));assert.ok(!('lastRunAt' in result));
});
test('new routine starts paused and refuses missing model or malformed schedule',()=>{
 const input=r.routineInput({bot,title:'New',prompt:'Do it',schedule:{type:'interval',everyMs:60000},commandId:'new'}); assert.equal(input.enabled,false);assert.equal(input.runtimeMode,'approval-required');assert.equal(input.id,undefined);assert.equal(input.threadId,'thread');
 assert.throws(()=>r.routineInput({bot:{...bot,model:null},title:'x',prompt:'y',schedule:original.schedule,commandId:'a'}),/model/);
 for(const schedule of [{type:'interval',everyMs:59000},{type:'fixed_time',timeOfDay:'24:00'},{type:'fixed_time',timeOfDay:'09:00',weekdays:[7]}])assert.throws(()=>r.parseSchedule(schedule));
 assert.throws(()=>r.parseRoutineTask({...original,workspaceStrategy:null}));
});
test('webhook editing keeps signature metadata, dedupe and filters without copying credentials into input',()=>{
 const task={...original,schedule:{type:'webhook',signature:{header:'x-signature',encoding:'hex',prefix:'sha256='},filters:[{path:'body.action',op:'equals',value:'opened'}],dedupe:{replayKey:'{{headers.x-id}}',coalesceWindowSeconds:120},maxDeliveryAgeMinutes:30},webhook:{url:'https://example.invalid/private-token',path:'/private-token',hasSecret:true}};
 const input=r.routineInput({task,bot,title:task.title,prompt:task.prompt,schedule:task.schedule,commandId:'hook'});assert.deepEqual(input.schedule,task.schedule);assert.ok(!JSON.stringify(input).includes('private-token'));assert.ok(!('secret' in input.schedule.signature));
 assert.throws(()=>r.parseSchedule({...task.schedule,dedupe:{replayKey:'not-a-template'}}),/template/);
 assert.throws(()=>r.parseFilters([{path:'secret',op:'exists'}]));
});
test('schedule wording keeps exact interval and weekdays, and dates account for DST without changing schedule',()=>{
 assert.equal(r.scheduleText({schedule:{type:'interval',everyMs:90000}}),'Every 90 seconds');assert.match(r.scheduleText(original),/Weekdays.*server time/);
 assert.match(r.routineDate('2026-03-29T00:30:00Z','Europe/Madrid'),/1:30|01:30/);assert.match(r.routineDate('2026-03-29T01:30:00Z','Europe/Madrid'),/3:30|03:30/);
 assert.match(r.routineDate('2026-10-25T00:30:00Z','Europe/Madrid'),/2:30|02:30/);assert.match(r.routineDate('2026-10-25T01:30:00Z','Europe/Madrid'),/2:30|02:30/);
 assert.equal(original.schedule.timeOfDay,'09:00');assert.equal(r.dispatchStatus('succeeded'),'Dispatched');assert.equal(r.dispatchStatus('failed'),'Dispatch failed');
});
test('editing a routine prepares chat without changing its stored settings or history',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b}});
 const before=structuredClone(useApp.getState().tasks);
 await render(h(Details,{bot:b,threadId:null}));
 await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 await click(button('Edit'));
 assert.equal(chatDraft(b,b.mainThreadId).getSnapshot().text,'Edit your routine: Check example');
 assert.equal(useApp.getState().selectedThreadId,null);
 assert.equal(useApp.getState().detailsOpen,false);
 assert.deepEqual(useApp.getState().tasks,before);
 assert.equal(calls.some(c=>c.tag.startsWith('scheduledTasks.')),false);
});

test('routine chat editing preserves the existing draft and never submits automatically',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b}});
 chatDraft(b,b.mainThreadId).setText('Keep my draft');
 await render(h(Details,{bot:b,threadId:null}));
 await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 await click(button('Edit'));
 assert.equal(chatDraft(b,b.mainThreadId).getSnapshot().text,'Keep my draft\n\nEdit your routine: Check example');
 assert.equal(calls.some(c=>c.tag==='scheduledTasks.upsert'||c.payload?.type==='message.dispatch'),false);
});

test('new routine routes to chat and leaves existing routines intact',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b}});
 await render(h(Details,{bot:b,threadId:null}));
 await click(document.querySelector('[aria-label="New routine"]'));
 assert.equal(chatDraft(b,b.mainThreadId).getSnapshot().text,'Set up a routine');
 assert.deepEqual(useApp.getState().tasks,[original]);
 assert.equal(document.querySelector('.routine-editor'),null);
 assert.equal(calls.some(c=>c.tag==='scheduledTasks.upsert'),false);
});

test('list pause failure keeps authoritative switch and schedule wording',async()=>{
 transport=async()=>{throw Error('Denied');};await render(h(RoutineRow,{task:original,onOpen(){}}));assert.match(host.textContent,/Paused.*Weekdays/);await click(document.querySelector('[role="switch"]'));assert.equal(document.querySelector('[role="switch"]').getAttribute('aria-checked'),'false');assert.match(host.textContent,/Denied/);
});
test('detail shows one history list; delete waits for confirmation and acknowledgement',async()=>{
 let back=false;await render(h(RoutineDetail,{task:original,onBack(){back=true;},onEdit(){}}));assert.match(host.textContent,/History/);assert.doesNotMatch(host.textContent,/Last dispatch summary|Recorded run history|Rotate URL token/);assert.match(host.textContent,/not available on this gateway/);assert.ok(!host.textContent.includes('Next:'));
 await click(button('Delete routine'));assert.equal(calls.length,0);transport=async()=>{throw Error('Denied');};await click(button('Delete'));assert.equal(back,false);assert.equal(useApp.getState().tasks.length,1);assert.match(host.textContent,/Denied/);
 transport=async()=>({id:original.id});await click(button('Delete'));assert.equal(back,true);assert.equal(useApp.getState().tasks.length,0);
});
test('redacted webhook diagnostics never return payload, headers, prompts, errors or tokens',async()=>{
 transport=async()=>({deliveries:[{id:'delivery',receivedAt:'2026-10-31T00:00:00Z',outcome:'filtered',signatureVerified:false,body:'PRIVATE',headers:{token:'PRIVATE'},error:'PRIVATE',renderedPrompt:'PRIVATE'}]});const deliveries=await r.webhookDeliveries('routine-1');assert.equal(deliveries[0].outcome,'filtered');assert.ok(!JSON.stringify(deliveries).includes('PRIVATE'));
});

for (const runtimeMode of ['approval-required','auto-accept-edits','auto','full-access']) test(`editor retains T3 runtime mode ${runtimeMode}`,()=>{assert.equal(r.parseRoutineTask({...original,runtimeMode}).runtimeMode,runtimeMode);});

test('webhook Test is unavailable because T3 runNow rejects webhook tasks',async()=>{const task={...original,schedule:{type:'webhook',signature:null}};await assert.rejects(r.testRoutine(task),/private URL/);assert.equal(calls.length,0);await render(h(RoutineDetail,{task,onBack(){},onEdit(){}}));assert.equal(button('Test'),undefined);assert.match(host.textContent,/Paused.*When a webhook is called/);});

test('mobile Back returns from routine to list, then profile; changing Bot closes its routine view',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b},detailsTab:'details'});
 await render(h(Details,{bot:b,threadId:null}));await click(document.querySelector('.profile-actions button'));await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 assert.match(host.textContent,/History/);await click(document.querySelector('.details-back'));assert.ok(!host.textContent.includes('History'));assert.match(document.querySelector('.details-page-title').textContent,/Routines/);
 await click(document.querySelector('[aria-label="New routine"]'));assert.equal(document.querySelector('.routine-editor'),null);assert.match(chatDraft(b,b.mainThreadId).getSnapshot().text,/Set up a routine/);
 const other={...b,slug:'other',projectId:'other-project'};useApp.setState({bots:{lab:b,other}});await render(h(Details,{bot:other,threadId:null}));assert.equal(document.querySelector('.routine-editor'),null);assert.ok(!host.textContent.includes(original.title));
});
test('repeated Test clicks dispatch once while pending',async()=>{
 let resolve;transport=()=>new Promise(r=>{resolve=r;});
 await render(h(RoutineDetail,{task:original,onBack(){},onEdit(){}}));
 await act(async()=>{const b=button('Test');b.click();b.click();});
 assert.equal(calls.filter(c=>c.tag==='scheduledTasks.runNow').length,1);await act(async()=>resolve({task:original}));
});

test('webhook details expose no technical form or token rotation controls',async()=>{
 const task={...original,schedule:{type:'webhook',signature:{header:'x-signature',encoding:'base64',prefix:'sha256='}}};
 await render(h(RoutineDetail,{task,onBack(){},onEdit(){}}));
 assert.doesNotMatch(host.textContent,/Coalesce key|Replay key|Signature header|Encoding|Prefix|Base64|HMAC|Rotate URL token/);
 assert.equal(calls.length,0);
});

test('editing an open routine closes the detail and does not mount a technical editor',async(t)=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b},detailsTab:'details'});
 await render(h(Details,{bot:b,threadId:null}));await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 const errors=t.mock.method(console,'error',()=>{});await click(button('Edit'));
 assert.equal(document.querySelector('.routine-editor'),null);
 assert.ok(!errors.mock.calls.some(call=>String(call.arguments[0]).includes('same key')));
 assert.match(chatDraft(b,b.mainThreadId).getSnapshot().text,/Edit your routine/);
});

test('one-time routines from T3 0.1.7+ parse, read as a date and keep working controls',async()=>{
 const task={...original,schedule:{type:'once',runAt:'2026-11-20T09:30:00+01:00'},blockedByPolicy:undefined};
 assert.deepEqual(r.parseSchedule(task.schedule),task.schedule);
 for(const schedule of [{type:'once',runAt:'2026-11-20T09:30'},{type:'once',runAt:'soon+01:00'},{type:'once'}])assert.throws(()=>r.parseSchedule(schedule));
 const text=r.scheduleText(task,'Europe/Madrid');assert.match(text,/^Once, /);assert.match(text,/9:30|09:30/);assert.match(text,/2026/);assert.doesNotMatch(text,/webhook/);
 await render(h(RoutineRow,{task,onOpen(){}}));assert.match(host.textContent,/Paused · Once, /);
 await click(document.querySelector('[role="switch"]'));assert.deepEqual(calls.at(-1),{tag:'scheduledTasks.setEnabled',payload:{id:task.id,enabled:true}});assert.equal(document.querySelector('[role="alert"]'),null);
 const input=r.routineInput({task,bot,title:task.title,prompt:task.prompt,schedule:task.schedule,commandId:'once'});assert.deepEqual(input.schedule,task.schedule);
});
test('a routine an administrator policy blocks says why',async()=>{
 const task={...original,enabled:true,blockedByPolicy:'Webhooks are turned off by Example Org.'};
 assert.equal(r.parseRoutineTask(task).blockedByPolicy,task.blockedByPolicy);
 await render(h(RoutineRow,{task,onOpen(){}}));assert.match(host.textContent,/Blocked · Weekdays/);
 await render(h(RoutineDetail,{task,onBack(){},onEdit(){}}));assert.match(host.textContent,/This routine can’t run: Webhooks are turned off by Example Org\./);
});
test('a bound routine can start fresh each run where T3 supports thread modes, and keeps everything else',async()=>{
 const task={...original,threadId:'thread',threadMode:'continue',workspaceStrategy:{type:'root'}};
 assert.equal(r.parseRoutineTask(task).threadMode,'continue');assert.equal('threadMode' in r.parseRoutineTask(original),false);
 assert.throws(()=>r.parseRoutineTask({...task,threadMode:'elsewhere'}),/destination/);
 assert.equal(r.threadMode(original),'new_thread');assert.equal(r.threadMode({...original,threadId:'thread'}),'continue');
 const features=useApp.getState().runtimeFeatures;
 useApp.setState({runtimeFeatures:{...features,scheduledTaskThreadModes:false}});
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));assert.doesNotMatch(host.textContent,/Start fresh each run/,'older T3 ignores the mode, so no switch');
 await act(async()=>useApp.setState({runtimeFeatures:{...features,scheduledTaskThreadModes:true}}));
 await render(h(RoutineDetail,{bot,task:original,onBack(){},onEdit(){}}));assert.doesNotMatch(host.textContent,/Start fresh each run/,'a routine that starts a new conversation each run has no switch');
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 const toggle=host.querySelector('[role="switch"][aria-label="Start fresh each run"]');assert.equal(toggle.getAttribute('aria-checked'),'false');assert.match(host.textContent,/continues the conversation/);
 await click(toggle);
 const saved=calls.find(c=>c.tag==='scheduledTasks.upsert');assert.ok(saved);
 assert.equal(saved.payload.threadMode,'fresh_session');assert.equal(saved.payload.id,task.id);assert.equal(saved.payload.requireExisting,true);assert.equal(saved.payload.threadId,'thread');assert.equal(saved.payload.enabled,false);assert.deepEqual(saved.payload.modelSelection,model);assert.equal(saved.payload.runtimeMode,'auto');assert.deepEqual(saved.payload.schedule,task.schedule);
 assert.equal(useApp.getState().tasks.find(t=>t.id===task.id).threadMode,'fresh_session');
 await render(h(RoutineDetail,{bot,task:useApp.getState().tasks.find(t=>t.id===task.id),onBack(){},onEdit(){}}));
 assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'true');assert.match(host.textContent,/Lab keeps its memory and files/);
});
