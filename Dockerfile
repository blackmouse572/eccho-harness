# Container image for the Cloudflare Sandbox (domain reviewer's repo checkout).
# Tag must match the installed @cloudflare/sandbox version. Ships git + a Linux
# toolchain so the checkout-repo action can `git clone` the eccho repo at the PR head.
FROM docker.io/cloudflare/sandbox:0.11.0
