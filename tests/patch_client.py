import re, sys
p='apps-script/Index.html'
s=open('original/birr-ledger.html').read()

def rep(old,new,count=1):
    global s
    n=s.count(old)
    assert n==count, f'expected {count} match, got {n} for: {old[:70]!r}'
    s=s.replace(old,new)

# ---- 1. storage + load + save block -> server-backed ----
a=s.index('  // ---------- storage ----------')
b=s.index('  // ---------- engine (monthly-envelope model) ----------')
new_block = r'''  // ---------- session + server ----------
  // Data lives in Google Sheets/Drive behind Apps Script. The browser only keeps a sign-in token
  // (and the theme) in localStorage — both optional: if storage is blocked you just sign in each visit.
  const TOKENKEY='birrledger:token';
  let token=null, me=null, rev=0, saved={entries:new Map(),meta:'{}'};
  const lsGet=k=>{ try{ return window.localStorage.getItem(k); }catch(e){ return null; } };
  const lsSet=(k,v)=>{ try{ window.localStorage.setItem(k,v); }catch(e){} };
  const lsDel=k=>{ try{ window.localStorage.removeItem(k); }catch(e){} };

  function RPC(method,args){
    return new Promise(res=>{
      if(typeof google==='undefined'||!google.script||!google.script.run){
        res({ok:false,code:'NET',msg:'This page must be opened from the Apps Script web app URL.'}); return; }
      google.script.run
        .withSuccessHandler(r=>{
          r=r||{ok:false,code:'SERVER',msg:'Empty response from server.'};
          if(!r.ok && r.code==='AUTH' && method!=='login') signOut(r.msg);
          res(r);})
        .withFailureHandler(e=>res({ok:false,code:'NET',msg:(e&&e.message)||'Network error.'}))
        .rpc(method, token, args||{});
    });
  }

  const metaOf=d=>{ const m=Object.assign({},d); delete m.entries; return m; };

  // Server document -> in-memory ledger. Also runs on restored backups, so old backup formats still work.
  function normalize(raw){
    db=raw||{};
    if(!Array.isArray(db.entries)) db.entries=[];
    if(!Array.isArray(db.zero))    db.zero=[];
    if(typeof db.lastBackup!=='number') db.lastBackup=0;
    // v4 debts -> v5 people (a debt is a person with a negative balance)
    if(!Array.isArray(db.people)){
      db.people=Array.isArray(db.debts)?db.debts.map(d=>({id:d.id,name:d.name,opening:-(d.opening||0)})):[];
    }
    delete db.debts;
    if(!db.setup||typeof db.setup!=='object') db.setup={};
    if(typeof db.setup.floor!=='number') db.setup.floor=0;
    if(typeof db.setup.bufferMonths!=='number') db.setup.bufferMonths=3;
    if(!db.setup.opening||typeof db.setup.opening!=='object') db.setup.opening={};
    ACCOUNTS.forEach(a=>{ if(typeof db.setup.opening[a]!=='number') db.setup.opening[a]=0; });
    delete db.setup.opening.Equb; delete db.setup.split;
    db.entries=db.entries.filter(e=>e&&e.id&&e.acct!=='Equb'&&e.from!=='Equb'&&e.to!=='Equb');
    db.entries.forEach(e=>{
      if(!e.day) e.day=key(e.ts||Date.now());
      if(e.bucket==='tax') e.bucket='buffer';
      if(e.type==='out'&&!e.bucket) e.bucket='personal';
      if(e.type==='borrow'){ e.type='pin';  e.person=e.debtId; }   // money IN from a person
      if(e.type==='repay'){  e.type='pout'; e.person=e.debtId; }   // money OUT to a person
    });
    // opening-balance loans repay to Buffer (no recorded origin)
    db.people.forEach(x=>{ if((x.opening||0)>0 && !x.originBucket) x.originBucket='buffer'; });
    // MONTHLY-ENVELOPE MIGRATION (Option 3): stamp the day the envelope model began.
    // Set once, the first time the new engine loads a ledger that already has a floor.
    if(db.setup.floor>0 && !db.setup.envStart) db.setup.envStart=today();
    return db;
  }

  // Fetch the signed-in user's ledger. The "saved" snapshot is taken BEFORE normalising so that any
  // migration the normaliser performs is detected as a change and written back on the next save.
  async function load(){
    const r=await RPC('load');
    if(!r.ok) throw r;
    const raw=r.data.doc||{};
    rev=r.data.rev; me=r.data.user;
    saved={entries:new Map((raw.entries||[]).filter(e=>e&&e.id).map(e=>[e.id,JSON.stringify(e)])), meta:JSON.stringify(metaOf(raw))};
    normalize(raw);
  }
  const BACKUP_EVERY=14*DAY;
  const backupDue=()=>{
    if(!db||!db.entries||db.entries.length<3) return false;
    if(!db.lastBackup) return true;
    return (Date.now()-db.lastBackup) > BACKUP_EVERY;
  };

  // Saves are sent as a delta (changed/removed entries by id, settings only when changed) and
  // serialised so rapid taps can never interleave. The snapshot only advances on success, so a
  // failed save is simply re-sent, with everything since, by the next one.
  let saveOk=true, saveQ=Promise.resolve();
  const save=()=>(saveQ=saveQ.then(doSave,doSave));
  async function doSave(){
    if(!db||!token) return;
    const cur=new Map(db.entries.map(e=>[e.id,JSON.stringify(e)]));
    const metaStr=JSON.stringify(metaOf(db));
    const upserts=[], deletes=[];
    db.entries.forEach(e=>{ if(saved.entries.get(e.id)!==cur.get(e.id)) upserts.push(e); });
    saved.entries.forEach((_,id)=>{ if(!cur.has(id)) deletes.push(id); });
    const metaChanged=metaStr!==saved.meta;
    if(!upserts.length&&!deletes.length&&!metaChanged) return;
    const payload={baseRev:rev,upserts,deletes};
    if(metaChanged) payload.meta=metaOf(db);
    const r=await RPC('save',payload);
    const before=saveOk;
    if(r.ok){
      saveOk=true; rev=r.data.rev; saved={entries:cur,meta:metaStr};
      if(r.data.stale){ await refreshFromServer(); }          // another device saved too — pick up its entries
    }else if(r.code==='CONFLICT'){
      saveOk=true;
      await refreshFromServer();
      alert('This ledger was changed on another device, so it has been reloaded. Please redo your last change.');
    }else if(r.code==='AUTH'){
      return;                                                   // RPC already routed to the sign-in screen
    }else{
      saveOk=false;
    }
    if(before!==saveOk||r.code==='CONFLICT') render();
  }
  async function refreshFromServer(){
    const keep=sel;
    try{ await load(); sel=keep; render(); }catch(e){ if(!(e&&e.code==='AUTH')) saveOk=false; }
  }

  function signOut(msg){
    token=null; me=null; db=null; mode=null; draft={}; editId=null; panel=null; attView=null; usersList=null; newCred=null;
    lsDel(TOKENKEY);
    fileCache.forEach(f=>URL.revokeObjectURL(f.url)); fileCache.clear();
    renderLogin(msg||'');
  }

  // ---------- attachments ----------
  const ATT_MAX=5*1024*1024, ATT_LIMIT=5, IMG_EDGE=1600;
  const fileCache=new Map();                       // fileId -> {url,name,mime}
  let panel=null, attView=null, usersList=null, newCred=null, panelErr='';
  const readB64=blob=>new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(String(r.result).split(',')[1]||'');
    r.onerror=()=>rej(new Error('Could not read the file.'));
    r.readAsDataURL(blob); });
  const loadImg=file=>new Promise((res,rej)=>{
    const u=URL.createObjectURL(file), im=new Image();
    im.onload=()=>{ URL.revokeObjectURL(u); res(im); };
    im.onerror=()=>{ URL.revokeObjectURL(u); rej(new Error(file.name+': this image format cannot be read. Use JPEG, PNG or WebP.')); };
    im.src=u; });
  // Photos are shrunk to JPEG (max 1600px) before upload: receipts stay legible, uploads stay fast.
  async function prepFile(file){
    if(file.type==='application/pdf'){
      if(file.size>ATT_MAX) throw new Error(file.name+': PDF is over 5 MB.');
      return {name:file.name,mime:file.type,b64:await readB64(file),size:file.size};
    }
    if(!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(file.name+': use a photo (JPEG, PNG, WebP) or a PDF.');
    const im=await loadImg(file);
    const k=Math.min(1,IMG_EDGE/Math.max(im.naturalWidth,im.naturalHeight));
    const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(im.naturalWidth*k)); c.height=Math.max(1,Math.round(im.naturalHeight*k));
    const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height); x.drawImage(im,0,0,c.width,c.height);
    const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.82));
    if(!blob||blob.size>ATT_MAX) throw new Error(file.name+': image is too large even after shrinking.');
    return {name:file.name.replace(/\.[^.]+$/,'')+'.jpg',mime:'image/jpeg',b64:await readB64(blob),size:blob.size};
  }
  const attCount=()=>(draft.att||[]).length+(draft.newFiles||[]).length;
  function attField(){
    const have=(draft.att||[]).map((a,i)=>`<span class="attc">📎 ${esc(a.name)}<button data-attx="a${i}" title="Remove">×</button></span>`);
    const fresh=(draft.newFiles||[]).map((a,i)=>`<span class="attc new">📎 ${esc(a.name)}<button data-attx="n${i}" title="Remove">×</button></span>`);
    return `<div class="grp"><div class="gname">Receipt / attachment</div><div class="attl">
        ${have.concat(fresh).join('')}
        ${attCount()<ATT_LIMIT?`<label class="chip attadd">+ Add photo or PDF<input type="file" id="attf" accept="image/*,application/pdf" multiple hidden/></label>`:''}
      </div>${draft.attErr?`<div class="hint" style="color:var(--red)">${esc(draft.attErr)}</div>`:''}</div>`;
  }
  const b64Blob=(b64,mime)=>{ const bin=atob(b64), u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return new Blob([u],{type:mime}); };
  async function openAtt(entryId){
    const e=db.entries.find(x=>x.id===entryId); if(!e||!e.att||!e.att.length) return;
    panel='att'; attView={entryId,items:e.att.map(a=>({a,state:fileCache.has(a.fileId)?'ok':'load',msg:''}))}; render();
    for(const it of attView.items){
      if(it.state==='ok') continue;
      const r=await RPC('file',{fileId:it.a.fileId});
      if(!attView) return;                                   // closed meanwhile
      if(r.ok){ fileCache.set(it.a.fileId,{url:URL.createObjectURL(b64Blob(r.data.b64,r.data.mime)),name:r.data.name,mime:r.data.mime}); it.state='ok'; }
      else{ it.state='err'; it.msg=r.msg||'Could not load.'; }
      if(panel==='att') render();
    }
  }
  function attSheet(){
    if(panel!=='att'||!attView) return '';
    return `<div class="ovl" id="ovlp"><div class="card">
      <div class="ph"><span>Attachments</span><button class="xx" id="p_x">✕</button></div>
      <div class="attv">${attView.items.map(it=>{
        const f=fileCache.get(it.a.fileId);
        if(it.state==='load') return `<div class="hint">Loading ${esc(it.a.name)}…</div>`;
        if(it.state==='err')  return `<div class="hint" style="color:var(--red)">${esc(it.a.name)}: ${esc(it.msg)}</div>`;
        return f.mime==='application/pdf'
          ? `<div class="attpdf"><a href="${f.url}" download="${esc(it.a.name)}" target="_blank" rel="noopener">⬇ ${esc(it.a.name)} (PDF)</a></div>`
          : `<div class="attimg"><img src="${f.url}" alt="${esc(it.a.name)}"/><a href="${f.url}" download="${esc(it.a.name)}">⬇ ${esc(it.a.name)}</a></div>`;
      }).join('')}</div></div></div>`;
  }

  // ---------- sign-in, account and admin screens ----------
  function renderLogin(msg){
    const root=document.getElementById('root');
    root.setAttribute('data-theme',theme);
    root.innerHTML=`<div class="sheet"><div class="hdr"><h1>Ledger</h1></div>
      <div class="cfg"><h4>Sign in</h4>
        <p>Use the username and password your administrator gave you.</p>
        <div class="fl"><div class="lbl">Username</div>
          <input id="l_u" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"/></div>
        <div class="fl"><div class="lbl">Password</div>
          <input id="l_p" type="password" autocomplete="current-password"/></div>
        <div class="err" id="l_err">${esc(msg||'')}</div>
        <div class="btns"><button id="l_go">Sign in</button></div></div></div>`;
    const go=async()=>{
      const u=document.getElementById('l_u').value, p=document.getElementById('l_p').value;
      const err=document.getElementById('l_err'), btn=document.getElementById('l_go');
      if(!u||!p){ err.textContent='Enter your username and password.'; return; }
      btn.disabled=true; err.textContent='';
      const r=await RPC('login',{username:u,password:p});
      if(!r.ok){ btn.disabled=false; err.textContent=r.msg||'Could not sign in.'; return; }
      token=r.data.token; lsSet(TOKENKEY,token);
      await enter(err);
    };
    document.getElementById('l_go').onclick=go;
    document.getElementById('l_p').onkeydown=e=>{ if(e.key==='Enter') go(); };
  }
  async function enter(errEl){
    try{ await load(); }
    catch(r){
      if(r&&r.code==='AUTH') return;
      const m=(r&&r.msg)||'Could not load your ledger.';
      if(errEl) errEl.textContent=m; else renderLogin(m);
      if(!errEl) token=null;
      return;
    }
    sel=today(); tab='home'; mode=null; draft={}; editId=null; panel=null;
    if(db.setup.floor>0) await save();
    render();
  }

  function panelSheet(){
    if(panel==='att') return attSheet();
    if(panel==='acct'){
      return `<div class="ovl" id="ovlp"><div class="card">
        <div class="ph"><span>Account</span><button class="xx" id="p_x">✕</button></div>
        <p class="bkp">Signed in as <b>${esc(me.name)}</b> (${esc(me.username)}). Changing your password signs you out on every other device.</p>
        <div class="pform">
          <input id="a_cur" type="password" placeholder="Current password" autocomplete="current-password"/>
          <input id="a_new" type="password" placeholder="New password (8+ characters)" autocomplete="new-password"/>
          <input id="a_new2" type="password" placeholder="Repeat new password" autocomplete="new-password"/>
        </div>
        <div class="bkrow"><button class="save good" id="a_go">Change password</button></div>
        <div class="hint" id="a_msg">${esc(panelErr)}</div></div></div>`;
    }
    if(panel==='users'){
      const rows=(usersList||[]).map(u=>`<div class="urow${u.active?'':' off'}">
          <div class="un"><b>${esc(u.name)}</b><small>${esc(u.username)}${u.role==='admin'?' · admin':''}${u.active?'':' · disabled'}</small></div>
          <div class="ub"><button data-ures="${esc(u.id)}">Reset password</button>
            ${u.id===me.id?'':`<button data-uact="${esc(u.id)}" data-on="${u.active?'0':'1'}">${u.active?'Disable':'Enable'}</button>`}</div></div>`).join('');
      return `<div class="ovl" id="ovlp"><div class="card">
        <div class="ph"><span>Users</span><button class="xx" id="p_x">✕</button></div>
        ${newCred?`<div class="cred"><div class="lbl">${esc(newCred.label)}</div>
          <div class="credv">${esc(newCred.username)} &nbsp;/&nbsp; ${esc(newCred.password)}</div>
          <div class="hint">Shown once. Copy it now and send it to the user privately.</div></div>`:''}
        ${usersList?rows:'<div class="hint" style="padding:0 16px">Loading…</div>'}
        <div class="pform">
          <div class="lbl">Add a user</div>
          <input id="u_name" placeholder="Display name"/>
          <input id="u_user" placeholder="username (letters, digits . _ -)" autocapitalize="none" autocorrect="off" spellcheck="false"/>
        </div>
        <div class="bkrow"><button class="save good" id="u_add">Create user</button></div>
        <div class="hint" id="u_msg">${esc(panelErr)}</div></div></div>`;
    }
    return '';
  }
  async function openUsers(){
    panel='users'; panelErr=''; newCred=null; usersList=null; render();
    const r=await RPC('listUsers');
    if(panel!=='users') return;
    if(r.ok) usersList=r.data; else panelErr=r.msg||'Could not load users.';
    render();
  }

'''
s=s[:a]+new_block+s[b:]

