# Clira Clone — Implementation Documentation

This document explains every decision made while building this project: what we chose, why we chose it, how it works, and what problem it solves. Written phase by phase so you can read it alongside the code.

---

## Phase 0 — Monorepo Bootstrap

### What Phase 0 Is

Before a single line of application logic is written, the project needs a foundation: a repository structure that multiple apps and shared libraries can live in, a build system that orchestrates them intelligently, shared configuration so every package stays consistent, and local infrastructure (database + cache) that developers can spin up in one command.

Phase 0 is entirely setup — no business logic. But every decision here shapes how every subsequent phase gets built.

---

### Why a Monorepo?

The original Clira is a single Next.js app. Everything — the web server, the background workers, the cron jobs — lives in one `src/` folder and is separated only by a second `tsconfig.worker.json` file and some build-script tricks. That works, but it has friction:

- You can't build just the worker without also building the web app.
- You can't lint just the shared DB package.
- There's no clear boundary between "code that runs in an HTTP request" and "code that runs in a background job" — it's all one flat folder.
- Shared code between the web app and workers has no formal contract; it's just imported by path.

A **monorepo** solves all of this. Every app (`web`, `worker`, `cron`, `gmail-pull-worker`) and every shared library (`db`, `ai-core`, `agents`, etc.) is its own Node.js package with its own `package.json`. They can depend on each other explicitly, like any npm package. The build system knows the dependency graph and can parallelize builds, cache outputs, and rebuild only what changed.

Concretely, the tradeoff is:

| Approach | Pros | Cons |
|---|---|---|
| Single Next.js app (original) | Simple, fast to start | Blurry boundaries, no per-package caching, everything rebuilds together |
| Separate repos per service | Clear ownership | Massive coordination overhead, shared code must be published to npm |
| **Monorepo (chosen)** | Clear boundaries, shared code without publishing, intelligent caching | More initial setup |

For a project of this complexity (multiple long-running processes, 10+ shared packages), a monorepo is the right call.

---

### Why Turborepo?

We need a build system that understands which packages depend on which, so it can:

