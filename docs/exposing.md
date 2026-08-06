# Exposing rinnegan

Rinnegan serves plain HTTP on `127.0.0.1:8442`. Putting TLS in front is your job. Any proxy works: nginx, Caddy, Traefik, an ingress, a Cloudflare or Tailscale tunnel.

> Rinnegan is a shell on the box, guarded by one password with no rate limiting. TLS is not access control, so keep network-level restrictions in front of it.

## Requirements

1. Reverse-proxy to `127.0.0.1:8442`.
2. Pass WebSocket upgrades through (`/ws` and `/tunnel`).
3. No request-body cap and no read timeout. Uploads are unbounded and terminal sockets are long-lived.
4. Set `"cookie": {"secure": true}` in `~/.config/rinnegan/config.json`.

Clipboard upload and copy-the-path need a secure context, so even a LAN box wants a certificate.

## Caddy, self-signed (no domain)

Browse to `https://<host>:8443` and accept the warning once.

```caddyfile
{
	admin off
	auto_https disable_redirects
	skip_install_trust
	default_sni localhost
	# A leaf may not outlive its issuer; at the 7-day default Caddy silently clamps the 30-day leaf below.
	pki {
		ca local {
			intermediate_lifetime 8760h
		}
	}
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

# Named block: a subject-less policy accepts `lifetime` and then ignores it.
https://localhost:8443 {
	import rinnegan
	# Browsers pin the click-through exception to the leaf's fingerprint, so the 12h default re-warns twice a day.
	tls {
		issuer internal {
			lifetime 720h
		}
	}
}

# Host-less: serves IP-literal Host headers the cert above, via default_sni.
https://:8443 {
	import rinnegan
}
```

To drop the warning entirely, install `$XDG_DATA_HOME/caddy/pki/authorities/local/root.crt` in each client's trust store. `rinnegan tunnel --insecure` skips verification against this cert.

## Caddy, real domain

Point an A record at the box, open 443/tcp (and udp for HTTP/3), and delete any registrar parking records. No API token needed.

```caddyfile
{
	email you@example.com
	admin off
	# TLS-ALPN-01 only, so port 80 is never used.
	cert_issuer acme {
		disable_http_challenge
	}
	auto_https disable_redirects
	# No default_sni and no host-less block: a bare-IP request sends no SNI and dies at the handshake.
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

TLS-ALPN-01 is built into stock Caddy. It needs the handshake to reach *this* Caddy, so it breaks behind a proxying CDN, an ALB, or NAT. Use HTTP-01 (open 80, drop the `cert_issuer` block) instead.

Wildcards need DNS-01, which needs a plugin for whoever hosts your DNS (`dig NS example.com +short`):

```sh
xcaddy build --with github.com/caddy-dns/cloudflare
```

Providers are listed at [github.com/caddy-dns](https://github.com/caddy-dns); [acme-dns](https://github.com/caddy-dns/acmedns) works anywhere via one CNAME.

For port 443 as a non-root user: `sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"`.

## nginx

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

        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_read_timeout  1d;
        proxy_send_timeout  1d;
    }
}
```
