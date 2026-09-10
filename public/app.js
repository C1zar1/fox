const $ = (s) => document.querySelector(s);
const state = { user: null, guilds: [], guildId: null, channels: [], categories: [], roles: [], settings: null, buttons: [] };

async function api(url, opts={}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLoggedOut(message='') {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#logout').classList.add('hidden');
  $('#errorBox').textContent = message;
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  $('#userBox').textContent = state.user ? `${state.user.global_name || state.user.username}` : 'Пользователь';
}

async function init() {
  const me = await api('/api/me');
  if (!me.loggedIn) return showLoggedOut(new URLSearchParams(location.search).has('error') ? 'Не удалось выполнить вход через Discord.' : '');
  state.user = me.user;
  state.guilds = await api('/api/guilds');
  if (!state.guilds.length) return showLoggedOut('Нет доступных серверов. Бот должен быть добавлен на сервер, а у аккаунта должны быть права владельца, Administrator или разрешённая роль.');
  showApp();
  $('#guildSelect').innerHTML = state.guilds.map(g => `<option value="${g.id}">${escapeHtml(g.name)} — ${g.level}</option>`).join('');
  state.guildId = state.guilds[0].id;
  $('#guildSelect').value = state.guildId;
  await loadGuild();
  seedButtons();
}

async function loadGuild() {
  state.guildId = $('#guildSelect').value;
  const [channels, categories, roles, settings] = await Promise.all([
    api(`/api/guilds/${state.guildId}/channels`),
    api(`/api/guilds/${state.guildId}/categories`),
    api(`/api/guilds/${state.guildId}/roles`),
    api(`/api/guilds/${state.guildId}/settings`)
  ]);
  state.channels = channels; state.categories = categories; state.roles = roles; state.settings = settings;
  $('#channel').innerHTML = channels.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');
  $('#ticketCategory').innerHTML = `<option value="">Без категории</option>` + categories.map(c => `<option value="${c.id}">📁 ${escapeHtml(c.name)}</option>`).join('');
  $('#ticketCategory').value = settings.ticketCategory || '';
  $('#rolesEditor').innerHTML = roles.map(r => `<button class="role-chip ${settings.staffRoleIds?.includes(r.id) ? 'selected':''}" data-role="${r.id}">${escapeHtml(r.name)}</button>`).join('') || '<div class="muted">На сервере нет обычных ролей.</div>';
  $$('#rolesEditor .role-chip').forEach(el => el.addEventListener('click', () => el.classList.toggle('selected')));
}

function $$(s){ return [...document.querySelectorAll(s)]; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function seedButtons(){ if (!state.buttons.length) state.buttons = [{label:'Поддержка',emoji:'🛠️',style:'Primary'},{label:'Покупка',emoji:'💳',style:'Success'}]; renderButtons(); }

function renderButtons(){
  $('#buttonsEditor').innerHTML = state.buttons.map((b,i)=>`<div class="button-item"><div class="button-top"><div><div class="button-index">Кнопка ${i+1}</div></div><div class="button-actions"><button class="icon-btn" data-up="${i}">↑</button><button class="icon-btn" data-down="${i}">↓</button><button class="icon-btn" data-remove="${i}">Удалить</button></div></div><div class="button-grid"><input data-field="label" data-i="${i}" value="${escapeHtml(b.label)}" placeholder="Название"><input data-field="emoji" data-i="${i}" value="${escapeHtml(b.emoji)}" placeholder="Emoji"><select data-field="style" data-i="${i}"><option ${b.style==='Primary'?'selected':''}>Primary</option><option ${b.style==='Secondary'?'selected':''}>Secondary</option><option ${b.style==='Success'?'selected':''}>Success</option><option ${b.style==='Danger'?'selected':''}>Danger</option></select></div></div>`).join('');
  $$('#buttonsEditor [data-field]').forEach(el => el.addEventListener('input', e => { state.buttons[Number(e.target.dataset.i)][e.target.dataset.field]=e.target.value; renderPreview(); }));
  $$('#buttonsEditor [data-remove]').forEach(el => el.addEventListener('click', () => { state.buttons.splice(Number(el.dataset.remove),1); renderButtons(); renderPreview(); }));
  $$('#buttonsEditor [data-up]').forEach(el => el.addEventListener('click', () => moveButton(Number(el.dataset.up), -1)));
  $$('#buttonsEditor [data-down]').forEach(el => el.addEventListener('click', () => moveButton(Number(el.dataset.down), 1)));
  renderPreview();
}
function moveButton(i,dir){ const j=i+dir; if(j<0||j>=state.buttons.length)return; [state.buttons[i],state.buttons[j]]=[state.buttons[j],state.buttons[i]]; renderButtons(); }
function renderPreview(){ $('#previewTitle').textContent=$('#title').value||'Нужна помощь?'; $('#previewMessage').textContent=$('#message').value||'Выберите нужную категорию тикета ниже.'; $('#previewButtons').innerHTML=state.buttons.map(b=>`<button class="discord-btn ${b.style.toLowerCase()}">${escapeHtml(b.emoji || '🎫')} ${escapeHtml(b.label)}</button>`).join(''); }

async function sendPanel(){
  $('#status').textContent='Отправляем…';
  try { await api(`/api/guilds/${state.guildId}/panels`, { method:'POST', body: JSON.stringify({ channelId:$('#channel').value, title:$('#title').value, message:$('#message').value, color:$('#color').value, buttons:state.buttons })}); $('#status').textContent='Панель отправлена в Discord.'; } catch(e){ $('#status').textContent='Ошибка: '+e.message; }
}
async function saveSettings(){
  $('#settingsStatus').textContent='Сохраняем…';
  try { const ids=$$('#rolesEditor .role-chip.selected').map(x=>x.dataset.role); await api(`/api/guilds/${state.guildId}/settings`,{method:'PUT',body:JSON.stringify({ticketCategory:$('#ticketCategory').value||null,staffRoleIds:ids})}); $('#settingsStatus').textContent='Настройки сохранены.'; } catch(e){ $('#settingsStatus').textContent='Ошибка: '+e.message; }
}
async function loadHistory(){ const data=await api(`/api/guilds/${state.guildId}/panels`); $('#history').innerHTML=data.length?data.map(p=>`<div class="history-item"><div><strong>${escapeHtml(p.title||'Без заголовка')}</strong><div class="muted">${escapeHtml(p.message||'')} · ${p.buttons.length} кнопки</div></div><div class="muted">${new Date(p.createdAt).toLocaleString('ru-RU')}</div></div>`).join(''):'<div class="muted">Панелей пока нет.</div>'; }

$$('.nav').forEach(btn=>btn.addEventListener('click',async()=>{ $$('.nav').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); const view=btn.dataset.view; $$('.view').forEach(x=>x.classList.add('hidden')); $('#pageTitle').textContent=view==='builder'?'Создать панель':view==='settings'?'Права и тикеты':'Отправленные панели'; $(`#${view}View`).classList.remove('hidden'); if(view==='history') await loadHistory(); }));
$('#guildSelect').addEventListener('change', async()=>{ await loadGuild(); });
$('#addButton').addEventListener('click',()=>{if(state.buttons.length>=5)return;state.buttons.push({label:'Новая кнопка',emoji:'🎫',style:'Primary'});renderButtons();});
$('#sendPanel').addEventListener('click',sendPanel);$('#saveSettings').addEventListener('click',saveSettings);$('#title').addEventListener('input',renderPreview);$('#message').addEventListener('input',renderPreview);
$('#logout').addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
init().catch(e=>showLoggedOut('Ошибка загрузки панели: '+e.message));