1. Build packages in the right order (can't build `agents` before `ai-core` if `agents` imports from `ai-core`).
2. Cache build outputs so re-running `build` after nothing changed takes milliseconds, not minutes.
3. Run tasks in parallel where there are no dependencies.

**Turborepo** is the industry-standard tool for this in the JavaScript/TypeScript ecosystem. Alternatives:

- **Nx**: More powerful, more complex configuration, heavier. Overkill for this project.
- **Lerna**: Mostly a package publishing tool, not a build orchestrator. Deprecated in favor of Turborepo/Nx for build tasks.
- **Raw npm/pnpm workspaces**: Give you dependency resolution but zero build orchestration — you'd have to write your own ordering logic.

Turborepo is the right size for what we need.

---

### Why pnpm?

pnpm is the package manager. Alternatives are npm and yarn. The reason pnpm wins:

1. **Content-addressable storage**: pnpm stores every package version once on disk and hard-links it into each project's `node_modules`. A monorepo with 15 packages that all depend on `typescript` installs typescript once, not 15 times. This saves significant disk space and install time.
2. **Strict by default**: pnpm won't let you import a package you haven't explicitly declared as a dependency (unlike npm, which hoists everything into the root `node_modules` making it easy to accidentally import things). This enforces cleaner dependency declarations.
3. **Native workspace support**: pnpm's workspace protocol (`workspace:*`) makes cross-package dependencies inside the monorepo explicit and easy to declare.
4. **Turborepo recommends it**: The two tools are designed to work well together.

---

### The `pnpm-workspace.yaml` File

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

This is the only file pnpm needs to understand the monorepo. It tells pnpm: "every directory inside `apps/` and `packages/` is a workspace package." When any package declares `"@clira/db": "workspace:*"` as a dependency, pnpm resolves it to the local `packages/db` directory instead of going to the npm registry. This is how shared code works across the monorepo without publishing anything.

---

### The Root `package.json`

```json
{
  "name": "clira-clone",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    ...
  }
}
```

Key points:

- **`"private": true`**: Prevents accidentally publishing the root package to npm. The root is an orchestration shell, not a publishable library.
- **Scripts delegate to `turbo run`**: When you run `pnpm build` at the root, Turborepo takes over, reads the dependency graph, and runs `build` in the correct order across all packages. You never run `tsc` directly at the root.
- **`"packageManager": "pnpm@9.12.3"`**: Pins the exact pnpm version. This means anyone cloning the repo gets the same pnpm behavior. Node.js's `corepack` feature can enforce this automatically.
- **`"engines"`**: Documents the minimum Node.js and pnpm versions required. Fails fast with a clear error if someone tries to install with an old version.
- **Only dev tools at the root level**: `turbo`, `prettier`, `typescript`. Application dependencies live in their respective package's `package.json`, not here.

---

### The `turbo.json` File

This is the brain of the build system. It defines **tasks** and their **relationships**.

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", ".env*"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    ...
  }
}
```

Breaking down each task:

**`build`**
- `"dependsOn": ["^build"]` — The `^` prefix means "run `build` in all dependency packages first." So if `apps/web` depends on `packages/db`, Turborepo builds `packages/db` before `apps/web`. This is the core dependency-aware build ordering.
- `"inputs": ["$TURBO_DEFAULT$", ".env*"]` — Turborepo hashes these files to decide if the cache is still valid. `$TURBO_DEFAULT$` means all source files tracked by git. Adding `.env*` means an environment variable change invalidates the cache.
- `"outputs": [".next/**", "!.next/cache/**", "dist/**"]` — These are the files Turborepo stores in its cache. On a cache hit, it just restores these files instead of running the build again.

**`dev`**
- `"cache": false` — Dev servers are long-running processes, not one-shot commands. Caching them makes no sense.
- `"persistent": true` — Tells Turborepo this task runs forever (doesn't exit). This prevents Turborepo from waiting for it to complete before starting dependent tasks.

**`typecheck`**
- `"dependsOn": ["^build", "^typecheck"]` — Before typechecking a package, you need all its dependencies to be built (so their `.d.ts` type declaration files exist) AND typechecked themselves. This enforces type correctness propagates through the dependency graph.

**`db:generate`** and **`db:migrate:dev`**
- `"cache": false` — These Prisma commands write to disk and interact with a database. They should always run fresh; caching their output would be misleading and potentially dangerous.
- `"outputs"` for `db:generate` — The generated Prisma client (`node_modules/.prisma/**`) and any generated types should be cached so other packages that depend on `@clira/db` can get the generated types without re-running `prisma generate`.

---

### The Folder Structure

```
apps/
  web/              ← Next.js: UI, API routes, webhooks
  worker/           ← BullMQ: background job consumers
  gmail-pull-worker/← Gmail: history.list polling fallback
  cron/             ← node-cron: scheduled recurring jobs
packages/
  config/           ← Shared tooling config (tsconfig, eslint, tailwind)
  db/               ← Prisma schema + generated client
  ai-core/          ← AI SDK wrappers (the LLM abstraction layer)
  agents/           ← The actual AI agents (Planner, Style, Executive)
  schemas/          ← Zod schemas shared across agents and API
  queues/           ← BullMQ queue definitions + job types
  channels/         ← Gmail, WhatsApp, Telegram, Twilio adapters
  mcp-client/       ← MCP (Model Context Protocol) connection manager
  encryption/       ← AES-256-GCM helpers for tokens + email content
  ui/               ← Shared React components
```

**Why `apps/` vs `packages/`?**

The distinction is conceptual but important:
- **`apps/`** — Things that run as processes. They consume packages, they are not consumed by other packages.
- **`packages/`** — Libraries. They export code that apps and other packages import.

This mirrors the structure used by major open-source monorepos (Vercel, Supabase, etc.) and makes it immediately clear where business logic lives vs. where it's consumed.

**Why split `worker`, `gmail-pull-worker`, and `cron` into separate apps instead of one?**

The original Clira runs all three in a single process. We split them for these reasons:

1. **Independent scaling**: The reply-generation worker is CPU/LLM-bound. The Gmail poller is I/O-bound (polling an API). The cron jobs are lightweight. In production, you can run more instances of the worker while running just one instance of cron.
2. **Independent failure**: If the reply worker crashes, the Gmail poller keeps running. In a combined process, one uncaught exception takes down everything.
3. **Clear responsibility**: Looking at the codebase, it's immediately obvious that `apps/cron/src/index.ts` is where scheduled jobs live. No hunting through a monolithic `src/` folder.
4. **Turborepo build caching**: Each app gets its own build cache. Changing a cron job doesn't invalidate the worker's cache.

---

### `packages/config` — Shared Tooling Configuration

Every package in the monorepo needs TypeScript configuration, ESLint rules, and (for UI packages) Tailwind configuration. Instead of copy-pasting these into every package, we centralize them in `packages/config` and have each package extend them.

**`tsconfig.base.json`** — The shared TypeScript configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022",
    "declarationMap": true,
    "incremental": true
  }
}
```

Why each flag matters:

- **`"strict": true`** — Enables TypeScript's entire suite of strict checks. This is non-negotiable for a production codebase. Without it, TypeScript is half as useful.
- **`"strictNullChecks": true`** — Already included in `strict`, but called out explicitly: `null` and `undefined` are not assignable to other types unless you explicitly say so. This eliminates an entire class of runtime crashes.
- **`"noUncheckedIndexedAccess": true`** — When you access an array by index (`arr[0]`), TypeScript normally assumes it exists. With this flag, `arr[0]` returns `T | undefined`, forcing you to handle the case where the index doesn't exist. This catches real bugs in agent loops where tool results are iterated.
- **`"noImplicitReturns": true`** — Every code path in a function that declares a return type must actually return a value. Prevents accidentally returning `undefined` from a function that promises to return a string.
- **`"moduleResolution": "bundler"`** — Modern TypeScript projects built with Vite, esbuild, or Next.js should use `"bundler"` resolution. It matches how modern bundlers actually resolve imports (supporting bare specifiers, exports maps, etc.) without the legacy `node` resolution quirks.
- **`"module": "ESNext"` + `"target": "ES2022"`** — Emit modern JavaScript. We're running on Node.js 20+ which natively supports ES2022. No need to downcompile to ES5.
- **`"declarationMap": true`** — Generates `.d.ts.map` files alongside `.d.ts` declaration files. This means when you "Go to definition" on a type from `@clira/db` while inside `apps/web`, your editor jumps to the actual TypeScript source, not the compiled `.d.ts`. Essential for developer experience in a monorepo.
- **`"incremental": true`** — TypeScript saves a cache file (`.tsbuildinfo`) after each compilation and only recompiles changed files on subsequent runs. In a monorepo with many packages, this makes typechecks 2-10x faster.

Each package's `tsconfig.json` then extends this base:
```json
{ "extends": "@clira/config/tsconfig" }
```
...and adds only what's specific to that package (like `"jsx": "react-jsx"` for UI packages, or `"lib": ["dom"]` for the web app).

**`tailwind.preset.ts`** — The shared Tailwind theme

Rather than copy-pasting the full Tailwind color palette into `apps/web/tailwind.config.ts` and `packages/ui/tailwind.config.ts`, we define CSS custom property-based colors once here. Every color references a CSS variable (`hsl(var(--background))`), which means:
1. The actual color values are set in CSS (in `globals.css`), not in the Tailwind config.
2. Dark mode is just switching the CSS variables — no Tailwind "dark:" prefixes needed for theming.
3. Any package using this preset gets the same design tokens automatically.

---

### The `apps/web` Next.js App

**Why Next.js 15 with App Router?**

- **App Router** (introduced in Next.js 13, stable in 14/15) is the modern Next.js paradigm. It uses React Server Components, which can fetch data on the server without client-side JavaScript, and uses file-system routing inside `src/app/`. The alternative is Pages Router (the old `src/pages/` model), but all new Next.js projects should use App Router — it will eventually replace Pages Router.
- **React Server Components** are important for this project because many pages (draft queue, approval modal) will load data directly from the database without an intermediate API call. Server Components handle this natively.
- Next.js 15 also ships with Turbopack as the dev bundler (fast HMR), improved caching control, and better TypeScript support.

**`next.config.ts`**

```ts
const nextConfig: NextConfig = {
  transpilePackages: ["@clira/ui", "@clira/db"],
};
```

`transpilePackages` tells Next.js to run these workspace packages through its own Babel/SWC transpiler rather than assuming they're pre-built CommonJS modules. This is necessary because `@clira/ui` and `@clira/db` are TypeScript source files (they point `"main"` at `.ts` files, not `.js`), not compiled packages. Without this, Next.js would try to import `.ts` files as-is and fail.

**`postcss.config.js` + `tailwind.config.ts`**

Tailwind CSS works by scanning your source files for class names and generating only the CSS that's actually used. The `content` array in `tailwind.config.ts` tells Tailwind where to look:

```ts
content: [
  "./src/**/*.{ts,tsx}",          // web app's own files
  "../../packages/ui/src/**/*.{ts,tsx}", // shared components
]
```

Including the UI package path is important — if `packages/ui` uses a Tailwind class that `apps/web/src` doesn't, Tailwind would normally prune it from the final CSS. Including both paths ensures all used classes are included.

**App Router file structure (`src/app/`)**

- **`layout.tsx`** — The root layout. In App Router, every route is wrapped by the nearest `layout.tsx` in its directory tree. The root layout defines the `<html>` and `<body>` tags, imports global CSS, and sets metadata (page title, description). This runs once on the server per request for SSR routes.
- **`page.tsx`** — The root page (`/`). In App Router, every file named `page.tsx` is a route. This is the homepage.
- **`globals.css`** — The global stylesheet, imported once in the root layout. Contains the CSS custom properties (variables) that define the design system colors. The `@tailwind base/components/utilities` directives inject Tailwind's generated CSS.

---

### The Background Process Apps

**`apps/worker/src/index.ts`**

The BullMQ worker process. Currently just a placeholder that logs a startup message and handles `SIGTERM` gracefully. In Phase 4, this will import BullMQ `Worker` instances for each job queue and register handlers for each job type.

The `SIGTERM` handler is not optional — it's how Docker and Kubernetes tell a process to shut down cleanly. Without it, a running job would be killed mid-execution when the container restarts, corrupting state. With it, the worker can finish the current job and then exit.

**`apps/gmail-pull-worker/src/index.ts`**

A separate process that polls Gmail's `history.list` API to catch emails that weren't delivered via push notifications (Pub/Sub). Google's push delivery has a failure rate — this is the fallback that reconciles any gaps. Kept separate from the main worker because its polling loop needs to run on its own schedule, independent of job queue load.

**`apps/cron/src/index.ts`**

```ts
import cron from "node-cron";

