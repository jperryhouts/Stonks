FROM node:20-slim

WORKDIR /opt/portfolio

COPY app/ app/

# node:20-slim ships with a "node" user (uid 1000). Run as that user so the
# process has no root privileges.
# Note: the data/ bind-mount must be readable/writable by uid 1000
# on the host (e.g. `chown -R 1000:1000 ./data` before first run).
RUN chown -R node:node /opt/portfolio

USER node

EXPOSE 8000

CMD ["node", "app/serve.js"]
