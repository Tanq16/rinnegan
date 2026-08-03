// Every rinnegan route lives under one prefix so a proxied app's root-relative request can never collide with one. Only / stays outside, as the entry point — which also keeps it available as the way back out of a proxied page.
export const NS = '/_rinnegan';
export const PROXY_BASE = NS + '/proxy/';
