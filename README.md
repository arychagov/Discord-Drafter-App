## Discord Drafter

Discord-бот для драфта (2 команды), где **всё состояние хранится прямо в одном сообщении** (в конце сообщения — машинный JSON).

### Возможности

- **`/draft`** — создаёт draft-сообщение с кнопками: Join / Leave / Draft! / Stop
- **Join/Leave** — набор участников
- **Draft!** — фиксирует состав и показывает 2 команды
- **Draft!** — можно нажимать повторно: перераздаёт команды и подхватывает игроков “на замену”
- **Stop** — отключает все кнопки (жёсткая остановка)
- Синхронизация: при одновременных кликах используется **message-level lock**, чтобы не терять обновления

### Требования

- Node.js 20+
- Discord application + bot token

### Настройка

1) Установить зависимости:

```bash
npm install
```

2) Создать `.env` (можно скопировать из `env.example`) и заполнить:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- (опционально) `DISCORD_GUILD_ID` — для dev-регистрации команд только в одном сервере (быстро обновляется)

3) Зарегистрировать slash-команды:

```bash
npm run build
npm run register
```

4) Запуск:

```bash
npm run dev
```

### Деплой на DigitalOcean (Docker Compose)

На droplet (Ubuntu):

```bash
sudo apt update
sudo apt install -y docker.io docker-compose
sudo systemctl enable --now docker
```

Дальше на сервере:

```bash
git clone <your-repo>
cd <repo>
cp env.example .env
nano .env
docker-compose up -d --build
docker-compose logs -f
```

Slash-команды (пере)регистрировать при изменениях команд:

```bash
docker-compose up -d --build
docker-compose run --rm bot npm run register
```

### Как работает хранение в сообщении

В конце draft-сообщения бот хранит JSON в блоке:

````text
||```DRAFT_STATE
{ ... }
```||
````

При каждом нажатии кнопки бот:

- читает сообщение
- парсит `DRAFT_STATE`
- пытается захватить lock (через edit + verify)
- применяет изменение и редактирует сообщение

