const $ = (s) => document.querySelector(s);
const state = { user: null, guilds: [], guildId: null, channels: [], categories: [], roles: [], settings: null, buttons: [], live: null };

async function api(url, opts={}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const base = data.error || `HTTP ${res.status}`;
    const detail = data.detail ? ` — ${data.detail}` : '';
    throw new Error(base + detail);
  }
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

function startLiveUpdates() {
  if (state.live) state.live.close();
  const badge = $('#liveBadge');
  badge.className = 'live-badge online';
  badge.textContent = '● LIVE';
  state.live = new EventSource(`/api/guilds/${state.guildId}/live`);
  state.live.onopen = () => { badge.className='live-badge online'; badge.textContent='● LIVE'; };
  state.live.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'channel' || data.type === 'role') await refreshGuildResources(data.type);
      if (data.type === 'connected') return;
    } catch {}
  };
  state.live.onerror = () => { badge.className='live-badge offline'; badge.textContent='● Переподключение…'; };
}

async function refreshGuildResources(type='all') {
  try {
    if (type === 'all' || type === 'channel') {
      const [channels, categories] = await Promise.all([
        api(`/api/guilds/${state.guildId}/channels`),
        api(`/api/guilds/${state.guildId}/categories`)
      ]);
      const oldChannel = $('#channel').value;
      const oldCategory = $('#ticketCategory').value;
      state.channels = channels; state.categories = categories;
      renderChannelSelect(oldChannel); renderCategorySelect(oldCategory);
      renderButtonEditorKeepingValues();
    }
    if (type === 'all' || type === 'role') {
      const roles = await api(`/api/guilds/${state.guildId}/roles`);
      const selected = new Set($$('#rolesEditor .role-chip.selected').map(x => x.dataset.role));
      state.roles = roles;
      renderRoles(selected);
      renderButtonEditorKeepingValues();
    }
  } catch (e) {
    console.warn('Live resource refresh failed:', e.message);
  }
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
  renderChannelSelect();
  renderCategorySelect(settings.ticketCategory || '');
  renderRoles(new Set(settings.staffRoleIds || []));
  startLiveUpdates();
  renderButtons();
}

function renderChannelSelect(selected='') {
  const value = state.channels.some(c => c.id === selected) ? selected : state.channels[0]?.id || '';
  $('#channel').innerHTML = state.channels.map(c => `<option value="${c.id}" ${c.id===value?'selected':''}># ${escapeHtml(c.name)}</option>`).join('') || '<option value="">Нет доступных текстовых каналов</option>';
}
function renderCategorySelect(selected='') {
  const value = state.categories.some(c => c.id === selected) ? selected : '';
  $('#ticketCategory').innerHTML = `<option value="">Без категории</option>` + state.categories.map(c => `<option value="${c.id}" ${c.id===value?'selected':''}>📁 ${escapeHtml(c.name)}</option>`).join('');
}
function renderRoles(selected) {
  $('#rolesEditor').innerHTML = state.roles.map(r => `<button class="role-chip ${selected.has(r.id) ? 'selected':''}" data-role="${r.id}"><span class="role-dot" style="--role:${r.color}"></span>${escapeHtml(r.name)}</button>`).join('') || '<div class="muted">На сервере нет обычных ролей.</div>';
  $$('#rolesEditor .role-chip').forEach(el => el.addEventListener('click', () => el.classList.toggle('selected')));
}

