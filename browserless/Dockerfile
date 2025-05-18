# browserless/Dockerfile
FROM ghcr.io/browserless/chromium:latest

# ── tweak defaults; override in Railway UI if you like ──
ENV MAX_CONCURRENT_SESSIONS=5 \
    CONNECTION_TIMEOUT=60000 \
    DEFAULT_BLOCK_ADS=true \
    TOKEN=browserless_token

EXPOSE 3000
# upstream image already has the correct entrypoint