# ---- 2. variables that used to hold the storage key etc. ----
rep("  const KEY='birrledger:v5', S=100, DAY=86400000, TBILL=12.4;","  const S=100, DAY=86400000, TBILL=12.4;")

# ---- 3. render(): header, banners, tools, overlays ----
rep("""            <div class="lbl">${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>""",
    """            <div class="lbl">${esc(me.name)} · ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>""")
rep("""          Aim to back up <b style="color:var(--ink);display:inline">every 3 days</b> — this ledger lives in
          <em>this browser only</em>. <button class="act" id="baknow" style="margin-top:9px">Back up now</button></div>`:''}""",
    """          Your ledger is stored on the server, but keep your own copy too — a backup file is
          your protection against a mistaken restore or erase.
          <button class="act" id="baknow" style="margin-top:9px">Back up now</button></div>`:''}""")
rep("""        ${saveOk?'':`<div class="alarm"><b>Not saving</b>
          This browser is refusing to store data — anything you log now will vanish on refresh.
          Hit <b style="color:var(--chalk);display:inline">Backup (JSON)</b> before you go, and try a normal
          (non-private) browser window.</div>`}""",
    """        ${saveOk?'':`<div class="alarm"><b>Not saved</b>
          The server could not be reached, so your latest changes exist only on this screen. They are kept and
          re-sent with your next save — don't close this page yet.
          <button class="act" id="retry" style="margin-top:9px">Retry now</button></div>`}""")
