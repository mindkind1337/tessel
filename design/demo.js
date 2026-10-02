(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const key = 'tessel-design-demo-v1';
  const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const line = (text, kind = '') => ({ text, kind });
  const makePane = (name, status = 'ready') => ({ id:uid(), name, status, included:true, draft:'', lines:[line(name === 'PowerShell' ? 'PowerShell  /  session locale' : name + '  /  nouvelle conversation', 'note')] });
  function initial() {
    const codex = makePane('Codex', 'busy');
    codex.lines.push(line('› Harmoniser les composants', 'command'), line('Analyse des en-têtes de panneaux et des états de sélection…'));
    const claude = makePane('Claude', 'waiting');
    claude.lines.push(line('La revue des espacements est terminée.', 'success'), line('Souhaites-tu conserver le mode compact par défaut ?'));
    const shell = makePane('PowerShell');
    const web = makePane('PowerShell');
    return { version:1, current:'tessel', theme:'dark', tasksOpen:true, workspaces:[{ id:'tessel', name:'Tessel', layout:'grid', broadcast:false, active:codex.id, panes:[codex,claude,shell], tasks:[{id:uid(),title:'Harmoniser les composants',status:'doing',agent:codex.id},{id:uid(),title:'Vérifier la navigation clavier',status:'todo',agent:''},{id:uid(),title:'Revue des espacements',status:'done',agent:claude.id}] },{id:'web',name:'Site web',layout:'grid',broadcast:false,active:web.id,panes:[web],tasks:[]}] };
  }
  let state = initial();
  let canSave = true;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.version === 1 && Array.isArray(saved.workspaces) && saved.workspaces.length && saved.workspaces.some(w => w.id === saved.current) && saved.workspaces.every(w => Array.isArray(w.panes) && Array.isArray(w.tasks))) state = saved;
  } catch { canSave = false; }
  const ws = () => state.workspaces.find(w => w.id === state.current);
  const labels = {busy:'● En cours',waiting:'! Attend une réponse',ready:'○ Prêt'};
  let toastTimer;
  function notify(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(() => $('toast').hidden=true, 3500); }
  function save() {
    try { localStorage.setItem(key, JSON.stringify(state)); canSave=true; } catch { canSave=false; }
    $('save-status').textContent=canSave?'Sauvegardé dans ce navigateur':'Session temporaire · stockage indisponible';
  }
  function el(tag, className, text) { const n=document.createElement(tag); if(className)n.className=className; if(text!==undefined)n.textContent=text; return n; }
  function button(text, className, handler, label) { const n=el('button',className,text); n.type='button'; if(label)n.setAttribute('aria-label',label); n.addEventListener('click',handler); return n; }
  function renderChrome() {
    const w=ws();
    document.documentElement.dataset.theme=state.theme;
    $('theme').textContent=state.theme==='dark'?'Thème clair':'Thème sombre';
    $('theme').setAttribute('aria-label','Passer au '+$('theme').textContent.toLowerCase());
    $('project-name').textContent=w.name;
    $('project-path').textContent='main';
    $('layout').value=w.layout;
    $('summary').textContent=`${w.panes.length} panneaux · ${w.panes.filter(p=>p.status==='busy').length} en cours · ${w.panes.filter(p=>p.status==='waiting').length} en attente`;
    $('broadcast').textContent=w.broadcast?'Diffusion active':'Diffusion';
    $('broadcast').setAttribute('aria-pressed',String(w.broadcast));
    $('broadcast-note').hidden=!w.broadcast;
    const targets=w.panes.filter(p=>p.included);
    $('broadcast-note').textContent=targets.length?`Diffusion active → ${targets.map(p=>p.name).join(', ')} · ${targets.length} destinataire(s)`:'Aucun destinataire : cochez au moins un panneau pour diffuser.';
    $('tasks').hidden=!state.tasksOpen;
    $('toggle-tasks').setAttribute('aria-expanded',String(state.tasksOpen));
    $('work-area').classList.toggle('no-tasks',!state.tasksOpen);
    const active=w.panes.find(p=>p.id===w.active);
    $('target').textContent=w.broadcast?`Saisie → ${targets.length} panneau(x)`:'Saisie → '+(active?.name || 'aucun panneau');
    $('workspaces').replaceChildren(...state.workspaces.map(workspace=>{
      const n=button(workspace.name,'workspace',()=>{state.current=workspace.id;render();});
      n.setAttribute('aria-current',String(workspace.id===w.id));
      n.prepend(el('span','workspace-icon','▱'));
      n.append(el('small','workspace-count',String(workspace.panes.length)));
      const waiting=workspace.panes.filter(p=>p.status==='waiting').length;
      if(waiting){const dot=el('span','attention','●');dot.title=`${waiting} agent(s) en attente`;n.append(dot);}
      return n;
    }));
    $('session-count').textContent=w.panes.length;
    $('sessions').replaceChildren(...w.panes.map((p,index)=>{
      const n=button('','session',()=>{activate(p.id);const pane=Array.from($('panes').children).find(x=>x.dataset.id===p.id);pane?.querySelector('.command-input')?.focus();});
      n.setAttribute('aria-current',String(p.id===w.active));
      const icon=el('span','agent-mark '+p.name.toLowerCase(),p.name==='PowerShell'?'›_':p.name==='Claude'?'✳':p.name==='Gemini'?'✧':'◇');
      const text=el('span','session-text');text.append(el('span','',p.name),el('small','',p.status==='waiting'?'Attend une réponse':p.status==='busy'?'Travail en cours':'Prêt'));
      n.append(icon,text,el('span','session-index',String(index+1)));return n;
    }));
  }
  function activate(id) { ws().active=id; for(const p of $('panes').children)p.classList.toggle('active',p.dataset.id===id); renderChrome(); save(); }
  function renderPanes() {
    const w=ws();
    $('panes').className='panes '+w.layout;
    $('panes').replaceChildren();
    if(!w.panes.length) { const empty=el('div','empty'); empty.append(el('h2','','Votre espace est prêt.'),el('p','','Ouvrez un terminal ou un agent pour commencer.'),button('+ Nouveau panneau','primary',openLauncher)); $('panes').append(empty); return; }
    w.panes.forEach((p,index)=>{
      const pane=el('section','pane'+(p.id===w.active?' active':'')); pane.dataset.id=p.id; pane.setAttribute('aria-label',p.name+' · panneau '+(index+1));
      pane.addEventListener('pointerdown',()=>activate(p.id));
      pane.addEventListener('focusin',()=>{if(w.active!==p.id)activate(p.id);});
      const head=el('header','pane-head');
      const name=button('','pane-name',()=>{activate(p.id);pane.querySelector('.command-input').focus();},'Activer '+p.name);
      name.append(el('span','pane-number',String(index+1).padStart(2,'0')),document.createTextNode(p.name));
      name.prepend(el('span','agent-mark '+p.name.toLowerCase(),p.name==='PowerShell'?'›_':p.name==='Claude'?'✳':p.name==='Gemini'?'✧':'◇'));
      head.append(name,el('span','status '+p.status,labels[p.status] || labels.ready),button('×','icon-button',()=>{w.panes=w.panes.filter(x=>x.id!==p.id);w.tasks.forEach(t=>{if(t.agent===p.id)t.agent='';});if(w.active===p.id)w.active=w.panes[0]?.id || '';render();notify('Panneau fermé dans la démo.');},'Fermer '+p.name));
      const output=el('div','terminal');
      for(const entry of p.lines)output.append(el('p','line '+entry.kind,entry.text));
      const form=el('form','command-form');
      const input=el('input','command-input'); input.value=p.draft || ''; input.placeholder=p.name==='PowerShell'?'help, dir, git status…':'Écrire à '+p.name+'…'; input.setAttribute('aria-label','Commande pour '+p.name); input.autocomplete='off'; input.maxLength=2000;
      input.addEventListener('input',()=>{p.draft=input.value;save();});
      const send=el('button','','↑'); send.type='submit';send.setAttribute('aria-label','Envoyer à '+p.name);
      form.append(el('span','','›'),input,send);
      form.addEventListener('submit',e=>{e.preventDefault();const command=input.value.trim();if(!command)return;const targets=w.broadcast?w.panes.filter(x=>x.included):[p];if(!targets.length){notify('Sélectionne au moins un destinataire.');return;}p.draft='';for(const target of targets)runCommand(target,command,w);render();const focusPane=Array.from($('panes').children).find(n=>n.dataset.id===p.id);focusPane?.querySelector('.command-input')?.focus();});
      const foot=el('div','pane-foot');
      if(w.broadcast){const label=el('label');const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=p.included;checkbox.addEventListener('change',()=>{p.included=checkbox.checked;renderChrome();save();});label.append(checkbox,document.createTextNode('Inclure dans la diffusion'));foot.append(label);}
      else foot.append(el('span','','main · session simulée'));
      if(p.name!=='PowerShell')foot.append(button('Changer l’état','subtle',()=>{p.status=p.status==='busy'?'waiting':p.status==='waiting'?'ready':'busy';render();},'Changer l’état de '+p.name));
      const composer=el('div','composer');composer.append(el('div','composer-context','▱  '+w.name+'   /   main'),form);
      pane.append(head,output,composer,foot);$('panes').append(pane);output.scrollTop=output.scrollHeight;
    });
  }
  function runCommand(p, command, workspace) {
    const c=command.toLowerCase();
    p.lines.push(line('› '+command,'command'));
    if(c==='clear'||c==='cls')p.lines=[];
    else if(c==='help')p.lines.push(line('Commandes disponibles :\nhelp — aide\ndir ou ls — fichiers fictifs\ngit status — état fictif du projet\nnpm test — résultat de test fictif\nclear — effacer ce panneau\n\nDans un agent : écrivez une demande pour simuler une réponse.','note'));
    else if(c==='dir'||c==='ls')p.lines.push(line('src/\nbuild/\npackage.json\nREADME.md'));
    else if(c==='git status')p.lines.push(line('On branch main\nNothing to commit, working tree clean\n(résultat simulé)','success'));
    else if(c==='npm test')p.lines.push(line('Démonstration : 12 tests réussis sur 12.\nAucun test du projet réel n’a été exécuté.','success'));
    else if(p.name==='PowerShell')p.lines.push(line('Commande non exécutée. Cette démo accepte help, dir, git status et npm test.','note'));
    else { p.status='ready';p.lines.push(line('Réponse simulée : demande reçue. Dans Tessel, cet échange serait envoyé à '+p.name+'.','success')); }
    p.lines=p.lines.slice(-80);
    workspace.active=workspace.active || p.id;
  }
  function renderTasks() {
    const w=ws();
    $('task-count').textContent=w.tasks.length;
    $('task-list').replaceChildren();
    for(const [status,title] of [['doing','EN COURS'],['todo','À FAIRE'],['done','TERMINÉ']]) {
      const section=el('section');const tasks=w.tasks.filter(t=>t.status===status);section.append(el('h3','task-group-title',`${title} · ${tasks.length}`));
      if(!tasks.length)section.append(el('p','empty-tasks','Aucune tâche'));
      for(const task of tasks){
        const card=el('div','task-card');const heading=el('div','task-title');heading.append(el('span','',task.title),button('×','icon-button',()=>{w.tasks=w.tasks.filter(t=>t.id!==task.id);renderTasks();save();},'Supprimer '+task.title));
        const controls=el('div','task-controls');const progress=el('select');progress.setAttribute('aria-label','État : '+task.title);
        for(const [value,label] of [['todo','À faire'],['doing','En cours'],['done','Terminé']]){const option=el('option','',label);option.value=value;progress.append(option);}progress.value=task.status;progress.addEventListener('change',()=>{task.status=progress.value;renderTasks();save();});
        const assignee=el('select');assignee.setAttribute('aria-label','Responsable : '+task.title);const none=el('option','','Non assignée');none.value='';assignee.append(none);
        for(const [index,p] of w.panes.entries()){const option=el('option','',`${index+1} · ${p.name}`);option.value=p.id;assignee.append(option);}assignee.value=task.agent;assignee.addEventListener('change',()=>{task.agent=assignee.value;save();});
        controls.append(progress,assignee);card.append(heading,controls);section.append(card);
      }
      $('task-list').append(section);
    }
  }
  function render() { renderChrome();renderPanes();renderTasks();save(); }
  const modal=$('modal');
  let modalAction=null;
  function showModal(title,content,actionLabel,action) {
    $('modal-title').textContent=title;$('modal-body').replaceChildren(content);$('modal-actions').replaceChildren();modalAction=action;
    if(actionLabel){const submit=el('button','primary',actionLabel);submit.type='submit';$('modal-actions').append(submit);}
    else $('modal-actions').append(button('C’est parti','primary',()=>modal.close()));
    if(!modal.open)modal.showModal();
  }
  function openLauncher() {
    const wrapper=el('div');const label=el('label','','Type de panneau');const select=el('select');select.id='pane-type';for(const name of ['Codex','Claude','Gemini','PowerShell']){const option=el('option','',name);option.value=name;select.append(option);}label.append(select);wrapper.append(label);
    showModal('Ouvrir un panneau',wrapper,'Ouvrir',()=>{const p=makePane(select.value);ws().panes.push(p);ws().active=p.id;modal.close();render();const target=Array.from($('panes').children).find(n=>n.dataset.id===p.id);target?.querySelector('input')?.focus();});
  }
  $('modal-form').addEventListener('submit',e=>{e.preventDefault();if(modalAction)modalAction();});
  $('close-modal').addEventListener('click',()=>modal.close());
  $('new-pane').addEventListener('click',openLauncher);
  $('add-workspace').addEventListener('click',()=>{const label=el('label','','Nom de l’espace');const input=el('input');input.required=true;input.maxLength=50;input.placeholder='Mon projet';label.append(input);showModal('Nouvel espace de travail',label,'Créer',()=>{const name=input.value.trim();if(!name){input.setCustomValidity('Saisis un nom.');input.reportValidity();return;}const id=uid();state.workspaces.push({id,name,layout:'grid',broadcast:false,active:'',panes:[],tasks:[]});state.current=id;modal.close();render();});input.addEventListener('input',()=>input.setCustomValidity(''));input.focus();});
  $('layout').addEventListener('change',()=>{ws().layout=$('layout').value;renderPanes();save();});
  $('broadcast').addEventListener('click',()=>{ws().broadcast=!ws().broadcast;render();});
  $('toggle-tasks').addEventListener('click',()=>{state.tasksOpen=!state.tasksOpen;renderChrome();save();});
  $('theme').addEventListener('click',()=>{state.theme=state.theme==='dark'?'light':'dark';renderChrome();save();});
  $('task-form').addEventListener('submit',e=>{e.preventDefault();const title=$('task-title').value.trim();if(!title)return;ws().tasks.push({id:uid(),title,status:'todo',agent:''});$('task-title').value='';renderTasks();save();notify('Tâche ajoutée.');});
  $('reset').addEventListener('click',()=>{showModal('Réinitialiser la démo',el('p','','Les espaces et tâches créés dans cette démo seront remplacés par les exemples de départ.'),'Réinitialiser',()=>{state=initial();modal.close();render();notify('Démo réinitialisée.');});});
  $('guide').addEventListener('click',()=>{const list=el('ol','guide-list');for(const text of ['Passe du projet Tessel au Site web, ou crée ton propre espace.','Ajoute un agent avec Nouveau panneau et essaie les dispositions.','Tape help ou git status dans un panneau. Les réponses sont simulées.','Active Diffusion et coche les panneaux qui doivent recevoir ton message.','Ajoute une tâche, choisis son responsable et change son état.','Teste les thèmes et masque les tâches pour agrandir les terminaux.'])list.append(el('li','',text));showModal('Essaie le nouveau Tessel',list);});
  document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&!modal.open){if(e.code==='Space'){e.preventDefault();openLauncher();}if(e.code==='KeyK'){e.preventDefault();$('toggle-tasks').click();}if(e.code==='KeyB'){e.preventDefault();$('broadcast').click();}}});
  render();
})();
