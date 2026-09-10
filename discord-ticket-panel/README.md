# Discord Ticket Panel

Готовая основа Discord Ticket Bot + веб-панель управления.

## Возможности

- Вход через Discord OAuth2.
- Видны только серверы, где бот установлен и у пользователя есть доступ.
- Доступ к панели: владелец сервера, `Administrator` или роль из Staff Roles.
- Выбор реального Discord-канала из выпадающего списка.
- Заголовок + текст в стиле webhook/embed.
- До 5 кнопок с названием, emoji и цветом.
- Предпросмотр сообщения до отправки.
- Отправка панели прямо в Discord без Discord-команд.
- Настройка категории тикетов и staff-ролей.
- Нажатие кнопки панели создаёт приватный тикет.
- В тикете есть кнопка закрытия.
- PostgreSQL/Prisma для сохранения конфигурации и панелей.

## Требования

Node.js 24+ и PostgreSQL. Современная ветка discord.js использует актуальный Discord API; проект рассчитан на Node 24+.

## Discord Developer Portal

Создай application/bot и заполни `.env`.

OAuth2 Redirect URL:

`http://localhost:3000/auth/callback`

OAuth scopes для сайта используются `identify guilds`.

Добавь бота на сервер с правами, которые ему нужны для тикетов: минимум View Channels, Send Messages, Embed Links, Read Message History, Manage Channels, Manage Roles (если планируется дальнейшее расширение).

## Запуск

```bash
npm install
npx prisma generate
npx prisma db push
npm start
```

Открой `http://localhost:3000`.

## Production

Для GitHub репозитория храни исходники, но не `.env`. В продакшене задай переменные окружения у хостинга, а `DISCORD_REDIRECT_URI` замени на реальный домен, например:

`https://panel.example.com/auth/callback`

Для production желательно поставить HTTPS и secure cookies, а для сессий использовать постоянное session-хранилище (Redis/DB), а не MemoryStore Express.