cron.schedule("* * * * *", () => {
  console.log("[cron] reminder sweep tick");
});
```

Uses `node-cron` (cron expression syntax: `* * * * *` = every minute) for time-based jobs that don't fit the event-driven BullMQ model. Things like:
- Sweeping for reminders that are due (run every minute)
- Triggering batch-sort jobs at off-peak hours
- Cleaning up expired `PendingCalendarChange` and `PendingMcpAction` rows

Why `node-cron` instead of BullMQ's `repeat` feature? BullMQ can also schedule repeating jobs, but for simple "run every X minutes" tasks without queueing semantics (no retries, no concurrency, no distributed workers), `node-cron` is simpler and more readable. BullMQ's repeat is better when you need the job to run on a distributed fleet of workers; `node-cron` is better when you want one designated "scheduler" process.

---

### `packages/db` — Database Package

The database package wraps Prisma (the ORM we're using). In Phase 0, it's a stub — just the `package.json` declaring Prisma as a dependency and `src/client.ts` as an empty placeholder. The full Prisma schema and client are built in Phase 1.

**Why Prisma?**

Prisma is a TypeScript-first ORM that:
1. Generates a fully typed client from your schema — every query is type-safe, every field is autocompleted.
2. Has a migration system (`prisma migrate dev`) that generates SQL migrations from schema changes and keeps migration history in version control.
3. Works well with Postgres and has first-class support for the `@prisma/adapter-pg` that lets you swap the underlying driver (important for edge/serverless environments).

**Why `@prisma/adapter-pg`?**

The original Clira uses `@prisma/adapter-pg` (the pg driver adapter) instead of Prisma's default binary engine. The adapter:
- Connects via a `pg.Pool` (standard Postgres connection pool) instead of Prisma's bundled Rust query engine binary.
- Is more predictable in Docker environments (no binary compatibility issues).
- Is the preferred path for serverless/edge deployments.

---

### The Remaining Package Stubs

Every package in `packages/` (except `config` and `db`) follows the same pattern in Phase 0:

```
packages/<name>/
  package.json    ← declares name, deps, and "main"/"types" pointing at ./src/index.ts
  tsconfig.json   ← extends @clira/config/tsconfig
  src/index.ts    ← a single comment explaining what gets implemented in which phase
