# Security Policy

## Supported versions

Only the latest released version (the highest `v*` tag) receives security
fixes. If you're on an older store version, update first.

| Version        | Supported |
| -------------- | --------- |
| latest release | yes       |
| older releases | no        |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use [private vulnerability reporting](../../security/advisories/new) on this
repository (Security tab → Advisories → Report a vulnerability). If that isn't
available, contact the maintainer through their GitHub profile.

Please include:

- what the issue is and where (file/line or steps to reproduce),
- the browser and extension version,
- what an attacker could plausibly achieve with it.

You should get an acknowledgement within 7 days. We'll fix, cut a release,
and credit you in the release notes unless you'd rather stay anonymous.

## Scope notes

ImageForge runs entirely locally: images you convert never leave your
browser except when *you* ask it to fetch a URL *you* supplied. The threat
model we care about most is malicious image input (a crafted file or URL)
leading to unexpected behavior — e.g. script execution outside the extension
sandbox, data exfiltration, or corrupting the user's downloads. Reports in
that area are especially welcome.
