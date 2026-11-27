# Run HoV Router in Docker

HoV Router publishes no container image. You build the image from a checkout of this repository, which compiles the dashboard and the `hov-router` binary inside Docker. Nothing from [tombii/better-ccflare](https://github.com/tombii/better-ccflare) is downloaded: the `ghcr.io/tombii/better-ccflare` image and its release binaries are upstream's, not this fork's.

You need Docker with BuildKit (any current Docker Engine or Docker Desktop). The build works on whatever platform your Docker host builds natively (amd64 or arm64); it is not cross-built.

## Build and run with Docker Compose

```bash
git clone https://github.com/StartupBros-com/hov-router.git
cd hov-router
docker compose up -d --build
```

Open <http://localhost:8080> and add accounts in the dashboard. Account sign-in that needs a browser (OAuth modes) works through the dashboard; the container has no browser for CLI-driven sign-in.

A fresh install with no accounts reports `unhealthy` on `/health` (HTTP 503) once the 40-second start period ends, because `/health` is `ok` only when at least one account can serve requests. Add an account and the container turns healthy.

The compose service and container are named `hov-router`, and the volume `hov-router-data`. Docker Compose prefixes the volume with the project name, which defaults to the checkout's directory name: the clone above stores its data in `hov-router_hov-router-data`. Run compose from the same directory (or with the same `COMPOSE_PROJECT_NAME`) to keep using that data. An install from before 8.0.0 used `better-ccflare` names; [move its data](#moving-an-install-from-before-800) before starting this one.

`docker compose` reads an optional `.env` file next to `docker-compose.yml` (see [`.env.example`](../.env.example)); it starts fine without one.

## Build and run with plain Docker

```bash
docker build -t hov-router:local .

docker run -d --name hov-router \
  --stop-timeout 90 \
  -p 8080:8080 \
  -v hov-router-data:/data \
  hov-router:local
```

`--stop-timeout 90` gives the server time to finish in-flight responses when the container stops; [Stopping the container](#stopping-the-container) explains why.

To label the build with its commit, pass the SHA. `/health` then reports it as `git_sha`:

```bash
docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" -t hov-router:local .
```

Pass settings with `-e NAME=value` or `--env-file .env`. The container runs `--serve --port 8080`; append other flags after the image name, for example `hov-router:local --serve --port 8080 --help`. `hov-router` is on the container's `PATH`.

## Stopping the container

On `docker compose stop`, `docker stop` or an upgrade, the server stops taking new requests and finishes the responses already in flight. It waits up to 60 seconds for them, then takes up to 15 seconds more to flush the database before it exits. Docker kills a container 10 seconds after asking it to stop unless told otherwise, which would cut most long model responses off mid-stream. So the compose file sets `stop_grace_period: 90s`, and the `docker run` example passes `--stop-timeout 90`.

To change how long the server waits, set `HOV_ROUTER_SHUTDOWN_DRAIN_MS` (milliseconds, up to 900000). Keep the stop grace longer than that value plus 15 seconds.

## Memory

The compose file limits the container to 1 GB (`deploy.resources.limits.memory`), and Docker OOM-kills a container that goes over its limit. That suits a small deployment. A busy one needs more: the managed systemd deployment peaked between 2.2 and 4.7 GB a run, page cache included. Watch `docker stats`, or the container's `memory.peak`, under your normal load and set the limit above the peak.

The 256 MB `reservations.memory` does not protect the router by itself. Compose sets it as the container's `memory.low` (checked with Compose v5.4.0 on cgroup v2), but the kernel caps a cgroup's protection at what its ancestors allow, and the cgroups Docker puts containers under have none by default. To keep other workloads on the host from reclaiming the router's memory, set `MemoryLow` on every ancestor as well. With Docker's systemd cgroup driver, that is `system.slice`, or each slice above a configured `cgroup-parent`; the container's path is in `/proc/$(docker inspect -f '{{.State.Pid}}' better-ccflare)/cgroup`. [Protection on a shared host](systemd.md#protection-on-a-shared-host) explains the rule and the sizing.

## What the image contains

- A two-stage build: the `oven/bun` builder (pinned to the Bun version in `.bun-version`) compiles with the same `bun run build` as a source checkout; the runtime stage is `debian:trixie-slim` (Debian 13, the current stable release) with `ca-certificates` and `curl` (for the health check) and the compiled binary.
- A non-root user, `hov-router` (uid 1000).
- Port 8080 and a `HEALTHCHECK` on `/health`.
- `/data`, a volume holding the database and config.

## Data, config and backups

| Variable | Value in the image |
| --- | --- |
| `HOV_ROUTER_DB_PATH` | `/data/hov-router.db` |
| `XDG_CONFIG_HOME` | `/data` (config lands in `/data/hov-router/hov-router.json`) |
| `HOV_ROUTER_LOG_DIR` | `/app/logs` |
| `NODE_ENV` | `production` |

All the usual settings (`LOG_LEVEL`, `LB_STRATEGY`, `STORE_PAYLOADS`, `PAYLOAD_ENCRYPTION_KEY`, `HEALTH_DETAIL_ENABLED`, and the rest) are described in [configuration](configuration.md) and work as environment variables here.

Back up with the container stopped, so SQLite has flushed its WAL. `--volumes-from hov-router` mounts whichever volume that container actually uses, whatever compose project created it, and the command refuses to write an archive when the database is missing:

```bash
docker compose stop
docker run --rm --volumes-from hov-router -v "$PWD":/backup debian:trixie-slim \
  sh -c 'test -f /data/hov-router.db && tar czf /backup/hov-router-data.tgz -C /data .'
docker compose start
```

To restore, stop the container and replace everything in its volume with the archive. The command checks that the archive is readable and contains the database before it deletes anything:

```bash
docker compose stop
docker run --rm --volumes-from hov-router -v "$PWD":/backup debian:trixie-slim \
  sh -c 'tar tzf /backup/hov-router-data.tgz ./hov-router.db >/dev/null && find /data -mindepth 1 -delete && tar xzf /backup/hov-router-data.tgz -C /data'
docker compose start
```

With plain Docker, use `docker stop` / `docker start`; the container in the example above has the same name, `hov-router`. To use a host directory instead of a named volume, mount it at `/data` and make it writable by uid 1000: `chown 1000:1000 ./data`.

## Health and provenance

`/health` reports `version`, `git_sha`, and a `distribution` block. A source build proves no release identity, so `distribution.proven` is `false` with reason `unknown_distribution`, and `git_sha` is the `GIT_SHA` you built with (`null` if you passed none). The update checker therefore never treats a locally built image as an upstream release.

## Upgrade

From the same checkout:

```bash
cd hov-router
git pull
docker compose up -d --build
```

The volume is untouched, and the database migrates on start.

### Moving an install from before 8.0.0

Release 8.0.0 renamed the compose service, container and volume from `better-ccflare` to `hov-router`, and the files inside the volume from `better-ccflare.*` to `hov-router.*` ([what was renamed](hov-router-migration.md#renamed-in-800)). The same steps move an install of this repository from before 8.0.0 and one from upstream's compose file (the one that ran `ghcr.io/tombii/better-ccflare:latest`). They copy the data into the new volume and leave the old volume as it was, which is your way back.

A container that still finds an old name stops at start with exit status 78 and lists each old name with its new one in `docker compose logs hov-router`. Compose's `restart: unless-stopped` restarts it anyway, so follow the steps before you start the new container.

1. Note the volume the old container uses, then stop it and back it up:

   ```bash
   docker inspect better-ccflare --format '{{ range .Mounts }}{{ .Name }}{{ end }}'
   docker stop better-ccflare
   docker run --rm --volumes-from better-ccflare -v "$PWD":/backup debian:trixie-slim \
     sh -c 'test -f /data/better-ccflare.db && tar czf /backup/better-ccflare-data.tgz -C /data .'
   ```

   The first command prints the volume, for example `hov-router_better-ccflare-data`. The steps below call it `<old-volume>`.

2. Remove the old container from the directory it ran from, keeping its volume (no `-v`). For this repository, do this before you update the checkout, while its compose file still names `better-ccflare`:

   ```bash
   cd /path/to/old-install
   docker compose down
   ```

3. Update the checkout (`git pull`), or clone this repository for an upstream install, then create the new container and its empty volume without starting them:

   ```bash
   cd hov-router
   docker compose create --build
   ```

4. Copy the old volume into the new one and rename the files. The copy stops without changing anything if the old volume has no database or the new one already has one:

   ```bash
   docker run --rm -v <old-volume>:/old:ro --volumes-from hov-router debian:trixie-slim sh -euc '
     test -f /old/better-ccflare.db
     test ! -e /data/hov-router.db
     cp -a /old/. /data/
     cd /data
     for f in better-ccflare.*; do mv -n "$f" "hov-router.${f#better-ccflare.}"; done
     if [ -d better-ccflare ]; then
       mv -T better-ccflare hov-router
       cd hov-router
       for f in better-ccflare.*; do if [ -e "$f" ]; then mv -n "$f" "hov-router.${f#better-ccflare.}"; fi; done
     fi
   '
   ```

   This renames the database with its `-wal` and `-shm` files together, which SQLite needs to keep changes it has not yet written into the database file.

5. Rename the variables in the `.env` file next to `docker-compose.yml`: `BETTER_CCFLARE_*`, `CCFLARE_*` and `ccflare_*` become `HOV_ROUTER_*` with the same ending, and `BETTER_CCFLARE_GIT_SHA` becomes `HOV_ROUTER_HEALTH_GIT_SHA`. This prints any left:

   ```bash
   sed -nE 's/^[[:space:]]*(export[[:space:]]+)?((BETTER_CCFLARE_|CCFLARE_|ccflare_)[A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' .env
   ```

6. Recreate the container so it captures the renamed environment, then check that the database is there:

   ```bash
   docker compose up -d --force-recreate
   docker compose exec hov-router ls -l /data/hov-router.db
   ```

   Your accounts appear in the dashboard as before. Keep `<old-volume>` until you are sure; `docker volume rm <old-volume>` then deletes it.

To go back to 7.0.0, run `docker compose down`, check out the `v7.0.0` tag and run `docker compose up -d --build` from the directory the old install used. It mounts `<old-volume>` again, as it was before step 4; anything the new container wrote stays in the new volume.

With plain Docker, the volume keeps its name and only the files inside it change. Stop the container, rename the files in place, then rebuild the image and start a new container as in [Build and run with plain Docker](#build-and-run-with-plain-docker):

```bash
docker stop hov-router
docker run --rm --volumes-from hov-router debian:trixie-slim sh -euc '
  cd /data
  test -f better-ccflare.db
  test ! -e hov-router.db
  for f in better-ccflare.*; do mv -n "$f" "hov-router.${f#better-ccflare.}"; done
  if [ -d better-ccflare ]; then
    mv -T better-ccflare hov-router
    cd hov-router
    for f in better-ccflare.*; do if [ -e "$f" ]; then mv -n "$f" "hov-router.${f#better-ccflare.}"; fi; done
  fi
'
docker rm hov-router
```

## Related

- [Deployment options](deployment.md), including the systemd service in [systemd](systemd.md).
- [Release policy](hov-router-releases.md): releases here are GitHub releases of the Linux x86_64 binary; no container image is part of them.
- [Acknowledgements](acknowledgements.md) for upstream credit.
