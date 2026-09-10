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
  EmbedBuilder,
  PermissionsBitField
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

  const botGuild = guild;
  const member = await botGuild.members.fetch(req.session.user.id).catch(() => null);
  if (!member) return null;
  if (member.id === botGuild.ownerId) return { level: 'owner', member, guild: botGuild };
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return { level: 'administrator', member, guild: botGuild };

  const config = await prisma.guildConfig.findUnique({ where: { guildId } });
  const allowed = new Set(config?.staffRoleIds || []);
  const roleAllowed = member.roles.cache.some(r => allowed.has(r.id));
  if (roleAllowed) return { level: 'role', member, guild: botGuild };
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
    const user = await discordUser(token.access_token);
    req.session.user = user;
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
      result.push({ id: g.id, name: botGuild.name, icon: botGuild.iconURL({ size: 64 }), level: member.id === botGuild.ownerId ? 'owner' : member.permissions.has(PermissionFlagsBits.Administrator) ? 'administrator' : 'role' });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'GUILDS_FAILED' });
  }
});

app.get('/api/guilds/:guildId/channels', requireAuth, requireGuildAccess, async (req, res) => {
  const channels = await req.guildAccess.guild.channels.fetch();
  const result = channels.filter(c => c && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type)).sort((a,b) => (a.position ?? 0) - (b.position ?? 0)).map(c => ({ id: c.id, name: c.name, parentId: c.parentId, type: c.type }));
  res.json(result);
});

app.get('/api/guilds/:guildId/categories', requireAuth, requireGuildAccess, async (req, res) => {
  const channels = await req.guildAccess.guild.channels.fetch();
  res.json(channels.filter(c => c?.type === ChannelType.GuildCategory).map(c => ({ id: c.id, name: c.name })));
});

app.get('/api/guilds/:guildId/roles', requireAuth, requireGuildAccess, async (req, res) => {
  const roles = await req.guildAccess.guild.roles.fetch();
  res.json(roles.filter(r => r && r.id !== req.guildAccess.guild.id && !r.managed).sort((a,b) => b.position - a.position).map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position })));
});

app.get('/api/guilds/:guildId/settings', requireAuth, requireGuildAccess, async (req, res) => {
  const config = await prisma.guildConfig.findUnique({ where: { guildId: req.params.guildId } });
  res.json(config || { guildId: req.params.guildId, ticketCategory: null, staffRoleIds: [] });
});

app.put('/api/guilds/:guildId/settings', requireAuth, requireGuildAccess, async (req, res) => {
  const { ticketCategory, staffRoleIds } = req.body || {};
  const roles = Array.isArray(staffRoleIds) ? staffRoleIds.slice(0, 25) : [];
  const guild = req.guildAccess.guild;
  if (ticketCategory && !guild.channels.cache.has(ticketCategory)) return res.status(400).json({ error: 'INVALID_CATEGORY' });
  for (const roleId of roles) if (!guild.roles.cache.has(roleId)) return res.status(400).json({ error: 'INVALID_ROLE' });
  const config = await prisma.guildConfig.upsert({ where: { guildId: req.params.guildId }, create: { guildId: req.params.guildId, ticketCategory: ticketCategory || null, staffRoleIds: roles }, update: { ticketCategory: ticketCategory || null, staffRoleIds: roles } });
  res.json(config);
});

function parseColor(value) {
  const v = String(value || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return Number.parseInt(v, 16);
}

function normalizeButtons(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 5).map((b, i) => ({
    id: crypto.randomBytes(5).toString('hex'),
    label: String(b.label || `Кнопка ${i + 1}`).trim().slice(0, 80),
    emoji: String(b.emoji || '').trim().slice(0, 16),
    style: ['Primary', 'Secondary', 'Success', 'Danger'].includes(b.style) ? b.style : 'Primary'
  })).filter(b => b.label.length > 0);
}