rep("""          <button id="reset" class="danger">Erase all</button>""",
    """          <button id="acct">Account</button>${me.role==='admin'?'<button id="usr">Users</button>':''}
          <button id="out">Log out</button>
          <button id="reset" class="danger">Erase all</button>""")
rep("      ${backupSheet()}${restoreSheet()}`;\n    wire();","      ${backupSheet()}${restoreSheet()}${panelSheet()}`;\n    wire();")

# ---- 4. theme persistence ----
rep("      await writeRaw(THEMEKEY, theme);","      lsSet(THEMEKEY, theme);")

# ---- 5. rows: attachment button ----
rep("""    const ctl=`<button class="edt${isEd?' on':''}" data-edit="${e.id}" title="Edit">✎</button>""",
    """    const na=(e.att||[]).length;
    const ctl=(na?`<button class="attb" data-att="${e.id}" title="Attachments">📎${na>1?na:''}</button>`:'')+
      `<button class="edt${isEd?' on':''}" data-edit="${e.id}" title="Edit">✎</button>""")

# ---- 6. forms: attachment field before every Record button ----
rep("""        <button class="save" id="rec" ${ready?'':'disabled'}>${editId?'Save changes':'Record transfer'}</button>""",
    """        ${attField()}
        <button class="save" id="rec" ${ready?'':'disabled'}>${editId?'Save changes':'Record transfer'}</button>""")
