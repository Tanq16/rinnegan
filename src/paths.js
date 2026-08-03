// One prefix for every rinnegan route so a proxied app's root-relative request can never collide with one; / stays outside as the entry point.
export const NS = '/_rinnegan';
export const PROXY_BASE = NS + '/proxy/';
