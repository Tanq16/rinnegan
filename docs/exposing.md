# Exposing rinnegan on a real domain

Rinnegan binds `127.0.0.1` and stays there. `serve --https` puts the bundled Caddy in front with a self-signed certificate, which is enough for a LAN box, a homelab VM, or anything without a domain — see [Serving over HTTPS](../README.md#serving-over-https) for that path.

This document covers the other case: a public domain with a real, browser-trusted certificate. Read it if you are putting rinnegan on the internet; skip it otherwise.

> **Read [Security](../README.md#security) first.** Rinnegan is a shell on the machine it runs on, guarded by one password and with no login rate limiting. TLS stops eavesdroppers; it does not make the box safe to leave open. Keep network-level access controls in front of it.

## Use your own proxy if you have one

If the box already runs nginx, Traefik, a Kubernetes ingress, a Cloudflare Tunnel, or a Caddy of its own, use it. Rinnegan needs nothing special from the front — reverse-proxy to `127.0.0.1:8442`, pass WebSocket upgrades through, and don't cap or time out request bodies (uploads stream for as long as they need). Then set `cookie.secure: true` in `~/.config/rinnegan/config.json`, since only `serve --https` forces that for you.

The rest of this page is for the case where you do not already have one.

## The bundled sample

`Caddyfile.domain.example` ships in every tarball and serves exactly one subdomain with a Let's Encrypt certificate and no credentials anywhere. Replace `example.com` and the `email`, and it is ready to run. Its header comments carry the full domain-side checklist — A record, firewall ports, registrar parking records — so read the file itself as the runbook.

It uses the **TLS-ALPN-01** challenge: Let's Encrypt completes a TLS handshake against your Caddy on port 443 to prove you control the name. That means no API token, no `_acme-challenge` record, and nothing to install. Port 80 is never opened.

**TLS-ALPN-01 works only when the handshake reaches this Caddy directly.** Anything terminating TLS in front of it — a proxying CDN such as Cloudflare's orange-cloud mode, an ALB, another reverse proxy — breaks the challenge, and so does a box that isn't publicly reachable on 443. In those cases you need HTTP-01 (port 80) or DNS-01.

The sample deliberately omits `default_sni` and any host-less site block, so a request to the server's bare IP sends no SNI, matches no certificate, and dies at the TLS handshake instead of offering something to click through.

## Wildcards and DNS-01

A wildcard certificate can only be issued via DNS-01, which requires a Caddy carrying the plugin for whoever *hosts* your DNS (check with `dig NS example.com +short`). The bundled `bin/caddy` is a stock build and carries none, so this path means bringing your own binary:

```sh
xcaddy build --with github.com/caddy-dns/cloudflare
```

Point `serve --https --caddyfile <path>` at your Caddyfile and `--caddy-bin` at that binary, or run it as its own service. Each provider's credential fields are documented at [github.com/caddy-dns](https://github.com/caddy-dns). If your DNS host has no module, [acme-dns](https://github.com/caddy-dns/acmedns) works everywhere via one permanent CNAME, and keeps a token that could rewrite your real zone off the box.

DNS-01 is also the answer when the box is behind NAT, or when you want the subdomain label kept out of Certificate Transparency logs.

## Running it

The sample is never auto-seeded — `~/.config/rinnegan/Caddyfile` stays the self-signed template — so edit a copy and run it one of three ways:

```sh
# 1. Two processes. Needs cookie.secure: true in config.json.
./bin/rinnegan serve
./bin/caddy run --config ./Caddyfile.domain.example

# 2. Managed child, explicit path.
./bin/rinnegan serve --https --caddyfile ~/.config/rinnegan/Caddyfile.domain

# 3. Managed child, no flag: install it as the runtime Caddyfile and plain --https loads it.
cp Caddyfile.domain.example ~/.config/rinnegan/Caddyfile
./bin/rinnegan serve --https
```

`serve --https` prints the Caddyfile it resolved, so you can confirm which one is live. It forces `cookie.secure` regardless of the file loaded; set that manually only on the two-process route.

Option 3 is the least typing, but the runtime copy is exactly what `--refresh-caddyfile` overwrites — pass that flag again and you silently drop back to the self-signed template on `:8443`. Option 2 is immune.

## Binding port 443

Binding `:443` as rinnegan's non-root child needs `setcap cap_net_bind_service=+ep` on `bin/caddy`. **`./update.sh` replaces that binary, which drops the capability — re-apply it after every update**, or Caddy fails to bind and the server exits. Running Caddy as its own systemd service avoids both concerns.