rep("""        <button class="save ppl" id="rec" ${ready?'':'disabled'}>${editId?'Save changes':'Record it'}</button>""",
    """        ${attField()}
        <button class="save ppl" id="rec" ${ready?'':'disabled'}>${editId?'Save changes':'Record it'}</button>""")
rep("""        <button class="save ppl" id="rec" ${ready?'':'disabled'}>Record it</button>""",
    """        ${attField()}
        <button class="save ppl" id="rec" ${ready?'':'disabled'}>Record it</button>""")
rep("""      <button class="save ${isIn?'inflow':'danger'}" id="rec" ${ready?'':'disabled'}>""",
    """      ${attField()}
      <button class="save ${isIn?'inflow':'danger'}" id="rec" ${ready?'':'disabled'}>""")

# ---- 7. wire(): attachments inside the form block, panels/tools outside ----
rep("""      if($('rec')) $('rec').onclick=record;
    }
""","""      if($('rec')) $('rec').onclick=record;
      if(draft.busy&&$('rec')){ $('rec').disabled=true; $('rec').textContent='Uploading…'; }
      if($('attf')) $('attf').onchange=async e=>{
        const files=Array.from(e.target.files||[]); draft.attErr='';
        for(const f of files){
          if(attCount()>=ATT_LIMIT){ draft.attErr='Up to '+ATT_LIMIT+' files per entry.'; break; }
          try{ (draft.newFiles=draft.newFiles||[]).push(await prepFile(f)); }
          catch(err){ draft.attErr=err.message||'Could not use that file.'; }
        }
        animate=false; render();
      };
      document.querySelectorAll('[data-attx]').forEach(x=>{x.onclick=()=>{
        const w=x.dataset.attx, i=+w.slice(1);
        if(w[0]==='a') draft.att.splice(i,1); else draft.newFiles.splice(i,1);
        animate=false; render();};});
    }
    document.querySelectorAll('[data-att]').forEach(x=>{x.onclick=()=>openAtt(x.dataset.att);});
    if($('retry')) $('retry').onclick=async()=>{ await save(); render(); };
    if($('out'))  $('out').onclick=()=>{ if(confirm('Log out of this device?')) signOut(''); };
    if($('acct')) $('acct').onclick=()=>{ panel='acct'; panelErr=''; render(); };
    if($('usr'))  $('usr').onclick=openUsers;
    const closePanel=()=>{ panel=null; attView=null; newCred=null; render(); };
    if($('p_x')) $('p_x').onclick=closePanel;
    if($('ovlp')) $('ovlp').onclick=e=>{ if(e.target.id==='ovlp') closePanel(); };
    if($('a_go')) $('a_go').onclick=async()=>{
      const cur=$('a_cur').value, n1=$('a_new').value, n2=$('a_new2').value, m=$('a_msg');
      m.style.color='var(--red)';
      if(n1!==n2){ m.textContent='The new passwords do not match.'; return; }
      if(n1.length<8){ m.textContent='New password must be at least 8 characters.'; return; }
      $('a_go').disabled=true;
      const r=await RPC('changePassword',{current:cur,next:n1});
      $('a_go').disabled=false;
      if(!r.ok){ m.textContent=r.msg||'Could not change the password.'; return; }
      token=r.data.token; lsSet(TOKENKEY,token);
      m.style.color='var(--green)'; m.textContent='✓ Password changed.';
      $('a_cur').value=$('a_new').value=$('a_new2').value='';
    };
    if($('u_add')) $('u_add').onclick=async()=>{
      const name=$('u_name').value.trim(), user=$('u_user').value.trim(), m=$('u_msg');
      m.style.color='var(--red)';
      if(!user){ m.textContent='Enter a username.'; return; }
      $('u_add').disabled=true;
      const r=await RPC('createUser',{name,username:user});
      $('u_add').disabled=false;
      if(!r.ok){ m.textContent=r.msg||'Could not create the user.'; return; }
      newCred={label:'New user created',username:r.data.user.username,password:r.data.password};
      panelErr=''; const l=await RPC('listUsers'); if(l.ok) usersList=l.data; render();
    };
    document.querySelectorAll('[data-ures]').forEach(x=>{x.onclick=async()=>{
      const u=usersList.find(v=>v.id===x.dataset.ures);
      if(!confirm('Reset the password for '+u.username+'? They will be signed out everywhere.')) return;
      const r=await RPC('resetPassword',{userId:u.id});
      if(!r.ok){ panelErr=r.msg||'Could not reset.'; render(); return; }
      newCred={label:'Password reset',username:u.username,password:r.data.password}; panelErr=''; render();};});
    document.querySelectorAll('[data-uact]').forEach(x=>{x.onclick=async()=>{
      const u=usersList.find(v=>v.id===x.dataset.uact), on=x.dataset.on==='1';
      if(!on&&!confirm('Disable '+u.username+'? They will be signed out. Their data is kept.')) return;
      const r=await RPC('setActive',{userId:u.id,active:on});
      if(!r.ok){ panelErr=r.msg||'Could not update.'; render(); return; }
      const l=await RPC('listUsers'); if(l.ok) usersList=l.data; panelErr=''; render();};});
""")

