# YaSHu AI

A private, local-first chat app for Ollama. Conversations are stored in SQLite on your machine; prompts go only to the Ollama endpoint you configure.

## Run locally

Prerequisites: Node.js 22.12 or newer and [Ollama](https://ollama.com/) with at least one model installed.

```powershell
ollama pull llama3.2:3b
npm.cmd install
npm.cmd run dev
```

Open <http://localhost:4173>. The default Ollama endpoint is `http://127.0.0.1:11434`. To use another Ollama host, set `OLLAMA_BASE_URL` before starting.

## Production

```powershell
npm.cmd run build
$env:NODE_ENV = 'production'
npm.cmd start
```

`PORT` sets the HTTP port, `HOST` controls the bind address, and `DATA_DIR` sets the database directory. The defaults are port `4173`, `127.0.0.1`, and `./data`.

## Docker Compose

Copy `.env.example` to `.env`, then run:

```powershell
docker compose up --build -d
```

Open <http://localhost:4173>. Compose binds to host loopback and stores conversations in a persistent Docker volume. On Windows and macOS, the container reaches Ollama on the host using `host.docker.internal`. For Ollama on another host, set `OLLAMA_BASE_URL` in `.env`. If Ollama listens only on localhost, configure it to listen on `0.0.0.0:11434` and firewall that port to trusted local access.

## API

- `GET /api/health` and `GET /api/models` report Ollama connectivity and installed models.
- `GET /api/conversations` lists history; `GET /api/conversations/:id` loads a conversation.
- `PATCH` and `DELETE /api/conversations/:id` rename or remove history.
- `POST /api/chat` streams responses as server-sent events and saves completed or interrupted output.

The API binds to loopback by default, limits JSON payloads and request rates, and sets security headers. This single-user app has no account system; do not expose it directly to the internet. Put it behind authenticated access and TLS if deploying remotely. There is no cloud account or third-party telemetry.