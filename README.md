# URL Shortener

A URL shortener with a Next.js interface for creating, copying, and opening short links. The API uses Node.js, TypeScript, Express, and MongoDB. Redis accelerates redirects and allocates global numeric IDs; RabbitMQ processes click events asynchronously.

## Requirements

- Docker and Docker Compose to run the full application; or
- Node.js 22.6 or later, MongoDB, and Redis to run the API locally. RabbitMQ can be temporarily unavailable; click events remain in the MongoDB outbox until it reconnects.

## Run with Docker Compose

From the project root, run:

```bash
docker compose up --build
```

The frontend is available at `http://localhost:3001` and the API at `http://localhost:3000`. MongoDB, the Redis counter, and RabbitMQ use persistent volumes. The frontend proxies API requests and opens short links through the frontend origin.

To stop the services, press `Ctrl+C` and run `docker compose down`. To also delete persisted data, run `docker compose down -v`.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | API port exposed on the host by Compose. |
| `WEB_PORT` | `3001` | Next.js frontend port exposed on the host. |
| `MONGO_PORT` | `27018` | MongoDB port exposed on the host. |
| `REDIS_PORT` | `6380` | Cache Redis port exposed on the host. |
| `COUNTER_REDIS_PORT` | `6381` | Persistent counter Redis port exposed on the host. |
| `RABBITMQ_PORT` | `5672` | RabbitMQ AMQP port exposed on the host. |
| `RABBITMQ_MANAGEMENT_PORT` | `15672` | RabbitMQ management UI port. |
| `RABBITMQ_USER` | `shortly` | Local RabbitMQ user. |
| `RABBITMQ_PASSWORD` | Development-only password | Local RabbitMQ password. |
| `MONGODB_DB` | `url-shortener` | Database name used by the API. |
| `CACHE_ENABLED` | `true` | Enables or disables redirect caching. |
| `CLICK_EVENTS_MODE` | `outbox` | `outbox` uses MongoDB outbox + RabbitMQ worker; `direct` writes idempotent click events to MongoDB in the request, for serverless demo deployments. |
| `SHORT_CODE_SECRET` | Compose development secret | Shared secret used to permute IDs before Base62 encoding. |