```

Why create all of them now even though they're empty?

1. **Workspace resolution works immediately.** Any app that declares `"@clira/ai-core": "workspace:*"` can import from it without waiting for Phase 2. The import will be empty, but it won't break.
2. **`pnpm install` sets up symlinks now.** The `node_modules` in each package are linked correctly from the start. Adding real code in later phases won't require any plumbing changes.
3. **Turborepo's graph is established now.** It knows all the packages exist and can cache their tasks from the first build.
4. **The architecture is visible.** Looking at the `packages/` directory tells you the full shape of the system, even before any logic is written.

---

### Docker Compose — Local Infrastructure

**`docker/docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ...
  redis:
    image: redis:7-alpine
    ...
```

**Why `pgvector/pgvector:pg16` and not plain `postgres:16`?**

The inbox search feature uses vector embeddings stored in Postgres via the `pgvector` extension. `pgvector` adds a new column type (`vector(768)`) and new index types (HNSW, IVFFlat) for similarity search. The `pgvector/pgvector:pg16` image is the official Postgres 16 image with `pgvector` pre-installed. Using plain `postgres:16` would require a custom Dockerfile or an init script to `CREATE EXTENSION vector` — and even then, the extension binary wouldn't be present. Starting with the right image from the beginning means Phase 1 can enable the extension with a single SQL migration line.

**Why Redis?**

BullMQ (the job queue library) uses Redis as its backing store. Every job enqueued (`addJob()`), every job consumed (`Worker`), every retry, every delayed job — all tracked in Redis data structures. Redis is the right choice here because:
- It's extremely fast for the tiny metadata payloads BullMQ stores (job IDs, status, attempts).
- Its pub/sub and keyspace notification features power BullMQ's real-time `QueueEvents` (used for SSE streaming job status to the frontend).
- It's ephemeral by design — if you lose your Redis state, jobs that haven't been processed are lost, but no persistent application data is affected (that all lives in Postgres).

**Health checks**

Both services have health checks defined:
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U clira -d clira_dev"]
  interval: 5s
  timeout: 5s
  retries: 5
```

