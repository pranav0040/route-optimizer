# AWS EC2 Deployment Runbook

This document summarizes the AWS deployment work completed for the Route Optimizer project and the commands needed to maintain it.

## Current deployment

- Provider: AWS EC2, Ubuntu
- Recorded public IP: `15.252.109.67`
- Application URL: <http://15.252.109.67>
- Project directory on EC2: `/home/ubuntu/route-optimizer`
- SSH key on the Windows development machine: `C:\Users\geeky\Downloads\route-optimizer.pem`
- Deployment method: Docker Compose
- AWS account: free plan with approximately $200 in credits at the time of setup

AWS credits cover eligible usage only until the credits or free-plan period expire. Continue checking the Billing and Cost Management dashboard and keep budget alerts enabled.

## Architecture

The Compose stack contains:

- Angular frontend served by Nginx on host port `80`
- Express API on host port `3000`
- Background routing worker
- PostgreSQL/PostGIS on host port `5432`
- Redis on host port `6379`
- A one-shot migration service

PostgreSQL and Redis use named Docker volumes. A normal rebuild or restart preserves their data.

## Recommended EC2 settings

- Use a small burstable instance appropriate for the available credits. This deployment was running with about 2 GiB RAM and a 4 GiB swap file.
- Use an EBS root volume with the general-purpose `gp3` type. No additional file system is required for the current setup.
- For T-family CPU credit specification, use **Standard** to avoid unexpected unlimited-mode surplus CPU charges.
- Assign an Elastic IP if the public IP must remain stable across stop/start cycles.
- Configure billing budgets and cost-anomaly monitoring.

### Security group inbound rules

Allow only:

- SSH (`22`) from your own public IP
- HTTP (`80`) from users who need access
- HTTPS (`443`) when TLS is configured

Do not expose API port `3000`, PostgreSQL port `5432`, or Redis port `6379` publicly. The current Compose file publishes these ports on the instance, so the EC2 security group must block public access to them. A future hardening change should remove the unnecessary PostgreSQL and Redis host port mappings or bind internal services to `127.0.0.1`.

## Connect from Windows PowerShell

Restrict the PEM file permissions once:

```powershell
icacls "C:\Users\geeky\Downloads\route-optimizer.pem" /inheritance:r
icacls "C:\Users\geeky\Downloads\route-optimizer.pem" /grant:r "$($env:USERNAME):(R)"
```

Connect to EC2:

```powershell
ssh -i "C:\Users\geeky\Downloads\route-optimizer.pem" ubuntu@15.252.109.67
```

If the address stops working, check the instance's current public IPv4 address in the EC2 console. An Elastic IP prevents that address from changing.

## Docker installation and GPG-key fix

Docker Engine and Docker Compose were installed successfully. The test below produced the expected `Hello from Docker!` response:

```bash
docker version
docker compose version
docker run --rm hello-world
```

During installation, `apt update` initially failed with:

```text
NO_PUBKEY 7EA0A9C3F273FCD8
```

The Docker signing key was installed at `/etc/apt/keyrings/docker.gpg`, and the Docker source was configured to use it:

```text
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.gpg
```

Useful verification commands:

```bash
grep Signed-By /etc/apt/sources.list.d/docker.sources
ls -lh /etc/apt/keyrings/docker.gpg
gpg --show-keys /etc/apt/keyrings/docker.gpg
sudo apt update
```

The installed key identified `Docker Release (CE deb) <docker@docker.com>`, after which Docker installed and ran correctly.

## Application configuration

Create `/home/ubuntu/route-optimizer/.env` from `.env.example` and keep all secrets out of Git. Important production values include:

```dotenv
FRONTEND_PORT=80
API_BASE_URL=/api
CORS_ORIGIN=http://15.252.109.67
RATE_LIMIT_MAX=100
TRUST_PROXY_HOPS=1
```

Use a strong PostgreSQL password in the real `.env`. When a domain and HTTPS are configured, update `CORS_ORIGIN` to the final HTTPS origin.

Rate limiting should remain enabled because this is a public API. The present default allows 100 requests per configured window; adjust it based on legitimate traffic and monitor API logs.

## Upload the Bengaluru map extract

Run this as one line in Windows PowerShell:

```powershell
scp -i "C:\Users\geeky\Downloads\route-optimizer.pem" "C:\Users\geeky\Documents\RESUME PROEJCTS\Route optimizer\data\Bengaluru.osm.pbf" ubuntu@15.252.109.67:/home/ubuntu/route-optimizer/data/
```

The upload completed successfully. Verify it on EC2:

```bash
cd ~/route-optimizer
ls -lh data/Bengaluru.osm.pbf
free -h
```

At deployment time, the file was approximately 2.5 MiB. The instance reported about 1.9 GiB RAM and 4 GiB swap.