Inside the Compose network, the API connects to MongoDB at `mongo:27017`, the cache at `redis:6379`, and the persistent counter at `redis-counter:6379`. The cache is disposable; the counter uses AOF with `appendfsync always` and the `redis_counter_data` volume. This favors write durability at the cost of counter-write latency. [Redis persistence documentation](https://redis.io/docs/latest/management/persistence/).

RabbitMQ stores the durable `url-shortener.click-events` queue in the `rabbitmq_data` volume. The API first writes each click to the MongoDB `click_outbox` collection and then returns a `302`, without waiting for RabbitMQ. A background dispatcher publishes pending events when the broker is available and marks them as published after a publisher confirmation. If it crashes between those steps, it may publish the event again; the worker uses `eventId` as the unique `_id` in `click_events`, so redelivery does not duplicate the recorded click. The worker acknowledges a message only after MongoDB persists it. Published outbox documents are retained for seven days; pending documents are retried with backoff and do not expire automatically. The local RabbitMQ management UI is at `http://localhost:15672`.

If RabbitMQ is unavailable, redirects continue while MongoDB can accept outbox writes. If an outbox write fails, the API still redirects and logs the error, but that click may be missing from analytics. `GET /api/v1/:shortCode/stats` returns the count persisted in `click_events`; it is eventually consistent.

For a serverless portfolio deployment, set `CLICK_EVENTS_MODE=direct`. The API writes each click to `click_events` using the event ID as MongoDB's unique `_id`, so persisting the same event again does not duplicate it. It does not start the RabbitMQ consumer or outbox dispatcher. Readiness reports `{ "status": "ready", "clickEvents": "direct" }`; MongoDB and the Redis counter remain required. This mode trades the queue and outbox workflow for simpler request-driven execution. The normal Compose mode remains `outbox` and demonstrates asynchronous delivery with RabbitMQ.

`GET /health/live` reports whether the process is running. `GET /health/ready` returns `503` if MongoDB or Redis is unavailable. If RabbitMQ is down, it still returns `200` with `"rabbitmq":"degraded"`, because click events can wait in the outbox. Compose waits for the API to become ready before starting the frontend and does not block API startup on RabbitMQ availability.

The counter also stores its highest allocated ID in MongoDB's `counters` collection. On startup, the API reconciles Redis with this checkpoint and the highest `numericId` in the URL collection. Each ID is checkpointed before its URL is inserted; failures may leave gaps, but persisted IDs should not be reused. Running `docker compose down -v` deletes the links and counter checkpoint.

The Compose secret is fixed for local development only. In production, set `SHORT_CODE_SECRET` to a random value of at least 32 bytes and use the same value across all API instances. Never commit this secret.

### Run the frontend locally

With MongoDB, Redis, and RabbitMQ accessible, configure the environment and start the API on port `3000`. Then open another terminal for the frontend:

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:3001`. The frontend uses `BACKEND_API_URL` in the Next.js server; its local default is `http://localhost:3000`. Compose sets it to `http://app:3000`. This variable stays on the server and is not exposed to the browser.

## Run the API locally

With MongoDB available at `localhost:27017`, configure the environment and start the server:

```bash
# Bash / macOS / Linux
export MONGODB_URI=mongodb://localhost:27017
export MONGODB_DB=url-shortener
export REDIS_URL=redis://localhost:6380
export COUNTER_REDIS_URL=redis://localhost:6381
export RABBITMQ_URL=amqp://shortly:shortly-local-password@localhost:5672
export SHORT_CODE_SECRET='use-a-stable-random-secret-of-at-least-32-bytes'
npm start
```

```powershell
# PowerShell
$env:MONGODB_URI = "mongodb://localhost:27017"
$env:MONGODB_DB = "url-shortener"
$env:REDIS_URL = "redis://localhost:6380"
$env:COUNTER_REDIS_URL = "redis://localhost:6381"
$env:RABBITMQ_URL = "amqp://shortly:shortly-local-password@localhost:5672"
$env:SHORT_CODE_SECRET = "use-a-stable-random-secret-of-at-least-32-bytes"
npm start
```

If your local MongoDB requires authentication, use a URI with the configured username, password, and authentication database. In Git Bash:

```bash
export MONGODB_URI='mongodb://<username>:<password>@localhost:27017/?authSource=admin'
npm start
```

Replace `<username>` and `<password>` with your MongoDB credentials. If the user was created in another database, adjust `authSource`. The API requires MongoDB and the counter Redis to start. The cache Redis is optional and can be unavailable; RabbitMQ reconnects in the background while click events wait in the outbox.

The server also accepts `PORT`, which defaults to `3000`. For local development, the Compose service `redis` exposes the cache on port `6380`, and `redis-counter` exposes the counter on port `6381`.

## Tests

Run the automated tests with:

```bash
npm test
```

The tests use an in-memory database and do not require MongoDB or Docker.

## API

The Next.js frontend provides a form to create and copy links, and shows the five most recent links saved in the current browser's `localStorage`. Short links open at `/{shortCode}` on the frontend domain, which proxies the redirect to the API.

### Create a short link

`POST /api/v1/shorten`

```bash
curl -X POST http://localhost:3000/api/v1/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/articles/system-design"}'
```

Response `201 Created`:

```json
{
  "shortenedUrl": "8GmP4dJr7Qk",
  "expiresAt": "2031-10-09T12:00:00.000Z"
}
```

HTTP and HTTPS URLs up to 2048 characters are accepted. Links expire after five years. The endpoint allows up to 10 link creations per minute per IP address; excess requests receive `429 Too Many Requests` and a `Retry-After` header.

### Redirect

`GET /api/v1/:shortCode`

A request such as `GET /api/v1/8GmP4dJr7Qk` records a click and returns `302 Found` to the destination. In `outbox` mode it first writes the event to MongoDB's outbox for asynchronous RabbitMQ delivery; in `direct` mode it writes idempotently to `click_events` in the request. Unknown or expired codes return `404`.

### Click count

`GET /api/v1/:shortCode/stats` returns the click count persisted in `click_events`. The result is eventually consistent in `outbox` mode because a background worker consumes the queue; in `direct` mode, the event is written before the redirect response when MongoDB is available.

## Architecture and decisions

```mermaid
flowchart LR
    Client[Browser] -->|create / open short link| Web[Next.js frontend]
    Web -->|proxy POST /api/v1/shorten| API[Express API]
    Web -->|proxy GET /api/v1/code| API
    API -->|cache hit| Redis[(Redis cache)]
    API -->|cache miss and writes| Mongo[(MongoDB)]
    API -->|global INCR + durable counter| Counter[(Redis counter)]
    API -->|recovery checkpoint| Mongo
    API -->|write outbox, then redirect| Mongo
    Mongo -->|dispatcher publishes pending events| Rabbit[(RabbitMQ durable queue)]
    Rabbit -->|worker consumes and deduplicates| Mongo
    API -->|302 to original URL| Web
    Web -->|302 to original URL| Client
```

- The frontend creates and copies links, and keeps the five most recent links in the current browser's `localStorage`.
- Next.js server routes proxy link creation and redirects to the API. `BACKEND_API_URL` is server-side configuration and is not exposed to the client.
- Each link gets a global `numericId` from Redis `INCR`. The operation is atomic in Redis; the ID and its durable checkpoint are also stored in MongoDB. [Redis `INCR` documentation](https://redis.io/docs/latest/commands/incr/).
- A keyed Feistel permutation transforms the ID before Base62 encoding, so the sequence is not directly exposed. Keep `SHORT_CODE_SECRET` identical across all API instances.
- MongoDB unique indexes protect `numericId` and `shortenedUrl`. If Redis is restored to an older counter value, the MongoDB checkpoint helps advance it before new IDs are issued.
- Redirects use `302` so requests continue to pass through the API and can be counted.
- Link expiration is checked on reads. A TTL index lets MongoDB remove expired documents in the background.
- Looked-up destinations are cached in Redis with a TTL no longer than the link's remaining lifetime. Cache failures fall back to MongoDB.
- The redirect writes the click to the MongoDB outbox before responding. A dispatcher publishes persistent messages to RabbitMQ and waits for publisher confirms; the worker saves the event under a unique `_id` before acknowledging it. If the dispatcher crashes after publishing but before marking the outbox row, it may publish again; the consumer's idempotent write deduplicates that case.
- If RabbitMQ is unavailable, clicks accumulate in the outbox and redirects continue. If MongoDB cannot accept the outbox write, the API still redirects, but that click may be missing from analytics.
- `GET /health/live` checks the process. `GET /health/ready` checks critical dependencies; RabbitMQ degradation is reported without marking the API unready because the outbox buffers events.
- Link-creation rate limiting is held in memory per process. With multiple API replicas, each replica would have its own limit; use shared storage such as Redis in that deployment.
- Compose is intended for local development. Configure MongoDB authentication and secure credentials in production.

### Local limitations and a path to high availability

Compose runs one instance of each component. MongoDB is a single node, RabbitMQ uses a durable classic queue without replication, and the counter Redis is a single instance. Volumes preserve data across container restarts, but do not protect against host failure or disk loss. Multiple containers on the same computer do not provide high availability either.

A possible production evolution would be:

- Run multiple stateless API instances behind a load balancer; also move rate limiting, currently in memory, to shared storage.
- Use a MongoDB replica set with three members across failure domains, and configure backups and recovery. [MongoDB replica set architectures](https://www.mongodb.com/docs/manual/core/replica-set-architectures/).
- Use a RabbitMQ cluster with a three-member quorum queue to replicate queue state. The Compose queue is durable, but it is not a quorum queue. [RabbitMQ quorum queues](https://www.rabbitmq.com/docs/quorum-queues).
- Use managed Redis with failover for the cache and counter, keeping the MongoDB counter checkpoint. Redis replication is asynchronous by default, so failover still involves consistency trade-offs. [Redis replication](https://redis.io/docs/latest/manual/replication/).
- Monitor the number and age of the oldest event in `click_outbox`, alert on backlog growth, and track dispatcher errors and retries. Pending events do not expire automatically; published events are removed after seven days.

The outbox prevents a RabbitMQ outage from interrupting redirects while MongoDB can still accept writes. MongoDB remains a critical dependency: if it is unavailable and the destination is not cached, the API cannot resolve the link. If the outbox write fails, the redirect still proceeds, but that click may be lost from analytics.