This matters for `depends_on` in the production `docker-compose.yml` — services that depend on Postgres won't start until Postgres is actually accepting connections, not just until the container is running. Without health checks, a web or worker container can start before Postgres is ready and crash on the first DB query.

**Why two compose files (`docker-compose.dev.yml` vs `docker-compose.yml`)?**

- `docker-compose.dev.yml` — Only infrastructure (Postgres + Redis). The apps run on your host machine (`pnpm dev`), not in Docker. This gives you fast hot-reload without Docker's file-watching overhead.
- `docker-compose.yml` — Full production stack including the web app, worker, and infrastructure, using `profiles` (`core`, `backfill`) to let you opt into optional services. This is what you'd use on a VPS or for integration testing.

---

### The `.env.example` File

Documents every environment variable the system needs, grouped by concern, with instructions for generating secret values. Developers copy this to `.env` and fill in their values. The actual `.env` is gitignored — you never commit secrets. `.env.example` is committed and serves as the canonical list of required configuration.

Key variable groups:

| Group | Variables | Purpose |
|---|---|---|
| Database | `DATABASE_URL` | Prisma connection string |
| Redis | `REDIS_URL` | BullMQ connection |
| Auth | `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | NextAuth session signing |
| Google | `GOOGLE_CLIENT_ID/SECRET`, `GMAIL_PUBSUB_TOPIC` | OAuth + Gmail push |
| Encryption | `EMAIL_ENCRYPT_SECRET`, `EMAIL_ENCRYPT_SALT` | AES-256-GCM key derivation |
| AI | `AI_PROVIDER`, `GOOGLE_GENERATIVE_AI_API_KEY` | LLM provider selection |
| Cron | `CRON_SECRET` | Bearer token for HTTP-triggered cron endpoints |
| Channels | Telegram, WhatsApp, Twilio tokens | Optional messaging integrations |

---

### The `.gitignore` File

Key entries explained:

- `node_modules/` — Never commit dependencies; they're always re-installed from `pnpm-lock.yaml`.
- `.next/` — Next.js build output. Regenerated by `next build`.
- `.turbo/` — Turborepo's local build cache. Fast to regenerate, no value in git history.
- `*.tsbuildinfo` — TypeScript incremental compilation cache files. Local only.
- `.env`, `.env.local` — Secret values. Never committed.
- `packages/db/src/generated/` — Prisma's generated client code. Always regenerated from the schema via `prisma generate`; committing it causes merge conflicts and drift.

---

### The `.prettierrc` File

```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
```

Prettier enforces consistent formatting across the entire codebase automatically. These specific settings:
- `"semi": true` — Semicolons at end of statements. More explicit, less surprising.
- `"singleQuote": false` — Double quotes for strings. Consistent with JSON, HTML attributes, and JSX.
- `"trailingComma": "es5"` — Add trailing commas in multi-line objects/arrays (valid in ES5+). Makes git diffs cleaner: adding a new item to an array doesn't modify the previous last line (no comma added).
- `"printWidth": 100` — Lines up to 100 characters before Prettier wraps them. 80 is too narrow for TypeScript with long type annotations; 100 is a good balance.

---

### Phase 0 — Verify Checklist

At the end of Phase 0, the following must be true:

- [ ] `pnpm install` at the root succeeds with no errors.
- [ ] `find . -name "package.json" -not -path "*/node_modules/*"` shows 16 package.json files (1 root + 4 apps + 11 packages).
- [ ] `docker compose -f docker/docker-compose.dev.yml up -d` starts Postgres and Redis with health checks passing.
- [ ] `pnpm --filter @clira/web dev` starts the Next.js dev server on port 3000.
- [ ] `http://localhost:3000` shows the "Clira" heading.

All five are confirmed. Phase 0 is complete.

---

## What Comes Next

**Phase 1 — Schema (`packages/db`)**

Port the full Prisma schema from the original Clira repository. This involves 9 logical migration groups covering: identity/auth, email core, search/embeddings (with pgvector), agent output, approval-gated actions, the MCP subsystem, reminders/audit, and messaging channels.

The key thing to understand going into Phase 1: **every subsequent phase depends on the schema**. The agents store their trace spans in the schema. The queues reference job IDs that map to schema rows. The channel adapters write to schema tables. Getting the schema right in Phase 1 is the highest-leverage work in the project.
