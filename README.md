# Discord Ticket Panel

MVP Discord Ticket Bot + веб-панель управления.

## Что умеет новая версия

- Discord OAuth2 авторизация.
- Доступ к панели только владельцу сервера, Administrator или выбранным Staff-ролям.
- Автоматическое обновление каналов, категорий и ролей без перезагрузки страницы через Discord Gateway + SSE.
- Выбор канала для публикации.
- Embed: заголовок, текст и цвет.
- До 5 кнопок.
- Для каждой кнопки можно выбрать:
  - создать приватный тикет;
  - отправить ephemeral-сообщение, которое видит только нажавший пользователь.
- Для тикетной кнопки можно отдельно настроить:
  - заголовок тикета;
  - текст сообщения в тикете;
  - категорию тикета;
  - роль, которую нужно упомянуть при открытии тикета.
- При повторной публикации в том же канале старая бот-панель автоматически удаляется, затем публикуется новая.
- PostgreSQL + Prisma.

## Запуск

```bash
npm install
npx prisma generate
npx prisma db push
npm start
```

Открой `http://localhost:3000`.

## Discord Developer Portal

Для Gateway в **Bot → Privileged Gateway Intents** требуется включить `SERVER MEMBERS INTENT`.

OAuth2 Redirect URL для локального запуска:

`http://localhost:3000/auth/callback`

OAuth scopes для сайта:

`identify guilds`

Боту для этого проекта проще всего дать `Administrator`.

## .env

Скопируй `.env.example` в `.env` и укажи настоящий Bot Token, OAuth2 Client ID/Secret, Session Secret и PostgreSQL `DATABASE_URL`.

## Production

На хостинге замени `DISCORD_REDIRECT_URI` на домен панели, например:

`https://panel.example.com/auth/callback`

и добавь тот же redirect URL в Discord Developer Portal. В production используй HTTPS, secure cookies и постоянное session-хранилище (например Redis/PostgreSQL-backed store).