# ---- 8. edit: carry existing attachments into the draft ----
rep("""      draft={amt:String(e.amt/S)};
      if(e.fee>0) draft.fee=String(e.fee/S);""","""      draft={amt:String(e.amt/S), att:(e.att||[]).slice(), newFiles:[]};
      if(e.fee>0) draft.fee=String(e.fee/S);""")

# ---- 9. restore: normalise like a normal load ----
rep("""        db=j;
        if(!Array.isArray(db.zero)) db.zero=[];
        if(!Array.isArray(db.people)) db.people=[];
        if(!db.setup) db.setup={floor:0,bufferMonths:3,opening:{}};
        if(db.setup.floor>0 && !db.setup.envStart) db.setup.envStart=today();
        if(typeof db.lastBackup!=='number') db.lastBackup=0;
        sel=today();""","""        normalize(j);
        sel=today();""")

# ---- 10. record(): upload staged files first ----
rep("""  async function record(){
    const a=toS(draft.amt);
    if(!(a>0)) return;
    const st=state();""","""  async function record(){
    const a=toS(draft.amt);
    if(!(a>0)||draft.busy) return;
    // Upload staged files first: if one fails nothing else has changed, and files already uploaded stay
    // attached to the draft so a retry does not upload them twice.
    if(draft.newFiles&&draft.newFiles.length){
      draft.busy=true; draft.attErr=''; animate=false; render();
      draft.att=draft.att||[];
      while(draft.newFiles.length){
        const f=draft.newFiles[0];
        const r=await RPC('upload',{name:f.name,mime:f.mime,b64:f.b64});
        if(!r.ok){ draft.busy=false; draft.attErr=(r.code==='AUTH')?'':(f.name+': '+(r.msg||'upload failed')); if(db) render(); return; }
        draft.att.push({fileId:r.data.fileId,name:r.data.name,mime:r.data.mime,size:r.data.size});
        draft.newFiles.shift();
      }
      draft.busy=false;
    }
    const st=state();""")
