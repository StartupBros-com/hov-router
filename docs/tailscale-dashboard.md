# Tailscale dashboard access

An operator can open the dashboard through Tailscale Serve without entering or
saving a Router API key in their browser. This is an opt-in authentication mode
for the managed guard/runner deployment on Unix. It does not disable API-key
authentication or create a new API key.

Tailscale authenticates the connecting device and supplies its user's login.
Router grants dashboard admin access only to explicitly allowed logins arriving
through a dedicated private Unix socket. The ordinary HTTP listener does not
trust Tailscale identity headers, forwarded addresses, or a localhost peer.

## What stays unchanged

- AI clients still send their existing Router API keys. Dashboard identity never
  authorizes inference, including an unmatched API route that falls through to
  the proxy.
- Explicit API-key or Bearer credentials keep their existing role and validity
  checks. An API-only key is not upgraded to admin by Tailscale identity.
- The ordinary guard listener, direct backend listener, and public routes retain
  their existing authentication behavior.
- With these settings absent, the extra socket does not exist.
- Keep at least one active API key. As before, removing the last active key opens
  ordinary API and proxy access; this feature is not a replacement for protecting
  those other entry points.

## Trust boundary

The private socket must be reachable only by the Router service user and the
local Tailscale daemon. Its existing parent directory must be owned by the guard
user and have mode `0700`; the socket itself is created with mode `0600`. Only
Tailscale Serve should forward remote traffic to it. Processes with the same OS
user or root remain trusted, as they already have access to Router's database
and credentials.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) removes
caller-supplied identity headers before adding the verified identity. Funnel
traffic does not carry an authenticated user and cannot receive automatic
dashboard access. Tagged devices without a user identity must continue to use
an API key.

The guard strips raw Tailscale identity headers on both entry points. After
checking the private ingress, login allowlist, and browser origin, it sends the
backend a short-lived proof bound to the request method and exact path/query.
The proof uses the existing managed guard credential and rotates with the
backend handoff. It is not exposed to the browser, providers, or stored request
headers. Logs, requests, and alerts streams authenticate their connection again;
a token minted without an API key cannot authenticate through ordinary ingress.

## Configuration

Set all three variables in the managed service's environment:

| Variable | Value |
| --- | --- |
| `HOV_ROUTER_TAILSCALE_SOCKET` | Absolute Unix socket path in a private directory, for example `/run/hov-router-dashboard/http.sock` |
| `HOV_ROUTER_TAILSCALE_ORIGIN` | Exact HTTPS origin of the dashboard, without a trailing slash, path, query, or fragment |
| `HOV_ROUTER_TAILSCALE_USERS` | Comma-separated, exact Tailscale login names allowed to administer the dashboard |

Login names are case-sensitive ASCII strings, not display names, device names,
or wildcard patterns. Read the connecting device's identity from Tailscale;
do not guess it from the device name. Partial or malformed settings refuse
startup rather than opening an unauthenticated listener. The managed runner
already supplies the internal signing credential; do not invent or publish one.

For a systemd deployment, a separate drop-in can provide the private runtime
directory and environment. Replace the example origin and login with the
installation's actual values:

```ini
[Service]
RuntimeDirectory=hov-router-dashboard
RuntimeDirectoryMode=0700
Environment="HOV_ROUTER_TAILSCALE_SOCKET=/run/hov-router-dashboard/http.sock"
Environment="HOV_ROUTER_TAILSCALE_ORIGIN=https://router.example.ts.net"
Environment="HOV_ROUTER_TAILSCALE_USERS=operator@example.com"
```

Keep host-specific identities and settings out of the repository. Do not change
the deployment script's pinned-build drop-in. The private socket is served by
the existing guard, so it participates in the same admission, backend-handoff,
and shutdown lifecycle rather than bypassing it.

## Activate and verify

1. Deploy a merged revision containing this feature using the repository's
   deployment script. Configure the service drop-in, reload systemd, and obtain
   approval for a full service restart before activating it. Adding these
   environment settings requires a **full restart**, even if a later deploy
   check otherwise reports backend-only: an existing runner cannot inherit new
   environment values.
2. Verify the ordinary guard `/health` endpoint is healthy and that the private
   socket exists with the expected ownership and permissions. A pre-existing
   socket or file at that path is not overwritten. Resolve it deliberately if
   startup reports it; never delete an unidentified path to make startup pass.
3. Point only the intended private HTTPS handler at the socket. Tailscale versions
   with Unix-socket Serve support accept:

   ```bash
   tailscale serve --bg --https=443 unix:/run/hov-router-dashboard/http.sock
   ```

   Inspect `tailscale serve status --json` before and after the change. Preserve
   unrelated ports, paths, and services. Do not enable Funnel for this handler.
4. From an allowed device, open `/accounts` in a fresh browser profile. It should
   load without a key prompt. A credential-free `GET /api/config/strategy`
   through the private HTTPS URL should also succeed.
5. Verify `GET /api/config/strategy` through the ordinary guard port still
   returns `401` without a key, including when sent a forged
   `Tailscale-User-Login` header. Verify the normal AI clients continue working;
   do not send diagnostic inference requests to subscription accounts.

Browser API reads with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are
rejected. Mutations require the configured origin. This prevents another site
from using the browser's Tailscale access to read or change Router state. The
normal dashboard already sends the required same-origin headers automatically.

An explicitly supplied invalid browser key is still rejected rather than
silently promoted. After the dashboard clears it, reload to use automatic
Tailscale authentication. No old storage-name migration is needed.

## Roll back

Restore the private Serve handler's previous backend target and verify its
health before removing the three environment settings and restarting the
managed service. Existing API-key clients remain usable through the ordinary
listener. Do not use `tailscale serve reset`, which would remove unrelated
handlers too. Restoring the old target restores the previous dashboard login
behavior; it does not disable authentication.
