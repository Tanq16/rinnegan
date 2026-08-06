# Exposing rinnegan

Rinnegan serves plain HTTP on `127.0.0.1:8442` and does nothing else. It terminates no TLS, ships no certificate machinery, and has no opinion about what sits in front of it. If you want it reachable from anywhere but the box it runs on, that is your reverse proxy's job — and this document is the reference for doing it.

> **Read [Security](../README.md#security) first.** Rinnegan is a shell on the machine it runs on, guarded by one password, with no login rate limiting and no accounts. TLS stops eavesdroppers; it does not make the box safe to leave open to the internet. Keep network-level access control in front of it.

## What rinnegan needs from a proxy

Any proxy works — nginx, Caddy, Traefik, HAProxy, a Kubernetes ingress, a Cloudflare or Tailscale tunnel. Four requirements, all of them ordinary:

1. **Reverse-proxy to `127.0.0.1:8442`** and leave `listen.host` at `127.0.0.1` so nothing else can reach rinnegan directly.
2. **Pass WebSocket upgrades through.** The terminal and the port tunnel both run over `/ws` and `/tunnel`; a proxy that strips `Upgrade`/`Connection` leaves you with a login page and no shell.
3. **Do not cap or time out request bodies.** Uploads are unbounded and stream for as long as they need, so a body-size limit or a short read timeout breaks [file transfer](../README.md#file-transfer) on large files. Long-lived streams also need write/idle timeouts left off, or the terminal socket is torn down mid-session.
4. **Set `"cookie": {"secure": true}`** in `~/.config/rinnegan/config.json` once TLS is in front. Rinnegan cannot detect this for you.

## Why you want TLS even on a LAN

Beyond eavesdropping: **the browser gates features on a secure context.** Reading an image off your clipboard, and copying the finished upload path back out, both need HTTPS or `localhost`. Reach a plain-HTTP rinnegan at `http://192.168.1.10:8442` and those quietly stop working — the upload modal says so and falls back to select-the-text.

So a homelab box deserves a certificate too, even one nothing else trusts. The Caddy config below is the shortest path.

## A self-signed front for a box with no domain

Caddy's internal CA issues a certificate for `localhost` and for the machine's own IP, with no ACME and no network dependency. Save this as `Caddyfile`, run `caddy run`, and browse to `https://<host>:8443`:

```caddyfile
{
	admin off
	auto_https disable_redirects
	# Never touch the system, NSS, or Java trust stores, and never shell out to sudo.
	skip_install_trust
	default_sni localhost
	# A leaf may not outlive its issuer: at the 7-day default, Caddy silently clamps the 30-day lifetime below.
	pki {
		ca local {
			intermediate_lifetime 8760h
		}
	}
	# No read_body timeout and no request_body cap: file uploads are unbounded and stream for as long as they need.
	servers {
		timeouts {
			read_header 10s
		}
	}
}

(rinnegan) {
	bind 0.0.0.0 ::
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy 127.0.0.1:8442
}

# Named so the automation policy carries `localhost` as its subject: a subject-less policy accepts `lifetime` and then ignores it.
https://localhost:8443 {
	import rinnegan
	# Browsers pin the click-through exception to the leaf's fingerprint, so the 12h default re-raises the warning twice a day.
	tls {
		issuer internal {
			lifetime 720h
		}
	}
}

# Host-less: routes IP-literal Host headers (e.g. 192.168.1.10), served the cert above via default_sni.
https://:8443 {
	import rinnegan
}
```

Two details in there cost real time to find, so they are worth keeping when you adapt it. **The leaf lifetime** must be pinned: browsers tie a click-through exception to a specific certificate fingerprint, so Caddy's 12-hour default re-raises the warning twice a day. **The intermediate must outlast the leaf**, or Caddy silently clamps your 30-day leaf back down to the 7-day default intermediate.

To lose the warning entirely, install Caddy's root (`$XDG_DATA_HOME/caddy/pki/authorities/local/root.crt`) into each client's trust store — it is stable for ten years, so rotation stops mattering.

`rinnegan tunnel --insecure` skips certificate verification, which is what you want against this cert or a bare IP.

## A real domain

With a public domain and a box reachable on port 443, Caddy gets a browser-trusted certificate with no credentials at all:

```caddyfile
{
	email you@example.com
	admin off
	# Leaves TLS-ALPN-01 as the only challenge, so port 80 is never needed.
	cert_issuer acme {
		disable_http_challenge
	}
	auto_https disable_redirects
	# No default_sni and no host-less site block, deliberately: a request to the bare IP sends no SNI, matches no certificate, and dies at the TLS handshake instead of offering something to click through.
	servers {
		timeouts {
			read_header 10s
		}
	}
}

term.example.com {
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		X-Robots-Tag noindex
		-Server
	}
	reverse_proxy 127.0.0.1:8442
}
```

Domain side, once:

1. An **A record** `term.example.com` → the server's public IP. Use a static/Elastic IP; an ephemeral one changes on stop/start and silently breaks the record.
2. Open **443/tcp** inbound, plus 443/udp for HTTP/3. Port 80 is unused.
3. **Delete the registrar's parking records** — new domains usually ship an apex ALIAS and a `*` CNAME to a placeholder page, and those fight your own records.
4. Nothing else: no `_acme-challenge` record, no API token, no registrar API access.

This uses **TLS-ALPN-01**, which is built into stock Caddy — no `xcaddy`, no plugins. Let's Encrypt proves the name by completing a TLS handshake against *this* Caddy on 443, which means **nothing may terminate TLS in front of it**: a proxying CDN such as Cloudflare's orange-cloud mode, an ALB, or another reverse proxy all break the challenge, as does a box that is not publicly reachable on 443.

In those cases use HTTP-01 (open port 80, drop the `cert_issuer` block) or DNS-01. DNS-01 is also the only way to get a **wildcard**, and the only option behind NAT. It needs a Caddy built with the provider module for whoever *hosts* your DNS — check with `dig NS example.com +short`:

```sh
xcaddy build --with github.com/caddy-dns/cloudflare
```

Each provider's credential fields are documented at [github.com/caddy-dns](https://github.com/caddy-dns). If your DNS host has no module, [acme-dns](https://github.com/caddy-dns/acmedns) works everywhere through one permanent CNAME, and keeps a token that could rewrite your real zone off the box.

## Binding port 443

Caddy needs privileges for a port below 1024. Either run it as a systemd service, or grant the binary the capability directly:

```sh
sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"
```

## nginx

If nginx is already on the box, the upgrade and buffering directives are the parts that matter:

```nginx
server {
    listen 443 ssl;
    server_name term.example.com;

    ssl_certificate     /etc/letsencrypt/live/term.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/term.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8442;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;

        # Uploads are unbounded and terminal sockets are long-lived.
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_read_timeout  1d;
        proxy_send_timeout  1d;
    }
}
```
