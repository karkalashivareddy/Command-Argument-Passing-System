# Deployment Guide

## Overview

The CAPS Observatory consists of three independently deployable pieces:

1. **C Engine** (`./caps`) — Linux-only ELF binary
2. **Node Gateway** (`web/backend`) — Fastify + SQLite + SSE
3. **React Frontend** (`web/frontend`) — Static assets served by any web server

For production, run the C engine + Node gateway on a Linux host (or WSL2), and serve the built frontend from a CDN or the Node gateway itself.

---

## 1. Build Artifacts

```bash
# From repo root
make caps                    # Builds ./caps (C engine)
cd web/frontend && npm run build  # Outputs to web/frontend/dist/
```

### Artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| `caps` | repo root | The monitor/execution engine |
| `web/frontend/dist/` | web/frontend/dist/ | Static frontend (index.html + assets) |
| `web/backend/src/server.ts` | source | Node gateway (run via `tsx` or compiled) |

---

## 2. Production Configuration

### Environment Variables (Gateway)

```bash
# Required
CAPS_DATABASE_PATH=/var/lib/caps/caps-observatory.db
CAPS_WORKSPACE=/var/lib/caps/work
CAPS_EXECUTABLE=/opt/caps/caps

# Optional (defaults shown)
CAPS_HOST=127.0.0.1
CAPS_PORT=3000
CAPS_MAX_CONCURRENT=4
CAPS_DEFAULT_TIMEOUT_MS=30000
CAPS_MAX_TIMEOUT_MS=120000
CAPS_MAX_OUTPUT_BYTES=65536
CAPS_LOG_LEVEL=info
```

### Directory Setup

```bash
mkdir -p /var/lib/caps/work
chown -R caps:caps /var/lib/caps
# Ensure the caps binary is executable and in PATH or use CAPS_EXECUTABLE
```

---

## 3. Running the Gateway

### Option A: Direct (with tsx)

```bash
cd /opt/caps/web/backend
CAPS_DATABASE_PATH=/var/lib/caps/caps-observatory.db \
CAPS_WORKSPACE=/var/lib/caps/work \
CAPS_EXECUTABLE=/opt/caps/caps \
node --disable-warning=ExperimentalWarning --import tsx src/server.ts
```

### Option B: Compiled (esbuild)

```bash
cd /opt/caps/web/backend
npm install --production
npx esbuild src/server.ts --platform=node --outfile=dist/server.js --bundle --external:node:sqlite
node --disable-warning=ExperimentalWarning dist/server.js
```

### Option C: Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY web/backend/package*.json ./
RUN npm ci --production
COPY web/backend/src ./src
COPY caps /usr/local/bin/caps
ENV CAPS_DATABASE_PATH=/data/caps-observatory.db
ENV CAPS_WORKSPACE=/data/work
ENV CAPS_EXECUTABLE=/usr/local/bin/caps
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/server.ts"]
```

---

## 4. Frontend Deployment

### Static Hosting (Recommended)

```bash
cd web/frontend
npm run build
# Output: dist/
# Deploy dist/ to Netlify, Vercel, Cloudflare Pages, S3+CloudFront, nginx, etc.
```

Configure the frontend's API proxy by setting `VITE_CAPS_API` at build time:

```bash
VITE_CAPS_API=https://api.example.com npm run build
```

If not set, the frontend assumes the API is at the same origin (i.e., served from the gateway).

### Served from Gateway

The gateway can serve the built frontend directly:

```bash
# In gateway config, add:
# app.register(fastifyStatic, { root: path.join(__dirname, "../../frontend/dist") })
# app.setNotFoundHandler((req, reply) => reply.sendFile("index.html"))
```

---

## 5. Reverse Proxy (nginx example)

```nginx
server {
    listen 443 ssl http2;
    server_name caps.example.com;

    ssl_certificate /etc/letsencrypt/live/caps.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/caps.example.com/privkey.pem;

    # Frontend
    location / {
        root /var/www/caps/dist;
        try_files $uri $uri/ /index.html;
    }

    # API → Node gateway
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE needs no buffering
        proxy_cache off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

---

## 6. Systemd Service

```ini
# /etc/systemd/system/caps-observatory.service
[Unit]
Description=CAPS Process Execution Observatory Gateway
After=network.target

[Service]
Type=simple
User=caps
WorkingDirectory=/opt/caps/web/backend
Environment=CAPS_DATABASE_PATH=/var/lib/caps/caps-observatory.db
Environment=CAPS_WORKSPACE=/var/lib/caps/work
Environment=CAPS_EXECUTABLE=/opt/caps/caps
Environment=CAPS_LOG_LEVEL=info
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --import tsx src/server.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now caps-observatory
journalctl -u caps-observatory -f
```

---

## 7. Health Checks

```bash
# Gateway health
curl -f http://127.0.0.1:3000/api/health

# Engine availability
curl -f http://127.0.0.1:3000/api/capabilities | jq .engineAvailable

# Database
sqlite3 /var/lib/caps/caps-observatory.db "PRAGMA integrity_check;"
```

---

## 8. Backup & Migration

```bash
# Backup (online - WAL mode allows concurrent reads)
sqlite3 /var/lib/caps/caps-observatory.db ".backup /backup/caps-$(date +%F).db"

# Migration: schema is auto-migrated on gateway startup (see db/database.ts migrate())
# For manual migrations, add ALTER TABLE statements to migrate() function.
```

---

## 9. Scaling Notes

| Concern | Approach |
|---------|----------|
| **Concurrency** | Gateway limit: `CAPS_MAX_CONCURRENT` (default 4). Horizontal scaling requires sticky sessions for SSE or a shared Redis pub/sub for event bus. |
| **Database** | SQLite is single-writer. For multi-instance, use a central PostgreSQL + `pg` driver instead of `node:sqlite`. |
| **File storage** | Workspace is local. For multi-host, use a shared NFS mount or object storage for redirection files. |
| **Frontend** | Static — trivially scalable via CDN. |

---

## 10. Monitoring

- **Gateway logs**: JSON lines via stdout (structured logger in `utils/logger.ts`)
- **Key metrics**: `/api/analytics/overview` (executions, latency percentiles, error rates)
- **Process table**: `/api/processes` (live child processes)
- **SSE health**: Check `/api/live/stream` connection count

---

## 11. Troubleshooting

| Symptom | Likely Cause |
|---------|--------------|
| `engine.available: false` | `CAPS_EXECUTABLE` wrong, binary not executable, missing deps |
| `database: unavailable` | `CAPS_DATABASE_PATH` directory missing or permissions |
| `403 FORBIDDEN` | Request from non-loopback IP (proxy misconfiguration) |
| `422 REDIRECTION_REJECTED` | Path contains `..`, `~`, absolute, or empty |
| SSE disconnects | Proxy buffering (`proxy_buffering off` required) |
| Frontend blank | `VITE_CAPS_API` not set for cross-origin deployment |
