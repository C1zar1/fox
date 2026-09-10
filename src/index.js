import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';
import { PrismaClient } from '@prisma/client';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'SESSION_SECRET', 'DATABASE_URL'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}

const prisma = new PrismaClient();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(express.static('public'));

// Live browser connections. They are used to push fresh channel/role/category data
// immediately after a Discord change instead of making the user refresh the page.
const sseClients = new Map(); // guildId -> Set<res>

function pushGuildEvent(guildId, type) {
  const clients = sseClients.get(guildId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify({ type, at: Date.now() })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function addSseClient(guildId, res) {
  if (!sseClients.has(guildId)) sseClients.set(guildId, new Set());
  sseClients.get(guildId).add(res);
  res.on('close', () => {
    const set = sseClients.get(guildId);
    if (!set) return;
    set.delete(res);
    if (!set.size) sseClients.delete(guildId);
  });
}

function oauthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function discordUser(accessToken) {
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('Unable to fetch Discord user');
  return res.json();
}

async function userGuilds(accessToken) {
  const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('Unable to fetch Discord guilds');
  return res.json();
}

function hasAdministrator(guild) {
  return (BigInt(guild.permissions || '0') & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
}

async function accessForGuild(req, guildId) {
  if (!req.session.user || !req.session.accessToken) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const member = await guild.members.fetch(req.session.user.id).catch(() => null);
  if (!member) return null;
  if (member.id === guild.ownerId) return { level: 'owner', member, guild };
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return { level: 'administrator', member, guild };

  const config = await prisma.guildConfig.findUnique({ where: { guildId } });
  const allowed = new Set(config?.staffRoleIds || []);
  const roleAllowed = member.roles.cache.some(r => allowed.has(r.id));
  if (roleAllowed) return { level: 'role', member, guild };
  return null;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  next();
}

async function requireGuildAccess(req, res, next) {
  try {
    const access = await accessForGuild(req, req.params.guildId);
    if (!access) return res.status(403).json({ error: 'FORBIDDEN' });
    req.guildAccess = access;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ACCESS_CHECK_FAILED' });
  }
}

app.get('/auth/login', (req, res) => res.redirect(oauthUrl()));
app.get('/auth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) return res.redirect('/?error=oauth');
    const body = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI
    });
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!tokenRes.ok) throw new Error('OAuth token exchange failed');
    const token = await tokenRes.json();
    req.session.user = await discordUser(token.access_token);
    req.session.accessToken = token.access_token;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/?error=oauth');
  }
});
app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null, loggedIn: Boolean(req.session.user) }));

app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guilds = await userGuilds(req.session.accessToken);
    const result = [];
    for (const g of guilds) {
      if (!client.guilds.cache.has(g.id)) continue;
      const botGuild = client.guilds.cache.get(g.id);
      const member = await botGuild.members.fetch(req.session.user.id).catch(() => null);
      if (!member) continue;
      const config = await prisma.guildConfig.findUnique({ where: { guildId: g.id } });
      const allowed = new Set(config?.staffRoleIds || []);
      const roleAllowed = member.roles.cache.some(r => allowed.has(r.id));
      const allowedHere = member.id === botGuild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator) || roleAllowed;
      if (!allowedHere) continue;
      result.push({
        id: g.id,
        name: botGuild.name,
        icon: botGuild.iconURL({ size: 64 }),
        level: member.id === botGuild.ownerId ? 'owner' : member.permissions.has(PermissionFlagsBits.Administrator) ? 'administrator' : 'role'
      });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'GUILDS_FAILED' });
  }
});

async function getGuildChannels(guild) {
  return guild.channels.fetch();
}

async function getGuildRoles(guild) {
  return guild.roles.fetch();
}

function serializeChannels(channels) {
  return channels
    .filter(c => c && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type))
    .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0))
    .map(c => ({ id: c.id, name: c.name, parentId: c.parentId, type: c.type }));
}

function serializeCategories(channels) {
  return channels.filter(c => c?.type === ChannelType.GuildCategory).sort((a,b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0)).map(c => ({ id: c.id, name: c.name }));
}

function serializeRoles(roles) {
  return roles
    .filter(r => r && r.id !== r.guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position }));
}