app.post('/api/guilds/:guildId/panels', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { channelId, title, message, color, buttons } = req.body || {};
    const channel = await req.guildAccess.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return res.status(400).json({ error: 'INVALID_CHANNEL' });
    if (!message && !title) return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
    const cleanButtons = normalizeButtons(buttons);
    if (!cleanButtons.length) return res.status(400).json({ error: 'BUTTONS_REQUIRED' });

    const config = await prisma.guildConfig.findUnique({ where: { guildId: req.params.guildId } });
    if (!config) await prisma.guildConfig.create({ data: { guildId: req.params.guildId } });
    const panel = await prisma.ticketPanel.create({ data: { guildId: req.params.guildId, channelId, title: String(title || '').slice(0, 256) || null, message: String(message || '').slice(0, 4000), color: parseColor(color), buttonsJson: JSON.stringify(cleanButtons) } });

    const rows = [];
    for (let i = 0; i < cleanButtons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(cleanButtons.slice(i, i + 5).map(b => new ButtonBuilder().setCustomId(`ticket:${panel.id}:${b.id}`).setLabel(b.label).setStyle(ButtonStyle[b.style]).setEmoji(b.emoji || '🎫'))));
    }
    const embed = new EmbedBuilder();
    if (panel.title) embed.setTitle(panel.title);
    if (panel.message) embed.setDescription(panel.message);
    if (panel.color !== null) embed.setColor(panel.color);
    await channel.send({ embeds: [embed], components: rows });
    res.json({ ok: true, panelId: panel.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PANEL_SEND_FAILED', detail: err.message });
  }
});

app.get('/api/guilds/:guildId/panels', requireAuth, requireGuildAccess, async (req, res) => {
  const panels = await prisma.ticketPanel.findMany({ where: { guildId: req.params.guildId }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(panels.map(p => ({ id: p.id, channelId: p.channelId, title: p.title, message: p.message, buttons: JSON.parse(p.buttonsJson), createdAt: p.createdAt })));
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith('ticket:')) return handleTicketButton(interaction);
  if (interaction.customId === 'ticket-close') {
    await interaction.reply({ content: 'Тикет закрывается…', ephemeral: true });
    setTimeout(() => interaction.channel?.delete().catch(() => {}), 1200);
  }
});

async function handleTicketButton(interaction) {
  const [, panelId, buttonId] = interaction.customId.split(':');
  const panel = await prisma.ticketPanel.findUnique({ where: { id: panelId } });
  if (!panel) return interaction.reply({ content: 'Эта панель больше не существует.', ephemeral: true });
  const guild = interaction.guild;
  const config = await prisma.guildConfig.findUnique({ where: { guildId: guild.id } });
  const button = JSON.parse(panel.buttonsJson).find(b => b.id === buttonId);
  const safe = String(button?.label || 'ticket').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').slice(0, 24) || 'ticket';
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic === `ticket-owner:${interaction.user.id}` && c.parentId === (config?.ticketCategory || null));
  if (existing) return interaction.reply({ content: `У тебя уже есть открытый тикет: ${existing}`, ephemeral: true });

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
  ];
  for (const roleId of config?.staffRoleIds || []) {
    if (guild.roles.cache.has(roleId)) overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }
  const channel = await guild.channels.create({ name: `${safe}-${interaction.user.username}`.slice(0, 100), type: ChannelType.GuildText, parent: config?.ticketCategory || undefined, topic: `ticket-owner:${interaction.user.id}`, permissionOverwrites: overwrites });
  const close = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket-close').setLabel('Закрыть тикет').setEmoji('🔒').setStyle(ButtonStyle.Danger));
  await channel.send({ content: `${interaction.user}`, embeds: [new EmbedBuilder().setTitle('Тикет открыт').setDescription('Опишите вашу проблему. Сотрудник ответит здесь.').setColor(0x5865f2)], components: [close] });
  await interaction.reply({ content: `Тикет создан: ${channel}`, ephemeral: true });
}

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
  console.log(`Web panel: http://localhost:${PORT}`);
});

await client.login(process.env.DISCORD_TOKEN);
await prisma.$connect();
app.listen(PORT, () => console.log(`Web server listening on :${PORT}`));