function $$(s){ return [...document.querySelectorAll(s)]; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function seedButtons(){ if (!state.buttons.length) state.buttons = [{label:'Поддержка',emoji:'🛠️',style:'Primary',actionType:'ticket',ephemeralMessage:'',ticketTitle:'Тикет открыт',ticketMessage:'Опишите вашу проблему. Сотрудник ответит здесь.',ticketMentionRoleId:'',ticketCategoryId:''},{label:'Покупка',emoji:'💳',style:'Success',actionType:'ticket',ephemeralMessage:'',ticketTitle:'Тикет покупки',ticketMessage:'Опишите, что вы хотите приобрести.',ticketMentionRoleId:'',ticketCategoryId:''}]; renderButtons(); }

function renderButtonEditorKeepingValues(){ renderButtons(false); }

function renderButtons(reset=true){
  if (reset && !state.buttons.length) seedButtons();
  $('#buttonsEditor').innerHTML = state.buttons.map((b,i)=>{
    const categories = [`<option value="">Глобальная категория</option>`, ...state.categories.map(c=>`<option value="${c.id}" ${b.ticketCategoryId===c.id?'selected':''}>📁 ${escapeHtml(c.name)}</option>`)].join('');
    const roles = [`<option value="">Никого не отмечать</option>`, ...state.roles.map(r=>`<option value="${r.id}" ${b.ticketMentionRoleId===r.id?'selected':''}>@${escapeHtml(r.name)}</option>`)].join('');
    return `<div class="button-item">
      <div class="button-top"><div><div class="button-index">Кнопка ${i+1}</div></div><div class="button-actions"><button class="icon-btn" data-up="${i}">↑</button><button class="icon-btn" data-down="${i}">↓</button><button class="icon-btn danger-text" data-remove="${i}">Удалить</button></div></div>
      <div class="button-grid"><input data-field="label" data-i="${i}" value="${escapeHtml(b.label)}" placeholder="Название"><input data-field="emoji" data-i="${i}" value="${escapeHtml(b.emoji)}" placeholder="Emoji"><select data-field="style" data-i="${i}"><option ${b.style==='Primary'?'selected':''}>Primary</option><option ${b.style==='Secondary'?'selected':''}>Secondary</option><option ${b.style==='Success'?'selected':''}>Success</option><option ${b.style==='Danger'?'selected':''}>Danger</option></select></div>
      <label>Действие кнопки</label><select class="action-select" data-field="actionType" data-i="${i}"><option value="ticket" ${b.actionType==='ticket'?'selected':''}>🎫 Создать тикет</option><option value="ephemeral" ${b.actionType==='ephemeral'?'selected':''}>👤 Сообщение только пользователю</option></select>
      ${b.actionType==='ephemeral' ? `<label>Личное сообщение</label><textarea data-field="ephemeralMessage" data-i="${i}" rows="3" maxlength="2000" placeholder="Сообщение, которое увидит только нажавший кнопку.">${escapeHtml(b.ephemeralMessage||'Готово!')}</textarea>` : `<div class="button-advanced"><div><label>Заголовок тикета</label><input data-field="ticketTitle" data-i="${i}" value="${escapeHtml(b.ticketTitle||'Тикет открыт')}" maxlength="256"></div><div><label>Категория</label><select data-field="ticketCategoryId" data-i="${i}">${categories}</select></div><div><label>Сообщение в тикете</label><textarea data-field="ticketMessage" data-i="${i}" rows="3" maxlength="4000">${escapeHtml(b.ticketMessage||'')}</textarea></div><div><label>Отметить роль</label><select data-field="ticketMentionRoleId" data-i="${i}">${roles}</select></div></div>`}
    </div>`;
  }).join('');

  $$('#buttonsEditor [data-field]').forEach(el => {
    const event = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(event, e => {
      state.buttons[Number(e.target.dataset.i)][e.target.dataset.field] = e.target.value;
      if (e.target.dataset.field === 'actionType') renderButtons(false); else renderPreview();
    });
  });
  $$('#buttonsEditor [data-remove]').forEach(el => el.addEventListener('click', () => { state.buttons.splice(Number(el.dataset.remove),1); renderButtons(false); renderPreview(); }));
  $$('#buttonsEditor [data-up]').forEach(el => el.addEventListener('click', () => moveButton(Number(el.dataset.up), -1)));
  $$('#buttonsEditor [data-down]').forEach(el => el.addEventListener('click', () => moveButton(Number(el.dataset.down), 1)));
  renderPreview();
}
function moveButton(i,dir){ const j=i+dir; if(j<0||j>=state.buttons.length)return; [state.buttons[i],state.buttons[j]]=[state.buttons[j],state.buttons[i]]; renderButtons(false); }
function renderPreview(){
  const title = $('#title').value.trim() || 'Нужна помощь?';
  const message = $('#message').value.trim() || 'Выберите нужную категорию тикета ниже.';
  $('#previewTitle').textContent = title;
  $('#previewMessage').textContent = message;
  $('#previewButtons').innerHTML = state.buttons.map(b=>`<button type="button" class="discord-btn ${escapeHtml((b.style||'Primary').toLowerCase())}">${escapeHtml(b.emoji || '🎫')} ${escapeHtml(b.label)}</button>`).join('');
}

async function sendPanel(){
  $('#status').textContent='Публикуем…';
  try {
    const title = $('#title').value.trim() || 'Нужна помощь?';
    const message = $('#message').value.trim() || 'Выберите нужную категорию тикета ниже.';
    await api(`/api/guilds/${state.guildId}/panels`, { method:'POST', body: JSON.stringify({ channelId:$('#channel').value, title, message, color:$('#color').value, buttons:state.buttons, replaceExisting:$('#replaceExisting').checked })});
    $('#status').textContent='Готово: старая панель удалена, новая появилась в Discord.';
    loadHistory().catch(()=>{});
  } catch(e){
    const msg = e.message || 'Неизвестная ошибка';
    const pretty = msg.includes('MISSING_ACCESS') ? 'У бота нет доступа к серверу или каналу.' :
      msg.includes('Missing Permissions') ? 'У бота нет прав на отправку сообщений в выбранный канал.' :
      msg.includes('Invalid Form Body') ? 'Discord отклонил сообщение. Проверь текст, кнопки и их настройки.' :
      msg.includes('INVALID_CHANNEL') ? 'Выбранный канал недоступен для публикации.' :
      msg.includes('BUTTONS_REQUIRED') ? 'Добавь хотя бы одну кнопку.' : msg;
    $('#status').textContent='Ошибка: '+pretty;
  }
}
async function saveSettings(){
  $('#settingsStatus').textContent='Сохраняем…';
  try {
    const ids=$$('#rolesEditor .role-chip.selected').map(x=>x.dataset.role);
    state.settings = await api(`/api/guilds/${state.guildId}/settings`,{method:'PUT',body:JSON.stringify({ticketCategory:$('#ticketCategory').value||null,staffRoleIds:ids})});
    $('#settingsStatus').textContent='Права сохранены.';
  } catch(e){ $('#settingsStatus').textContent='Ошибка: '+e.message; }
}
async function loadHistory(){ const data=await api(`/api/guilds/${state.guildId}/panels`); $('#history').innerHTML=data.length?data.map(p=>`<div class="history-item"><div><div class="history-title"><strong>${escapeHtml(p.title||'Без заголовка')}</strong>${p.active?'<span class="pill">активна</span>':'<span class="pill muted-pill">архив</span>'}</div><div class="muted">${escapeHtml(p.message||'')} · ${p.buttons.length} кнопок · #${escapeHtml(findChannelName(p.channelId))}</div></div><div class="muted">${new Date(p.createdAt).toLocaleString('ru-RU')}</div></div>`).join(''):'<div class="muted">Панелей пока нет.</div>'; }
function findChannelName(id){ return state.channels.find(c=>c.id===id)?.name || id; }

$$('.nav').forEach(btn=>btn.addEventListener('click',async()=>{ $$('.nav').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); const view=btn.dataset.view; $$('.view').forEach(x=>x.classList.add('hidden')); $('#pageTitle').textContent=view==='builder'?'Конструктор панели':view==='settings'?'Права и тикеты':'Панели'; $(`#${view}View`).classList.remove('hidden'); if(view==='history') await loadHistory(); }));
$('#guildSelect').addEventListener('change', async()=>{ await loadGuild(); });
$('#addButton').addEventListener('click',()=>{if(state.buttons.length>=5)return;state.buttons.push({label:'Новая кнопка',emoji:'🎫',style:'Primary',actionType:'ticket',ephemeralMessage:'Готово!',ticketTitle:'Тикет открыт',ticketMessage:'Опишите вашу проблему. Сотрудник ответит здесь.',ticketMentionRoleId:'',ticketCategoryId:''});renderButtons(false);});
$('#sendPanel').addEventListener('click',sendPanel); $('#saveSettings').addEventListener('click',saveSettings); $('#title').addEventListener('input',renderPreview); $('#message').addEventListener('input',renderPreview);
$('#ticketCategory').addEventListener('change', () => { renderButtonEditorKeepingValues(); });
$('#logout').addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
init().catch(e=>showLoggedOut('Ошибка загрузки панели: '+e.message));