app.get('/api/guilds/:guildId/channels', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const channels = await getGuildChannels(req.guildAccess.guild);
    res.json(serializeChannels(channels));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'CHANNELS_FAILED' });
  }
});

app.get('/api/guilds/:guildId/categories', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const channels = await getGuildChannels(req.guildAccess.guild);
    res.json(serializeCategories(channels));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'CATEGORIES_FAILED' });
  }
});

app.get('/api/guilds/:guildId/roles', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const roles = await getGuildRoles(req.guildAccess.guild);
    res.json(serializeRoles(roles));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ROLES_FAILED' });
  }
});

app.get('/api/guilds/:guildId/live', requireAuth, requireGuildAccess, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'connected', at: Date.now() })}\n\n`);
  addSseClient(req.params.guildId, res);
});

app.get('/api/guilds/:guildId/settings', requireAuth, requireGuildAccess, async (req, res) => {
  const config = await prisma.guildConfig.findUnique({ where: { guildId: req.params.guildId } });
  res.json(config || { guildId: req.params.guildId, ticketCategory: null, staffRoleIds: [] });
});

app.put('/api/guilds/:guildId/settings', requireAuth, requireGuildAccess, async (req, res) => {
  const { ticketCategory, staffRoleIds } = req.body || {};
  const roles = Array.isArray(staffRoleIds) ? [...new Set(staffRoleIds.map(String))].slice(0, 25) : [];
  const guild = req.guildAccess.guild;
  const category = ticketCategory ? guild.channels.cache.get(ticketCategory) : null;
  if (ticketCategory && (!category || category.type !== ChannelType.GuildCategory)) return res.status(400).json({ error: 'INVALID_CATEGORY' });
  for (const roleId of roles) {
    const role = guild.roles.cache.get(roleId);
    if (!role || role.managed) return res.status(400).json({ error: 'INVALID_ROLE' });
  }
  const config = await prisma.guildConfig.upsert({
    where: { guildId: req.params.guildId },
    create: { guildId: req.params.guildId, ticketCategory: ticketCategory || null, staffRoleIds: roles },
    update: { ticketCategory: ticketCategory || null, staffRoleIds: roles }
  });
  res.json(config);
});

function parseColor(value) {
  const v = String(value || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return Number.parseInt(v, 16);
}

const ACTION_TYPES = new Set(['ticket', 'ephemeral']);
const BUTTON_STYLES = new Set(['Primary', 'Secondary', 'Success', 'Danger']);

function normalizeButtons(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 5).map((b, i) => {
    const actionType = ACTION_TYPES.has(b.actionType) ? b.actionType : 'ticket';
    return {
      id: crypto.randomBytes(5).toString('hex'),
      label: String(b.label || `Кнопка ${i + 1}`).trim().slice(0, 80),
      emoji: String(b.emoji || '').trim().slice(0, 32),
      style: BUTTON_STYLES.has(b.style) ? b.style : 'Primary',
      actionType,
      ephemeralMessage: String(b.ephemeralMessage || 'Готово!').trim().slice(0, 2000),
      ticketTitle: String(b.ticketTitle || 'Тикет открыт').trim().slice(0, 256),
      ticketMessage: String(b.ticketMessage || 'Опишите вашу проблему. Сотрудник ответит здесь.').trim().slice(0, 4000),
      ticketMentionRoleId: String(b.ticketMentionRoleId || '').trim().slice(0, 30),
      ticketCategoryId: String(b.ticketCategoryId || '').trim().slice(0, 30)
    };
  }).filter(b => b.label.length > 0);
}

async function buildPanelPayload(channel, panel, cleanButtons) {
  const rows = [];
  for (let i = 0; i < cleanButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(cleanButtons.slice(i, i + 5).map(b => {
      const buttonStyle = ButtonStyle[b.style];
      if (!buttonStyle) throw new Error(`Invalid button style: ${b.style}`);
      const button = new ButtonBuilder()
        .setCustomId(`ticket:${panel.id}:${b.id}`)
        .setLabel(b.label)
        .setStyle(buttonStyle);
      if (b.emoji) button.setEmoji(b.emoji);
      return button;
    })));
  }
  const payload = { components: rows };
  // Always publish a real webhook-like embed. We use defaults on both the client and server
  // so an empty form can never turn into a blank/invalid embed.
  const title = String(panel.title || '').trim();
  const message = String(panel.message || '').trim();
  const embed = new EmbedBuilder()
    .setTitle(title || 'Нужна помощь?')
    .setDescription(message || 'Выберите нужную категорию тикета ниже.');
  if (panel.color !== null) embed.setColor(panel.color);
  payload.embeds = [embed];
  return payload;
}

async function deleteDiscordPanel(guild, panel) {
  if (!panel?.channelId || !panel?.discordMessageId) return false;
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  const message = await channel.messages.fetch(panel.discordMessageId).catch(() => null);
  if (!message) return false;
  await message.delete().catch(() => {});
  return true;
}

app.post('/api/guilds/:guildId/panels', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { channelId, title, message, color, buttons, replaceExisting = true } = req.body || {};
    const guild = req.guildAccess.guild;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return res.status(400).json({ error: 'INVALID_CHANNEL' });

    const cleanButtons = normalizeButtons(buttons);
    if (!cleanButtons.length) return res.status(400).json({ error: 'BUTTONS_REQUIRED', detail: 'At least one non-empty button is required.' });
    if (cleanButtons.some(b => b.label.length > 80)) return res.status(400).json({ error: 'BUTTON_LABEL_TOO_LONG' });
    const parsedColor = parseColor(color);
    if (String(color || '').trim() && parsedColor === null) return res.status(400).json({ error: 'INVALID_COLOR', detail: 'Use a hex color such as #5865F2.' });

    const config = await prisma.guildConfig.findUnique({ where: { guildId: req.params.guildId } });
    if (!config) await prisma.guildConfig.create({ data: { guildId: req.params.guildId } });

    // Validate per-button role/category choices before creating anything.
    const allRoles = await guild.roles.fetch();
    const allChannels = await guild.channels.fetch();
    for (const b of cleanButtons) {
      if (b.ticketMentionRoleId) {
        const role = allRoles.get(b.ticketMentionRoleId);
        if (!role || role.managed) return res.status(400).json({ error: 'INVALID_BUTTON_ROLE' });
      }
      if (b.ticketCategoryId) {
        const category = allChannels.get(b.ticketCategoryId);
        if (!category || category.type !== ChannelType.GuildCategory) return res.status(400).json({ error: 'INVALID_BUTTON_CATEGORY' });
      }
    }

    // The requested behaviour is replacement: one active panel per destination channel.
    // The old message is deleted first, then the new one is published immediately.
    const oldPanels = replaceExisting === false ? [] : await prisma.ticketPanel.findMany({ where: { guildId: req.params.guildId, channelId, active: true }, orderBy: { createdAt: 'desc' } });
    for (const old of oldPanels) await deleteDiscordPanel(guild, old);

    const panel = await prisma.ticketPanel.create({
      data: {
        guildId: req.params.guildId,
        channelId,
        title: String(title || '').trim().slice(0, 256) || 'Нужна помощь?',
        message: String(message || '').trim().slice(0, 4000) || 'Выберите нужную категорию тикета ниже.',
        color: parsedColor,
        buttonsJson: JSON.stringify(cleanButtons),
        active: true
      }
    });

    try {
      const sent = await channel.send(await buildPanelPayload(channel, panel, cleanButtons));
      await prisma.ticketPanel.update({ where: { id: panel.id }, data: { discordMessageId: sent.id } });
      await prisma.ticketPanel.updateMany({ where: { id: { in: oldPanels.map(p => p.id) } }, data: { active: false } });
      res.json({ ok: true, panelId: panel.id, discordMessageId: sent.id });
    } catch (sendError) {
      await prisma.ticketPanel.delete({ where: { id: panel.id } }).catch(() => {});
      throw sendError;
    }
  } catch (err) {
    console.error('PANEL_SEND_FAILED', { message: err?.message, code: err?.code, status: err?.status, rawError: err?.rawError });
    const detail = err?.message || 'Unknown Discord error';
    const extra = err?.code ? ` (Discord code ${err.code})` : '';
    res.status(500).json({ error: 'PANEL_SEND_FAILED', detail: detail + extra });
  }
});

app.get('/api/guilds/:guildId/panels', requireAuth, requireGuildAccess, async (req, res) => {
  const panels = await prisma.ticketPanel.findMany({ where: { guildId: req.params.guildId }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(panels.map(p => ({ id: p.id, channelId: p.channelId, discordMessageId: p.discordMessageId, active: p.active, title: p.title, message: p.message, buttons: JSON.parse(p.buttonsJson), createdAt: p.createdAt })));
});

client.on('channelCreate', channel => { if (channel.guild) pushGuildEvent(channel.guild.id, 'channel'); });
client.on('channelDelete', channel => { if (channel.guild) pushGuildEvent(channel.guild.id, 'channel'); });
client.on('channelUpdate', (oldChannel, newChannel) => { if (newChannel.guild) pushGuildEvent(newChannel.guild.id, 'channel'); });
client.on('roleCreate', role => pushGuildEvent(role.guild.id, 'role'));
client.on('roleDelete', role => pushGuildEvent(role.guild.id, 'role'));
client.on('roleUpdate', (oldRole, newRole) => pushGuildEvent(newRole.guild.id, 'role'));

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith('ticket:')) return handleTicketButton(interaction);
  if (interaction.customId === 'ticket-close') {
    await interaction.reply({ content: 'Тикет закрывается…', ephemeral: true });
    setTimeout(() => interaction.channel?.delete().catch(() => {}), 1200);
  }
});

async function handleTicketButton(interaction) {
  try {
    const [, panelId, buttonId] = interaction.customId.split(':');
    const panel = await prisma.ticketPanel.findUnique({ where: { id: panelId } });
    if (!panel) return interaction.reply({ content: 'Эта панель больше не существует.', ephemeral: true });

    const button = JSON.parse(panel.buttonsJson).find(b => b.id === buttonId);
    if (!button) return interaction.reply({ content: 'Эта кнопка больше не настроена.', ephemeral: true });

    if (button.actionType === 'ephemeral') {
      return interaction.reply({ content: button.ephemeralMessage || 'Готово!', ephemeral: true });
    }

    const guild = interaction.guild;
    const config = await prisma.guildConfig.findUnique({ where: { guildId: guild.id } });
    const categoryId = button.ticketCategoryId || config?.ticketCategory || null;

    const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic === `ticket-owner:${interaction.user.id}` && c.parentId === categoryId);
    if (existing) return interaction.reply({ content: `У тебя уже есть открытый тикет: ${existing}`, ephemeral: true });

    const safe = String(button.label || 'ticket').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').slice(0, 24) || 'ticket';
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
    ];
    for (const roleId of config?.staffRoleIds || []) {
      if (guild.roles.cache.has(roleId)) overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    const channel = await guild.channels.create({
      name: `${safe}-${interaction.user.username}`.slice(0, 100),
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      topic: `ticket-owner:${interaction.user.id}`,
      permissionOverwrites: overwrites
    });

    const close = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket-close').setLabel('Закрыть тикет').setEmoji('🔒').setStyle(ButtonStyle.Danger));
    const mention = button.ticketMentionRoleId && guild.roles.cache.has(button.ticketMentionRoleId) ? `${guild.roles.cache.get(button.ticketMentionRoleId)}` : '';
    const embed = new EmbedBuilder()
      .setTitle(button.ticketTitle || 'Тикет открыт')
      .setDescription(button.ticketMessage || 'Опишите вашу проблему. Сотрудник ответит здесь.')
      .setColor(0x5865f2);

    await channel.send({ content: [interaction.user.toString(), mention].filter(Boolean).join(' '), embeds: [embed], components: [close] });
    await interaction.reply({ content: `Тикет создан: ${channel}`, ephemeral: true });
    pushGuildEvent(guild.id, 'channel');
  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Не удалось выполнить действие. Проверь права бота.', ephemeral: true }).catch(() => {});
  }
}

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
  console.log(`Web panel: http://localhost:${PORT}`);
});

await client.login(process.env.DISCORD_TOKEN);
await prisma.$connect();
app.listen(PORT, () => console.log(`Web server listening on :${PORT}`));