## Initial build and database setup

From the repository directory on EC2:

```bash
cd ~/route-optimizer
docker compose up --build -d
docker compose ps
docker compose logs migrate
```

The migration service successfully applied:

- `001_create_road_graph.sql`
- `002_create_routes_and_jobs.sql`
- `003_add_route_geometry.sql`

All long-running containers became healthy: `frontend`, `api`, `worker`, `postgres`, and `redis`. The migration container is expected to exit successfully after applying migrations.

## Import the road graph

Run:

```bash
cd ~/route-optimizer
docker compose run --rm migrate node dist/scripts/ingest-osm.js /data/Bengaluru.osm.pbf
docker compose restart api worker
```

The completed import reported:

```text
nodeCount: 150265
edgeCount: 317487
componentCount: 309
largestComponentNodeCount: 148646
```

The warning about 309 disconnected components is not an import failure. Small disconnected road groups are normal in OSM-derived data. At runtime, both the API and worker loaded all 150,265 nodes and 317,487 edges. The runtime routable component contained 147,028 nodes; this can differ from the ingestion summary because the runtime routing graph applies directed reachability rules.

## Verify the live deployment

Open:

<http://15.252.109.67>

On EC2, run:

```bash
cd ~/route-optimizer
docker compose ps
curl http://127.0.0.1/api/health
docker compose logs --tail=50 api worker frontend
docker stats --no-stream
```

Repeated successful `/health` requests in API logs are generated by the Docker health check and are normal. An older worker log showing `graphNodes: 0` was recorded before the post-import restart; later logs confirmed that the graph loaded correctly.

## Enable HTTPS with DuckDNS

The production hostname is `pranav-route-optimizer.duckdns.org`, pointing to the Elastic IP `15.252.109.67`. In the EC2 security group, allow inbound TCP ports `80` and `443`. Keep port `80` open because Caddy uses it for certificate validation and redirects it to HTTPS.

Update the deployment's `.env` values:

```dotenv
FRONTEND_PORT=8080
FRONTEND_BIND_ADDRESS=127.0.0.1
SITE_ADDRESS=pranav-route-optimizer.duckdns.org
CORS_ORIGIN=https://pranav-route-optimizer.duckdns.org
```

Then start the HTTPS profile:

```bash
cd ~/route-optimizer
docker compose --profile https up --build -d
docker compose --profile https ps
docker compose logs --tail=100 caddy
```

Caddy obtains and renews the TLS certificate automatically, serves the site on port `443`, and redirects HTTP requests to HTTPS. Verify both the application and API:

```bash
curl -I https://pranav-route-optimizer.duckdns.org
curl https://pranav-route-optimizer.duckdns.org/api/health
```

Use <https://pranav-route-optimizer.duckdns.org> as the public application URL after certificate issuance succeeds.

## Deploy future GitHub changes

First, commit and push changes from the development machine:

```powershell
git status
git add <changed-files>
git commit -m "feat: describe the change"
git push origin main
```

Then connect to EC2 and update the deployment:

```bash
cd ~/route-optimizer
git status --short
git pull --ff-only origin main
docker compose --profile https up --build -d
docker compose --profile https ps
```

Verify the update:

```bash
curl http://127.0.0.1/api/health
docker compose logs --tail=50 api worker frontend
```

`docker compose up --build -d` rebuilds the images and recreates services whose configuration or images changed. It also preserves the PostgreSQL and Redis volumes and the map file stored under the repository's `data/` directory.

If new database migrations were added, confirm that the `migrate` service completed successfully:

```bash
docker compose logs migrate
```

If the OSM file itself is replaced, repeat the road-graph import and restart the graph consumers:

```bash
docker compose run --rm migrate node dist/scripts/ingest-osm.js /data/Bengaluru.osm.pbf
docker compose restart api worker
```

Normal frontend, backend, or routing-code changes do not require re-importing the map.

## Safe operational commands

```bash
# Show container state
docker compose ps

# Follow application logs
docker compose logs -f api worker frontend

# Restart application services
docker compose restart api worker frontend

# Stop the stack while preserving data
docker compose down

# Start it again
docker compose up -d
```

Never use the following command unless intentionally deleting the database and Redis data:

```bash
docker compose down -v
```

## Recommended next improvements

1. Attach a domain name and configure HTTPS.
2. Remove public host mappings for PostgreSQL and Redis, and route API traffic only through Nginx.
3. Keep rate limiting enabled and tune it after observing real traffic.
4. Add automated PostgreSQL backups.
5. Add a GitHub Actions deployment workflow only after creating a narrowly scoped deployment credential.
6. Continue monitoring AWS budgets, credits, storage, and public IPv4 charges.

