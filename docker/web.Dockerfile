FROM node:20-slim

ARG UID=1000
ARG GID=1000

WORKDIR /opt/portfolio

COPY app/ app/

# node:20-slim ships with a "node" user/group at 1000:1000. Adjust them to
# the requested UID:GID so the process matches the host data directory owner.
# Override via UID/GID build args (or the matching .env variables) — no manual
# chown of the data/ bind-mount needed when these match the host owner.
RUN groupmod -g ${GID} node && usermod -u ${UID} -g ${GID} node \
    && chown -R node:node /opt/portfolio

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "app/serve.js"]