rep("""    if(editId){
      const i=db.entries.findIndex(e=>e.id===editId);""","""    if(draft.att&&draft.att.length) fields.att=draft.att.slice();
    if(editId){
      const i=db.entries.findIndex(e=>e.id===editId);""")

# ---- 11. boot ----
a=s.index("  load().then(async()=>{")
b=s.index("})();\n</script>")
s=s[:a]+"""  (async function boot(){
    const th=lsGet(THEMEKEY); if(th==='vellum'||th==='viewport') theme=th;
    token=lsGet(TOKENKEY);
    if(!token){ renderLogin(''); return; }
    document.getElementById('root').innerHTML='<div class="sheet"><p style="color:var(--graphite);font-family:var(--mono)">Loading…</p></div>';
    await enter(null);
  })();
"""+s[b:]

# ---- 12. CSS ----
css = """
/* ---- server edition: attachments, account, users ---- */
.attl{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.attadd{cursor:pointer;color:var(--blue);border-style:dashed}
.attc{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;padding:6px 8px 6px 10px;
  border:1px solid var(--edge2);color:var(--chalk);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attc.new{border-color:var(--blue)}
.attc button{border:0;background:transparent;color:var(--faint);cursor:pointer;font-size:14px;padding:0 2px;line-height:1}
.attc button:hover{color:var(--red)}
.row .attb{border:0;background:transparent;color:var(--graphite);cursor:pointer;font-size:12px;padding:0 6px;font-family:var(--mono)}
.row .attb:hover{color:var(--blue)}
.attv{padding:8px 16px 16px}
.attimg img{display:block;max-width:100%;height:auto;border:1px solid var(--edge);margin-top:8px}
.attimg a,.attpdf a{display:inline-block;margin:8px 0 14px;font-family:var(--mono);font-size:10.5px;color:var(--blue);word-break:break-all}
.pform{padding:6px 16px 0}
.pform input{width:100%;margin:6px 0;border:0;border-bottom:1.5px solid var(--edge2);background:transparent;color:var(--chalk);
  font-family:var(--mono);font-size:16px;padding:8px 0;outline:0;border-radius:0}
.pform input:focus{border-bottom-color:var(--blue)}
.urow{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--edge)}
.urow.off{opacity:.55}
.urow .un b{font-size:13px;font-weight:600} .urow .un small{display:block;font-family:var(--mono);font-size:9.5px;color:var(--faint);margin-top:2px}
.urow .ub{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.urow .ub button{border:1px solid var(--edge2);background:transparent;color:var(--graphite);font-family:var(--mono);font-size:9.5px;padding:6px 8px;cursor:pointer}
.urow .ub button:hover{border-color:var(--blue);color:var(--blue)}
.cred{margin:10px 16px;padding:12px 14px;border:1px solid var(--green);background:color-mix(in srgb,var(--green) 8%,transparent)}
.credv{font-family:var(--mono);font-size:15px;font-weight:700;margin:6px 0;user-select:all;word-break:break-all}
"""
rep("</style>", css+"</style>")
open(p,'w').write(s)
print('patched', len(s))
